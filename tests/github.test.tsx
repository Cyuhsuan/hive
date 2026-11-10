import { expect, mock, test } from 'claude-code/testing'

// The pane with GitHub as the ticket source. `$.process.run` is answered by a
// fake `gh`: no network and no real `gh`. The replies have the shape
// `gh api repos/<owner>/<repo>/issues/<n>[/sub_issues|/dependencies/blocked_by]`
// returns (read from this repo's own issues).

const WF = { options: { workflow: 'mattpocock-skills' } }
const TRACKER = 'docs/agents/issue-tracker.md'
const GITHUB = '# Issue tracker: GitHub\n\nUse gh.\n'
const LOCAL = '# Issue tracker: Local Markdown\n'

const PANE = {
  plugin: 'hive',
  component: 'Pane',
  requestId: 'hive',
  props: {
    title: 'Hive',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

type Failure = { exitCode: number; stderr: string } | Error

type World = {
  tracker: string
  opens: number
  /** Every endpoint `gh` was asked for. */
  gh: string[]
  /** Set to make every `gh` call fail. */
  failure?: Failure
  /** Set to make the calls whose endpoint matches fail, the others answer. */
  failOn?: RegExp
  /** How many times the tracker file was read. */
  trackerReads: number
  statuses: (string | undefined)[]
  sub: unknown[]
  all: unknown[]
  /** Closed ticket numbers. */
  closed: Set<number>
  /** Issue numbers GitHub answers 404 for. */
  missing: Set<number>
  /** Issue numbers that are pull requests. */
  pulls: Set<number>
  /** Set to make every tool call fail or be denied. */
  toolOutcome?: 'error' | 'deny'
  /** Set to make the first `gh` call whose endpoint matches wait for `until`; the others are answered at once. */
  hold?: { endpoint: RegExp; until: Promise<void>; isTaken?: boolean }
}

const issue = (number: number, title: string, body = '', extra: object = {}) => ({ number, title, body, state: 'open', ...extra })

function newWorld(): World {
  return {
    tracker: GITHUB,
    trackerReads: 0,
    opens: 0,
    gh: [],
    statuses: [],
    closed: new Set([11]),
    missing: new Set(),
    pulls: new Set(),
    sub: [
      issue(11, 'Schema', '- [x] a\n- [x] b'),
      issue(12, 'API', '- [x] a\n- [ ] b'),
      issue(13, 'Page', '## Blocked by\n\n- #11\n- #12\n\n- [ ] a'),
    ],
    all: [],
  }
}

const PARENTS: Record<number, number> = { 11: 10, 12: 10, 13: 10, 14: 10, 21: 20 }

function gh(world: World, argv: readonly string[]) {
  if (world.failure) {
    if (world.failure instanceof Error) return { deny: world.failure.message }
    return { exitCode: world.failure.exitCode, stdout: '', stderr: world.failure.stderr, isStdoutTruncated: false, isStderrTruncated: false }
  }
  const endpoint = (argv.find(a => a.startsWith('repos/')) ?? '').replace('repos/{owner}/{repo}/', '')
  world.gh.push(endpoint)
  const ok = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify(argv.includes('--slurp') ? [data] : data), stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  if (world.failOn?.test(endpoint)) return { exitCode: 1, stdout: '', stderr: 'gh: HTTP 500 Server Error', isStdoutTruncated: false, isStderrTruncated: false }
  const state = (i: { number: number }) => ({ ...i, state: world.closed.has(i.number) ? 'closed' : 'open' })
  if (endpoint === 'issues/10') return ok(issue(10, 'Login feature'))
  if (endpoint.startsWith('issues/10/sub_issues')) return ok(world.sub.map(i => state(i as { number: number })))
  // a second spec, with one ticket
  if (endpoint === 'issues/20') return ok(issue(20, 'Billing feature'))
  if (endpoint.startsWith('issues/20/sub_issues')) return ok([issue(21, 'Invoice')])
  if (endpoint.startsWith('issues?')) return ok(world.all)
  // issues with no sub-issues (the standalone ones) answer an empty list
  if (/^issues\/\d+\/sub_issues/.test(endpoint)) return ok([])
  const blocked = endpoint.match(/^issues\/(\d+)\/dependencies\/blocked_by$/)
  if (blocked) return ok(blocked[1] === '12' ? [{ number: 11 }] : blocked[1] === '31' ? [{ number: 30 }] : [])
  // the parent endpoint: the parent issue, or a 404 when there is none
  const parentOf = endpoint.match(/^issues\/(\d+)\/parent$/)
  if (parentOf) {
    const parent = PARENTS[Number(parentOf[1])]
    if (parent === undefined) return { exitCode: 1, stdout: '', stderr: 'gh: No parent issue found (HTTP 404)', isStdoutTruncated: false, isStderrTruncated: false }
    return ok(issue(parent, 'Login feature'))
  }
  const one = endpoint.match(/^issues\/(\d+)$/)
  if (one && world.missing.has(Number(one[1]))) return { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)', isStdoutTruncated: false, isStderrTruncated: false }
  if (one) {
    const n = Number(one[1])
    return ok(state(issue(n, `Issue ${n}`, '', world.pulls.has(n) ? { pull_request: {} } : {})))
  }
  return { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)', isStdoutTruncated: false, isStderrTruncated: false }
}

function engine(on: (event: string, hook: (...args: any[]) => unknown) => unknown, world: World) {
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
  on('tool.call', () => (world.toolOutcome === 'deny' ? { deny: 'no' } : world.toolOutcome === 'error' ? { result: {}, isError: true } : { result: {} }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('command.run', () => ({ text: 'ran' }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith(TRACKER)) {
      world.trackerReads += 1
      return { value: world.tracker }
    }
    throw new Error('ENOENT')
  })
  on('process.run', async (_: unknown, e: { argv: string[] }) => {
    const endpoint = (e.argv.find(a => a.startsWith('repos/')) ?? '').replace('repos/{owner}/{repo}/', '')
    const hold = world.hold
    if (hold && !hold.isTaken && hold.endpoint.test(endpoint)) {
      hold.isTaken = true
      await hold.until
    }
    const r = gh(world, e.argv)
    return 'deny' in r ? r : { value: r }
  })
  return clock
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const spawn = ($: any, prompt: string, description = 'work', subagentType = 'ticket-implementer') =>
  $.agent.spawn({ prompt, description, subagentType } as never)
const mount = ($: any) => $.ui.mount({ ...PANE, surface: 'terminal' })
const has = async (ui: any, text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
const skill = ($: any, args: string) => $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args } as never)
const swarm = ($: any, args: string) => $.command.run({ command: 'swarm', args } as never)

// ------------------------------------------------------------ loading

test('github: /implement-spec with a spec issue number opens the pane with its sub-issues', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  expect(world.opens).toBe(1)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /Login feature/)).toBe(true)
  expect(await has(ui, /票來源 GitHub$/)).toBe(true)
  // 11 is closed (resolved), 12 and 13 follow it in later steps
  expect(await has(ui, /✓11/)).toBe(true)
  expect(await has(ui, /12 API 1\/2/)).toBe(true)
  await ui.unmount()
})

const SPEC_URL = 'https://github.com/Cyuhsuan/hive/issues/10'
for (const [how, args] of [
  ['skill', '10'],
  ['skill', SPEC_URL],
  ['swarm', '#10'],
  ['swarm', SPEC_URL],
] as const) {
  test(`github: /${how === 'skill' ? 'implement-spec' : 'swarm'} ${args} loads the feature`, WF, async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await start($)
    await (how === 'skill' ? skill($, args) : swarm($, args))
    const ui = await mount($)
    expect(await has(ui, /Login feature/)).toBe(true)
    expect(await has(ui, /12 API/)).toBe(true)
    await ui.unmount()
  })
}

test('github: no sub-issues, so the issues that say Part of #N are the tickets', WF, async ($, on) => {
  const world = newWorld()
  world.sub = []
  world.all = [issue(21, 'Alpha', 'Part of #10'), issue(22, 'Beta', '## Parent\n\n#10'), issue(23, 'Elsewhere', 'Part of #3')]
  engine(on, world)
  await start($)
  await swarm($, '#10')
  const ui = await mount($)
  expect(await has(ui, /Alpha/)).toBe(true)
  expect(await has(ui, /Beta/)).toBe(true)
  expect(await has(ui, /Elsewhere/)).toBe(false)
  await ui.unmount()
})

test('github: closed counts whole, an open ticket by its ticks (1 + 1/2 + 0 of 3 is 50%)', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  const ui = await mount($)
  expect(await has(ui, /50%/)).toBe(true)
  expect(await has(ui, /1\/3/)).toBe(true)
  await ui.unmount()
})

test('github: opening the pane and starting a session do not call gh', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  const reply = await swarm($, '')
  expect(world.gh).toEqual([])
  expect(JSON.stringify(reply)).toContain('票來源 GitHub')
  expect(JSON.stringify(reply)).not.toContain('（')
  const ui = await mount($)
  expect(await has(ui, /票來源 GitHub$/)).toBe(true)
  await ui.unmount()
})

// ------------------------------------------------------------ prompts

test('github: no feature yet, a prompt with a ticket URL loads the batch from its parent', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, '實作 https://github.com/Cyuhsuan/hive/issues/12 ，整合分支 feat/x', '第 12 張')
  expect(world.opens).toBe(1)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /12 API/)).toBe(true)
  await ui.unmount()
})

test('github: no feature yet, an issue that does not exist loads nothing', WF, async ($, on) => {
  const world = newWorld()
  world.missing.add(99)
  engine(on, world)
  await start($)
  await spawn($, 'fix #99 please', '修 99')
  expect(world.opens).toBe(0)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(false)
  await ui.unmount()
})

test('github: no feature yet, a prompt with no issue in it does not call gh', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, 'summarise the repo', '摘要', 'Explore')
  expect(world.gh).toEqual([])
})

test('github: a loaded batch: a number of the batch is a ticket card, another number is an observing card', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  await spawn($, '看一下 PR #77 的結果', '看 PR')
  const ui = await mount($)
  expect(await has(ui, /第 12 張 · ticket-impl/)).toBe(false) // a workflow card shows number and title, not the description
  expect(await has(ui, /看 PR · ticket-impl/)).toBe(true) // the observing card
  expect(await has(ui, /77 /)).toBe(false)
  await ui.unmount()
})

// ------------------------------------------------------------ merge

test('github: the lead merging a branch with the ticket number marks the ticket, others do not', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat-ticket-99' } as never)
  let ui = await mount($)
  expect(await has(ui, /◆/)).toBe(false)
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat-ticket-12' } as never)
  ui = await mount($)
  expect(await has(ui, /◆12/)).toBe(true)
  expect(await has(ui, /已 merge 1/)).toBe(true)
  await ui.unmount()
})

// ------------------------------------------------------------ re-reading

const ISSUE_COMMANDS = ['gh issue close 12', 'gh issue reopen 12 --comment back', 'gh issue edit 12 --add-label x', 'cd x && gh   issue close 12']
const readsOf = (world: World) => world.gh.filter(e => e === 'issues/10').length

for (const command of ISSUE_COMMANDS) {
  test(`github: the lead's \`${command}\` reads the batch again once it succeeds`, WF, async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await start($)
    await skill($, '#10')
    const base = readsOf(world)
    world.closed.add(12)
    await $.tool.call({ tool: 'Bash', command } as never)
    expect(readsOf(world)).toBe(base + 1)
    const ui = await mount($)
    expect(await has(ui, /✓12/)).toBe(true)
    await ui.unmount()
  })
}

test('github: other gh commands, and a failed or denied issue command, do not read again', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  const base = readsOf(world)
  for (const command of ['gh issue view 12', 'gh issue comment 12 -b x', 'gh pr list']) await $.tool.call({ tool: 'Bash', command } as never)
  expect(readsOf(world)).toBe(base)
  world.toolOutcome = 'error'
  await $.tool.call({ tool: 'Bash', command: 'gh issue close 12' } as never)
  expect(readsOf(world)).toBe(base)
  world.toolOutcome = 'deny'
  await $.tool.call({ tool: 'Bash', command: 'gh issue close 12' } as never)
  expect(readsOf(world)).toBe(base)
})

test('github: a subagent running an issue command does not read again', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  const base = readsOf(world)
  await $.tool.call({ tool: 'Bash', command: 'gh issue close 12', agentId: 'agent-1' } as never)
  expect(readsOf(world)).toBe(base)
})

test('github: a subagent finishing reads the tickets again, and a closed issue becomes resolved', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  world.closed.add(12)
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', isAborted: false, durationMs: 1000, answer: 'ok' } as never)
  const ui = await mount($)
  expect(await has(ui, /✓12/)).toBe(true)
  await ui.unmount()
})

test('github: while a subagent runs the tickets are read every 30 seconds', WF, async ($, on) => {
  const world = newWorld()
  const clock = engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  const reads = () => world.gh.filter(e => e === 'issues/10').length
  const base = reads()
  await clock.advance(20_000)
  expect(reads()).toBe(base)
  await clock.advance(12_000)
  expect(reads()).toBe(base + 1)
})

// ------------------------------------------------------------ failing

const FAILURES: [string, Failure, RegExp][] = [
  ['missing', new Error('spawn gh ENOENT'), /票來源 GitHub（`gh` 不存在）/],
  ['logged out', { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, /票來源 GitHub（`gh` 未登入）/],
  ['failing', { exitCode: 1, stderr: 'gh: HTTP 500 Server Error' }, /票來源 GitHub（`gh` 呼叫失敗/],
]
for (const [name, failure, line] of FAILURES) {
  test(`github: gh ${name}: no feature box, one line says why, nothing throws`, WF, async ($, on) => {
    const world = newWorld()
    world.failure = failure
    engine(on, world)
    await start($)
    await skill($, '#10')
    await swarm($, '#10')
    const ui = await mount($)
    expect(await has(ui, /feature/)).toBe(false)
    expect(await has(ui, line)).toBe(true)
    expect(await has(ui, /session log/)).toBe(true)
    // the screen is the observing one: the status line is all that is added
    expect(await has(ui, /派票 → merge → review/)).toBe(false)
    await ui.unmount()
  })
}

test('github: a spawn whose batch fails to load is an observing card, not a ticket card', WF, async ($, on) => {
  const world = newWorld()
  world.failOn = /^issues\/10(\?|$|\/sub_issues)/
  engine(on, world)
  await start($)
  await spawn($, '實作 #12', '第 12 張')
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(false)
  expect(await has(ui, /票來源 GitHub（`gh` 呼叫失敗/)).toBe(true)
  await ui.unmount()
})

test('github: a bare /swarm reads a loaded batch again, and calls gh for nothing when none is loaded', WF, async ($, on) => {
  const world = newWorld()
  world.failure = { exitCode: 1, stderr: 'gh: HTTP 500 Server Error' }
  engine(on, world)
  await start($)
  await swarm($, '#10') // fails: remembered for the scheduled re-read
  world.failure = undefined
  await swarm($, '')
  expect(world.gh).toEqual([])
  await swarm($, '#10') // loads
  world.gh.length = 0
  await swarm($, '')
  expect(world.gh.filter(e => e === 'issues/10')).toHaveLength(1)
})

for (const failOn of [/sub_issues/, /blocked_by/, /^issues\/10$/]) {
  test(`github: ${failOn} failing in a re-read fails the whole re-read: the loaded tickets stay`, WF, async ($, on) => {
    const world = newWorld()
    world.sub = []
    world.all = [issue(21, 'Alpha', 'Part of #10')]
    engine(on, world)
    await start($)
    await skill($, '#10')
    await spawn($, '實作 #21', '第 21 張')
    world.failOn = failOn
    world.sub = [issue(31, 'Intruder')]
    await $.turn.complete({ agentId: 'agent-1', reason: 'answer', isAborted: false, durationMs: 1000, answer: 'ok' } as never)
    const ui = await mount($)
    expect(await has(ui, /Alpha/)).toBe(true)
    expect(await has(ui, /Intruder/)).toBe(false)
    expect(await has(ui, /票來源 GitHub（/)).toBe(true)
    await ui.unmount()
  })
}

test('github: a failed spawn lookup is not tried again at once, and says why', WF, async ($, on) => {
  const world = newWorld()
  world.failure = { exitCode: 4, stderr: 'run gh auth login' }
  const clock = engine(on, world)
  await start($)
  await spawn($, '實作 #12', '第 12 張')
  const ui = await mount($)
  expect(await has(ui, /票來源 GitHub（`gh` 未登入）/)).toBe(true)
  await ui.unmount()

  // a second spawn within the pause does not ask again; after it, it does
  world.failure = undefined
  await spawn($, '實作 #12', '第 12 張')
  expect(world.gh).toEqual([])
  await clock.advance(11_000)
  await spawn($, '實作 #12', '第 12 張')
  expect(world.gh.length).toBeGreaterThan(0)
})

test('github: a failed re-read keeps the tickets read before, and the next one recovers', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')

  world.failure = { exitCode: 1, stderr: 'dial tcp: lookup api.github.com: no such host' }
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', isAborted: false, durationMs: 1000, answer: 'ok' } as never)
  let ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /12 API/)).toBe(true)
  expect(await has(ui, /票來源 GitHub（`gh` 連不上 GitHub）/)).toBe(true)
  await ui.unmount()

  world.failure = undefined
  world.closed.add(12)
  await $.tool.call({ tool: 'Bash', command: 'git merge feat-ticket-12' } as never)
  ui = await mount($)
  expect(await has(ui, /票來源 GitHub$/)).toBe(true)
  expect(await has(ui, /◆12/)).toBe(true)
  await ui.unmount()
})

test('github: a load that failed is tried again by the scheduled re-read', WF, async ($, on) => {
  const world = newWorld()
  world.failure = { exitCode: 4, stderr: 'run gh auth login' }
  const clock = engine(on, world)
  await start($)
  await swarm($, '#10')
  await spawn($, 'summarise the repo', '摘要', 'Explore')
  world.failure = undefined
  await clock.advance(32_000)
  const ui = await mount($)
  expect(await has(ui, /feature/)).toBe(true)
  expect(await has(ui, /票來源 GitHub$/)).toBe(true)
  await ui.unmount()
})

// ------------------------------------------------------------ the other trackers

test('an empty tracker file is not a local one: only observing, and the status line says why', WF, async ($, on) => {
  const world = newWorld()
  world.tracker = '\n'
  engine(on, world)
  await start($)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票')
  const ui = await mount($)
  expect(await has(ui, /票來源 無法辨識/)).toBe(true)
  expect(await has(ui, /feature/)).toBe(false)
  await ui.unmount()
})

test('local markdown tracker: a prompt with only #N does not read the tracker file again and again', WF, async ($, on) => {
  const world = newWorld()
  world.tracker = LOCAL
  engine(on, world)
  await start($)
  await spawn($, '看 #12', '看')
  await spawn($, '看 #13', '看')
  await spawn($, '看 #14', '看')
  expect(world.trackerReads).toBeLessThanOrEqual(1)
  expect(world.gh).toEqual([])
})

test('local markdown tracker: nothing calls gh', WF, async ($, on) => {
  const world = newWorld()
  world.tracker = LOCAL
  engine(on, world)
  await start($)
  await spawn($, '實作 #12 見 .scratch/f/issues/02-api.md', '第 2 張')
  await swarm($, '')
  expect(world.gh).toEqual([])
})

// ------------------------------------------------------------ starting over

const typed = ($: any, args: string) => $.command.run({ command: 'mattpocock-skills:implement-spec', args } as never)
const finishAgent = ($: any, agentId: string, reason = 'answer') =>
  $.turn.complete({ agentId, reason, isAborted: false, durationMs: 1000, answer: 'ok' } as never)

test('github: the person typing the start skill resets like the lead calling it, and loads the spec', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #11', '第 11 張')
  await finishAgent($, 'agent-1')
  world.closed.add(12)
  const ran = await typed($, '#10')
  expect(JSON.stringify(ran)).toContain('ran') // the command itself still runs

  const ui = await mount($)
  expect(await has(ui, /11 Schema/)).toBe(false) // the finished card is gone
  expect(await has(ui, /Login feature/)).toBe(true) // the feature is loaded again
  expect(await has(ui, /開始，等待派票/)).toBe(true)
  expect(await has(ui, /派出 ticket/)).toBe(false) // the log only has the start line
  await ui.unmount()
})

test('github: typed and Skill-tool starts leave the same panel', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  const panel = async (begin: () => Promise<unknown>) => {
    await spawn($, '實作 #12', '第 12 張')
    await finishAgent($, `agent-${++round}`)
    await begin()
    const ui = await mount($)
    const drawn = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return drawn
  }
  let round = 0
  const a = await panel(() => typed($, '#10'))
  const b = await panel(() => skill($, '#10'))
  expect(a).toContain('Login feature')
  expect(a).toBe(b)
})

test('a command that is not a start skill does not reset', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  await $.command.run({ command: 'compact', args: '' } as never)
  await $.command.run({ command: 'hive', args: '#10' } as never)
  const ui = await mount($)
  expect(await has(ui, /12 API/)).toBe(true)
  expect(await has(ui, /派出 ticket/)).toBe(true)
  await ui.unmount()
})

test('the start skill typed again for the same spec resets again', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  await finishAgent($, 'agent-1')
  await typed($, '#10')
  const ui = await mount($)
  expect(await has(ui, /派出 ticket/)).toBe(false)
  expect(await has(ui, /讀到 Login feature/)).toBe(true)
  await ui.unmount()
})

test('a card still running survives the reset, loses its ticket, and keeps updating', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  await typed($, '#10')

  let ui = await mount($)
  // no longer a ticket card: the observing card shows its description
  expect(await has(ui, /第 12 張 · ticket-impl/)).toBe(true)
  await ui.unmount()

  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' } as never)
  await finishAgent($, 'agent-1')
  ui = await mount($)
  expect(await has(ui, /1 次工具/)).toBe(true) // the call after the reset still updated the card
  expect(await has(ui, /完成/)).toBe(true)
  await ui.unmount()
})

test('with no usable ticket source a typed start skill resets nothing', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await spawn($, '實作 #12', '第 12 張')
  world.tracker = '# Issue tracker: GitLab\n'
  await typed($, '#10')
  world.tracker = GITHUB
  const ui = await mount($)
  expect(await has(ui, /派出 ticket/)).toBe(true)
  await ui.unmount()
})

// ------------------------------------------------------------ the next feature

const NEXT_PROMPT = '實作 #21 發票'

const lastStatus = (world: World) => world.statuses.at(-1) ?? ''

/** A card done (agent-1), one failed (agent-2) and one still running (agent-3) on the spec feature; the next spawn is agent-4. */
async function endedAndRunning($: any) {
  await spawn($, '實作 #12', '第 12 張')
  await finishAgent($, 'agent-1')
  await spawn($, '實作 #11', '第 11 張')
  await finishAgent($, 'agent-2', 'error')
  await spawn($, '實作 #13', '第 13 張')
}
const ENDED = /swarm \d+ 跑 · 1 完 · 1 敗/
const NO_ENDED = /swarm \d+ 跑 · 0 完(?! · \d+ 敗)/

test('github: the feature all done, a prompt pointing at another spec swaps the tickets, drops ended cards and keeps the log', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 12, 13])
  engine(on, world)
  await start($)
  await skill($, '#10')
  await endedAndRunning($)
  expect(lastStatus(world)).toMatch(ENDED)
  await spawn($, NEXT_PROMPT, '第 21 張')

  expect(world.gh).toContain('issues/21/parent')
  const ui = await mount($)
  expect(await has(ui, /Billing feature/)).toBe(true)
  expect(await has(ui, /12 API/)).toBe(false) // the old tickets are gone
  expect(await has(ui, /21 Invoice/)).toBe(true) // the triggering agent points at its ticket in the new feature
  expect(lastStatus(world)).toMatch(NO_ENDED) // the ended cards are gone; the running one and the new one stay
  expect(await has(ui, /派出 ticket/)).toBe(true) // the log stays
  await ui.unmount()
})

test('github: the card still running at the swap keeps being updated by its tool calls', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 12, 13])
  engine(on, world)
  await start($)
  await skill($, '#10')
  await endedAndRunning($)
  await spawn($, NEXT_PROMPT, '第 21 張')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'agent-3' } as never)
  await finishAgent($, 'agent-3')
  const ui = await mount($)
  expect(await has(ui, /1 次工具/)).toBe(true)
  expect(lastStatus(world)).toMatch(/swarm 1 跑 · 1 完(?! · \d+ 敗)/)
  await ui.unmount()
})

test('github: no feature loaded yet, loading the first one keeps the ended cards', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, 'explore', '先探索', 'Explore')
  await finishAgent($, 'agent-1')
  await spawn($, '實作 #12', '第 12 張') // loads spec 10 for the first time
  expect(lastStatus(world)).toMatch(/swarm 1 跑 · 1 完/)
})

test('github: the start skill waiting for tickets, loading the first feature keeps the ended cards', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '') // the workflow screen is up with no feature on it
  await spawn($, 'explore', '先探索', 'Explore')
  await finishAgent($, 'agent-1')
  await spawn($, '實作 #12', '第 12 張') // loads spec 10 for the first time
  expect(lastStatus(world)).toMatch(/swarm 1 跑 · 1 完/)
})

test('github: a load that fails leaves the ended cards', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 12, 13])
  engine(on, world)
  await start($)
  await skill($, '#10')
  await endedAndRunning($)
  world.failure = { exitCode: 1, stderr: 'boom' }
  await spawn($, NEXT_PROMPT, '第 21 張')
  expect(lastStatus(world)).toMatch(ENDED)
})

test('github: re-reading the same spec, or the spec gaining a ticket, keeps the ended cards', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 12, 13])
  engine(on, world)
  await start($)
  await skill($, '#10')
  await endedAndRunning($)
  await finishAgent($, 'agent-3') // the tickets are read again
  await swarm($, '') // and again
  world.sub.push(issue(14, 'Report', '- [ ] a'))
  await spawn($, '實作 #14 報表', '第 14 張')
  expect(lastStatus(world)).toMatch(/swarm 1 跑 · 2 完 · 1 敗/)
  const ui = await mount($)
  expect(await has(ui, /14 Report/)).toBe(true)
  await ui.unmount()
})

test('github: /swarm naming another spec drops the ended cards and keeps the log', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  await endedAndRunning($)
  await swarm($, '#21')
  const ui = await mount($)
  expect(await has(ui, /Billing feature/)).toBe(true)
  expect(lastStatus(world)).toMatch(NO_ENDED)
  expect(await has(ui, /派出 ticket/)).toBe(true)
  await ui.unmount()
})

test('github: a feature with tickets left is not left for another spec, and gh is not asked', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  const before = world.gh.length
  await spawn($, NEXT_PROMPT, '第 21 張')
  expect(world.gh.slice(before)).toEqual([])
  const ui = await mount($)
  expect(await has(ui, /Login feature/)).toBe(true)
  expect(await has(ui, /Billing feature/)).toBe(false)
  await ui.unmount()
})

test('github: the feature all done, a ticket added to the same spec since is read in and its card points at it', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 12, 13])
  engine(on, world)
  await start($)
  await skill($, '#10')
  world.sub.push(issue(14, 'Report', '- [ ] a'))
  await spawn($, '實作 #14 報表', '第 14 張')
  expect(world.gh).toContain('issues/14/parent')
  const ui = await mount($)
  expect(await has(ui, /Login feature/)).toBe(true)
  expect(await has(ui, /14 Report/)).toBe(true) // the new ticket is on the panel
  expect(await has(ui, /第 14 張 · ticket-impl/)).toBe(false) // and the card points at it
  await ui.unmount()
})

// ------------------------------------------------------------ standalone tickets

// 30, 31 and 32 have no parent and no sub-issues; 31 is blocked by 30. 21 belongs to spec 20.
// A ticket is a glyph and its number (`·31`); only the step under way also has its title.
const ROW30 = /^\S30( |$)/
const feature = async (ui: any) => ({
  isStandalone: await has(ui, /獨立票/),
  has30: await has(ui, ROW30),
  has31: await has(ui, /^\S31( |$)/),
  has32: await has(ui, /^\S32( |$)/),
})

for (const [how, run] of [
  ['the start skill', ($: any) => skill($, '#30')],
  ['/swarm', ($: any) => swarm($, '#30')],
] as const) {
  test(`github standalone: ${how} naming an issue with no parent and no sub-issues draws the 獨立票 feature`, WF, async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await start($)
    await run($)
    const ui = await mount($)
    expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: false, has32: false })
    expect(await has(ui, /Login feature/)).toBe(false)
    await ui.unmount()
  })
}

test('github standalone: two standalone issues named are one feature', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30 and https://github.com/o/r/issues/31')
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: true, has32: false })
  expect(await has(ui, /0\/2/)).toBe(true)
  await ui.unmount()
})

test('github standalone: naming a ticket of a spec loads that spec, titled by the spec', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await swarm($, '#12')
  const ui = await mount($)
  expect(await has(ui, /Login feature/)).toBe(true)
  expect(await has(ui, /12 API/)).toBe(true)
  expect(await has(ui, /獨立票/)).toBe(false)
  await ui.unmount()
})

test('github standalone: naming a spec and standalone issues loads the first spec, the standalone ones are not in it', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30 #10 #20 #31')
  const ui = await mount($)
  expect(await has(ui, /Login feature/)).toBe(true)
  expect(await has(ui, ROW30)).toBe(false)
  expect(await has(ui, /Billing feature/)).toBe(false)
  await ui.unmount()
})

test('github standalone: issues that do not exist or are pull requests are left out; none left says so and draws nothing', WF, async ($, on) => {
  const world = newWorld()
  world.missing = new Set([98])
  world.pulls = new Set([97])
  engine(on, world)
  await start($)
  await swarm($, '#98 #30 #97')
  let ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: false, has32: false })
  await ui.unmount()

  await swarm($, 'reset')
  await swarm($, '#98 #97')
  ui = await mount($)
  expect(await has(ui, /獨立票/)).toBe(false)
  expect(await has(ui, /讀不到/)).toBe(true)
  await ui.unmount()
})

test('github standalone: a failing gh draws no half feature and the status line says why', WF, async ($, on) => {
  const world = newWorld()
  world.failOn = /^issues\/31$/
  engine(on, world)
  await start($)
  await skill($, '#30 #31')
  const ui = await mount($)
  expect(await has(ui, ROW30)).toBe(false)
  expect(await has(ui, /票來源 GitHub（`gh` 呼叫失敗/)).toBe(true)
  await ui.unmount()
})

test('github standalone: with no feature, a prompt naming an open standalone issue loads it and the card points at it', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, '實作 #30', '第 30 張')
  expect(world.opens).toBe(1)
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: false, has32: false })
  expect(await has(ui, /第 30 張 · ticket-impl/)).toBe(false) // a ticket card, not an observing card
  expect(world.statuses.at(-1)).toMatch(/1 跑 · 0 完 · 票 0\/1/)
  await ui.unmount()
})

test('github standalone: a prompt naming a closed issue or a pull request with no parent is not a standalone ticket', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 30])
  world.pulls = new Set([31])
  engine(on, world)
  await start($)
  await spawn($, '看 #30', '看 30')
  await spawn($, '看 #31', '看 31')
  expect(world.opens).toBe(0)
  const ui = await mount($)
  expect(await has(ui, /獨立票/)).toBe(false)
  await ui.unmount()
})

test('github standalone: a standalone feature not done takes another standalone ticket, cards and log stay', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, '實作 #30', '第 30 張')
  await spawn($, '實作 #31', '第 31 張')
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: true, has32: false })
  expect(world.statuses.at(-1)).toMatch(/2 跑 · 0 完 · 票 0\/2/) // both cards stay, both pointing at tickets
  expect(await has(ui, /第 3[01] 張 · ticket-impl/)).toBe(false)
  expect(await has(ui, /派出 ticket/)).toBe(true)
  await ui.unmount()
})

test('github standalone: a feature all done takes a new standalone ticket and is no longer done', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 30])
  engine(on, world)
  await start($)
  await skill($, '#30')
  await spawn($, '實作 #32', '第 32 張')
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: false, has32: true })
  expect(world.statuses.at(-1)).toMatch(/票 1\/2/)
  await ui.unmount()
})

test('github standalone: a standalone feature not done does not change for a spec ticket; all done it swaps to that spec', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30')
  await spawn($, NEXT_PROMPT, '第 21 張')
  let ui = await mount($)
  expect(await has(ui, /Billing feature/)).toBe(false)
  expect(await has(ui, ROW30)).toBe(true)
  await ui.unmount()

  world.closed.add(30)
  await finishAgent($, 'agent-1') // the tickets are read again
  await spawn($, NEXT_PROMPT, '第 21 張，再一次')
  ui = await mount($)
  expect(await has(ui, /Billing feature/)).toBe(true)
  expect(await has(ui, ROW30)).toBe(false)
  expect(await has(ui, /派出 ticket/)).toBe(true) // the log stays
  expect(lastStatus(world)).toMatch(NO_ENDED) // the card that ended (agent-1) is gone, the new one stays
  await ui.unmount()
})

test('github standalone: a spec feature not done is not asked about a standalone ticket; all done it swaps to the standalone feature', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#10')
  const before = world.gh.length
  await spawn($, '實作 #30', '第 30 張')
  expect(world.gh.slice(before)).toEqual([])
  let ui = await mount($)
  expect(await has(ui, /Login feature/)).toBe(true)
  await ui.unmount()

  world.closed = new Set([11, 12, 13])
  await finishAgent($, 'agent-1') // the tickets are read again
  await spawn($, '實作 #30', '第 30 張，再一次')
  ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: false, has32: false })
  expect(await has(ui, /12 API/)).toBe(false)
  await ui.unmount()
})

test('github standalone: a closed standalone ticket and a merged branch update the feature like a spec feature', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30 #31')
  await spawn($, '實作 #30', '第 30 張')
  world.closed.add(30)
  await finishAgent($, 'agent-1')
  let ui = await mount($)
  expect(world.statuses.at(-1)).toMatch(/票 1\/2/)
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff ticket-31' } as never)
  ui = await mount($)
  expect(world.statuses.at(-1)).toMatch(/票 2\/2/)
  await ui.unmount()
})

test('github standalone: a reset leaves no standalone feature, the next one starts fresh', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, '實作 #30', '第 30 張')
  await swarm($, 'reset')
  await spawn($, '實作 #31', '第 31 張')
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: false, has31: true, has32: false })
  await ui.unmount()
})

test('github standalone: two spawns at once naming different standalone tickets leave both in the feature', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30')
  await Promise.all([spawn($, '實作 #31', '第 31 張'), spawn($, '實作 #32', '第 32 張')])
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: true, has32: true })
  await ui.unmount()
})

test('github standalone: a re-read that started before a spawn added a ticket does not take it out of the feature', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30')
  await spawn($, '實作 #30', '第 30 張')
  let release!: () => void
  world.hold = { endpoint: /^issues\/30\/dependencies/, until: new Promise<void>(r => (release = r)) }
  const reread = finishAgent($, 'agent-1') // the tickets are read again, and that read waits
  await spawn($, '實作 #31', '第 31 張')
  release()
  await reread
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: true, has32: false })
  await ui.unmount()
})

test('github standalone: /swarm naming a standalone issue joins the standalone feature; merged, cards and log stay', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30')
  await spawn($, '實作 #30', '第 30 張')
  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff ticket-30' } as never)
  await swarm($, '#31')
  const ui = await mount($)
  expect(await feature(ui)).toEqual({ isStandalone: true, has30: true, has31: true, has32: false })
  expect(world.statuses.at(-1)).toMatch(/1 跑 · 0 完 · 票 1\/2/) // 30 is still merged, the card stays
  expect(await has(ui, /派出 ticket/)).toBe(true)
  expect(await has(ui, /讀到 獨立票/)).toBe(true)
  await ui.unmount()
})

test('github standalone: /swarm naming a spec while standalone tickets are loaded loads that spec', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await skill($, '#30')
  await swarm($, '#10')
  const ui = await mount($)
  expect(await has(ui, /Login feature/)).toBe(true)
  expect(await has(ui, ROW30)).toBe(false)
  await ui.unmount()
})

test('github standalone: a spec feature all done swapping to the standalone feature, and back, drops the ended cards', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 12, 13])
  engine(on, world)
  await start($)
  await skill($, '#10')
  await endedAndRunning($)
  await spawn($, '實作 #30', '第 30 張') // agent-4: swaps to the standalone feature
  expect(lastStatus(world)).toMatch(NO_ENDED)

  world.closed.add(30)
  await finishAgent($, 'agent-3')
  await finishAgent($, 'agent-4') // the tickets are read again: the standalone feature is all done
  await spawn($, NEXT_PROMPT, '第 21 張') // agent-5: swaps to spec 20
  expect(lastStatus(world)).toMatch(NO_ENDED)
  const ui = await mount($)
  expect(await has(ui, /Billing feature/)).toBe(true)
  expect(await has(ui, /派出 ticket/)).toBe(true) // the log stays
  await ui.unmount()
})

test('github standalone: another standalone ticket joining the feature, by prompt or /swarm #N, keeps the ended cards', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, '實作 #30', '第 30 張')
  await finishAgent($, 'agent-1')
  await spawn($, '實作 #31', '第 31 張')
  await finishAgent($, 'agent-2', 'error')
  await spawn($, '實作 #32', '第 32 張')
  await swarm($, '#31')
  expect(lastStatus(world)).toMatch(ENDED)
})

test('github standalone: /swarm adding a new standalone ticket, by #N or by issue URL, keeps the ended cards', WF, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await start($)
  await spawn($, '實作 #30', '第 30 張')
  await finishAgent($, 'agent-1')
  await spawn($, '實作 #31', '第 31 張')
  await finishAgent($, 'agent-2', 'error')
  await spawn($, '實作 #32', '第 32 張')
  await swarm($, '#33')
  expect(world.gh).toContain('issues/33') // a ticket the feature did not have
  expect(lastStatus(world)).toMatch(ENDED)
  await swarm($, 'https://github.com/o/r/issues/34')
  expect(world.gh).toContain('issues/34')
  expect(lastStatus(world)).toMatch(ENDED)
})

test('github: /swarm <issue URL> of another spec swaps the tickets and drops the ended cards', WF, async ($, on) => {
  const world = newWorld()
  world.closed = new Set([11, 12, 13])
  engine(on, world)
  await start($)
  await skill($, '#10')
  await endedAndRunning($)
  await swarm($, 'https://github.com/o/r/issues/20')
  expect(lastStatus(world)).toMatch(NO_ENDED)
  const ui = await mount($)
  expect(await has(ui, /Billing feature/)).toBe(true)
  expect(await has(ui, /派出 ticket/)).toBe(true) // the log stays
  await ui.unmount()
})
