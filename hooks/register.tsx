import type { EngineInterface, Register } from 'claude-code'

import type { Swarm, SwarmAgent, Ticket } from '../types'
import { spinnerAt, sweptBar } from './animation'
import { PHASE_LABEL, PHASE_PERCENT, describeCall, isLive, phaseOfCall, whoOf } from './agent-phase'
import { enterWorkflow, loadFeature, openFeature, pickSource, refreshFeature, reportFailure, ticketOfPrompt, workflowLine } from './feature-load'
import { EMPTY, PANE, TITLE, isWorkflowShown, log, patchAgent, readSwarm, status, updateSwarm } from './swarm-state'
import { bar, cells, clip, fmtClock, fmtDuration, shortModel, shortType } from './text-format'
import { markdownSource } from './ticket-source'
import { sourceById, workflowOf } from './workflow'
import type { Workflow } from './workflow'

// Completed cards a pane that only observes lists; the rest fold into one line.
const DONE_SHOWN = 5

// How often the clock ticks while the pane is up; the tickets are re-read every
// few ticks (a source's `refreshSeconds`).
const TICK_MS = 2000

// The pane is redrawn twice per animation frame, so the feature bar's light glides.
const REDRAW_MS = 60

// The dock's width is the person's: dragged at the pane's edge, never set from
// here. The engine seats a dock at 24 body columns at least.
const WIDTH_MIN = 24

// ---------------------------------------------------------------- pane

/** Opens the pane at the surface's own width; the person drags it from there. */
async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
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
      void readSwarm($).then(async s => {
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
        void readSwarm($).then(async s => {
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
      await updateSwarm($, () => EMPTY)
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

    const s = await readSwarm($)
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
        await updateSwarm($, s => ({ ...EMPTY, startedAt: at, sourceLabel: s.sourceLabel, sourceId: s.sourceId }))
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
    const before = await readSwarm($)
    const shown = isShown(before)
    const { ticket, ticketNumber, loadFrom, origin } = await ticketOfPrompt($, e.prompt, before, workflow, at)

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
    await updateSwarm($, s => ({
      ...s,
      startedAt: s.startedAt ?? at,
      leadModel: e.parentAgentId === undefined ? e.parentModel : s.leadModel,
      agents: [...s.agents.filter(a => a.id !== agent.id), agent],
    }))
    await log($, whoOf(agent), `派出 ${shortType(agent.type)} · ${shortModel(agent.model)}${agent.isBackground ? ' · 背景' : ''}`)
    if (loadFrom && origin !== undefined && (await loadFeature($, loadFrom, origin))) {
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
    const s = await readSwarm($)
    if (!isShown(s) || !s.feature) return next(e)
    const n = sourceById(s.feature.sourceId, workflow).mergedTicket(e.command, s.feature)
    if (n === undefined) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await updateSwarm($, cur => ({
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
    const s = await readSwarm($)
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
    const s = await readSwarm($)
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
    if (isShown(await readSwarm($))) await refreshFeature($, workflow)
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
    const s = await readSwarm($)
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
