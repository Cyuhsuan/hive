import { expect, mock, test } from 'claude-code/testing'

// A bee flies along the top of every subagent card at work and, when the
// subagent finishes, leaves the card in about a second. The lead's frame counts
// the bees that came home. The bee is laid over the card: nothing moves for it.

const ON = { options: { workflow: 'none' } }
const OFF = { options: { workflow: 'none', animation: 'off' } }

const START = 1_700_000_000_000
const RETURN_MS = 1000
const REDRAW_MS = 60

const PANE = {
  plugin: 'hive',
  component: 'Pane',
  requestId: 'hive',
  props: { title: 'Hive', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

type Hook = (...args: any[]) => unknown
type On = (event: string, hook: Hook) => unknown
type World = { invalidations: number }

function engine(on: On, world: World = { invalidations: 0 }) {
  const clock = mock.clock(on as never, { now: START })
  let n = 0
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'hive', title: 'Hive', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.invalidate', () => {
    world.invalidations += 1
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  return clock
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const spawn = ($: any) => $.agent.spawn({ prompt: '看看', description: '探索', subagentType: 'Explore' } as never)
const finish = ($: any, agentId: string, over: object = {}) =>
  $.turn.complete({ agentId, reason: 'answer', isAborted: false, durationMs: 1000, answer: 'ok', ...over } as never)
const fail = ($: any, agentId: string) => finish($, agentId, { reason: 'error' })

type Node = { type?: string; props?: Record<string, any>; children?: unknown[] }
const drawn = async ($: any, bodyColumns = 80): Promise<Node> => {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
  const tree = (await ui.drawn()) as Node
  await ui.unmount()
  return tree
}
const find = (node: unknown, test: (n: Node) => boolean): Node[] => {
  if (node === null || typeof node !== 'object') return []
  const n = node as Node
  return [...(test(n) ? [n] : []), ...(n.children ?? []).flatMap(c => find(c, test))]
}
const cardOf = (tree: Node, id: string) => find(tree, n => n.props?.key === id)[0]!
const text = (node: unknown) => JSON.stringify(node)
/** The bees laid over a card: absolute boxes holding the bee. */
const beesOn = (card: Node) => find(card, n => n.props?.position === 'absolute' && text(n).includes('🐝'))
const beeLeftOf = (card: Node) => beesOn(card)[0]!.props!['left'] as number

// ------------------------------------------------------------ the flight

test('a live card has a bee, laid over the card, and it moves as the clock does', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($)

  const first = beeLeftOf(cardOf(await drawn($), 'agent-1'))
  const lefts = new Set([first])
  for (let i = 0; i < 20; i++) {
    await clock.advance(250)
    lefts.add(beeLeftOf(cardOf(await drawn($), 'agent-1')))
  }
  expect(lefts.size).toBeGreaterThan(3)
  expect(beesOn(cardOf(await drawn($), 'agent-1'))).toHaveLength(1)
})

test('the bee takes no cell of the card: its title, right side and width are the same without it', ON, async ($, on) => {
  engine(on)
  await start($)
  await spawn($)

  const card = cardOf(await drawn($), 'agent-1')
  const bee = beesOn(card)[0]!
  expect(bee.props!['position']).toBe('absolute')
  // the card's flow: the title row and the detail line, as before the bee
  const flow = (card.children ?? []).filter(c => c !== bee)
  expect(flow).toHaveLength(2)
  expect(text(flow[0])).toContain('探索 · Explore')
  expect(text(flow[0])).toContain('0s')
  expect(card.props!['width']).toBe(38)
  // and laid on the card's top edge
  expect(bee.props!['top']).toBe(-1)
})

// ------------------------------------------------------------ the return

test('a finished subagent keeps its bee for a second, flying on, then none', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($)
  await finish($, 'agent-1')

  const lefts = new Set<number>()
  for (let t = 0; t < RETURN_MS; t += 100) {
    const card = cardOf(await drawn($), 'agent-1')
    expect(beesOn(card)).toHaveLength(1)
    lefts.add(beeLeftOf(card))
    await clock.advance(100)
  }
  expect(lefts.size).toBeGreaterThan(3)
  expect(beesOn(cardOf(await drawn($), 'agent-1'))).toHaveLength(0)
  // the card is the finished card it always was
  expect(text(cardOf(await drawn($), 'agent-1'))).toContain('✓')
})

test('the returning bee leaves past the card edge', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($)
  await finish($, 'agent-1')
  await clock.advance(RETURN_MS - REDRAW_MS)

  // inside the card's 38 columns, the frame's two included: a bee left of 36 is wholly out
  expect(beeLeftOf(cardOf(await drawn($), 'agent-1'))).toBeGreaterThan(30)
})

test('a failed subagent has no bee the moment it fails, and keeps its red frame', ON, async ($, on) => {
  engine(on)
  await start($)
  await spawn($)
  await fail($, 'agent-1')

  const card = cardOf(await drawn($), 'agent-1')
  expect(beesOn(card)).toHaveLength(0)
  expect(card.props!['borderColor']).toBe('error')
  expect(text(card)).toContain('✗')
})

test('a pane mounted after the return time shows the result, not the flight', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($)
  await finish($, 'agent-1')
  await clock.advance(RETURN_MS * 5)

  const tree = await drawn($)
  expect(beesOn(cardOf(tree, 'agent-1'))).toHaveLength(0)
  expect(text(tree)).toContain('已派 1 · 🐝 1')
})

// ------------------------------------------------------------ the redraws

test('the pane is redrawn through the return and not after it', ON, async ($, on) => {
  const world: World = { invalidations: 0 }
  const clock = engine(on, world)
  await start($)
  await spawn($)
  await finish($, 'agent-1')
  await clock.settle()

  world.invalidations = 0
  await clock.advance(RETURN_MS - 100)
  await clock.settle()
  expect(world.invalidations).toBeGreaterThan(5)

  await clock.advance(2000)
  await clock.settle()
  world.invalidations = 0
  await clock.advance(2000)
  await clock.settle()
  expect(world.invalidations).toBe(0)
})

test('a failed subagent starts no redraws', ON, async ($, on) => {
  const world: World = { invalidations: 0 }
  const clock = engine(on, world)
  await start($)
  await spawn($)
  await fail($, 'agent-1')
  await clock.settle()

  world.invalidations = 0
  await clock.advance(2000)
  await clock.settle()
  expect(world.invalidations).toBe(0)
})

// ------------------------------------------------------------ the hive

test('the lead counts the bees home: finished ones, not failed, and nothing at 0', ON, async ($, on) => {
  engine(on)
  await start($)
  await spawn($)
  await spawn($)
  await spawn($)
  expect(text(await drawn($))).not.toContain('已派 3 · 🐝')
  expect(text(find(await drawn($), n => n.type === 'Text' && text(n).includes('已派'))[0])).not.toContain('🐝')

  await finish($, 'agent-1')
  await finish($, 'agent-2')
  await fail($, 'agent-3')
  expect(text(await drawn($))).toContain('已派 3 · 🐝 2')
})

test('narrow, the bee flies and the count shows, and nothing is pushed out of the frames at any width', ON, async ($, on) => {
  engine(on)
  await start($)
  await spawn($)
  await spawn($)
  await finish($, 'agent-2')

  for (const columns of [24, 56, 84]) {
    const tree = await drawn($, columns)
    expect(text(tree)).toContain('🐝 1')
    const card = cardOf(tree, 'agent-1')
    const width = card.props!['width'] as number
    expect(width).toBeLessThanOrEqual(columns - 2)
    // the whole bee (two cells) lies inside the card's frame
    const left = beeLeftOf(card)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(left + 2).toBeLessThanOrEqual(width - 2)
    // the lead's tally still fits the lead's frame
    const lead = find(tree, n => n.type === 'Text' && text(n).includes('🐝 1'))[0]!
    expect([...String(lead.children?.[0])].length).toBeLessThanOrEqual(columns - 4)
  }
})

// ------------------------------------------------------------ the setting

test('animation off: the bee waits still on a live card, none after the finish, the count stays', OFF, async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($)
  await spawn($)

  const first = beeLeftOf(cardOf(await drawn($), 'agent-1'))
  await clock.advance(1700)
  expect(beesOn(cardOf(await drawn($), 'agent-1'))).toHaveLength(1)
  expect(beeLeftOf(cardOf(await drawn($), 'agent-1'))).toBe(first)

  await finish($, 'agent-2')
  const tree = await drawn($)
  expect(beesOn(cardOf(tree, 'agent-2'))).toHaveLength(0)
  expect(text(tree)).toContain('已派 2 · 🐝 1')
})
