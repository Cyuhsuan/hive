import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentPhase, Feature, Swarm, SwarmAgent, SwarmLogLine, Ticket } from '../types'

const PANE = 'implement-swarm'
const TITLE = 'Implement swarm'

const EMPTY: Swarm = { isActive: false, agents: [], log: [] }

// The dock's width is the person's: dragged at the pane's edge, never set from
// here. The engine seats a dock at 24 body columns at least.
const WIDTH_MIN = 24

// Bump the tag when Swarm's fields change: an earlier version's value
// outlives a reload and is then read as EMPTY instead of crashing the pane.
const swarm = atom({ plugin: 'implement-swarm', key: 'swarm' } as const, EMPTY, {
  shape: 'swarm-2',
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
// `.scratch/<feature>/issues/03-login-api.md` → dir `.scratch/<feature>/issues`, ticket `03-login-api`
const TICKET_PATH_RE = /((?:[^\s`'"()<>]*\/)?issues)\/(\d+)(-[^\s`'"()<>]*?)?\.md/
const TICKET_FILE_RE = /^(\d+)(?:-(.*))?\.md$/

/** Paths are matched with `/` only, so a Windows path is read the same way. */
const toPosix = (text: string): string => text.replace(/\\/g, '/')

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

function isLive(agent: SwarmAgent): boolean {
  return agent.phase !== 'done' && agent.phase !== 'failed'
}

function ticketNumber(ticket: string | undefined): string | undefined {
  const m = ticket?.match(/^(\d+)/)
  return m ? m[1] : undefined
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

function refreshStatus($: EngineInterface, s: Swarm) {
  if (!s.isActive) {
    $.ui.status(undefined)
    return
  }
  const live = s.agents.filter(isLive).length
  const done = s.agents.filter(a => a.phase === 'done').length
  const failed = s.agents.filter(a => a.phase === 'failed').length
  const f = s.feature
  const feat = f && f.tickets.length ? ` · 票 ${f.tickets.filter(t => t.status === 'resolved').length}/${f.tickets.length}` : ''
  $.ui.status(`swarm ${live} 跑 · ${done} 完${failed ? ` · ${failed} 敗` : ''}${feat}`)
}

// ---------------------------------------------------------------- pane

/** Opens the pane at the surface's own width; the person drags it from there. */
async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// ---------------------------------------------------------------- tickets

function parseTicket(name: string, text: string): Ticket | undefined {
  const file = name.match(TICKET_FILE_RE)
  if (!file) return undefined
  const number = file[1]!
  const slug = file[2] ?? ''
  const title = text.match(/^#\s*\d+\s*[:：]\s*(.+?)\s*$/m)?.[1] ?? slug
  const blockedLine = text.match(/\*\*Blocked by:?\*\*:?\s*(.*)/i)?.[1] ?? ''
  const blockedBy = /none/i.test(blockedLine)
    ? []
    : Array.from(new Set((blockedLine.match(/\b\d{1,3}\b/g) ?? []).map(n => n.padStart(number.length, '0'))))
  const status = (text.match(/\*\*Status:?\*\*:?\s*([^\s*]+)/i)?.[1] ?? 'unknown').toLowerCase()
  const checks = (text.match(/^\s*- \[[ xX]\]/gm) ?? []).length
  const checked = (text.match(/^\s*- \[[xX]\]/gm) ?? []).length

  return { number, slug, title, blockedBy, status, checked, checks, step: 1 }
}

function assignSteps(tickets: Ticket[]): Ticket[] {
  const byNumber = new Map(tickets.map(t => [t.number, t]))
  const depth = new Map<string, number>()
  const visit = (t: Ticket, seen: Set<string>): number => {
    const known = depth.get(t.number)
    if (known !== undefined) return known
    if (seen.has(t.number)) return 1
    seen.add(t.number)
    let d = 1
    for (const b of t.blockedBy) {
      const blocker = byNumber.get(b)
      if (blocker) d = Math.max(d, visit(blocker, seen) + 1)
    }
    depth.set(t.number, d)
    return d
  }
  return tickets
    .map(t => ({ ...t, step: visit(t, new Set()) }))
    .sort((a, b) => a.step - b.step || a.number.localeCompare(b.number))
}

async function loadFeature($: EngineInterface, issuesDir: string): Promise<Feature | undefined> {
  let entries
  try {
    entries = await $.fs.list(issuesDir)
  } catch {
    return undefined
  }
  const files = entries.filter(e => e.kind === 'file' && TICKET_FILE_RE.test(e.name))
  const tickets: Ticket[] = []
  for (const file of files) {
    try {
      const text = await $.fs.read(`${issuesDir}/${file.name}`)
      const ticket = parseTicket(file.name, text)
      if (ticket) tickets.push(ticket)
    } catch {
      // a ticket that cannot be read is left out of the graph
    }
  }
  const parts = issuesDir.replace(/\/+$/, '').split('/')
  const name = parts[parts.length - 2] ?? parts[parts.length - 1] ?? issuesDir

  return {
    issuesDir,
    name,
    tickets: assignSteps(tickets),
    merged: [],
    loadedAt: await $.clock.now(),
  }
}

async function refreshFeature($: EngineInterface, issuesDir?: string) {
  const s = await read($, swarm)
  const dir = issuesDir ?? s.feature?.issuesDir
  if (!dir) return
  const loaded = await loadFeature($, dir)
  if (!loaded) return
  const before = s.feature
  await update($, swarm, cur => ({
    ...cur,
    feature: { ...loaded, merged: cur.feature?.issuesDir === dir ? cur.feature.merged : [] },
  }))
  // Log tickets that turned resolved since the last read.
  if (before && before.issuesDir === dir) {
    for (const t of loaded.tickets) {
      const old = before.tickets.find(o => o.number === t.number)
      if (old && old.status !== 'resolved' && t.status === 'resolved') {
        await log($, `${t.number}-${t.slug}`, `票面 Status → resolved（${t.checked}/${t.checks} 驗收）`)
      }
    }
  } else {
    const steps = Math.max(0, ...loaded.tickets.map(t => t.step))
    await log($, 'lead', `讀到 ${loaded.name}：${loaded.tickets.length} 張票 · ${steps} 個時間步`)
  }
}

/** Which ticket a prompt or a skill argument points at, and its issues folder. */
function ticketRef(text: string): { issuesDir: string; ticket: string } | undefined {
  const m = toPosix(text).match(TICKET_PATH_RE)
  if (!m) return undefined
  return { issuesDir: m[1]!, ticket: `${m[2]}${m[3] ?? ''}` }
}

/** The issues folder a spec path implies: `.scratch/<feature>/spec.md` → `.scratch/<feature>/issues`. */
function issuesDirOfArgs(raw: string): string | undefined {
  const args = toPosix(raw)
  const direct = args.match(/([^\s`'"()<>]*\/issues)(?:\/|\b)/)?.[1]
  if (direct) return direct
  const spec = args.match(/([^\s`'"()<>]+)\/(?:spec|design)\.md/)?.[1]
  if (spec) return `${spec}/issues`
  const scratch = args.match(/(\.scratch\/[^\s/`'"()<>]+)/)?.[1]
  return scratch ? `${scratch}/issues` : undefined
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'swarm',
      description: '打開 implement-spec 進度面板（/swarm reset 清空；/swarm <issues 資料夾> 指定票）',
    })
    // Keep elapsed times moving while anything runs, and re-read the tickets
    // now and then so the feature bar follows what the implementers write.
    let ticks = 0
    $.clock.every(2000, () => {
      ticks += 1
      void read($, swarm).then(async s => {
        if (!s.isActive) return
        if (s.agents.some(isLive)) $.ui.invalidate('ui.render')
        if (ticks % 5 === 0 && s.feature && s.agents.some(isLive)) await refreshFeature($)
      })
    })

    return next(e)
  })

  on('command.run', { command: 'swarm' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (/^reset\b/.test(args)) {
      await update($, swarm, () => EMPTY)
      $.ui.status(undefined)
    } else if (args) {
      const dir = issuesDirOfArgs(args) ?? args
      await update($, swarm, s => ({ ...s, isActive: true }))
      await refreshFeature($, dir)
    } else {
      await refreshFeature($)
    }
    await openPane($)

    return { text: 'Implement swarm pane opened.' }
  })

  // The implement phase begins: /implement-spec was invoked.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.agentId === undefined && /implement-spec$/.test(e.skill)) {
      const at = await $.clock.now()
      await update($, swarm, () => ({ ...EMPTY, isActive: true, startedAt: at }))
      await log($, 'lead', `/${e.skill} 開始，等待派票`)
      const dir = issuesDirOfArgs(e.args ?? '')
      if (dir) await refreshFeature($, dir)
      await openPane($)
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started

    const at = await $.clock.now()
    const ref = ticketRef(e.prompt)
    const agent: SwarmAgent = {
      id: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      ticket: ref?.ticket,
      isBackground: e.background,
      phase: 'spawned',
      tools: 0,
      errors: 0,
      startedAt: at,
      parentId: e.parentAgentId,
    }
    // No agent type is required: a prompt that points at a ticket file is enough.
    const looksLikeImplement =
      ref !== undefined || /implement|review|merg/i.test(`${e.subagentType} ${e.description}`)
    let wasActive = true
    await update($, swarm, s => {
      wasActive = s.isActive
      const isActive = s.isActive || looksLikeImplement
      return {
        ...s,
        isActive,
        startedAt: s.startedAt ?? at,
        leadModel: e.parentAgentId === undefined ? e.parentModel : s.leadModel,
        agents: isActive ? [...s.agents.filter(a => a.id !== agent.id), agent] : s.agents,
      }
    })
    const now = await read($, swarm)
    if (!now.isActive) return started
    if (!wasActive) await openPane($)
    await log($, whoOf(agent), `派出 ${shortType(agent.type)} · ${shortModel(agent.model)}${agent.isBackground ? ' · 背景' : ''}`)
    if (ref && (!now.feature || now.feature.issuesDir !== ref.issuesDir)) {
      await refreshFeature($, ref.issuesDir)
    }
    refreshStatus($, await read($, swarm))

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
    if (!s.isActive || !s.feature) return next(e)
    const m = e.command.match(/\bgit merge\b[^\n]*?ticket-(\d+)/)
    if (!m) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const n = m[1]!
      await update($, swarm, cur => ({
        ...cur,
        feature: cur.feature && { ...cur.feature, merged: Array.from(new Set([...cur.feature.merged, n])) },
      }))
      await log($, 'lead', `票 ${n} merge 進整合分支`)
      await refreshFeature($)
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
    await refreshFeature($)
    refreshStatus($, await read($, swarm))

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
    const feature = s.feature
    const tickets = feature?.tickets ?? []
    const resolved = tickets.filter(t => t.status === 'resolved')
    const mergedSet = new Set(feature?.merged ?? [])
    const liveTicketNumbers = new Set(live.map(a => ticketNumber(a.ticket)).filter(Boolean))
    const failedTicketNumbers = new Set(failed.map(a => ticketNumber(a.ticket)).filter(Boolean))
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

    const stateGlyph = { merged: '◆', resolved: '✓', running: '●', failed: '✗', ready: '○', blocked: '·' } as const
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
    const ordered = [...s.agents].sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt)

    const card = (a: SwarmAgent) => {
      const isRunning = isLive(a)
      const isFailed = a.phase === 'failed'
      const frame = isFailed ? 'error' : a.phase === 'done' ? 'success' : 'warning'
      const dot = isFailed ? '✗' : a.phase === 'done' ? '✓' : '●'
      const percent = PHASE_PERCENT[a.phase]
      const elapsed = fmtDuration((a.endedAt ?? now) - a.startedAt)
      const number = ticketNumber(a.ticket)
      const t = tickets.find(x => x.number === number)
      // The ticket's number and title, as the step chart names it; with no
      // ticket read, what the spawn said.
      const name = t ? `${t.number} ${t.title}` : (a.ticket ?? a.description)
      const title = isNarrow ? `${number ?? clip(name, 8)} ${PHASE_LABEL[a.phase]}` : name
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
          {(isRunning || isFailed) && (
            <Text wrap="truncate-end">
              <Text color={frame}>{bar(percent, barW)}</Text>
              <Text dimColor> {String(percent).padStart(3)}% </Text>
              {!isNarrow && <Text>{PHASE_LABEL[a.phase]}</Text>}
            </Text>
          )}
          {(isRunning || isFailed) && (
            <Text dimColor wrap="truncate-end">
              {clip(a.lastTool ?? '…', inner)}
            </Text>
          )}
        </Box>
      )
    }

    const summary = s.isActive
      ? isNarrow
        ? `${live.length} 跑 · ${done.length} 完${failed.length ? ` · ${failed.length} 敗` : ''}`
        : `${live.length} 執行中 · ${done.length} 完成 · ${failed.length} 失敗${s.startedAt ? ` · ${fmtDuration(now - s.startedAt)}` : ''}`
      : '尚未進入 implement 階段'

    // The log draws what moved the work on: a phase change is on the card already.
    const logLines = s.log.filter(line => !line.text.startsWith('→ ')).slice(-5)
    const featureColor = isFeatureDone ? 'success' : 'claude'
    const featureTail = isNarrow
      ? ` ${String(featurePercent).padStart(3)}% ${resolved.length}/${tickets.length}`
      : ` ${String(featurePercent).padStart(3)}%  ${resolved.length}/${tickets.length} 票 · step ${Math.min(currentStep, stepCount)}/${stepCount}`
    const leadTally = `已派 ${s.agents.length} · 已 merge ${mergedSet.size}`
    // Narrow, a log line names its ticket by number alone.
    const whoW = isNarrow ? 4 : 14
    const who = (name: string) => {
      const shown = clip(isNarrow ? (name.match(/^\d+/)?.[0] ?? name) : name, whoW)
      return shown + ' '.repeat(Math.max(0, whoW - cells(shown)))
    }

    return (
      <Box flexDirection="column" width={W}>
        <Box justifyContent="space-between">
          <Text bold color="claude">{isNarrow ? 'SWARM' : 'IMPLEMENT SWARM'}</Text>
          <Text color={failed.length ? 'error' : undefined} dimColor={!failed.length}>
            {clip(summary, Math.max(6, W - (isNarrow ? 7 : 17)))}
          </Text>
        </Box>

        {feature && (
          <Box flexDirection="column" borderStyle="round" borderColor={featureColor} paddingX={1}>
            <Text wrap="truncate-end">
              <Text bold color="claude">feature </Text>
              <Text bold>{clip(feature.name, Math.max(4, boxInner - 8))}</Text>
            </Text>
            {tickets.length > 0 && (
              <Text wrap="truncate-end">
                <Text color={featureColor}>{bar(featurePercent, Math.max(6, boxInner - cells(featureTail)))}</Text>
                <Text>{featureTail}</Text>
              </Text>
            )}
            {tickets.length === 0 && <Text dimColor>{clip(`${feature.issuesDir} 裡沒有讀到票檔`, boxInner)}</Text>}
            {Array.from({ length: stepCount }, (_, i) => stepRow(i + 1))}
          </Box>
        )}

        <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold color="claude">lead</Text>
            <Text dimColor>{clip(`${isNarrow ? '' : ' · main session'} · ${shortModel(s.leadModel)}`, boxInner - 4)}</Text>
          </Text>
          <Box justifyContent="space-between">
            {!isNarrow && <Text dimColor>派票 → merge → review</Text>}
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

        {s.agents.length > 0 && (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {clip(`└─▶ back to lead · merge + review${done.length === s.agents.length ? ' · 全部完成' : ''}`, W - 2)}
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
