// What the pane draws, worked out from the panel state. Pure: no engine
// runtime, no JSX, and nothing that depends on the pane's width, the clock or
// the animation setting, so each rule can be tested on its own.

import type { Feature, Swarm, SwarmAgent, SwarmLogLine, Ticket } from '../types'
import { isLive } from './agent-phase'

/** Completed cards a pane that only observes lists; the rest fold into one line. */
export const DONE_SHOWN = 5

/** How many session log lines the pane draws. */
const LOG_SHOWN = 5

export type TicketState = 'merged' | 'resolved' | 'running' | 'failed' | 'ready' | 'blocked'

export type PaneModel = {
  /** The workflow screen is up. */
  isWorkflowView: boolean
  /** The feature to draw; none when the workflow screen is not shown. */
  feature: Feature | undefined
  tickets: Ticket[]
  /** Each ticket's state, by ticket number. */
  states: Record<string, TicketState>
  /** Feature percent, 0 to 100. */
  percent: number
  resolvedCount: number
  stepCount: number
  currentStep: number
  isFeatureDone: boolean
  live: SwarmAgent[]
  done: SwarmAgent[]
  failed: SwarmAgent[]
  /** Agent cards in the order drawn: failed, running, done; each by start. */
  ordered: SwarmAgent[]
  /** Done cards folded into one line. */
  hiddenDone: number
  mergedCount: number
  logLines: SwarmLogLine[]
}

export type TicketStateInput = {
  merged: ReadonlySet<string>
  live: ReadonlySet<string | undefined>
  failed: ReadonlySet<string | undefined>
  tickets: readonly Ticket[]
}

/** A ticket's state: merged, then resolved, then running, failed, blocked, else ready. */
export function ticketStateOf(t: Ticket, ctx: TicketStateInput): TicketState {
  if (ctx.merged.has(t.number)) return 'merged'
  if (t.status === 'resolved') return 'resolved'
  if (ctx.live.has(t.number)) return 'running'
  if (ctx.failed.has(t.number)) return 'failed'
  const isBlocked = t.blockedBy.some(b => {
    const blocker = ctx.tickets.find(x => x.number === b)
    return blocker ? blocker.status !== 'resolved' : false
  })
  return isBlocked ? 'blocked' : 'ready'
}

/** Resolved tickets count whole; an open ticket counts by its ticked acceptance items. */
export function featurePercentOf(tickets: readonly Ticket[]): number {
  if (!tickets.length) return 0
  const resolved = tickets.filter(t => t.status === 'resolved').length
  const openChecked = tickets
    .filter(t => t.status !== 'resolved')
    .reduce((n, t) => n + (t.checks ? t.checked / t.checks : 0), 0)
  return Math.round(((resolved + openChecked) / tickets.length) * 100)
}

/** The step of the first open ticket; the step count when every ticket is resolved. */
export function currentStepOf(tickets: readonly Ticket[]): number {
  const stepCount = Math.max(0, ...tickets.map(t => t.step))
  return tickets.find(t => t.status !== 'resolved')?.step ?? stepCount
}

/**
 * Agent cards in the order drawn: failed first, running next, done last, each
 * by start. Observing only, a finished run is as long as the session: only the
 * latest few done cards are listed and the rest are counted as folded.
 */
export function orderCards(agents: readonly SwarmAgent[], isWorkflowView: boolean): { ordered: SwarmAgent[]; hiddenDone: number } {
  const done = agents.filter(a => a.phase === 'done')
  const rank = (a: SwarmAgent) => (a.phase === 'failed' ? 0 : a.phase === 'done' ? 2 : 1)
  const recentDone = new Set(
    [...done].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, DONE_SHOWN).map(a => a.id),
  )
  const hiddenDone = isWorkflowView ? 0 : done.length - recentDone.size
  const ordered = agents
    .filter(a => isWorkflowView || a.phase !== 'done' || recentDone.has(a.id))
    .sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt)
  return { ordered, hiddenDone }
}

/** The log draws what moved the work on: a phase change is on the card already. */
export function logLinesOf(log: readonly SwarmLogLine[]): SwarmLogLine[] {
  return log.filter(line => !line.text.startsWith('→ ')).slice(-LOG_SHOWN)
}

export function paneModelOf(s: Swarm, isWorkflowView: boolean): PaneModel {
  const live = s.agents.filter(isLive)
  const done = s.agents.filter(a => a.phase === 'done')
  const failed = s.agents.filter(a => a.phase === 'failed')

  // Under `none` a workflow screen left in the state is not drawn.
  const feature = isWorkflowView ? s.feature : undefined
  const tickets = feature?.tickets ?? []
  const resolvedCount = tickets.filter(t => t.status === 'resolved').length
  const ctx: TicketStateInput = {
    merged: new Set(feature?.merged ?? []),
    live: new Set(live.map(a => a.ticketNumber).filter(Boolean)),
    failed: new Set(failed.map(a => a.ticketNumber).filter(Boolean)),
    tickets,
  }
  const states: Record<string, TicketState> = {}
  for (const t of tickets) states[t.number] = ticketStateOf(t, ctx)

  const { ordered, hiddenDone } = orderCards(s.agents, isWorkflowView)
  return {
    isWorkflowView,
    feature,
    tickets,
    states,
    percent: featurePercentOf(tickets),
    resolvedCount,
    stepCount: Math.max(0, ...tickets.map(t => t.step)),
    currentStep: currentStepOf(tickets),
    isFeatureDone: tickets.length > 0 && resolvedCount === tickets.length,
    live,
    done,
    failed,
    ordered,
    hiddenDone,
    mergedCount: ctx.merged.size,
    logLines: logLinesOf(s.log),
  }
}
