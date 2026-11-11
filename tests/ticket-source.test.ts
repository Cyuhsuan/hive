import { expect, test } from 'claude-code/testing'

import { githubSource } from '../hooks/github-source'
import { markdownSource, mergedBranches, parseTicket, ticketName } from '../hooks/ticket-source'
import type { SourceEnv } from '../hooks/ticket-source'
import { TRACKER_FILE, mattpocockSkills, sourceById, workflowOf } from '../hooks/workflow'
import { spoken, zh } from './zh'

// The ticket source is exercised on its own here: no pane, no plugin, only the
// small environment (files and a clock) it is handed.

const FILES: Record<string, string> = {
  '.scratch/f/issues/01-schema.md': '# 01: 新增資料表\n\n**Blocked by:** None\n\n**Status:** resolved\n\n- [x] a\n- [x] b\n',
  '.scratch/f/issues/02-api.md': '# 02: 登入 API\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\n- [x] a\n- [ ] b\n',
  '.scratch/f/issues/03-page.md': '# 03: 報表頁面\n\n**Blocked by:** 01, 02\n\n**Status:** ready-for-agent\n',
  '.scratch/f/issues/notes.txt': 'not a ticket',
}

function env(files: Record<string, string>): SourceEnv {
  return {
    fs: {
      async list(path) {
        const prefix = `${path.replace(/\/+$/, '')}/`
        const names = Object.keys(files).filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
        if (names.length === 0) throw new Error('ENOENT')
        return names.map(name => ({ name, kind: 'file' }))
      },
      async read(path) {
        const text = files[path]
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
    },
    now: async () => 42,
  }
}

test('load: tickets with titles, blockers, status, acceptance counts and time-steps', async () => {
  const result = await markdownSource.load(env(FILES), '.scratch/f/issues')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const f = result.feature
  expect(f.sourceId).toBe('local-markdown')
  expect(f.origin).toBe('.scratch/f/issues')
  expect(f.name).toBe('f')
  expect(f.loadedAt).toBe(42)
  expect(f.merged).toEqual([])
  expect(f.tickets.map(t => [t.number, t.title, t.step, t.status, `${t.checked}/${t.checks}`])).toEqual([
    ['01', '新增資料表', 1, 'resolved', '2/2'],
    ['02', '登入 API', 2, 'ready-for-agent', '1/2'],
    ['03', '報表頁面', 3, 'ready-for-agent', '0/0'],
  ])
  expect(f.tickets[2]!.blockedBy).toEqual(['01', '02'])
})

test('load: a folder that cannot be listed fails with a reason, it does not throw', async () => {
  const result = await markdownSource.load(env({}), '.scratch/none/issues')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(zh(result.reason)).toContain('.scratch/none/issues')
})

test('load: an unreadable ticket is left out of the graph', async () => {
  const e = env(FILES)
  const read = e.fs.read
  e.fs.read = async path => {
    if (path.endsWith('02-api.md')) throw new Error('EACCES')
    return read(path)
  }
  const result = await markdownSource.load(e, '.scratch/f/issues')
  expect(result.ok && result.feature.tickets.map(t => t.number)).toEqual(['01', '03'])
})

test('refOfText: a prompt that points at a ticket file, Windows paths included', () => {
  expect(markdownSource.refOfText('實作 .scratch/login/issues/03-login-api.md，整合分支 x')).toEqual({
    origin: '.scratch/login/issues',
    ticket: '03-login-api', number: '03',
  })
  expect(markdownSource.refOfText('Build .scratch\\feat\\issues\\09-export.md')).toEqual({
    origin: '.scratch/feat/issues',
    ticket: '09-export', number: '09',
  })
  expect(markdownSource.refOfText('review the merge, see PR #12')).toBeUndefined()
})

test('originOfArgs: an issues folder, or the folder a spec implies', () => {
  expect(markdownSource.originOfArgs('.scratch/f/issues')).toBe('.scratch/f/issues')
  expect(markdownSource.originOfArgs('.scratch/f/spec.md')).toBe('.scratch/f/issues')
  expect(markdownSource.originOfArgs('.scratch/f')).toBe('.scratch/f/issues')
  expect(markdownSource.originOfArgs('hello')).toBeUndefined()
})

test('originOfCommand: a spec path implies its folder, any other text is the folder itself', () => {
  expect(markdownSource.originOfCommand('.scratch/f/spec.md')).toBe('.scratch/f/issues')
  expect(markdownSource.originOfCommand('my/folder')).toBe('my/folder')
})

test('mergedTicket: the ticket number a git merge of a ticket branch names', () => {
  expect(markdownSource.mergedTicket('git merge --no-ff feat_demo-ticket-02')).toBe('02')
  expect(markdownSource.mergedTicket('git merge main')).toBeUndefined()
  expect(markdownSource.mergedTicket('ls ticket-02')).toBeUndefined()
})

// ------------------------------------------------------------ the workflow

const reading = (text: string | undefined) => ({
  async read(_path: string) {
    if (text === undefined) throw new Error('ENOENT')
    return text
  },
})

test('workflow: the tracker file title picks the ticket source', async () => {
  const w = mattpocockSkills
  expect((await w.chooseSource(reading('# Issue tracker: Local Markdown\n\nx'))).source).toBe(markdownSource)
  expect((await w.chooseSource(reading(undefined))).source).toBe(markdownSource)
  // an empty file is not a local tracker: it cannot be read, so the pane only observes
  const blank = await w.chooseSource(reading('\n\n'))
  expect(blank.source).toBeUndefined()
  expect(zh(blank.label)).toBe('無法辨識')

  const github = await w.chooseSource(reading('# Issue tracker: GitHub\n'))
  expect(github.source).toBe(githubSource)
  expect(zh(github.label)).toBe('GitHub')
  const gitlab = await w.chooseSource(reading('# Issue tracker: GitLab\n'))
  expect(gitlab.source).toBeUndefined()
  expect(zh(gitlab.label)).toBe('GitLab（尚未支援）')
  const other = await w.chooseSource(reading('# Tracker of my own\n'))
  expect(other.source).toBeUndefined()
  expect(zh(other.label)).toBe('無法辨識')
})

test('workflow: the start skill, the setting and the source of a loaded feature', () => {
  expect(mattpocockSkills.isStartSkill('mattpocock-skills:implement-spec')).toBe(true)
  expect(mattpocockSkills.isStartSkill('implement-spec')).toBe(true)
  expect(mattpocockSkills.isStartSkill('hive')).toBe(false)
  expect(workflowOf('mattpocock-skills')).toBe(mattpocockSkills)
  expect(workflowOf('none')).toBeUndefined()
  expect(workflowOf(undefined)).toBeUndefined()
  expect(sourceById('local-markdown', undefined)).toBe(markdownSource)
  // the skill's name ends there: a longer name is another skill
  expect(mattpocockSkills.isStartSkill('mattpocock-skills:implement-spec-v2')).toBe(false)
})

// ------------------------------------------------ what the tests above leave open

/** A folder whose entries are given as they are, and whose every file has the same text. */
const folder = (entries: Array<{ name: string; kind: string }>, text = '# 01: T\n'): SourceEnv => ({
  fs: { list: async () => entries, read: async () => text },
  now: async () => 1,
})

test('mergedBranches: the words after git merge, not the options and the values options take', () => {
  expect(mergedBranches('git merge a b')).toEqual(['a', 'b'])
  expect(mergedBranches('git merge --no-ff --squash a')).toEqual(['a'])
  for (const option of ['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name']) {
    expect(mergedBranches(`git merge ${option} val a`)).toEqual(['a'])
    expect(mergedBranches(`git merge a ${option} val`)).toEqual(['a'])
  }
  expect(mergedBranches('git merge -m "two words" a')).toEqual(['a'])
  expect(mergedBranches('git merge "" a')).toEqual(['', 'a'])
  expect(mergedBranches('git merge')).toEqual([])
  expect(mergedBranches('git rebase main')).toBeUndefined()
})

test('mergedBranches: a command separator ends the branches, what comes before git merge is not one', () => {
  for (const rest of ['\nls x', ';ls x', '; ls x', '|cat x', ' | cat x', '&ls x', ' && ls x']) {
    expect(mergedBranches(`git merge a${rest}`)).toEqual(['a'])
  }
  expect(mergedBranches('echo hi; git merge a')).toEqual(['a'])
  expect(mergedBranches('cd x && git merge a')).toEqual(['a'])
})

test('ticketName: the number and the slug, or the number alone', () => {
  expect(ticketName({ number: '03', slug: 'login-api' })).toBe('03-login-api')
  expect(ticketName({ number: '03', slug: '' })).toBe('03')
})

test('load: sub-folders, files that are not tickets and look-alike names are left out', async () => {
  const result = await markdownSource.load(
    folder([
      { name: '01-a.md', kind: 'file' },
      { name: '02-b.md', kind: 'dir' },
      { name: 'README.md', kind: 'file' },
      { name: '03.md', kind: 'file' },
      { name: '04-c.md.bak', kind: 'file' },
      { name: 'x05-d.md', kind: 'file' },
    ]),
    '.scratch/f/issues',
  )
  expect(result.ok && result.feature.tickets.map(t => [t.number, t.slug])).toEqual([['01', 'a'], ['03', '']])
})

test('load: the feature is named by the folder above issues, however many slashes end the path', async () => {
  const name = async (origin: string) => {
    const r = await markdownSource.load(folder([]), origin)
    return r.ok ? r.feature.name : zh(r.reason)
  }
  expect(await name('.scratch/f/issues')).toBe('f')
  expect(await name('.scratch/f/issues/')).toBe('f')
  expect(await name('.scratch/f/issues//')).toBe('f')
  expect(await name('issues/')).toBe('issues')
})

test('load: blockers are padded to the width of the ticket numbers', async () => {
  const files: Record<string, string> = {
    '.scratch/f/issues/001-a.md': '# 001: A\n\n**Blocked by:** None\n',
    '.scratch/f/issues/002-b.md': '# 002: B\n\n**Blocked by:** 1\n',
    '.scratch/f/issues/003-c.md': '# 003: C\n\n**Blocked by:** 1, 2\n',
  }
  const result = await markdownSource.load(env(files), '.scratch/f/issues')
  expect(result.ok && result.feature.tickets.map(t => [t.number, t.step, t.blockedBy])).toEqual([
    ['001', 1, []],
    ['002', 2, ['001']],
    ['003', 3, ['001', '002']],
  ])
})

test('load: tickets that block each other still load, each with a time-step', async () => {
  const files: Record<string, string> = {
    '.scratch/f/issues/01-a.md': '# 01: A\n\n**Blocked by:** 02\n',
    '.scratch/f/issues/02-b.md': '# 02: B\n\n**Blocked by:** 01\n',
  }
  const result = await markdownSource.load(env(files), '.scratch/f/issues')
  expect(result.ok && result.feature.tickets.map(t => [t.number, t.step])).toEqual([['02', 2], ['01', 3]])
})

test('parseTicket: a ticket without Status is unknown, one without Blocked by is blocked by nothing', () => {
  const t = parseTicket('01-a.md', '# 01: A\n')
  expect(t).toEqual({ number: '01', slug: 'a', title: 'A', blockedBy: [], status: 'unknown', checked: 0, checks: 0, step: 1 })
  expect(parseTicket('01.md', '# 01: A\n')?.slug).toBe('')
  expect(parseTicket('01-a.md', '**Blocked by:** None\n')?.blockedBy).toEqual([])
  expect(parseTicket('01-a.md', '**Blocked by:** soon\n')?.blockedBy).toEqual([])
  expect(parseTicket('README.md', '# 01: A\n')).toBeUndefined()
})

test('parseTicket: the title may have blanks around the number and the colon, and either colon', () => {
  const title = (text: string) => parseTicket('01-slug.md', text)?.title
  expect(title('# 01: T')).toBe('T')
  expect(title('#01:T')).toBe('T')
  expect(title('#   01:   T   ')).toBe('T')
  expect(title('# 01：T')).toBe('T')
  expect(title('# 01 : T')).toBe('T')
  // a heading is at the start of a line; no heading falls back to the slug
  expect(title('Note #01: nope\n# 01: Real')).toBe('Real')
  expect(title('no heading')).toBe('slug')
})

test('parseTicket: Blocked by and Status keep their colons optional and their case free', () => {
  const blocked = (line: string) => parseTicket('03-a.md', `${line}\n`)?.blockedBy
  expect(blocked('**Blocked by:** 01')).toEqual(['01'])
  expect(blocked('**Blocked by**: 01')).toEqual(['01'])
  expect(blocked('**Blocked by** 01')).toEqual(['01'])
  expect(blocked('**blocked BY:** 01')).toEqual(['01'])
  expect(blocked('**Blocked by:**01')).toEqual(['01'])
  expect(blocked('**Blocked by:**\n\n01')).toEqual(['01'])
  expect(blocked('**Blocked by:** NONE')).toEqual([])
  const status = (line: string) => parseTicket('03-a.md', `${line}\n`)?.status
  expect(status('**Status:** resolved')).toBe('resolved')
  expect(status('**Status**: resolved')).toBe('resolved')
  expect(status('**Status** resolved')).toBe('resolved')
  expect(status('**STATUS:**   Ready-For-Agent')).toBe('ready-for-agent')
})

test('parseTicket: only a list item at the start of a line (indented or not) is an acceptance check', () => {
  const t = parseTicket('01-a.md', '- [ ] a\n  - [x] b\n\t- [X] c\nsee - [ ] d\nsee - [x] e\n')
  expect([t?.checks, t?.checked]).toEqual([3, 2])
})

test('refOfText: a ticket file without a slug', () => {
  expect(markdownSource.refOfText('.scratch/f/issues/09.md')).toEqual({ origin: '.scratch/f/issues', ticket: '09', number: '09' })
})

test('originOfArgs: a spec or design path anywhere implies its issues folder, an issues folder is itself', () => {
  expect(markdownSource.originOfArgs('docs/feat/spec.md')).toBe('docs/feat/issues')
  expect(markdownSource.originOfArgs('docs/feat/design.md')).toBe('docs/feat/issues')
  expect(markdownSource.originOfArgs('docs/feat/issues')).toBe('docs/feat/issues')
  expect(markdownSource.originOfArgs('.scratch/feature')).toBe('.scratch/feature/issues')
})

test('changesTickets: only the GitHub source says an issue command changes the tickets', () => {
  expect(markdownSource.changesTickets).toBeUndefined()
  const changes = (c: string) => githubSource.changesTickets?.(c)
  expect(changes('gh issue close 12')).toBe(true)
  expect(changes('gh issue reopen 12')).toBe(true)
  expect(changes('cd x && gh issue edit 12 --title y')).toBe(true)
  expect(changes('gh issue view 12')).toBe(false)
  expect(changes('gh issue comment 12 -b x')).toBe(false)
  expect(changes('gh pr close 3')).toBe(false)
})

test('emptyText: names the folder', () => {
  expect(zh(markdownSource.emptyText('.scratch/f/issues'))).toBe('.scratch/f/issues 裡沒有讀到票檔')
})

test('workflow: the title is the first non-blank line, trimmed, in any spacing and case', async () => {
  const w = mattpocockSkills
  for (const [title, source] of [
    ['Local Markdown', markdownSource],
    ['GitHub', githubSource],
    ['GitLab', undefined],
  ] as const) {
    for (const text of [
      `# Issue tracker: ${title}`,
      `\n\n   \n  # Issue tracker: ${title}  \n\nbody`,
      `#Issue tracker:${title.toUpperCase()}`,
      `#   Issue tracker:   ${title.toLowerCase()}\r\n`,
    ]) {
      const choice = await w.chooseSource(reading(text))
      expect(choice.source).toBe(source)
      expect(zh(choice.label)).toBe(source ? zh(source.label) : 'GitLab（尚未支援）')
    }
    // text around the title, or something else on its line, is another title
    for (const text of [`Notes # Issue tracker: ${title}`, `# Issue tracker: ${title} Enterprise`, `intro\n# Issue tracker: ${title}`]) {
      expect(zh((await w.chooseSource(reading(text))).label)).toBe('無法辨識')
    }
  }
})

test('workflow: a tracker the workflow cannot read says why', async () => {
  const gitlab = await mattpocockSkills.chooseSource(reading('# Issue tracker: GitLab\n'))
  expect(spoken(gitlab)).toEqual({ label: 'GitLab（尚未支援）', reason: '票在 GitLab，尚未支援' })
  const other = await mattpocockSkills.chooseSource(reading('# Something else\n'))
  expect(spoken(other)).toEqual({ label: '無法辨識', reason: `${TRACKER_FILE} 的標題無法辨識票來源` })
})
