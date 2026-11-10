import { expect, mock, test } from 'claude-code/testing'

const WF = { options: { workflow: 'mattpocock-skills' } }

const PANE = {
  plugin: 'hive',
  component: 'Pane',
  requestId: 'hive',
  props: {
    title: 'Hive',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('a spawned ticket-implementer shows as a card with its ticket', WF, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    prompt: '實作 .scratch/login/issues/03-login-api.md，整合分支 feat_login',
    description: '實作第 3 張票',
    subagentType: 'ticket-implementer',
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const card = await ui.find({ type: 'Text', text: /03-login-api/ })
    expect(card).toBeDefined()
    const kind = await ui.find({ type: 'Text', text: /implementer · sonnet 5.5/ })
    expect(kind).toBeDefined()
    await ui.unmount()
  }
})

test('with no subagent yet the pane says so', WF, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /尚無子代理/ })).toBeDefined()
  await ui.unmount()
})

test("an Edit inside the agent's loop moves its card to 改碼", WF, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    prompt: '實作 issues/07-report.md',
    description: '第 7 張票',
    subagentType: 'ticket-implementer',
  } as never)
  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/Report.cs',
    old_string: 'a',
    new_string: 'b',
    agentId: 'agent-1',
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /45% 改碼/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Edit src\/Report.cs/ })).toBeDefined()
  await ui.unmount()
})

test('the pane opens at the surface width and draws no width controls', WF, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const opens: (number | undefined)[] = []
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', (_, e) => {
    opens.push(e.columns)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'swarm', args: '' } as never)
  expect(opens.at(-1)).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /寬度/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('the pane draws at the narrowest dock the engine seats', WF, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: '實作 issues/07-report.md', description: '第 7 張票', subagentType: 'ticket-implementer' } as never)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 24 }, surface: 'terminal' })
  // Narrow: the card's title is the ticket's number and its phase.
  expect(await ui.find({ type: 'Text', text: /07 啟動中/ })).toBeDefined()
  await ui.unmount()
})

test('cards carry the ticket title, failed ones first, done ones on one line', WF, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const TICKETS: Record<string, string> = {
    '01-schema.md': '# 01: 新增資料表\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
    '02-api.md': '# 02: 登入 API\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
    '03-page.md': '# 03: 報表頁面\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
  }
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('fs.list', () => ({ value: Object.keys(TICKETS).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_, e) => {
    // the project has no tracker file: its tickets are the local ones
    if (e.path.endsWith('issue-tracker.md')) throw new Error('ENOENT')
    return { value: TICKETS[e.path.split('/').pop() ?? ''] ?? '' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const file of Object.keys(TICKETS)) {
    await $.agent.spawn({ prompt: `實作 .scratch/f/issues/${file}`, description: file, subagentType: 'ticket-implementer' } as never)
  }
  // 01 finishes, 03 fails, 02 keeps running.
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', isAborted: false, durationMs: 1000, answer: 'ok' } as never)
  await $.turn.complete({ agentId: 'agent-3', reason: 'error', isAborted: false, durationMs: 1000, answer: '' } as never)

  // The bee of 01 is home a second after it finished, and only then in the lead's count.
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /02 登入 API/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /100% 失敗/ })).toBeDefined()
  // The done card is its title alone: no bar of its own.
  expect(await ui.find({ type: 'Text', text: /100% 完成/ })).toBeUndefined()
  const drawn = JSON.stringify(await ui.drawn())
  const at = (text: string) => drawn.lastIndexOf(text)
  expect(at('03 報表頁面')).toBeLessThan(at('02 登入 API'))
  expect(at('02 登入 API')).toBeLessThan(at('01 新增資料表'))
  // The lead's frame counts what it sent out.
  expect(await ui.find({ type: 'Text', text: /已派 3 · 🐝 1 · 已 merge 0/ })).toBeDefined()
  await ui.unmount()
})

test('any agent type whose prompt points at a ticket opens a card, Windows path included', WF, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    prompt: 'Build .scratch\\feat\\issues\\09-export.md',
    description: 'export',
    subagentType: 'general-purpose',
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /general-purpose · sonnet 5.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /09/ })).toBeDefined()
  await ui.unmount()
})
