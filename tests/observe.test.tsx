import { expect, mock, test } from 'claude-code/testing'

const WF = { options: { workflow: 'mattpocock-skills' } }
const NONE = { options: { workflow: 'none' } }
const TRACKER = 'docs/agents/issue-tracker.md'

const PANE = {
  plugin: 'implement-swarm',
  component: 'Pane',
  requestId: 'implement-swarm',
  props: {
    title: 'Implement swarm',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const TICKETS: Record<string, string> = {
  '01-schema.md': '# 01: 新增資料表\n\n**Blocked by:** None\n\n**Status:** resolved\n\n- [x] a\n',
  '02-api.md': '# 02: 登入 API\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
}

type Hook = (...args: any[]) => unknown
type On = (event: string, hook: Hook) => unknown

type World = {
  /** The tracker file's text; `undefined` is a file that does not exist. */
  tracker?: string
  /** Every path the plugin read. */
  reads: string[]
  /** The status line, as the plugin set it. */
  statuses: (string | undefined)[]
  opens: number
}

/** The engine beneath the plugin: a clock, a tracker file, an issues folder, agents. */
function engine(on: On, world: World) {
  const clock = mock.clock(on as never, { now: 1_700_000_000_000 })
  let n = 0
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => {
    world.opens += 1
    return { value: { isPlaced: true } }
  })
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('fs.list', () => ({
    value: Object.keys(TICKETS).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    world.reads.push(e.path)
    if (e.path.endsWith(TRACKER)) {
      if (world.tracker === undefined) throw new Error('ENOENT')
      return { value: world.tracker }
    }
    return { value: TICKETS[e.path.split('/').pop() ?? ''] ?? '' }
  })
  return clock
}

const newWorld = (tracker?: string): World => ({ tracker, reads: [], statuses: [], opens: 0 })
const LOCAL = '# Issue tracker: Local Markdown\n\nIssues live in .scratch.\n'
const GITHUB = '# Issue tracker: GitHub\n\nUse gh.\n'

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const spawn = ($: any, prompt: string, description: string, subagentType: string) =>
  $.agent.spawn({ prompt, description, subagentType } as never)
const finish = ($: any, agentId: string, durationMs = 1000, reason = 'answer') =>
  $.turn.complete({ agentId, reason, isAborted: false, durationMs, answer: 'ok' } as never)
const mount = ($: any, bodyColumns = 80) => $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
const has = async (ui: any, text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
const drawnText = async (ui: any) => JSON.stringify(await ui.drawn())
const trackerReads = (w: World) => w.reads.filter(p => p.endsWith(TRACKER)).length

// ------------------------------------------------------------ the manifest

// The manifest's field (options none and mattpocock-skills, default none) is
// checked by `claude plugin validate`; here, that the engine fills the default in.
test('the setting left out is none: /implement-spec starts nothing and nothing is read', async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
  expect(world.opens).toBe(0)
  expect(world.reads).toEqual([])
})

test('a value outside the options counts as unset, so none', { options: { workflow: 'auto' } }, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'implement-spec', args: '.scratch/f/spec.md' } as never)
  expect(world.opens).toBe(0)
  expect(world.reads).toEqual([])
})

// ------------------------------------------------------------ observing

test('none: any subagent is recorded, the status line moves, the pane does not open', NONE, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, 'review the branch', '審查分支', 'code-reviewer')
  await spawn($, 'summarise', '摘要', 'general-purpose')

  expect(world.opens).toBe(0)
  expect(world.statuses.at(-1)).toBe('swarm 2 跑 · 0 完')
  expect(trackerReads(world)).toBe(0)
})

test('none: /swarm shows the lead, the cards and the log, no feature, no stage bar', NONE, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, 'review the branch', '審查分支', 'code-reviewer')
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'agent-1' } as never)
  const reply = await $.command.run({ command: 'swarm', args: '' } as never)
  expect(world.opens).toBe(1)
  expect(JSON.stringify(reply)).not.toMatch(/工作流/)

  for (const bodyColumns of [80, 24]) {
    const ui = await mount($, bodyColumns)
    expect(await has(ui, /lead/)).toBe(true)
    expect(await has(ui, /session log/)).toBe(true)
    expect(await has(ui, /feature/)).toBe(false)
    expect(await has(ui, /工作流/)).toBe(false)
    expect(await has(ui, /%/)).toBe(false)
    if (bodyColumns === 80) {
      expect(await has(ui, /審查分支 · code-reviewer/)).toBe(true)
      // the second line: what it does and how many tool calls
      expect(await has(ui, /審查 · 1 次工具/)).toBe(true)
    }
    await ui.unmount()
  }
})

test('observing lists the latest five done cards, every running and failed one, failed first', NONE, async ($, on) => {
  const world = newWorld()
  const clock = engine(on, world)
  await start($)
  for (let i = 1; i <= 9; i++) await spawn($, `job ${i}`, `工作${i}`, 'general-purpose')
  // 1..6 done in order, 7 fails, 8 and 9 keep running.
  for (let i = 1; i <= 6; i++) {
    await clock.advance(1000)
    await finish($, `agent-${i}`)
  }
  await finish($, 'agent-7', 1000, 'error')

  const ui = await mount($)
  const drawn = await drawnText(ui)
  expect(drawn).not.toContain('工作1 · general')
  for (const shown of [2, 3, 4, 5, 6, 7, 8, 9]) expect(drawn).toContain(`工作${shown} · general-purpose`)
  expect(await has(ui, /另有 1 個已完成/)).toBe(true)
  expect(drawn.lastIndexOf('工作7 ·')).toBeLessThan(drawn.lastIndexOf('工作8 ·'))
  expect(drawn.lastIndexOf('工作8 ·')).toBeLessThan(drawn.lastIndexOf('工作2 ·'))
  await ui.unmount()
})

test('none: /implement-spec and a prompt that names a ticket start nothing', NONE, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')

  expect(world.opens).toBe(0)
  expect(trackerReads(world)).toBe(0)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(false)
  expect(await has(ui, /第 2 張票 · ticket-impl/)).toBe(true)
  await ui.unmount()
})

test('none: /swarm <folder> still loads that folder as a feature', NONE, async ($, on) => {
  const world = newWorld(GITHUB)
  engine(on, world)
  await start($)
  await spawn($, 'something else', '先到的', 'general-purpose')
  await $.command.run({ command: 'swarm', args: '.scratch/f/issues' } as never)

  expect(trackerReads(world)).toBe(0)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /02 登入 API/)).toBe(true)
  // The subagent recorded before is still there, in the observing card style.
  expect(await has(ui, /先到的 · general-purpose/)).toBe(true)
  await ui.unmount()
})

test('a type or description with review, implement or merg starts nothing without a ticket in the prompt', async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, 'look at it', 'implement the thing', 'code-reviewer')
  await spawn($, 'look at it', 'merge the branch', 'merger')
  expect(world.opens).toBe(0)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(false)
  await ui.unmount()
})

test('mattpocock-skills: the same keywords without a ticket start nothing either', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, 'look at it', 'implement the thing', 'code-reviewer')
  await spawn($, 'look at it', 'review the merge', 'merger')
  expect(world.opens).toBe(0)
  expect(trackerReads(world)).toBe(0)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(false)
  expect(await has(ui, /implement the thing · code/)).toBe(true)
  await ui.unmount()
})

// ------------------------------------------------------------ the workflow

test('mattpocock-skills, local tracker: all three timings open the pane with a feature', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  expect(world.reads).toEqual([]) // nothing is read when the session starts

  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
  expect(world.opens).toBe(1)
  expect(trackerReads(world)).toBe(1)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /工作流 mattpocock-skills · 票來源 本地/)).toBe(true)
  await ui.unmount()
})

test('mattpocock-skills: a prompt that names a ticket enters the workflow and keeps earlier cards', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, 'explore', '先探索', 'Explore')
  expect(world.opens).toBe(0)
  expect(trackerReads(world)).toBe(0)

  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
  expect(world.opens).toBe(1)
  expect(trackerReads(world)).toBe(1)

  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  // the ticket card: number and title, and the stage bar
  expect(await has(ui, /02 登入 API/)).toBe(true)
  expect(await has(ui, /5%/)).toBe(true)
  // the card without a ticket is the observing card
  expect(await has(ui, /先探索 · Explore/)).toBe(true)
  await ui.unmount()
})

test('mattpocock-skills: /swarm <folder> enters the workflow, earlier cards stay', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, 'explore', '先探索', 'Explore')
  await $.command.run({ command: 'swarm', args: '.scratch/f/issues' } as never)

  expect(world.opens).toBe(1)
  expect(trackerReads(world)).toBe(1)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /先探索 · Explore/)).toBe(true)
  await ui.unmount()
})

test('mattpocock-skills: a missing tracker file reads as local', WF, async ($, on) => {
  const world = newWorld(undefined)
  engine(on, world)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'implement-spec', args: '.scratch/f/spec.md' } as never)

  expect(world.opens).toBe(1)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /票來源 本地/)).toBe(true)
  await ui.unmount()
})

test('mattpocock-skills: GitHub, GitLab or an unknown title keep observing and say why', WF, async ($, on) => {
  const world = newWorld(GITHUB)
  engine(on, world)
  await start($)

  const cases: [string, RegExp][] = [
    ['# Issue tracker: GitLab\n', /票來源 GitLab（尚未支援）/],
    ['# Something else\n', /票來源 無法辨識/],
  ]
  for (const [tracker, line] of cases) {
    world.tracker = tracker
    await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
    await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
    await $.command.run({ command: 'swarm', args: '.scratch/f/issues' } as never)
    const ui = await mount($)
    expect(await has(ui, /feature/)).toBe(false)
    expect(await has(ui, line)).toBe(true)
    // the subagent is drawn as an observing card
    expect(await has(ui, /第 2 張票 · ticket-impl/)).toBe(true)
    await ui.unmount()
  }
  expect(world.opens).toBe(2) // only the /swarm commands opened it
})

test('mattpocock-skills: /swarm before any ticket shows the source line and the reply says it', WF, async ($, on) => {
  const world = newWorld(GITHUB)
  engine(on, world)
  await start($)
  const reply = await $.command.run({ command: 'swarm', args: '' } as never)

  expect(JSON.stringify(reply)).toContain('工作流 mattpocock-skills · 票來源 GitHub')
  const ui = await mount($)
  expect(await has(ui, /工作流 mattpocock-skills · 票來源 GitHub/)).toBe(true)
  await ui.unmount()
})

test('the tracker file is read again at each load, at /swarm, and after reset', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  expect(trackerReads(world)).toBe(0)

  await $.command.run({ command: 'swarm', args: '' } as never)
  expect(trackerReads(world)).toBe(1)

  world.tracker = GITHUB
  await $.command.run({ command: 'swarm', args: '' } as never)
  expect(trackerReads(world)).toBe(2)
  let ui = await mount($)
  expect(await has(ui, /票來源 GitHub/)).toBe(true)
  await ui.unmount()

  world.tracker = LOCAL
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
  expect(trackerReads(world)).toBe(3)

  world.tracker = '# Issue tracker: GitLab\n'
  await $.command.run({ command: 'swarm', args: 'reset' } as never)
  expect(trackerReads(world)).toBe(4)
  ui = await mount($)
  expect(await has(ui, /票來源 GitLab（尚未支援）/)).toBe(true)
  expect(await has(ui, /feature/)).toBe(false)
  await ui.unmount()
})

test('mattpocock-skills: /swarm reset empties the record and returns to observing', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
  await $.command.run({ command: 'swarm', args: 'reset' } as never)
  await spawn($, 'explore', '之後的', 'Explore')

  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(false)
  expect(await has(ui, /2 張票/)).toBe(false)
  expect(await has(ui, /之後的 · Explore/)).toBe(true)
  await ui.unmount()
})

test('a start skill typed while a ticket is being worked: the card stays, tied to no ticket, and the new batch draws that ticket as waiting', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  on('command.run', () => ({ text: 'ran' }))
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
  let ui = await mount($)
  expect(await has(ui, /02 登入 API/)).toBe(true) // the ticket card
  await ui.unmount()

  await $.command.run({ command: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
  ui = await mount($)
  expect(await has(ui, /第 2 張票 · ticket-impl/)).toBe(true) // an ordinary card now
  expect(await has(ui, /(?<!○)02 登入 API/)).toBe(false) // no ticket card
  expect(await has(ui, /○02/)).toBe(true) // the ticket is ready, not in progress
  expect(await has(ui, /1 forks · 1 running/)).toBe(true) // the card still runs
  await ui.unmount()
})

test('workflow view: the merge marker still follows the lead merging a ticket', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat-ticket-02' } as never)

  const ui = await mount($)
  expect(await has(ui, /已 merge 1/)).toBe(true)
  await ui.unmount()
})

test('workflow view: the feature label and the feature name are apart', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')

  const ui = await mount($)
  expect(await has(ui, /feature f/)).toBe(true)
  await ui.unmount()
})

test('workflow view: the status line counts a merged ticket as done', WF, async ($, on) => {
  const world = newWorld(LOCAL)
  engine(on, world)
  await start($)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
  expect(world.statuses.at(-1)).toMatch(/票 1\/2/)
  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat-ticket-02' } as never)
  expect(world.statuses.at(-1)).toMatch(/票 2\/2/)
})

test('workflow view: a step whose tickets are all merged is marked past when the next step is current', WF, async ($, on) => {
  mock.clock(on as never, { now: 1_700_000_000_000 })
  const ticket = (number: string, step: number) => ({ number, slug: 's', title: `t${number}`, blockedBy: [], status: 'ready-for-agent', checked: 0, checks: 1, step })
  on('state.get', () => ({
    value: {
      value: {
        shape: 'swarm-5',
        value: {
          mode: 'workflow', agents: [], log: [],
          feature: { sourceId: 'local-markdown', origin: '.scratch/f/issues', name: 'f', merged: ['01'], loadedAt: 1_700_000_000_000, tickets: [ticket('01', 1), ticket('02', 2)] },
        },
      },
      version: 1,
    },
  }))
  const ui = await mount($)
  expect(await has(ui, /▶ step 2/)).toBe(true)
  expect(await has(ui, /✓ step 1/)).toBe(true)
  await ui.unmount()
})

// ------------------------------------------------------------ the setting changes

const STORED_WORKFLOW = {
  mode: 'workflow',
  agents: [
    {
      id: 'agent-9', type: 'ticket-implementer', description: '第 2 張票', model: 'claude-sonnet-5-5',
      ticket: '02-api', ticketNumber: '02', isBackground: false, phase: 'editing', tools: 3, errors: 0, startedAt: 1_700_000_000_000,
    },
  ],
  log: [{ at: 1_700_000_000_000, who: 'lead', text: '讀到 f：2 張票 · 2 個時間步' }],
  feature: {
    sourceId: 'local-markdown', origin: '.scratch/f/issues', name: 'f', merged: [], loadedAt: 1_700_000_000_000,
    tickets: [
      { number: '02', slug: 'api', title: '登入 API', blockedBy: [], status: 'ready-for-agent', checked: 0, checks: 1, step: 1 },
    ],
  },
}

test('none reloading a workflow session: no feature box, cards and log stay', NONE, async ($, on) => {
  mock.clock(on as never, { now: 1_700_000_000_000 })
  on('state.get', () => ({ value: { value: { shape: 'swarm-5', value: STORED_WORKFLOW }, version: 1 } }))
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(false)
  expect(await has(ui, /第 2 張票 · ticket-impl/)).toBe(true)
  expect(await has(ui, /讀到 f/)).toBe(true)
  expect(await has(ui, /%/)).toBe(false)
  await ui.unmount()
})

test('mattpocock-skills reloading the same state draws the feature box', WF, async ($, on) => {
  mock.clock(on as never, { now: 1_700_000_000_000 })
  on('state.get', () => ({ value: { value: { shape: 'swarm-5', value: STORED_WORKFLOW }, version: 1 } }))
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /02 登入 API/)).toBe(true)
  await ui.unmount()
})
