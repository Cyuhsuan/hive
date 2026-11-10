import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentPhase, Swarm, SwarmAgent, SwarmLogLine, Ticket } from '../types'
import { markdownSource, ticketName, toPosix } from './ticket-source'
import type { SourceEnv, TicketRef, TicketSource } from './ticket-source'
import { sourceById, workflowOf } from './workflow'
import type { SourceChoice, Workflow } from './workflow'

const PANE = 'implement-swarm'
const TITLE = 'Implement swarm'

const EMPTY: Swarm = { mode: 'observe', agents: [], log: [] }
// Completed cards a pane that only observes lists; the rest fold into one line.
const DONE_SHOWN = 5

// How often the clock ticks while the pane is up; the tickets are re-read every
// few ticks (a source's `refreshSeconds`).
const TICK_MS = 2000

// Animation says a subagent is at work, and nothing else: with none live the
// pane is still. A frame is read off the clock, so nothing about it is kept.
const FRAME_MS = 120
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// The pane is redrawn twice per spinner frame, so the feature bar's light glides.
const REDRAW_MS = 60
// One pass of the feature bar's light over its filled cells, however many.
const SWEEP_MS = 2000
// The light is a soft band: full at its middle, fading to the bar's own color
// this many cells either side. Where it sits between two cells, both glow in part.
const GLOW_REACH = 3
// The bar's color as the default themes paint `claude`, and the light at its
// brightest; a cell is tinted somewhere between the two.
const GLOW_FROM = [215, 119, 87] as const
const GLOW_TO = [255, 226, 208] as const
const GLOW_SHADES = 8

// The dock's width is the person's: dragged at the pane's edge, never set from
// here. The engine seats a dock at 24 body columns at least.
const WIDTH_MIN = 24

// Bump the tag when Swarm's fields change: an earlier version's value
// outlives a reload and is then read as EMPTY instead of crashing the pane.
const swarm = atom({ plugin: 'implement-swarm', key: 'swarm' } as const, EMPTY, {
  shape: 'swarm-5',
})

// ---------------------------------------------------------------- helpers

const PHASE_PERCENT: Record<AgentPhase, number> = {
  spawned: 5,
  reading: 20,
  editing: 45,
  testing: 65,
  merging: 80,
  committing: 92,
  reviewing: 50,
  done: 100,
  failed: 100,
}

const PHASE_LABEL: Record<AgentPhase, string> = {
  spawned: '啟動中',
  reading: '讀碼',
  editing: '改碼',
  testing: '測試',
  merging: 'merge',
  committing: 'commit',
  reviewing: '審查',
  done: '完成',
  failed: '失敗',
}

const TEST_RE = /\b(dotnet test|npm (run )?test|pnpm (run )?test|yarn test|vitest|jest|pytest|go test|cargo test|mvn test|gradle test)\b/
const MERGE_RE = /\bgit (merge|rebase|pull)\b/
const COMMIT_RE = /\bgit commit\b/
function shortModel(model: string | undefined): string {
  if (!model) return '?'
  const m = model.match(/(fable|opus|sonnet|haiku)[-_ ]?(\d+(?:[-_.]\d+)?)?/i)
  if (!m) return model.slice(0, 12)
  const ver = m[2] ? ' ' + m[2].replace(/[-_]/g, '.') : ''
  return m[1]!.toLowerCase() + ver
}

function shortType(type: string): string {
  // Any agent type works: only a plugin's `name:` prefix is dropped.
  return type.replace(/^.*:/, '')
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`
}

function fmtClock(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}

// CJK and full-width characters take two cells; everything else one.
const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

function cells(text: string): number {
  let n = 0
  for (const ch of text) n += WIDE_RE.test(ch) ? 2 : 1
  return n
}

/** Cuts `text` to `width` cells, an ellipsis in its last cell when it was cut. */
function clip(text: string, width: number): string {
  if (cells(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = WIDE_RE.test(ch) ? 2 : 1
    if (used + w > Math.max(0, width - 1)) break
    out += ch
    used += w
  }
  return out + '…'
}

function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/** The spinner's glyph at `now`: every card and ticket at work draws the same one. */
function spinnerAt(now: number): string {
  return SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length]!
}

/** A stretch of bar cells drawn alike; `glow` is the tint of lit cells, absent for the bar's own color. */
type BarRun = { text: string; glow?: string }

/**
 * A bar whose filled cells a band of light crosses left to right, once every
 * SWEEP_MS: it rises at the left end, glides at a steady pace and fades out
 * past the filled cells' last one, never lighting an empty cell.
 */
function sweptBar(percent: number, width: number, now: number): BarRun[] {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  // The band's middle, in cells: from wholly before the first cell to wholly after the last.
  const middle = ((now % SWEEP_MS) / SWEEP_MS) * (filled + 2 * GLOW_REACH) - GLOW_REACH
  const runs: BarRun[] = []
  for (let i = 0; i < filled; i++) {
    const near = Math.max(0, 1 - Math.abs(i + 0.5 - middle) / GLOW_REACH)
    // Eased, so the band has a soft shoulder instead of a tent's point.
    const shade = Math.round(near * near * (3 - 2 * near) * GLOW_SHADES)
    const glow = shade === 0 ? undefined : tint(shade / GLOW_SHADES)
    const last = runs[runs.length - 1]
    if (last && last.glow === glow) last.text += '█'
    else runs.push({ text: '█', glow })
  }
  if (width > filled) runs.push({ text: '░'.repeat(width - filled) })
  return runs
}

function tint(amount: number): string {
  return '#' + GLOW_FROM.map((from, i) => Math.round(from + (GLOW_TO[i]! - from) * amount).toString(16).padStart(2, '0')).join('')
}

function isLive(agent: SwarmAgent): boolean {
  return agent.phase !== 'done' && agent.phase !== 'failed'
}

function phaseOfCall(agent: SwarmAgent, tool: string, args: Record<string, unknown>): AgentPhase {
  if (agent.phase === 'done' || agent.phase === 'failed') return agent.phase
  if (/review/i.test(agent.type)) return 'reviewing'
  if (tool === 'Bash') {
    const cmd = String(args['command'] ?? '')
    if (COMMIT_RE.test(cmd)) return 'committing'
    if (MERGE_RE.test(cmd)) return 'merging'
    if (TEST_RE.test(cmd)) return 'testing'
    return agent.phase === 'spawned' ? 'reading' : agent.phase
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'editing'
  if (/(edit|write|replace|insert)/i.test(tool.replace(/^mcp__[^_]+__/, ''))) return 'editing'
  if (typeof args['code'] === 'string' && /\.edit\./.test(args['code'])) return 'editing'
  return agent.phase === 'spawned' ? 'reading' : agent.phase
}

function describeCall(tool: string, args: Record<string, unknown>): string {
  const name = tool.replace(/^mcp__[^_]+__/, '')
  const path = args['file_path'] ?? args['path'] ?? args['notebook_path']
  if (typeof path === 'string') return `${name} ${toPosix(path).split('/').slice(-2).join('/')}`
  if (tool === 'Bash') return `$ ${String(args['command'] ?? '').replace(/\s+/g, ' ')}`
  if (typeof args['pattern'] === 'string') return `${name} /${args['pattern']}/`
  if (typeof args['skill'] === 'string') return `${name} ${args['skill']}`
  if (typeof args['description'] === 'string') return `${name} ${args['description']}`
  return name
}

function whoOf(agent: SwarmAgent | undefined): string {
  if (!agent) return 'lead'
  return agent.ticket ?? shortType(agent.type)
}

async function log($: EngineInterface, who: string, text: string) {
  const at = await $.clock.now()
  const line: SwarmLogLine = { at, who, text }
  await update($, swarm, s => ({ ...s, log: [...s.log, line].slice(-60) }))
}

async function patchAgent(
  $: EngineInterface,
  id: string,
  fn: (agent: SwarmAgent) => SwarmAgent,
) {
  await update($, swarm, s => ({
    ...s,
    agents: s.agents.map(a => (a.id === id ? fn(a) : a)),
  }))
}

function refreshStatus($: EngineInterface, s: Swarm, hasTickets: boolean) {
  if (s.mode === 'observe' && s.agents.length === 0) {
    $.ui.status(undefined)
    return
  }
  const live = s.agents.filter(isLive).length
  const done = s.agents.filter(a => a.phase === 'done').length
  const failed = s.agents.filter(a => a.phase === 'failed').length
  const f = hasTickets ? s.feature : undefined
  const feat = f && f.tickets.length ? ` · 票 ${f.tickets.filter(t => t.status === 'resolved').length}/${f.tickets.length}` : ''
  $.ui.status(`swarm ${live} 跑 · ${done} 完${failed ? ` · ${failed} 敗` : ''}${feat}`)
}

// ---------------------------------------------------------------- pane

/** Opens the pane at the surface's own width; the person drags it from there. */
async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// ---------------------------------------------------------------- tickets

/** The workflow screen is up: a timing fired, and the workflow (or `/swarm <folder>`) is still wanted. */
function isWorkflowShown(s: Swarm, workflow: Workflow | undefined): boolean {
  return s.mode === 'workflow' && (s.isManual === true || workflow !== undefined)
}

function envOf($: EngineInterface): SourceEnv {
  return {
    fs: { list: p => $.fs.list(p), read: p => $.fs.read(p) },
    now: () => $.clock.now(),
    run: argv => $.process.run(argv),
  }
}

// A spawn does not ask a failing source again within this long.
const RETRY_AFTER_MS = 10_000

/** The workflow's own line: which workflow, which ticket source, and why its tickets could not be read. */
function workflowLine(workflow: Workflow, s: Swarm): string {
  return `工作流 ${workflow.name} · 票來源 ${s.sourceLabel ?? '尚未判斷'}${s.loadFailure ? `（${s.loadFailure}）` : ''}`
}

/** Reads the project's tracker setting afresh and says which ticket source it names. */
const chooseSource = ($: EngineInterface, workflow: Workflow): Promise<SourceChoice> => workflow.chooseSource({ read: p => $.fs.read(p) })

/** Tells the person a source could not be read: the status line says why, and the log once. The tickets already loaded stay. */
async function reportFailure($: EngineInterface, source: TicketSource, origin: string | undefined, reason: string) {
  const at = await $.clock.now()
  const before = (await read($, swarm)).loadFailure
  await update($, swarm, s => ({
    ...s,
    loadFailure: reason,
    pending: origin !== undefined && !s.feature ? { sourceId: source.id, origin } : s.pending,
    failedAt: at,
  }))
  if (before !== reason) await log($, 'lead', `票來源讀取失敗：${reason}`)
}

/**
 * No feature is loaded and the prompt may name a ticket whose spec has to be
 * looked up (a GitHub issue's parent). Asks the ticket source, if it can.
 */
async function resolveUnloaded($: EngineInterface, workflow: Workflow, text: string, now: number, s: Swarm): Promise<TicketRef | undefined> {
  if (s.failedAt !== undefined && now - s.failedAt < RETRY_AFTER_MS) return undefined
  // A source known not to look anything up is not asked for again: the setting is read once.
  if (s.sourceId !== undefined && !sourceById(s.sourceId, workflow).resolveRef) return undefined
  const choice = await chooseSource($, workflow)
  await update($, swarm, cur => ({ ...cur, sourceId: choice.source?.id ?? cur.sourceId, sourceLabel: choice.label }))
  const source = choice.source
  if (!source?.resolveRef) return undefined
  const found = await source.resolveRef(envOf($), text)
  if (!found.ok) {
    await reportFailure($, source, undefined, found.reason)
    return undefined
  }
  return found.ref
}

/** Reads the tracker setting afresh and records which ticket source it names. */
async function pickSource($: EngineInterface, workflow: Workflow | undefined): Promise<SourceChoice | undefined> {
  if (!workflow) return undefined
  const choice = await chooseSource($, workflow)
  const reason = choice.source ? undefined : choice.reason
  const before = (await read($, swarm)).noTicketsReason
  await update($, swarm, s => ({
    ...s,
    sourceLabel: choice.label,
    sourceId: choice.source?.id,
    // a failure belongs to the source that had it
    loadFailure: s.sourceId === choice.source?.id ? s.loadFailure : undefined,
    noTicketsReason: reason,
  }))
  if (reason && reason !== before) await log($, 'lead', reason)
  return choice
}

/**
 * Loads the feature at `origin` and logs what it found, or what turned resolved
 * since the last read. Says whether the workflow screen may be up: it may not
 * when a source that tells its failures failed, since nothing was read.
 */
async function loadFeature($: EngineInterface, source: TicketSource, origin: string): Promise<boolean> {
  const before = (await read($, swarm)).feature
  const result = await source.load(envOf($), origin)
  if (!result.ok) {
    if (!source.showsFailure) return true
    await reportFailure($, source, origin, result.reason)
    return false
  }
  const loaded = result.feature
  await update($, swarm, cur => ({
    ...cur,
    feature: { ...loaded, merged: cur.feature?.origin === origin ? cur.feature.merged : [] },
    pending: undefined,
    failedAt: undefined,
    loadFailure: undefined,
  }))
  if (before && before.origin === origin) {
    for (const t of loaded.tickets) {
      const old = before.tickets.find(o => o.number === t.number)
      if (old && old.status !== 'resolved' && t.status === 'resolved') {
        await log($, ticketName(t), `票面 Status → resolved（${t.checked}/${t.checks} 驗收）`)
      }
    }
  } else {
    const steps = Math.max(0, ...loaded.tickets.map(t => t.step))
    await log($, 'lead', `讀到 ${loaded.name}：${loaded.tickets.length} 張票 · ${steps} 個時間步`)
  }
  return true
}

/** The workflow screen goes up; `isManual` when it is `/swarm <folder>` with no workflow. */
async function enterWorkflow($: EngineInterface, isManual: boolean) {
  await update($, swarm, (s): Swarm => ({ ...s, mode: 'workflow', isManual: isManual ? true : undefined }))
}

/** Reads again what is already loaded, or what a failed load was reading; a read that now succeeds brings the workflow screen up. */
async function refreshFeature($: EngineInterface, workflow: Workflow | undefined) {
  const s = await read($, swarm)
  const target = s.feature ?? s.pending
  if (!target) return
  const isLoaded = await loadFeature($, sourceById(target.sourceId, workflow), target.origin)
  if (isLoaded && !s.feature) await enterWorkflow($, false)
}

async function status($: EngineInterface, workflow: Workflow | undefined) {
  const s = await read($, swarm)
  refreshStatus($, s, isWorkflowShown(s, workflow))
}

/** Reads the tickets at `origin`; the workflow screen goes up unless the read failed. */
async function openFeature($: EngineInterface, source: TicketSource, origin: string, isManual: boolean) {
  if (await loadFeature($, source, origin)) await enterWorkflow($, isManual)
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  // The setting is read once per load: changing it reloads the module.
  const workflow: Workflow | undefined = workflowOf(options['workflow'])
  const isShown = (s: Swarm) => isWorkflowShown(s, workflow)
  // `off` is the pane as it was before it moved: the same glyphs, drawn at the clock's own pace.
  const isAnimated = options['animation'] !== 'off'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'swarm',
      description: '打開子代理面板（/swarm reset 清空；/swarm <issues 資料夾>、/swarm #N、/swarm <issue 網址> 載入那批票）',
    })
    // Keep elapsed times moving while anything runs, and re-read the tickets
    // now and then so the feature bar follows what the implementers write.
    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks += 1
      void read($, swarm).then(async s => {
        if (s.agents.some(isLive)) $.ui.invalidate('ui.render')
        const target = s.feature ?? s.pending
        if (!target) return
        const every = Math.round((sourceById(target.sourceId, workflow).refreshSeconds * 1000) / TICK_MS)
        // A failed load has no workflow screen yet: it is tried again all the same.
        if (ticks % every === 0 && (!s.feature || isShown(s)) && s.agents.some(isLive)) await refreshFeature($, workflow)
      })
    })

    // The frames: only while a subagent is live and the pane is the one shown.
    if (isAnimated) {
      $.clock.every(REDRAW_MS, () => {
        void read($, swarm).then(async s => {
          if (!s.agents.some(isLive)) return
          const panes = await $.ui.panes()
          if (panes.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)) $.ui.invalidate('ui.render')
        }).catch(() => undefined)
      })
    }

    return next(e)
  })

  on('command.run', { command: 'swarm' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (/^reset\b/.test(args)) {
      await update($, swarm, () => EMPTY)
      $.ui.status(undefined)
      await pickSource($, workflow)
    } else if (args) {
      if (workflow) {
        const choice = await pickSource($, workflow)
        if (choice?.source) {
          const origin = choice.source.originOfCommand(args)
          if (origin === undefined) await reportFailure($, choice.source, undefined, '要帶 spec issue 的編號或網址')
          else await openFeature($, choice.source, origin, false)
        }
      } else {
        // The one thing `none` still does: the folder the person names.
        const folder = markdownSource.originOfCommand(args)
        if (folder !== undefined) await openFeature($, markdownSource, folder, true)
      }
    } else {
      // Opening the pane reads the setting, not the tickets: those are read at a timing.
      await pickSource($, workflow)
    }
    await status($, workflow)
    await openPane($)

    const s = await read($, swarm)
    const line = workflow ? ` ${workflowLine(workflow, s)}` : ''
    return { text: `Implement swarm pane opened.${line}` }
  })

  // The workflow begins: its start skill was invoked.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.agentId === undefined && workflow?.isStartSkill(e.skill)) {
      const choice = await pickSource($, workflow)
      if (choice?.source) {
        const at = await $.clock.now()
        const source = choice.source
        await update($, swarm, s => ({ ...EMPTY, startedAt: at, sourceLabel: s.sourceLabel, sourceId: s.sourceId }))
        await log($, 'lead', `/${e.skill} 開始，等待派票`)
        const origin = source.originOfArgs(e.args ?? '')
        // With no spec named the workflow waits for tickets; with one, it begins when that is read.
        if (origin === undefined || (await loadFeature($, source, origin))) {
          await enterWorkflow($, false)
          await openPane($)
        }
      }
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started

    const at = await $.clock.now()
    // Which ticket the prompt points at: in the loaded feature's source, or in
    // any of the workflow's while none is loaded.
    const before = await read($, swarm)
    const shown = isShown(before)
    const sources = shown && before.feature ? [sourceById(before.feature.sourceId, workflow)] : (workflow?.sources ?? [])
    let ref: TicketRef | undefined
    for (const src of sources) ref ??= src.refOfText(e.prompt, before.feature)
    if (!ref && !(shown && before.feature) && workflow?.sources.some(src => src.mayNameTicket?.(e.prompt))) ref = await resolveUnloaded($, workflow, e.prompt, at, before)

    let ticket: string | undefined
    let ticketNumber: string | undefined
    let loadFrom: TicketSource | undefined
    if (ref) {
      if (shown && before.feature?.origin === ref.origin) {
        ticket = ref.ticket
        ticketNumber = ref.number
      } else if (workflow) {
        // A ticket pointed at: the ticket source setting is read afresh before any tickets are.
        const choice = await pickSource($, workflow)
        if (choice?.source) {
          ticket = ref.ticket
          ticketNumber = ref.number
          loadFrom = choice.source
        }
      }
    }

    const agent: SwarmAgent = {
      id: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      ticket,
      ticketNumber,
      isBackground: e.background,
      phase: 'spawned',
      tools: 0,
      errors: 0,
      startedAt: at,
      parentId: e.parentAgentId,
    }
    await update($, swarm, s => ({
      ...s,
      startedAt: s.startedAt ?? at,
      leadModel: e.parentAgentId === undefined ? e.parentModel : s.leadModel,
      agents: [...s.agents.filter(a => a.id !== agent.id), agent],
    }))
    await log($, whoOf(agent), `派出 ${shortType(agent.type)} · ${shortModel(agent.model)}${agent.isBackground ? ' · 背景' : ''}`)
    if (loadFrom && ref && (await loadFeature($, loadFrom, ref.origin))) {
      await enterWorkflow($, false)
      if (!shown) await openPane($)
    }
    await status($, workflow)

    return started
  }).catch((_$, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await patchAgent($, e.agentId, a => (a.phase === 'spawned' ? { ...a, phase: 'reading' } : a))
    }

    return next(e)
  })

  // The lead merging a ticket branch into the integration branch.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const s = await read($, swarm)
    if (!isShown(s) || !s.feature) return next(e)
    const n = sourceById(s.feature.sourceId, workflow).mergedTicket(e.command, s.feature)
    if (n === undefined) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, swarm, cur => ({
        ...cur,
        feature: cur.feature && { ...cur.feature, merged: Array.from(new Set([...cur.feature.merged, n])) },
      }))
      await log($, 'lead', `票 ${n} merge 進整合分支`)
      await refreshFeature($, workflow)
    }

    return ran
  }).catch((_$, e, next) => next(e))

  // Every tool call inside a subagent's loop is one step of its progress.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const s = await read($, swarm)
    const agent = s.agents.find(a => a.id === e.agentId)
    if (!agent || !isLive(agent)) return next(e)

    const { tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...args } = e as unknown as {
      tool: string
      tool_use_id: string
      agentId?: string
      requestMeta?: unknown
      [key: string]: unknown
    }
    const phase = phaseOfCall(agent, tool, args)
    const lastTool = describeCall(tool, args)
    await patchAgent($, agent.id, a => ({ ...a, phase, tools: a.tools + 1, lastTool }))
    if (phase !== agent.phase) {
      await log($, whoOf(agent), `→ ${PHASE_LABEL[phase]}`)
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true) {
      await patchAgent($, agent.id, a => ({ ...a, errors: a.errors + 1 }))
    }

    return ran
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const s = await read($, swarm)
    const agent = s.agents.find(a => a.id === e.agentId)
    if (!agent) return next(e)

    const at = await $.clock.now()
    const isFailed = e.isAborted || e.reason === 'error' || e.reason === 'refusal'
    const usage = e.usage
    const tokens = usage
      ? usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      : undefined
    await patchAgent($, agent.id, a => ({
      ...a,
      phase: isFailed ? 'failed' : 'done',
      endedAt: at,
      tokens,
    }))
    await log(
      $,
      whoOf(agent),
      `${isFailed ? '失敗' : '完成'} · ${fmtDuration(e.durationMs)} · ${agent.tools} 次工具${e.reason === 'answer' ? '' : ` · ${e.reason}`}`,
    )
    if (isShown(await read($, swarm))) await refreshFeature($, workflow)
    await status($, workflow)

    return next(e)
  })

  // ------------------------------------------------------------ drawing
  //
  // The frames say who owns what: the feature and its tickets, the lead, the
  // delegates hanging under the lead, the log. A ticket's glyph and color in
  // the step chart are its agent card's dot and frame, so the two read as one.

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, swarm)
    const now = await $.clock.now()
    // Every row below is sized from W, so the pane follows whatever width the
    // person drags the dock to, down to the engine's own floor.
    const W = Math.max(WIDTH_MIN, e.props.bodyColumns)
    const isNarrow = W < 40
    const boxInner = W - 4 // a frame and one cell of padding each side

    const live = s.agents.filter(isLive)
    const done = s.agents.filter(a => a.phase === 'done')
    const failed = s.agents.filter(a => a.phase === 'failed')

    // ---- feature: tickets by time-step
    // Under `none` a workflow screen left in the state is not drawn.
    const isWorkflowView = isShown(s)
    const feature = isWorkflowView ? s.feature : undefined
    const tickets = feature?.tickets ?? []
    const resolved = tickets.filter(t => t.status === 'resolved')
    const mergedSet = new Set(feature?.merged ?? [])
    const liveTicketNumbers = new Set(live.map(a => a.ticketNumber).filter(Boolean))
    const failedTicketNumbers = new Set(failed.map(a => a.ticketNumber).filter(Boolean))
    const stepCount = Math.max(0, ...tickets.map(t => t.step))
    const ticketState = (t: Ticket): 'merged' | 'resolved' | 'running' | 'failed' | 'ready' | 'blocked' => {
      if (mergedSet.has(t.number)) return 'merged'
      if (t.status === 'resolved') return 'resolved'
      if (liveTicketNumbers.has(t.number)) return 'running'
      if (failedTicketNumbers.has(t.number)) return 'failed'
      const isBlocked = t.blockedBy.some(b => {
        const blocker = tickets.find(x => x.number === b)
        return blocker ? blocker.status !== 'resolved' : false
      })
      return isBlocked ? 'blocked' : 'ready'
    }
    const isFeatureDone = tickets.length > 0 && resolved.length === tickets.length
    const currentStep = tickets.find(t => t.status !== 'resolved')?.step ?? stepCount
    // Resolved tickets count whole; an open ticket counts by its ticked acceptance items.
    const openChecked = tickets.filter(t => t.status !== 'resolved').reduce((n, t) => n + (t.checks ? t.checked / t.checks : 0), 0)
    const featurePercent = tickets.length ? Math.round(((resolved.length + openChecked) / tickets.length) * 100) : 0

    // A ticket is `running` only with a live subagent behind it, so its glyph turns with that card's.
    const liveGlyph = isAnimated ? spinnerAt(now) : '●'
    const stateGlyph = { merged: '◆', resolved: '✓', running: liveGlyph, failed: '✗', ready: '○', blocked: '·' } as const
    const stateColor = { merged: 'success', resolved: 'success', running: 'warning', failed: 'error', ready: 'text', blocked: 'subtle' } as const

    // One row per step. The step being worked spells its tickets out (title,
    // acceptance count); the others are a glyph and a number each.
    const stepRow = (step: number) => {
      const inStep = tickets.filter(t => t.step === step)
      const isCurrent = step === currentStep && !isFeatureDone
      const isPast = inStep.every(t => t.status === 'resolved')
      const labelW = isNarrow ? 4 : 9
      const mark = isCurrent ? '▶' : isPast ? '✓' : ' '
      const isSpelled = isCurrent && !isNarrow
      const cellW = Math.max(12, Math.floor((boxInner - labelW) / Math.max(1, Math.min(inStep.length, 3))) - 1)
      return (
        <Box key={`step-${step}`} flexDirection="row">
          <Box width={labelW}>
            <Text color={isCurrent ? 'warning' : isPast ? 'success' : undefined} dimColor={!isCurrent && !isPast} bold={isCurrent}>
              {isNarrow ? `${mark} ${step}` : `${mark} step ${step}`}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {inStep.map(t => {
              const st = ticketState(t)
              const color = st === 'ready' || st === 'blocked' ? undefined : stateColor[st]
              return isSpelled ? (
                <Box key={`t-${t.number}`} width={cellW}>
                  <Text wrap="truncate-end" color={color} dimColor={st === 'blocked'}>
                    {clip(`${stateGlyph[st]}${t.number} ${t.title}${t.checks ? ` ${t.checked}/${t.checks}` : ''}`, cellW)}
                  </Text>
                </Box>
              ) : (
                <Text key={`t-${t.number}`} color={color} dimColor={st === 'blocked'}>
                  {`${stateGlyph[st]}${t.number}`}
                </Text>
              )
            })}
          </Box>
        </Box>
      )
    }

    // ---- agent cards: failed first, then running, then done.
    // As many columns as the body allows, 34 cells each or more; a body
    // narrower than one such card gets a single card at its width.
    const cols = Math.max(1, Math.floor((W - 1) / 35))
    const cardW = Math.max(WIDTH_MIN - 2, Math.floor((W - 2 - (cols - 1)) / cols))
    const inner = cardW - 4
    const rank = (a: SwarmAgent) => (a.phase === 'failed' ? 0 : a.phase === 'done' ? 2 : 1)
    // Observing only, a finished run is as long as the session: the pane lists
    // the latest few done cards and folds the rest into one line.
    const recentDone = new Set(
      [...done].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, DONE_SHOWN).map(a => a.id),
    )
    const hiddenDone = isWorkflowView ? 0 : done.length - recentDone.size
    const ordered = s.agents
      .filter(a => isWorkflowView || a.phase !== 'done' || recentDone.has(a.id))
      .sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt)

    const card = (a: SwarmAgent) => {
      // A card with a ticket is the workflow's; any other is the observing one.
      const isTicketCard = isWorkflowView && a.ticket !== undefined
      const isRunning = isLive(a)
      const isFailed = a.phase === 'failed'
      const frame = isFailed ? 'error' : a.phase === 'done' ? 'success' : 'warning'
      const dot = isFailed ? '✗' : a.phase === 'done' ? '✓' : liveGlyph
      const percent = PHASE_PERCENT[a.phase]
      const elapsed = fmtDuration((a.endedAt ?? now) - a.startedAt)
      const number = a.ticketNumber
      const t = tickets.find(x => x.number === number)
      // The ticket's number and title, as the step chart names it; with no
      // ticket read, what the spawn said.
      const name = isTicketCard
        ? (t ? `${t.number} ${t.title}` : a.ticket!)
        : `${a.description} · ${a.type}`
      const title = isNarrow ? `${(isTicketCard && number) || clip(name, 8)} ${PHASE_LABEL[a.phase]}` : name
      const right = [
        a.errors ? `⚠ ${a.errors} err` : '',
        t && !isNarrow ? `step ${t.step}` : '',
        elapsed,
      ].filter(Boolean).join(' ')
      const barW = Math.max(4, inner - 12)

      return (
        <Box
          key={a.id}
          flexDirection="column"
          width={cardW}
          borderStyle="round"
          borderColor={frame}
          paddingX={1}
        >
          <Box justifyContent="space-between">
            <Text bold={isFailed} wrap="truncate-end">
              <Text color={frame}>{dot} </Text>
              {clip(title, Math.max(4, inner - 3 - cells(right)))}
            </Text>
            <Text dimColor>{right}</Text>
          </Box>
          {!isTicketCard && (
            <Text dimColor wrap="truncate-end">
              {clip(
                `${PHASE_LABEL[a.phase]} · ${a.tools} 次工具${isRunning && a.lastTool ? ` · ${a.lastTool}` : ''}`,
                inner,
              )}
            </Text>
          )}
          {isTicketCard && (isRunning || isFailed) && (
            <Text wrap="truncate-end">
              <Text color={frame}>{bar(percent, barW)}</Text>
              <Text dimColor> {String(percent).padStart(3)}% </Text>
              {!isNarrow && <Text>{PHASE_LABEL[a.phase]}</Text>}
            </Text>
          )}
          {isTicketCard && (isRunning || isFailed) && (
            <Text dimColor wrap="truncate-end">
              {clip(a.lastTool ?? '…', inner)}
            </Text>
          )}
        </Box>
      )
    }

    const summary = s.mode === 'workflow' || s.agents.length > 0
      ? isNarrow
        ? `${live.length} 跑 · ${done.length} 完${failed.length ? ` · ${failed.length} 敗` : ''}`
        : `${live.length} 執行中 · ${done.length} 完成 · ${failed.length} 失敗${s.startedAt ? ` · ${fmtDuration(now - s.startedAt)}` : ''}`
      : '尚無子代理'
    // The workflow's own line: which workflow, and which ticket source the project names.
    const statusLine = workflow ? workflowLine(workflow, s) : undefined

    // The log draws what moved the work on: a phase change is on the card already.
    const logLines = s.log.filter(line => !line.text.startsWith('→ ')).slice(-5)
    const featureColor = isFeatureDone ? 'success' : 'claude'
    const featureTail = isNarrow
      ? ` ${String(featurePercent).padStart(3)}% ${resolved.length}/${tickets.length}`
      : ` ${String(featurePercent).padStart(3)}%  ${resolved.length}/${tickets.length} 票 · step ${Math.min(currentStep, stepCount)}/${stepCount}`
    const featureBarW = Math.max(6, boxInner - cells(featureTail))
    const isSweeping = isAnimated && live.length > 0 && featurePercent > 0 && featurePercent < 100
    const leadTally = isWorkflowView ? `已派 ${s.agents.length} · 已 merge ${mergedSet.size}` : `已派 ${s.agents.length}`
    // Narrow, a log line names its ticket by number alone.
    const whoW = isNarrow ? 4 : 14
    const who = (name: string) => {
      const shown = clip(isNarrow ? (name.match(/^\d+/)?.[0] ?? name) : name, whoW)
      return shown + ' '.repeat(Math.max(0, whoW - cells(shown)))
    }

    return (
      <Box flexDirection="column" width={W}>
        <Box justifyContent="space-between">
          <Text bold color="claude">{isNarrow || !isWorkflowView ? 'SWARM' : 'IMPLEMENT SWARM'}</Text>
          <Text color={failed.length ? 'error' : undefined} dimColor={!failed.length}>
            {clip(summary, Math.max(6, W - (isNarrow ? 7 : 17)))}
          </Text>
        </Box>

        {statusLine && (
          <Text dimColor wrap="truncate-end">
            {clip(statusLine, W)}
          </Text>
        )}

        {feature && (
          <Box flexDirection="column" borderStyle="round" borderColor={featureColor} paddingX={1}>
            <Text wrap="truncate-end">
              <Text bold color="claude">feature </Text>
              <Text bold>{clip(feature.name, Math.max(4, boxInner - 8))}</Text>
            </Text>
            {tickets.length > 0 && (
              <Text wrap="truncate-end">
                {isSweeping
                  ? sweptBar(featurePercent, featureBarW, now).map(run => <Text color={run.glow ?? featureColor}>{run.text}</Text>)
                  : <Text color={featureColor}>{bar(featurePercent, featureBarW)}</Text>}
                <Text>{featureTail}</Text>
              </Text>
            )}
            {tickets.length === 0 && <Text dimColor>{clip(sourceById(feature.sourceId, workflow).emptyText(feature.origin), boxInner)}</Text>}
            {Array.from({ length: stepCount }, (_, i) => stepRow(i + 1))}
          </Box>
        )}

        <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold color="claude">lead</Text>
            <Text dimColor>{clip(`${isNarrow ? '' : ' · main session'} · ${shortModel(s.leadModel)}`, boxInner - 4)}</Text>
          </Text>
          <Box justifyContent="space-between">
            {!isNarrow && isWorkflowView && <Text dimColor>派票 → merge → review</Text>}
            <Text>{clip(leadTally, boxInner)}</Text>
          </Box>
        </Box>

        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {s.agents.length === 0
              ? '│  (還沒派出任何子代理)'
              : clip(`└─┬─ delegates · ${s.agents.length} forks${live.length ? ` · ${live.length} running` : ''}`, W - 2)}
          </Text>
        </Box>

        {s.agents.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={2}>
            {ordered.map(card)}
          </Box>
        )}

        {hiddenDone > 0 && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">{clip(`另有 ${hiddenDone} 個已完成`, W - 2)}</Text>
          </Box>
        )}

        {s.agents.length > 0 && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {clip(`└─▶ back to lead${isWorkflowView ? ' · merge + review' : ''}${done.length === s.agents.length ? ' · 全部完成' : ''}`, W - 2)}
            </Text>
          </Box>
        )}

        <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
          <Text dimColor bold>session log</Text>
          {logLines.length === 0 && <Text dimColor>（空）</Text>}
          {logLines.map(line => (
            <Text wrap="truncate-end">
              {!isNarrow && <Text dimColor>{fmtClock(line.at)} </Text>}
              <Text color="warning">{who(line.who)}</Text>
              <Text> {clip(line.text, Math.max(8, boxInner - whoW - (isNarrow ? 1 : 10)))}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
