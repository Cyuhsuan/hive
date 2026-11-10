import { expect, mock, test } from 'claude-code/testing'

import { cells } from '../hooks/text-format'

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
  on('tool.call', () => ({ result: {} }))
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
/** The framed Box of a card: the terminal paints a frame over what its own Box holds. */
const framedOf = (card: Node) => find(card, n => n.props?.borderStyle !== undefined)[0]!
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
  const framed = framedOf(card)
  const flow = framed.children ?? []
  expect(flow).toHaveLength(2)
  expect(text(flow[0])).toContain('探索 · Explore')
  expect(text(flow[0])).toContain('0s')
  expect(card.props!['width']).toBe(38)
  // and laid on the card's top edge: over the framed Box, after it, never inside it,
  // where the frame would be painted over the bee
  expect(bee.props!['top']).toBe(0)
  expect(beesOn(framed)).toHaveLength(0)
  expect(card.children?.indexOf(bee)).toBeGreaterThan(card.children!.indexOf(framed))
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

  // From the card's left edge, its right frame is column 37 of its 38: a bee at 38 or more
  // (two cells wide) lies wholly past it, and further right than a flying bee ever goes (35).
  const left = beeLeftOf(cardOf(await drawn($), 'agent-1'))
  expect(left).toBeGreaterThanOrEqual(38)
  expect(left).toBeGreaterThan(38 - 3)
})

test('a failed subagent has no bee the moment it fails, and keeps its red frame', ON, async ($, on) => {
  engine(on)
  await start($)
  await spawn($)
  await fail($, 'agent-1')

  const card = cardOf(await drawn($), 'agent-1')
  expect(beesOn(card)).toHaveLength(0)
  expect(framedOf(card).props!['borderColor']).toBe('error')
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
    expect(left).toBeGreaterThanOrEqual(1)
    expect(left + 2).toBeLessThanOrEqual(width - 1)
    // the lead's tally still fits the lead's frame
    const lead = find(tree, n => n.type === 'Text' && text(n).includes('🐝 1'))[0]!
    expect(cells(String(lead.children?.[0]))).toBeLessThanOrEqual(columns - 4)
  }
})

test('the lead frame is uneven honeycomb with a ragged outline, with no subagent yet and at every width', ON, async ($, on) => {
  engine(on)
  await start($)

  for (const columns of [24, 56, 84]) {
    const hive = cardOf(await drawn($, columns), 'hive')
    expect(hive.props!['width']).toBe(columns)
    const [above, top, middle, bottom, below] = (hive.children as Node[]).map(n => n)
    const row = (n: Node) => String(n.children?.[0])
    // the ring's top and bottom: one cell in from each edge, capped and open cells in no even order
    for (const edge of [top!, bottom!]) {
      expect(row(edge)).toMatch(/^ [⬢⬡]+$/)
      expect(row(edge)).toMatch(/⬢⬢/)
      expect(row(edge)).toMatch(/⬡⬡/)
      expect(row(edge)).toMatch(/⬢⬡⬢/)
      expect(cells(row(edge))).toBe(columns - 1)
    }
    expect(row(top!)).not.toBe(row(bottom!))
    // past the ring, above and below: a few cells stand out and most of the edge is bare
    for (const ragged of [above!, below!]) {
      expect(row(ragged)).toMatch(/^[⬢⬡ ]+$/)
      expect(row(ragged)).toMatch(/[⬢⬡]/)
      expect(row(ragged)).toMatch(/ {2}/)
      expect(cells(row(ragged))).toBe(columns)
      expect(row(ragged).replace(/ /g, '').length).toBeLessThan(columns / 2)
    }
    expect(row(above!)).not.toBe(row(below!))
    // the sides: the ring's cell on every row, and outside it a cell standing out on some rows only
    const [left, body, right] = middle!.children as Node[]
    const rows = (n: Node) => (n.children as Node[]).map(row)
    expect(left!.props!['width']).toBe(2)
    expect(right!.props!['width']).toBe(2)
    for (const r of rows(left!)) expect(r).toMatch(/^[⬢⬡ ][⬢⬡]$/)
    for (const r of rows(right!)) expect(r).toMatch(/^[⬢⬡][⬢⬡ ]$/)
    for (const side of [left!, right!]) {
      const out = rows(side).join('')
      expect(rows(side)).toHaveLength(2)
      expect(out).toContain(' ')
      expect(out.replace(/ /g, '').length).toBe(3)
    }
    expect(body!.props!['width']).toBe(columns - 4)
    expect(body!.children).toHaveLength(2)
    expect(text(body)).toContain('lead')
    expect(text(body)).toContain('已派 0')
    // no line of a plain frame is left on it
    expect(find(hive, n => n.props?.borderStyle !== undefined)).toHaveLength(0)
    // and the comb is still: drawn again, cell for cell the same
    expect(text(cardOf(await drawn($, columns), 'hive'))).toBe(text(hive))
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

// ------------------------------------------------------------ the workflow view and its ticket cards

const WF = { options: { workflow: 'mattpocock-skills' } }
const WF_OFF = { options: { workflow: 'mattpocock-skills', animation: 'off' } }
const TICKETS: Record<string, string> = {
  '01-schema.md': '# 01: 新增資料表\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
  '02-api.md': '# 02: 登入 API\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
}

function workflowEngine(on: On, world: World = { invalidations: 0 }) {
  const clock = engine(on, world)
  on('fs.list', () => ({ value: Object.keys(TICKETS).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('issue-tracker.md')) throw new Error('ENOENT')
    return { value: TICKETS[e.path.split('/').pop() ?? ''] ?? '' }
  })
  return clock
}
const spawnTicket = ($: any, file: string, subagentType = 'ticket-implementer') =>
  $.agent.spawn({ prompt: `實作 .scratch/f/issues/${file}`, description: file, subagentType } as never)

test('workflow view: a ticket card, implementing or reviewing, has a bee and it flies home on finishing', WF, async ($, on) => {
  const clock = workflowEngine(on)
  await start($)
  await spawnTicket($, '01-schema.md')
  await spawnTicket($, '02-api.md', 'code-reviewer')
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'agent-2' } as never)

  const tree = await drawn($)
  expect(beesOn(cardOf(tree, 'agent-1'))).toHaveLength(1)
  expect(text(cardOf(tree, 'agent-2'))).toContain('審查')
  expect(beesOn(cardOf(tree, 'agent-2'))).toHaveLength(1)
  expect(beesOn(cardOf(tree, 'agent-1'))[0]!.props!['top']).toBe(0)

  await finish($, 'agent-1')
  await clock.advance(RETURN_MS - REDRAW_MS)
  const returning = cardOf(await drawn($), 'agent-1')
  expect(beesOn(returning)).toHaveLength(1)
  expect(beeLeftOf(returning)).toBeGreaterThanOrEqual(38)

  await clock.advance(REDRAW_MS)
  expect(beesOn(cardOf(await drawn($), 'agent-1'))).toHaveLength(0)
})

test('workflow view: the lead reads 已派 N, then 🐝 K, then 已 merge M', WF, async ($, on) => {
  workflowEngine(on)
  await start($)
  await spawnTicket($, '01-schema.md')
  await spawnTicket($, '02-api.md')
  await finish($, 'agent-1')

  const tally = find(await drawn($), n => n.type === 'Text' && text(n).includes('已派'))[0]!
  expect(String(tally.children?.[0])).toBe('已派 2 · 🐝 1 · 已 merge 0')
})

test('workflow view: at 24, 56 and 84 columns the step chart, the cards and the lead hold their frames', WF, async ($, on) => {
  workflowEngine(on)
  await start($)
  await spawnTicket($, '01-schema.md')
  await spawnTicket($, '02-api.md')
  await finish($, 'agent-2')

  for (const columns of [24, 56, 84]) {
    const tree = await drawn($, columns)
    // the step chart is drawn: one row per step, each row's glyphs and numbers kept whole
    const steps = find(tree, n => n.type === 'Text' && /step \d|[▶✓ ] \d/.test(text(n)))
    expect(steps.length).toBeGreaterThan(0)
    expect(text(tree)).toContain('01')
    expect(text(tree)).toContain('02')

    const card = cardOf(tree, 'agent-1')
    const width = card.props!['width'] as number
    expect(width).toBeLessThanOrEqual(columns - 2)
    const left = beeLeftOf(card)
    expect(left).toBeGreaterThanOrEqual(1)
    expect(left + 2).toBeLessThanOrEqual(width - 1)

    const lead = find(tree, n => n.type === 'Text' && text(n).includes('🐝 1'))[0]!
    expect(cells(String(lead.children?.[0]))).toBeLessThanOrEqual(columns - 4)
  }
})

test('workflow view, animation off: a still bee on a live ticket card, none once it finishes or fails', WF_OFF, async ($, on) => {
  workflowEngine(on)
  await start($)
  await spawnTicket($, '01-schema.md')
  await spawnTicket($, '02-api.md')

  expect(beeLeftOf(cardOf(await drawn($), 'agent-1'))).toBe(1)
  await finish($, 'agent-1')
  await fail($, 'agent-2')
  const tree = await drawn($)
  expect(beesOn(cardOf(tree, 'agent-1'))).toHaveLength(0)
  expect(beesOn(cardOf(tree, 'agent-2'))).toHaveLength(0)
})

test('animation off: a failed subagent has no bee', OFF, async ($, on) => {
  engine(on)
  await start($)
  await spawn($)
  await fail($, 'agent-1')

  expect(beesOn(cardOf(await drawn($), 'agent-1'))).toHaveLength(0)
})
