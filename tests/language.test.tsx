import { expect, mock, test } from 'claude-code/testing'

import { cells } from '../hooks/text-format'

// The `language` setting: what the pane says in English (the default),
// 繁體中文 and 日本語, that the skeleton and what is read in stay as they are,
// that nothing overflows its frame, and that what the state keeps is put into
// words when it is drawn, so a reload in another language changes all of it.

type Hook = (...args: any[]) => unknown
type On = (event: string, hook: Hook) => unknown
type Language = 'en' | 'zh-TW' | 'ja'

const LANGUAGES = ['en', 'zh-TW', 'ja'] as const
// English is the default: the setting is left out.
const optionsOf = (language: Language): { options: Record<string, string> } => ({ options: language === 'en' ? { workflow: 'mattpocock-skills' } : { workflow: 'mattpocock-skills', language } })
const NONE = (language: Language): { options: Record<string, string> } => ({ options: { workflow: 'none', language } })

const PANE = {
  plugin: 'hive',
  component: 'Pane',
  requestId: 'hive',
  props: { title: 'Hive', isFocused: false, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const TICKETS: Record<string, string> = {
  '01-schema.md': '# 01: 新增資料表\n\n**Blocked by:** None\n\n**Status:** resolved\n\n- [x] a\n',
  '02-api.md': '# 02: 登入 API\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\n- [ ] a\n',
}

type World = {
  tracker?: string
  statuses: (string | undefined)[]
  commands: string[]
  /** Set to make `gh` fail as if it were not logged in. */
  ghFails?: boolean
}

function engine(on: On, world: World) {
  mock.clock(on as never, { now: 1_700_000_000_000 })
  let n = 0
  on('command.register', (_: unknown, e: { description: string }) => {
    world.commands.push(e.description)
    return { value: { command: 'swarm' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('fs.list', () => ({ value: Object.keys(TICKETS).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('issue-tracker.md')) {
      if (world.tracker === undefined) throw new Error('ENOENT')
      return { value: world.tracker }
    }
    return { value: TICKETS[e.path.split('/').pop() ?? ''] ?? '' }
  })
  on('process.run', () => ({ value: { exitCode: world.ghFails ? 4 : 1, stdout: '', stderr: 'To get started, run: gh auth login', isStdoutTruncated: false, isStderrTruncated: false } }))
}

const newWorld = (tracker?: string): World => ({ tracker, statuses: [], commands: [] })
const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const spawn = ($: any, prompt: string, description: string, subagentType: string) => $.agent.spawn({ prompt, description, subagentType } as never)
const mount = ($: any, bodyColumns = 84) => $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
const drawnText = async (ui: any) => JSON.stringify(await ui.drawn())

// ------------------------------------------------------- the rendered tree

type Node = string | { type: string; props?: Record<string, any>; children?: Node[] }
const textOf = (node: Node): string => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''))

/** The width a node asks for when nothing shrinks it; text that truncates asks for none. */
function naturalWidth(node: Node): number {
  if (typeof node === 'string') return cells(node)
  const p = node.props ?? {}
  if (node.type === 'Text') return p['wrap'] === 'truncate-end' ? 0 : cells(textOf(node))
  if (typeof p['width'] === 'number') return p['width']
  const kids = (node.children ?? []).map(naturalWidth)
  const frame = (p['borderStyle'] ? 2 : 0) + 2 * (p['paddingX'] ?? 0) + (p['paddingLeft'] ?? 0)
  const isRow = (p['flexDirection'] ?? 'row') === 'row'
  return frame + (isRow ? kids.reduce((a, b) => a + b, 0) + (p['columnGap'] ?? 0) * Math.max(0, kids.length - 1) : Math.max(0, ...kids))
}

/** Every text (or row of them) that asks for more cells than its frame has; text that truncates is the engine's to cut. */
function overflows(node: Node, avail: number, found: string[] = []): string[] {
  if (typeof node === 'string') return found
  const p = node.props ?? {}
  if (node.type === 'Text') {
    if (p['wrap'] !== 'truncate-end' && cells(textOf(node)) > avail) found.push(textOf(node))
    return found
  }
  const outer = typeof p['width'] === 'number' ? Math.min(p['width'], avail) : avail
  const inner = outer - (p['borderStyle'] ? 2 : 0) - 2 * (p['paddingX'] ?? 0) - (p['paddingLeft'] ?? 0)
  const kids = node.children ?? []
  const isRow = (p['flexDirection'] ?? 'row') === 'row' && p['flexWrap'] !== 'wrap'
  if (isRow && naturalWidth({ ...node, props: { ...p, width: undefined, borderStyle: undefined, paddingX: 0, paddingLeft: 0 } }) > inner) {
    found.push(`row: ${textOf(node)}`)
  }
  for (const kid of kids) overflows(kid, inner, found)
  return found
}

// -------------------------------------------------------- one busy session

/** A workflow session: a ticket being worked, a reviewer that failed, a ticket merged. */
async function busySession($: any) {
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
  await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
  await spawn($, 'review the branch', '審查分支', 'code-reviewer')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' } as never)
  await $.turn.complete({ agentId: 'agent-2', reason: 'error', isAborted: false, durationMs: 61_000, answer: 'x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat-ticket-02' } as never)
}

const SAYS = {
  en: {
    status: 'swarm 1 run · 0 done · 1 fail · tickets 2/2',
    summary: '1 running · 0 done · 1 failed · 0s',
    workflow: 'Workflow mattpocock-skills · Ticket source Local',
    tail: ' 100%  2/2 tickets · step 2/2',
    tally: 'dispatched 2 · merged 1',
    hint: 'dispatch → merge → review',
    card: 'failed · 0 tool calls',
    editing: 'editing',
    log: ['read f: 2 tickets · 2 steps', 'dispatched ticket-implementer · sonnet 5.5', 'failed · 1m01s · 0 tool calls · error', 'ticket 02 merged into the integration branch'],
    description: 'Open the subagent pane (/swarm reset clears it; /swarm <issues folder>, /swarm #N, /swarm <issue URL> load that batch of tickets)',
    reply: 'Hive pane opened. Workflow mattpocock-skills · Ticket source Local',
  },
  'zh-TW': {
    status: 'swarm 1 跑 · 0 完 · 1 敗 · 票 2/2',
    summary: '1 執行中 · 0 完成 · 1 失敗 · 0s',
    workflow: '工作流 mattpocock-skills · 票來源 本地',
    tail: ' 100%  2/2 票 · step 2/2',
    tally: '已派 2 · 已 merge 1',
    hint: '派票 → merge → review',
    card: '失敗 · 0 次工具',
    editing: '改碼',
    log: ['讀到 f：2 張票 · 2 個時間步', '派出 ticket-implementer · sonnet 5.5', '失敗 · 1m01s · 0 次工具 · error', '票 02 merge 進整合分支'],
    description: '打開子代理面板（/swarm reset 清空；/swarm <issues 資料夾>、/swarm #N、/swarm <issue 網址> 載入那批票）',
    reply: 'Hive pane opened. 工作流 mattpocock-skills · 票來源 本地',
  },
  ja: {
    status: 'swarm 1 実行 · 0 完了 · 1 失敗 · チケット 2/2',
    summary: '1 実行中 · 0 完了 · 1 失敗 · 0s',
    workflow: 'ワークフロー mattpocock-skills · チケットソース ローカル',
    tail: ' 100%  2/2 チケット · step 2/2',
    tally: '派遣 2 · マージ済み 1',
    hint: '割り当て → merge → review',
    card: '失敗 · ツール 0 回',
    editing: '編集中',
    log: ['f を読み込み：チケット 2 件 · 2 ステップ', 'ticket-implementer を起動 · sonnet 5.5', '失敗 · 1m01s · ツール 0 回 · error', 'チケット 02 を統合ブランチにマージ'],
    description: 'サブエージェントパネルを開く（/swarm reset でクリア、/swarm <issues フォルダ>、/swarm #N、/swarm <issue URL> でそのチケット群を読み込む）',
    reply: 'Hive パネルを開きました。 ワークフロー mattpocock-skills · チケットソース ローカル',
  },
} as const

// What every language draws alike: the English skeleton, and what was read in.
const SKELETON = ['HIVE', 'feature ', 'lead', ' · main session', '✓ step 1', '✓ step 2', 'delegates · 2 forks · 1 running', 'back to lead · merge + review', 'session log']
const READ_IN = ['02 登入 API', '審查分支 · code-reviewer', 'Edit repo/a.ts']

for (const language of LANGUAGES) {
  test(`${language}: the pane, the status line, the log, the command and its reply say it in ${language}`, optionsOf(language), async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await busySession($)
    const says = SAYS[language]
    expect(world.commands).toEqual([says.description])
    expect(world.statuses.at(-1)).toBe(says.status)

    const reply = (await $.command.run({ command: 'swarm', args: '' } as never)) as { text: string }
    expect(reply.text).toBe(says.reply)

    const ui = await mount($)
    const text = await drawnText(ui)
    for (const piece of [says.summary, says.workflow, says.tail, says.tally, says.hint, says.card, ...says.log]) expect(text).toContain(JSON.stringify(piece).slice(1, -1))
    // the skeleton is the same in every language, and so is what was read in
    for (const piece of [...SKELETON, ...READ_IN]) expect(text).toContain(piece)
    // a card's phase is its own language's word; the log leaves phase moves to the card
    expect(text).toContain(says.editing)
    expect(text).not.toContain('→ ' + says.editing)
    await ui.unmount()
  })

  test(`${language}: no line is wider than the pane, from 84 down to 24 columns`, optionsOf(language), async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await busySession($)
    for (const bodyColumns of [84, 56, 44, 40, 39, 30, 24]) {
      const ui = await mount($, bodyColumns)
      expect(overflows((await ui.drawn()) as Node, bodyColumns)).toEqual([])
      await ui.unmount()
    }
  })

  test(`${language}: the narrow summary and the status line are abbreviated as the language does`, NONE(language), async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await start($)
    for (const i of [1, 2, 3, 4, 5]) await spawn($, `work ${i}`, `job ${i}`, 'general-purpose')
    await $.turn.complete({ agentId: 'agent-4', reason: 'answer', isAborted: false, durationMs: 1000, answer: 'x' } as never)
    await $.turn.complete({ agentId: 'agent-5', reason: 'error', isAborted: false, durationMs: 1000, answer: 'x' } as never)
    const narrow = { en: '3 run · 1 done · 1 fail', 'zh-TW': '3 跑 · 1 完 · 1 敗', ja: '3 実行 · 1 完了 · 1 失敗' }[language]
    const statusLine = { en: 'swarm 3 run · 1 done · 1 fail', 'zh-TW': 'swarm 3 跑 · 1 完 · 1 敗', ja: 'swarm 3 実行 · 1 完了 · 1 失敗' }[language]
    expect(world.statuses.at(-1)).toBe(statusLine)
    const ui = await mount($, 36)
    expect(await drawnText(ui)).toContain(narrow)
    await ui.unmount()
  })
}

test('a language outside the options counts as unset, so English', { options: { workflow: 'mattpocock-skills', language: 'fr' } }, async ($, on) => {
  const world = newWorld()
  engine(on, world)
  await busySession($)
  expect(world.statuses.at(-1)).toBe(SAYS.en.status)
})

for (const language of LANGUAGES) {
  test(`${language}: the empty pane`, NONE(language), async ($, on) => {
    mock.clock(on as never, { now: 1_700_000_000_000 })
    on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
    await start($)
    const ui = await mount($)
    const text = await drawnText(ui)
    expect(text).toContain({ en: 'No subagents yet', 'zh-TW': '尚無子代理', ja: 'サブエージェントはまだありません' }[language])
    expect(text).toContain({ en: '(no subagents dispatched yet)', 'zh-TW': '(還沒派出任何子代理)', ja: '(まだサブエージェントを派遣していません)' }[language])
    expect(text).toContain({ en: '(empty)', 'zh-TW': '（空）', ja: '（なし）' }[language])
    expect(text).toContain('session log')
    await ui.unmount()
  })
}

// ------------------------------------------------ ticket source: GitHub

for (const language of LANGUAGES) {
  test(`${language}: the label and the failure of a ticket source are told in ${language}, the first line of gh's own words as it said them`, optionsOf(language), async ($, on) => {
    const world = newWorld('# Issue tracker: GitHub\n')
    world.ghFails = true
    engine(on, world)
    await start($)
    await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '#10' } as never)
    const ui = await mount($)
    const text = await drawnText(ui)
    const failure = { en: '`gh` is not logged in', 'zh-TW': '`gh` 未登入', ja: '`gh` 未ログイン' }[language]
    const label = { en: 'Ticket source GitHub (', 'zh-TW': '票來源 GitHub（', ja: 'チケットソース GitHub（' }[language]
    expect(text).toContain(label + failure)
    const logged = { en: 'ticket source read failed: ', 'zh-TW': '票來源讀取失敗：', ja: 'チケットソース読込失敗：' }[language]
    expect(text).toContain(logged + failure)
    await ui.unmount()
  })
}

// ------------------------------------------ what the state keeps, and a reload

const AT = 1_700_000_000_000
const ticket = { number: '02', slug: 'api', title: '登入 API', blockedBy: [], status: 'ready-for-agent', checked: 0, checks: 1, step: 1 }
const agent = {
  id: 'agent-9', type: 'ticket-implementer', description: '第 2 張票', model: 'claude-sonnet-5-5',
  ticket: '02-api', ticketNumber: '02', isBackground: false, phase: 'editing', tools: 3, errors: 0, startedAt: AT,
}

/** What a session left in the state when it kept codes and arguments. */
const KEPT = {
  mode: 'workflow',
  agents: [agent],
  log: [
    { at: AT, who: 'lead', text: { code: 'sourceReadFailed', args: [{ code: 'ghFailed', args: ['gh: boom'] }] } },
    { at: AT, who: '02-api', text: { code: 'ticketResolved', args: [1, 2] } },
  ],
  sourceId: 'github',
  sourceLabel: { code: 'sourceGithub', args: [] },
  loadFailure: { code: 'ghNotLoggedIn', args: [] },
  feature: {
    sourceId: 'github', origin: 'standalone:30', name: { code: 'standaloneName', args: [] }, merged: [], loadedAt: AT,
    tickets: [],
  },
}

/** What an earlier version left: every one of them already in words. */
const OLD = {
  ...KEPT,
  log: [
    { at: AT, who: 'lead', text: '票來源讀取失敗：`gh` 呼叫失敗：gh: boom' },
    { at: AT, who: '02-api', text: '票面 Status → resolved（1/2 驗收）' },
  ],
  sourceLabel: '本地',
  loadFailure: '`gh` 未登入',
  feature: { ...KEPT.feature, name: '獨立票' },
}

const stateOf = (value: unknown) => (on: On) => on('state.get', () => ({ value: { value: { shape: 'swarm-5', value }, version: 1 } }))

for (const language of LANGUAGES) {
  test(`${language}: log, label, failure and the batch's name kept as codes are drawn in ${language}`, optionsOf(language), async ($, on) => {
    mock.clock(on as never, { now: AT })
    stateOf(KEPT)(on)
    const ui = await mount($)
    const text = await drawnText(ui)
    const says = {
      en: ['Ticket source GitHub (`gh` is not logged in)', 'ticket source read failed: `gh` call failed: gh: boom', 'ticket Status → resolved (1/2 criteria)', 'Standalone tickets'],
      'zh-TW': ['票來源 GitHub（`gh` 未登入）', '票來源讀取失敗：`gh` 呼叫失敗：gh: boom', '票面 Status → resolved（1/2 驗收）', '獨立票'],
      ja: ['チケットソース GitHub（`gh` 未ログイン）', 'チケットソース読込失敗：`gh` 失敗：gh: boom', 'チケットの Status → resolved（受け入れ条件 1/2）', '単独チケット'],
    }[language]
    for (const piece of says) expect(text).toContain(piece)
    await ui.unmount()
  })

  test(`${language}: a state an earlier version kept, in plain text, draws as it was kept`, optionsOf(language), async ($, on) => {
    mock.clock(on as never, { now: AT })
    stateOf(OLD)(on)
    for (const bodyColumns of [84, 56, 44, 40, 39, 30, 24]) {
      const ui = await mount($, bodyColumns)
      const text = await drawnText(ui)
      expect(overflows((await ui.drawn()) as Node, bodyColumns)).toEqual([])
      if (bodyColumns === 84) {
        for (const piece of ['本地', '`gh` 未登入', '票來源讀取失敗：`gh` 呼叫失敗：gh: boom', '票面 Status → resolved（1/2 驗收）', '獨立票']) expect(text).toContain(piece)
      }
      await ui.unmount()
    }
  })
}

test('a message this version does not know draws as nothing and breaks nothing', optionsOf('en'), async ($, on) => {
  mock.clock(on as never, { now: AT })
  stateOf({ ...KEPT, log: [{ at: AT, who: 'lead', text: { code: 'fromTheFuture', args: [1] } }], loadFailure: { code: 'alsoNew', args: [] } })(on)
  const ui = await mount($)
  expect(await drawnText(ui)).toContain('session log')
  await ui.unmount()
})

test('the state keeps codes and arguments, not the words of the language it was in', optionsOf('zh-TW'), async ($, on) => {
  const world = newWorld('# Issue tracker: GitHub\n')
  world.ghFails = true
  engine(on, world)
  let stored: unknown = { shape: 'swarm-5', value: { mode: 'observe', agents: [], log: [] } }
  on('state.get', () => ({ value: { value: stored, version: 1 } }))
  on('state.set', (_: unknown, e: { value: unknown }) => {
    stored = e.value
    return { value: { isSet: true, version: 2 } }
  })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '#10' } as never)
  await spawn($, 'work', '工作', 'general-purpose')
  const kept = JSON.stringify(stored)
  expect(kept).toContain('"code":"sourceReadFailed"')
  expect(kept).toContain('"code":"ghNotLoggedIn"')
  expect(kept).toContain('"code":"spawned"')
  expect(kept).not.toContain('票來源讀取失敗')
  expect(kept).not.toContain('派出')
})

// ------------------------------------------------- a running card's progress line

const PHASE_NAMES = {
  en: { spawned: 'starting', reading: 'reading', editing: 'editing', testing: 'testing', merging: 'merging', committing: 'committing', reviewing: 'reviewing', failed: 'failed' },
  'zh-TW': { spawned: '啟動中', reading: '讀碼', editing: '改碼', testing: '測試', merging: 'merge', committing: 'commit', reviewing: '審查', failed: '失敗' },
  ja: { spawned: '起動中', reading: '読込中', editing: '編集中', testing: 'テスト中', merging: 'マージ中', committing: 'コミット中', reviewing: 'レビュー中', failed: '失敗' },
} as const

/** The texts of the progress lines drawn: a bar, its percent, then the phase. */
const progressLines = (node: Node, names: Record<string, string>, found: string[] = []): string[] => {
  if (typeof node === 'string') return found
  if (node.type === 'Text' && /^[█░]+ +\d+% /.test(textOf(node)) && Object.values(names).some(n => textOf(node).endsWith(n))) found.push(textOf(node))
  for (const kid of node.children ?? []) progressLines(kid, names, found)
  return found
}

for (const language of LANGUAGES) {
  test(`${language}: at 84 columns every phase name is whole on the progress line, with the same bar throughout`, optionsOf(language), async ($, on) => {
    const world = newWorld()
    engine(on, world)
    await start($)
    await $.tool.call({ tool: 'Skill', skill: 'mattpocock-skills:implement-spec', args: '.scratch/f/spec.md' } as never)
    await spawn($, '實作 .scratch/f/issues/02-api.md', '第 2 張票', 'ticket-implementer')
    const names = PHASE_NAMES[language]
    const barLengths = new Set<number>()
    const seen: string[] = []
    const check = async (phase: keyof typeof names) => {
      const ui = await mount($, 84)
      const lines = progressLines((await ui.drawn()) as Node, names)
      await ui.unmount()
      expect(lines).toHaveLength(1)
      const line = lines[0]!
      expect(line.endsWith(names[phase])).toBe(true)
      expect(cells(line)).toBeLessThanOrEqual(36)
      barLengths.add(/^[█░]+/.exec(line)![0].length)
      seen.push(phase)
    }
    await check('spawned')
    const call = (tool: string, args: Record<string, unknown>) => $.tool.call({ tool, ...args, agentId: 'agent-1' } as never)
    await call('Read', { file_path: '/repo/a.ts' })
    await check('reading')
    await call('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
    await check('editing')
    await call('Bash', { command: 'npm test' })
    await check('testing')
    await call('Bash', { command: 'git merge main' })
    await check('merging')
    await call('Bash', { command: 'git commit -m x' })
    await check('committing')
    await $.turn.complete({ agentId: 'agent-1', reason: 'error', isAborted: false, durationMs: 1000, answer: 'x' } as never)
    await check('failed')
    await spawn($, '審查 .scratch/f/issues/02-api.md', '審查第 2 張票', 'code-reviewer')
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'agent-2' } as never)
    {
      const ui = await mount($, 84)
      const lines = progressLines((await ui.drawn()) as Node, names)
      await ui.unmount()
      expect(lines.some(l => l.endsWith(names.reviewing) && cells(l) <= 36)).toBe(true)
    }
    expect(seen).toHaveLength(7)
    // one bar length for the language's every card; zh-TW's stays 24 cells
    expect(barLengths.size).toBe(1)
    if (language === 'zh-TW') expect([...barLengths]).toEqual([24])
  })
}
