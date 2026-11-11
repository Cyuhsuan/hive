// What the pane draws, worked out from the panel state. Pure: no engine
// runtime, no JSX, and nothing that depends on the pane's width, the clock or
// the animation setting, so each rule can be tested on its own.

import type { Feature, Swarm, SwarmAgent, SwarmLogLine, Ticket } from '../types'
import { isLive } from './agent-phase'
import { say } from './i18n'
import type { Strings } from './i18n'
import { isDone, isEveryTicketDone } from './ticket-done'
import type { Workflow } from './workflow'

/** Completed cards a pane that only observes lists; the rest fold into one line. */
const DONE_SHOWN = 5

/** How many session log lines the pane draws. */
const LOG_SHOWN = 5

export type TicketState = 'merged' | 'resolved' | 'running' | 'failed' | 'ready' | 'blocked'

export type PaneModel = {
  /** The workflow screen is up. */
  isWorkflowView: boolean
  /** The feature to draw; none when the workflow screen is not shown. */
  feature: Feature | undefined
  tickets: Ticket[]
  /** Each ticket's state, in the order of `tickets`. */
  ticketStates: TicketState[]
  /** Feature percent, 0 to 100. */
  featurePercent: number
  /** Tickets that are done: merged into the integration branch, or resolved on their face. */
  doneCount: number
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

type TicketStateInput = {
  merged: ReadonlySet<string>
  liveTicketNumbers: ReadonlySet<string | undefined>
  failedTicketNumbers: ReadonlySet<string | undefined>
  tickets: readonly Ticket[]
}

/** A ticket's state: merged, then resolved, then running, failed, blocked, else ready. */
function ticketStateOf(t: Ticket, ctx: TicketStateInput): TicketState {
  if (ctx.merged.has(t.number)) return 'merged'
  if (t.status === 'resolved') return 'resolved'
  if (ctx.liveTicketNumbers.has(t.number)) return 'running'
  if (ctx.failedTicketNumbers.has(t.number)) return 'failed'
  const isBlocked = t.blockedBy.some(b => {
    const blocker = ctx.tickets.find(x => x.number === b)
    return blocker ? !isDone(blocker, ctx.merged) : false
  })
  return isBlocked ? 'blocked' : 'ready'
}

/** Done tickets count whole; an open ticket counts by its ticked acceptance items. */
function featurePercentOf(tickets: readonly Ticket[], merged: ReadonlySet<string>, doneCount: number): number {
  if (!tickets.length) return 0
  const openChecked = tickets
    .filter(t => !isDone(t, merged))
    .reduce((n, t) => n + (t.checks ? t.checked / t.checks : 0), 0)
  return Math.round(((doneCount + openChecked) / tickets.length) * 100)
}

/** The step of the first ticket not done; the step count when every ticket is done. */
function currentStepOf(tickets: readonly Ticket[], merged: ReadonlySet<string>, stepCount: number): number {
  return tickets.find(t => !isDone(t, merged))?.step ?? stepCount
}

/**
 * Agent cards in the order drawn: failed first, running next, done last, each
 * by start. Observing only, a finished run is as long as the session: only the
 * latest few done cards are listed and the rest are counted as folded.
 */
function orderCards(agents: readonly SwarmAgent[], done: readonly SwarmAgent[], isWorkflowView: boolean): { ordered: SwarmAgent[]; hiddenDone: number } {
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
function logLinesOf(log: readonly SwarmLogLine[]): SwarmLogLine[] {
  const isPhaseMove = (line: SwarmLogLine) => (typeof line.text === 'string' ? line.text.startsWith('→ ') : line.text.code === 'phaseMoved')
  return log.filter(line => !isPhaseMove(line)).slice(-LOG_SHOWN)
}

export function paneModelOf(s: Swarm, isWorkflowView: boolean): PaneModel {
  const live = s.agents.filter(isLive)
  const done = s.agents.filter(a => a.phase === 'done')
  const failed = s.agents.filter(a => a.phase === 'failed')

  // Under `none` a workflow screen left in the state is not drawn.
  const feature = isWorkflowView ? s.feature : undefined
  const tickets = feature?.tickets ?? []
  const merged = new Set(feature?.merged ?? [])
  const doneCount = tickets.filter(t => isDone(t, merged)).length
  const ctx: TicketStateInput = {
    merged,
    liveTicketNumbers: new Set(live.map(a => a.ticketNumber).filter(Boolean)),
    failedTicketNumbers: new Set(failed.map(a => a.ticketNumber).filter(Boolean)),
    tickets,
  }
  const stepCount = Math.max(0, ...tickets.map(t => t.step))

  const { ordered, hiddenDone } = orderCards(s.agents, done, isWorkflowView)
  return {
    isWorkflowView,
    feature,
    tickets,
    ticketStates: tickets.map(t => ticketStateOf(t, ctx)),
    featurePercent: featurePercentOf(tickets, merged, doneCount),
    doneCount,
    stepCount,
    currentStep: currentStepOf(tickets, merged, stepCount),
    isFeatureDone: tickets.length > 0 && isEveryTicketDone(tickets, merged),
    live,
    done,
    failed,
    ordered,
    hiddenDone,
    mergedCount: ctx.merged.size,
    logLines: logLinesOf(s.log),
  }
}

/** The workflow's own line: which workflow, which ticket source, and why its tickets could not be read. */
export function workflowLine(strings: Strings, workflow: Workflow, s: Swarm): string {
  const label = s.sourceLabel === undefined ? undefined : say(strings, s.sourceLabel)
  const failure = s.loadFailure === undefined ? undefined : say(strings, s.loadFailure)
  return strings.workflowLine(workflow.name, label, failure)
}
