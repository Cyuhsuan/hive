// The pane's layout: JSX and the sizes worked out from the pane's width. It
// only lays out what the pane model says; the tickets' states and percents are
// not worked out here.

import type { EngineInterface } from 'claude-code'

import type { Swarm, SwarmAgent } from '../types'
import { spinnerAt, sweptBar } from './animation'
import { PHASE_LABEL, PHASE_PERCENT, isLive } from './agent-phase'
import { workflowLine } from './feature-load'
import type { PaneModel } from './pane-model'
import { bar, cells, clip, fmtClock, fmtDuration, shortModel } from './text-format'
import { sourceById } from './workflow'
import type { Workflow } from './workflow'

// The dock's width is the person's: dragged at the pane's edge, never set from
// here. The engine seats a dock at 24 body columns at least.
const WIDTH_MIN = 24

export type PaneDrawing = {
  s: Swarm
  model: PaneModel
  /** The clock's now. */
  now: number
  workflow: Workflow | undefined
  isAnimated: boolean
}

// The frames say who owns what: the feature and its tickets, the lead, the
// delegates hanging under the lead, the log. A ticket's glyph and color in
// the step chart are its agent card's dot and frame, so the two read as one.
export function drawPane(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  { s, model, now, workflow, isAnimated }: PaneDrawing,
) {
  const { Box, Text } = $.ui.resolve(e)
  // Every row below is sized from W, so the pane follows whatever width the
  // person drags the dock to, down to the engine's own floor.
  const W = Math.max(WIDTH_MIN, e.props.bodyColumns)
  const isNarrow = W < 40
  const boxInner = W - 4 // a frame and one cell of padding each side

  const { live, done, failed, feature, tickets, states, isWorkflowView, isFeatureDone, currentStep, stepCount, ordered, hiddenDone, logLines } = model
  const featurePercent = model.percent
  const resolvedCount = model.resolvedCount

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
            const st = states[t.number]!
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

  // ---- agent cards
  // As many columns as the body allows, 34 cells each or more; a body
  // narrower than one such card gets a single card at its width.
  const cols = Math.max(1, Math.floor((W - 1) / 35))
  const cardW = Math.max(WIDTH_MIN - 2, Math.floor((W - 2 - (cols - 1)) / cols))
  const inner = cardW - 4

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

  const featureColor = isFeatureDone ? 'success' : 'claude'
  const featureTail = isNarrow
    ? ` ${String(featurePercent).padStart(3)}% ${resolvedCount}/${tickets.length}`
    : ` ${String(featurePercent).padStart(3)}%  ${resolvedCount}/${tickets.length} 票 · step ${Math.min(currentStep, stepCount)}/${stepCount}`
  const featureBarW = Math.max(6, boxInner - cells(featureTail))
  const isSweeping = isAnimated && live.length > 0 && featurePercent > 0 && featurePercent < 100
  const leadTally = isWorkflowView ? `已派 ${s.agents.length} · 已 merge ${model.mergedCount}` : `已派 ${s.agents.length}`
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
}
