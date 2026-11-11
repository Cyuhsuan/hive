import { expect, mock, test } from 'claude-code/testing'

// Animation says a subagent is at work: the cards' dots and the tickets' glyphs
// turn together, a light crosses the feature bar's filled cells, and with no
// subagent live (or the setting `off`) the pane is still.

const ON = { options: { workflow: 'mattpocock-skills', language: 'zh-TW' } }
const OFF = { options: { workflow: 'mattpocock-skills', language: 'zh-TW', animation: 'off' } }
const OBSERVE = { options: { workflow: 'none', language: 'zh-TW' } }

const START = 1_700_000_000_000
const FRAME_MS = 120
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const BRAILLE = /[⠀-⣿]/
const frameAt = (now: number) => SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length]!
/** A card's dot as the drawn tree holds it: a child of its own, a blank after it. */
const dotOf = (glyph: string) => `"${glyph}"," "`

const PANE = {
  plugin: 'hive',
  component: 'Pane',
  requestId: 'hive',
  props: { title: 'Hive', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

// Two tickets of four acceptance items: one resolved, so the bar is half full.
const TICKETS: Record<string, string> = {
  '01-schema.md': '# 01: 新增資料表\n\n**Blocked by:** None\n\n**Status:** resolved\n\n- [x] a\n',
  '02-api.md': '# 02: 登入 API\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
  '03-page.md': '# 03: 報表頁\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
}

type Hook = (...args: any[]) => unknown
type On = (event: string, hook: Hook) => unknown
type World = { invalidations: number; isShown: boolean; failingAgent?: string }

function engine(on: On, world: World = { invalidations: 0, isShown: true }) {
  const clock = mock.clock(on as never, { now: START })
  let n = 0
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({
    value: [{ id: 'hive', title: 'Hive', isShown: world.isShown, isFocused: false, isPlaced: true }],
  }))
  on('ui.invalidate', () => {
    world.invalidations += 1
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))
  on('tool.call', (_: unknown, e: { agentId?: string }) =>
    e.agentId !== undefined && e.agentId === world.failingAgent ? { result: {}, isError: true } : { result: {} })
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('fs.list', () => ({
    value: Object.keys(TICKETS).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('issue-tracker.md')) throw new Error('ENOENT')
    return { value: TICKETS[e.path.split('/').pop() ?? ''] ?? '' }
  })
  return clock
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const spawn = ($: any, prompt: string, description = '子代理', subagentType = 'ticket-implementer') =>
  $.agent.spawn({ prompt, description, subagentType } as never)
const finish = ($: any, agentId: string) =>
  $.turn.complete({ agentId, reason: 'answer', isAborted: false, durationMs: 1000, answer: 'ok' } as never)
const mount = ($: any, bodyColumns = 80) => $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
const drawnText = async ($: any, bodyColumns = 80) => {
  const ui = await mount($, bodyColumns)
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}
type Run = { text: string; color: string }
/** The feature bar as drawn: its stretches of cells in order, each with its color. Lit cells are tinted (`#rrggbb`). */
const barOf = async ($: any, bodyColumns = 80): Promise<Run[]> => {
  const ui = await mount($, bodyColumns)
  const runs: Run[] = []
  let isOver = false
  const walk = (node: any) => {
    if (isOver || node === null || typeof node !== 'object') return
    const only = Array.isArray(node.children) && node.children.length === 1 ? node.children[0] : undefined
    if (typeof only === 'string' && /^[█░]+$/.test(only)) {
      runs.push({ text: only, color: String(node.props?.color) })
      // the bar's empty cells end it: the cards' own bars come after
      if (only.includes('░')) isOver = true
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(await ui.drawn())
  await ui.unmount()
  return runs
}
const ACCENT = '#c084fc'
const DONE = '#b6d7a8'
const GLOW_PEAK = '#f3e8ff'
/** A tinted cell: any `#rrggbb` but the accent, which is the bar's own color. */
const isTint = (color: string) => color.startsWith('#') && color !== ACCENT && color !== DONE
const isLit = (run: Run) => isTint(run.color)
const cellsOf = (runs: Run[]) => runs.flatMap(run => [...run.text].map(ch => ({ ch, color: run.color })))
/** How bright a tint is: its channels summed. */
const brightness = (color: string) => [1, 3, 5].reduce((n, i) => n + parseInt(color.slice(i, i + 2), 16), 0)
/** The cell the light is brightest at, or -1 with no cell lit. */
const crestOf = (runs: Run[]) => {
  const all = cellsOf(runs)
  let best = -1
  all.forEach((cell, i) => {
    if (isTint(cell.color) && (best < 0 || brightness(cell.color) > brightness(all[best]!.color))) best = i
  })
  return best
}

// ------------------------------------------------------------ the spinner

test('a live card draws the spinner frame the clock names, and the next one a frame later', OBSERVE, async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, '看看這個 repo', '探索', 'Explore')

  const first = await drawnText($)
  expect(first).toContain(dotOf(frameAt(START)))
  expect(first).not.toContain('●')

  await clock.advance(FRAME_MS)
  const second = await drawnText($)
  expect(frameAt(START + FRAME_MS)).not.toBe(frameAt(START))
  expect(second).toContain(dotOf(frameAt(START + FRAME_MS)))
  expect(second).not.toContain(dotOf(frameAt(START)))
})

test('a card that never called a tool, and one that erred, turn all the same', OBSERVE, async ($, on) => {
  engine(on, { invalidations: 0, isShown: true, failingAgent: 'agent-2' })
  await start($)
  await spawn($, '還沒動', '剛派出', 'Explore')
  await spawn($, '會出錯', '出錯的', 'Explore')
  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'agent-2' } as never)

  const text = await drawnText($)
  expect(text).toContain('⚠ 1 err')
  expect(text.split(dotOf(frameAt(START))).length - 1).toBe(2)
})

test('done and failed cards are still: with no subagent live nothing is animated', OBSERVE, async ($, on) => {
  engine(on)
  await start($)
  await spawn($, '做完的', '完成的', 'Explore')
  await finish($, 'agent-1')

  const text = await drawnText($)
  expect(text).toContain(dotOf('✓'))
  expect(BRAILLE.test(text)).toBe(false)
})

test('narrow, the spinner still takes the dot\'s one cell', OBSERVE, async ($, on) => {
  engine(on)
  await start($)
  await spawn($, '看看', '探索', 'Explore')

  expect(await drawnText($, 24)).toContain(dotOf(frameAt(START)))
})

// ------------------------------------------------------------ the tickets

test('a ticket with a live subagent turns with its card; an open ticket nobody works is still', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')
  await clock.advance(FRAME_MS * 3)

  const frame = frameAt(START + FRAME_MS * 3)
  const text = await drawnText($)
  // the step chart's glyph and the card's dot are the same frame
  expect(text).toContain(`${frame}02 登入 API`)
  expect(text).toContain(dotOf(frame))
  // 03 is open with nobody on it: ready, not moving
  expect(text).toContain('○03')
  expect(text).not.toContain(`${frame}03`)
})

// ------------------------------------------------------------ the feature bar

test('a soft band of light glides across the filled cells of the feature bar and never leaves them', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')

  const crests: number[] = []
  const tints = new Set<string>()
  let widest = 0
  let shape = ''
  // one whole pass, looked at as often as the pane is redrawn
  for (let t = 0; t < 2000; t += 60) {
    const runs = await barOf($)
    const all = cellsOf(runs)
    // the cells themselves never change: the light is color alone
    const drawn = all.map(cell => cell.ch).join('')
    if (shape) expect(drawn).toBe(shape)
    shape = drawn
    expect(drawn).toMatch(/^█+░+$/)
    // no empty cell is ever lit
    expect(all.some(cell => cell.ch === '░' && isTint(cell.color))).toBe(false)
    const lit = runs.filter(isLit)
    lit.forEach(run => tints.add(run.color))
    widest = Math.max(widest, lit.reduce((n, run) => n + run.text.length, 0))
    crests.push(crestOf(runs))
    await clock.advance(60)
  }
  // a band, not a cell: several cells wide, in several shades
  expect(widest).toBeGreaterThan(2)
  expect(widest).toBeLessThan(7)
  expect(tints.size).toBeGreaterThan(3)
  // it glides: from one redraw to the next the crest moves on by a cell or two, never back
  const seen = crests.filter(c => c >= 0)
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]! - seen[i - 1]!).toBeGreaterThan(-1)
    expect(seen[i]! - seen[i - 1]!).toBeLessThan(3)
  }
  // and it crossed the whole of the filled cells
  const filled = shape.replace(/░/g, '').length
  expect(seen[0]).toBe(0)
  expect(seen[seen.length - 1]).toBe(filled - 1)
})

test('the pass takes the same two seconds at any width', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')
  await clock.advance(500)

  for (const columns of [120, 48]) {
    const before = JSON.stringify(await barOf($, columns))
    await clock.advance(2000)
    expect(JSON.stringify(await barOf($, columns))).toBe(before)
    await clock.advance(1000)
    expect(JSON.stringify(await barOf($, columns))).not.toBe(before)
    await clock.advance(1000)
  }
})

test('the feature bar is still once no subagent is live', ON, async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')
  await finish($, 'agent-1')

  const text = await drawnText($)
  expect(text).toContain('█')
  expect((await barOf($)).some(isLit)).toBe(false)
  expect(BRAILLE.test(text)).toBe(false)
})

// ------------------------------------------------------------ the setting

test('off is the pane as it was: the dot, the plain bar, no frame', OFF, async ($, on) => {
  const clock = engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')
  await clock.advance(FRAME_MS * 3)

  const text = await drawnText($)
  expect(text).toContain('●02 登入 API')
  expect(text).toContain(dotOf('●'))
  expect((await barOf($)).some(isLit)).toBe(false)
  expect(BRAILLE.test(text)).toBe(false)
})

// ------------------------------------------------------------ the accent

test('the light runs from the accent to #f3e8ff, and its brightest cell is #f3e8ff', ON, async ($, on) => {
  const clock = engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')

  const tints = new Set<string>()
  for (let t = 0; t < 2000; t += 40) {
    for (const run of await barOf($)) if (isLit(run)) tints.add(run.color)
    await clock.advance(40)
  }
  const [from, to] = [ACCENT, GLOW_PEAK].map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)))
  for (const tint of tints) {
    [1, 3, 5].forEach((i, c) => {
      const v = parseInt(tint.slice(i, i + 2), 16)
      expect(v).toBeGreaterThanOrEqual(Math.min(from![c]!, to![c]!))
      expect(v).toBeLessThanOrEqual(Math.max(from![c]!, to![c]!))
    })
  }
  expect(tints.has(GLOW_PEAK)).toBe(true)
})

test('the title, feature, lead and their frames are the accent, wide or narrow, never the theme\'s claude', ON, async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')
  await finish($, 'agent-1')

  for (const columns of [80, 24]) {
    const text = await drawnText($, columns)
    expect(text).not.toContain('"claude"')
    // title, feature, feature frame, feature bar, lead, lead frame
    expect(text.split(`"${ACCENT}"`).length - 1).toBe(6)
  }
})

test('the observing pane draws its title, lead and lead frame in the accent', OBSERVE, async ($, on) => {
  engine(on)
  await start($)
  await spawn($, '看看', '探索', 'Explore')

  const text = await drawnText($)
  expect(text).not.toContain('"claude"')
  expect(text.split(`"${ACCENT}"`).length - 1).toBe(3)
})

test('animation off, the whole bar is the accent', OFF, async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)
  await spawn($, '實作 .scratch/demo/issues/02-api.md')

  const filled = (await barOf($)).filter(run => run.text.includes('█'))
  expect(filled).toHaveLength(1)
  expect(filled[0]!.color).toBe(ACCENT)
})

test('a finished feature has its frame and bar in the done color, not the accent', ON, async ($, on) => {
  engine(on)
  const original = TICKETS['02-api.md']!
  const original3 = TICKETS['03-page.md']!
  TICKETS['02-api.md'] = original.replace('ready-for-agent', 'resolved')
  TICKETS['03-page.md'] = original3.replace('ready-for-agent', 'resolved')
  try {
    await start($)
    await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)

    const bar = (await barOf($)).filter(run => run.text.includes('█'))
    expect(bar.map(run => run.color)).toEqual([DONE])
    // title, feature, lead and its frame are still the accent
    expect((await drawnText($)).split(`"${ACCENT}"`).length - 1).toBe(4)
  } finally {
    TICKETS['02-api.md'] = original
    TICKETS['03-page.md'] = original3
  }
})

// ------------------------------------------------------------ the redraws

test('on, a live subagent has the shown pane redrawn twice per spinner frame', ON, async ($, on) => {
  const world: World = { invalidations: 0, isShown: true }
  const clock = engine(on, world)
  await start($)
  await spawn($, '看看', '探索', 'Explore')
  world.invalidations = 0

  await clock.advance(FRAME_MS * 10)
  await clock.settle()
  expect(world.invalidations).toBeGreaterThan(18)
})

test('off, a live subagent has the pane redrawn at the clock\'s old pace only', OFF, async ($, on) => {
  const world: World = { invalidations: 0, isShown: true }
  const clock = engine(on, world)
  await start($)
  await spawn($, '看看', '探索', 'Explore')
  world.invalidations = 0

  await clock.advance(2000)
  await clock.settle()
  expect(world.invalidations).toBeLessThan(3)
})

test('no frame is drawn for a pane that is not the one shown, or with nothing live', ON, async ($, on) => {
  const world: World = { invalidations: 0, isShown: false }
  const clock = engine(on, world)
  await start($)
  await spawn($, '看看', '探索', 'Explore')
  world.invalidations = 0

  // hidden behind another tab: only the two-second clock asks for a redraw
  await clock.advance(2000)
  await clock.settle()
  expect(world.invalidations).toBeLessThan(3)

  // shown again, but the subagent is done
  world.isShown = true
  await finish($, 'agent-1')
  await clock.settle()
  world.invalidations = 0
  await clock.advance(2000)
  await clock.settle()
  expect(world.invalidations).toBe(0)
})

// ------------------------------------------------------------ the done color

/** How many times a drawn tree names the color. */
const count = (text: string, color: string) => text.split(`"${color}"`).length - 1

test('a resolved ticket and a past step are drawn in the done color, never `success`', ON, async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo/spec.md' } as never)

  const text = await drawnText($)
  // step 1's label, plus ticket 01's glyph and number
  expect(count(text, DONE)).toBeGreaterThanOrEqual(2)
  expect(text).not.toContain('"success"')
})

test('a finished subagent card has its frame and dot in the done color', OBSERVE, async ($, on) => {
  engine(on)
  await start($)
  await spawn($, '看看', '探索', 'Explore')
  expect(count(await drawnText($), DONE)).toBe(0)

  await finish($, 'agent-1')
  const text = await drawnText($)
  // the frame and the dot
  expect(count(text, DONE)).toBe(2)
  expect(text).not.toContain('"success"')
})
