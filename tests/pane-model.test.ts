import { expect, test } from 'claude-code/testing'

import type { AgentPhase, Swarm, SwarmAgent, SwarmLogLine, Ticket } from '../types'
import { paneModelOf } from '../hooks/pane-model'
import { isEveryTicketDone } from '../hooks/ticket-done'

// The pane model on its own: no pane, no plugin, no mock.

function ticket(number: string, over: Partial<Ticket> = {}): Ticket {
  return { number, slug: '', title: `t${number}`, blockedBy: [], status: 'ready-for-agent', checked: 0, checks: 0, step: 1, ...over }
}

function agent(id: string, phase: AgentPhase, over: Partial<SwarmAgent> = {}): SwarmAgent {
  return { id, type: 'ticket-implementer', description: '', model: 'opus', isBackground: false, phase, tools: 0, errors: 0, startedAt: 0, ...over }
}

function swarm(tickets: Ticket[], agents: SwarmAgent[] = [], merged: string[] = [], log: SwarmLogLine[] = []): Swarm {
  return {
    mode: 'workflow',
    agents,
    log,
    feature: { sourceId: 'markdown', origin: 'issues', name: 'f', tickets, merged, loadedAt: 0 },
  }
}

const stateOf = (s: Swarm, n: string) => paneModelOf(s, true).ticketStates[s.feature!.tickets.findIndex(t => t.number === n)]

test('ticket state: merged wins over everything', () => {
  const s = swarm([ticket('1', { status: 'resolved' })], [agent('a', 'reading', { ticketNumber: '1' })], ['1'])
  expect(stateOf(s, '1')).toBe('merged')
})

test('ticket state: resolved wins over running and failed', () => {
  const s = swarm(
    [ticket('1', { status: 'resolved' })],
    [agent('a', 'reading', { ticketNumber: '1' }), agent('b', 'failed', { ticketNumber: '1' })],
  )
  expect(stateOf(s, '1')).toBe('resolved')
})

test('ticket state: running wins over failed', () => {
  const s = swarm([ticket('1')], [agent('a', 'failed', { ticketNumber: '1' }), agent('b', 'editing', { ticketNumber: '1' })])
  expect(stateOf(s, '1')).toBe('running')
})

test('ticket state: failed wins over blocked', () => {
  const s = swarm([ticket('1'), ticket('2', { blockedBy: ['1'] })], [agent('a', 'failed', { ticketNumber: '2' })])
  expect(stateOf(s, '2')).toBe('failed')
})

test('ticket state: blocked while its blocker is open, ready once it is resolved', () => {
  const open = swarm([ticket('1'), ticket('2', { blockedBy: ['1'] })])
  expect(stateOf(open, '1')).toBe('ready')
  expect(stateOf(open, '2')).toBe('blocked')
  const resolved = swarm([ticket('1', { status: 'resolved' }), ticket('2', { blockedBy: ['1'] })])
  expect(stateOf(resolved, '2')).toBe('ready')
})

test('ticket state: a blocker outside the batch does not block', () => {
  expect(stateOf(swarm([ticket('2', { blockedBy: ['9'] })]), '2')).toBe('ready')
})

test('ticket state: two tickets sharing a number each keep their own', () => {
  const s = swarm([ticket('01', { status: 'resolved' }), ticket('01', { slug: 'b' })])
  expect(paneModelOf(s, true).ticketStates).toEqual(['resolved', 'ready'])
})

test('feature percent counts resolved tickets whole and open ones by ticked items', () => {
  const s = swarm([
    ticket('1', { status: 'resolved' }),
    ticket('2', { checked: 1, checks: 2 }),
    ticket('3', { checked: 0, checks: 0 }),
    ticket('4'),
  ])
  // (1 + 0.5 + 0 + 0) / 4
  expect(paneModelOf(s, true).featurePercent).toBe(38)
  expect(paneModelOf(s, true).doneCount).toBe(1)
})

test('feature percent is 0 without tickets and 100 when all are resolved', () => {
  expect(paneModelOf(swarm([]), true).featurePercent).toBe(0)
  const all = swarm([ticket('1', { status: 'resolved' }), ticket('2', { status: 'resolved', step: 2 })])
  const m = paneModelOf(all, true)
  expect(m.featurePercent).toBe(100)
  expect(m.isFeatureDone).toBe(true)
})

test('current step is the first open ticket\'s step, the step count when all are resolved', () => {
  const s = swarm([ticket('1', { status: 'resolved' }), ticket('2', { step: 2 }), ticket('3', { step: 3 })])
  const m = paneModelOf(s, true)
  expect(m.currentStep).toBe(2)
  expect(m.stepCount).toBe(3)
  const done = paneModelOf(swarm([ticket('1', { status: 'resolved' }), ticket('2', { status: 'resolved', step: 2 })]), true)
  expect(done.currentStep).toBe(2)
  expect(done.stepCount).toBe(2)
})

test('cards order failed, then running, then done, each by start time', () => {
  const agents = [
    agent('d1', 'done', { startedAt: 1, endedAt: 9 }),
    agent('r2', 'editing', { startedAt: 5 }),
    agent('f1', 'failed', { startedAt: 7 }),
    agent('r1', 'reading', { startedAt: 2 }),
    agent('f0', 'failed', { startedAt: 3 }),
    agent('d0', 'done', { startedAt: 0, endedAt: 8 }),
  ]
  const m = paneModelOf(swarm([ticket('1')], agents), true)
  expect(m.ordered.map(a => a.id)).toEqual(['f0', 'f1', 'r1', 'r2', 'd0', 'd1'])
  expect(m.hiddenDone).toBe(0)
})

test('observing only lists the five latest done cards and folds the rest', () => {
  const agents = Array.from({ length: 7 }, (_, i) => agent(`d${i}`, 'done', { startedAt: i, endedAt: 100 + i }))
  const s: Swarm = { mode: 'observe', agents, log: [] }
  const m = paneModelOf(s, false)
  expect(m.ordered.map(a => a.id)).toEqual(['d2', 'd3', 'd4', 'd5', 'd6'])
  expect(m.hiddenDone).toBe(2)
})

test('the workflow screen lists every card and folds none', () => {
  const agents = Array.from({ length: 7 }, (_, i) => agent(`d${i}`, 'done', { startedAt: i, endedAt: 100 + i }))
  const m = paneModelOf(swarm([ticket('1')], agents), true)
  expect(m.ordered).toHaveLength(7)
  expect(m.hiddenDone).toBe(0)
})

test('no feature when the workflow screen is not shown, though the state holds tickets', () => {
  const s = swarm([ticket('1')])
  const m = paneModelOf(s, false)
  expect(m.feature).toBeUndefined()
  expect(m.tickets).toEqual([])
  expect(m.featurePercent).toBe(0)
})

test('merged count and agent groups', () => {
  const s = swarm([ticket('1'), ticket('2')], [agent('a', 'reading'), agent('b', 'done'), agent('c', 'failed')], ['1', '2'])
  const m = paneModelOf(s, true)
  expect(m.mergedCount).toBe(2)
  expect(m.live.map(a => a.id)).toEqual(['a'])
  expect(m.done.map(a => a.id)).toEqual(['b'])
  expect(m.failed.map(a => a.id)).toEqual(['c'])
})

test('log lines leave out phase changes and keep the last five', () => {
  const lines = ['派出 a', '→ 讀碼', 'b', 'c', '→ 改碼', 'd', 'e', 'f', 'g'].map((text, at) => ({ at, who: 'w', text }))
  const m = paneModelOf(swarm([], [], [], lines), true)
  expect(m.logLines.map(l => l.text)).toEqual(['c', 'd', 'e', 'f', 'g'])
})

// ------------------------------------------------ merged counts as done

test('done: a merged ticket whose face is not resolved counts whole in the percent and the count', () => {
  const s = swarm([ticket('1', { checked: 0, checks: 2 }), ticket('2')], [], ['1'])
  const m = paneModelOf(s, true)
  expect(m.featurePercent).toBe(50)
  expect(m.doneCount).toBe(1)
})

test('done: a merged ticket with some checks ticked counts once, as a whole ticket', () => {
  const s = swarm([ticket('1', { checked: 1, checks: 2 }), ticket('2')], [], ['1'])
  expect(paneModelOf(s, true).featurePercent).toBe(50)
})

test('done: the current step moves on when every ticket of the step is merged', () => {
  const s = swarm([ticket('1'), ticket('2'), ticket('3', { step: 2 })], [], ['1', '2'])
  expect(paneModelOf(s, true).currentStep).toBe(2)
})

test('done: every ticket merged or resolved makes the feature done', () => {
  const s = swarm([ticket('1'), ticket('2', { status: 'resolved', step: 2 })], [], ['1'])
  const m = paneModelOf(s, true)
  expect(m.isFeatureDone).toBe(true)
  expect(m.featurePercent).toBe(100)
  expect(m.currentStep).toBe(2)
  expect(paneModelOf(swarm([ticket('1'), ticket('2', { step: 2 })], [], ['1']), true).isFeatureDone).toBe(false)
})

test('done: a ticket whose blocker is merged but not resolved is ready, not blocked', () => {
  const s = swarm([ticket('1'), ticket('2', { blockedBy: ['1'], step: 2 })], [], ['1'])
  expect(stateOf(s, '2')).toBe('ready')
})

test('done: merged is still drawn as merged and resolved as resolved', () => {
  const s = swarm([ticket('1'), ticket('2', { status: 'resolved' }), ticket('3', { status: 'resolved' })], [], ['1', '3'])
  expect(paneModelOf(s, true).ticketStates).toEqual(['merged', 'resolved', 'merged'])
})

// ------------------------------------------------ a feature with no tickets

test('done: a feature with no tickets has nothing left, yet the pane does not draw it as finished', () => {
  // Nothing left to do, so a prompt naming another spec's ticket may swap it out…
  expect(isEveryTicketDone([], new Set())).toBe(true)
  // …but an empty feature is not a finished one: its frame stays the accent.
  expect(paneModelOf(swarm([]), true).isFeatureDone).toBe(false)
})

test('done: every ticket done needs each one merged or resolved', () => {
  const tickets = [ticket('1', { status: 'resolved' }), ticket('2')]
  expect(isEveryTicketDone(tickets, new Set())).toBe(false)
  expect(isEveryTicketDone(tickets, new Set(['2']))).toBe(true)
})
