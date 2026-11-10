import { expect, mock, test } from 'claude-code/testing'

declare const console: { log: (...a: unknown[]) => void }

const WF = { options: { workflow: 'mattpocock-skills' } }

const PANE = {
  plugin: 'hive',
  component: 'Pane',
  requestId: 'hive',
  props: { title: 'Hive', isFocused: false, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('dump the pane with three agents in flight', WF, async ($, on) => {
  const clock = mock.clock(on, { now: 1_762_420_000_000 })
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let n = 0
  on('agent.spawn', (_, e) => ({ model: e.subagentType === 'code-reviewer' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', agentId: `agent-${++n}` }))
  on('tool.call', () => ({ result: {} }))
  const TICKETS: Record<string, string> = {"01-schema.md": "# 01: 新增 login 資料表\n\n**Blocked by:** None\n\n**Status:** resolved\n\n- [x] a\n- [x] b\n", "02-prefactor.md": "# 02: 抽出共用 AuthService\n\n**Blocked by:** None\n\n**Status:** resolved\n\n- [x] a\n", "03-login-api.md": "# 03: 登入 API\n\n**Blocked by:** 01, 02\n\n**Status:** ready-for-agent\n\n- [x] a\n- [ ] b\n- [ ] c\n", "04-report-page.md": "# 04: 報表頁面\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\n- [ ] a\n- [ ] b\n", "05-logout.md": "# 05: 登出與 session 失效\n\n**Blocked by:** 03\n\n**Status:** ready-for-agent\n\n- [ ] a\n", "06-e2e.md": "# 06: 端對端流程\n\n**Blocked by:** 04, 05\n\n**Status:** ready-for-agent\n\n- [ ] a\n"}
  on('fs.list', () => ({ value: Object.keys(TICKETS).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_, e) => {
    // the project has no tracker file: its tickets are the local ones
    if (e.path.endsWith('issue-tracker.md')) throw new Error('ENOENT')
    return { value: TICKETS[e.path.split('/').pop() ?? ''] ?? '' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/demo-feature/spec.md' } as never)
  await $.agent.spawn({ prompt: '實作 .scratch/demo-feature/issues/03-login-api.md', description: '第 3 張票', subagentType: 'ticket-implementer' } as never)
  await $.agent.spawn({ prompt: '實作 .scratch/demo-feature/issues/04-report-page.md', description: '第 4 張票', subagentType: 'ticket-implementer' } as never)
  await $.agent.spawn({ prompt: '審查 .scratch/demo-feature/issues/02-prefactor.md 的分支', description: '審查第 2 張票', subagentType: 'code-reviewer' } as never)
  await clock.advance(42_000)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/Auth/Login.cs', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/Auth/LoginService.cs', old_string: 'a', new_string: 'b', agentId: 'agent-1' } as never)
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'dotnet test tests/Auth.Tests', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/Report/Page.tsx', agentId: 'agent-2' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git diff feat_demo...HEAD --stat', agentId: 'agent-3' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat_demo-ticket-02' } as never)
  await clock.advance(95_000)

  for (const bodyColumns of [84, 56, 24]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
    console.log(`=====JSON ${bodyColumns} ` + JSON.stringify(await ui.drawn()))
    expect(await ui.find({ type: 'Text', text: bodyColumns < 40 ? /03 測試/ : /03 登入 API/ })).toBeDefined()
    await ui.unmount()
  }
})
