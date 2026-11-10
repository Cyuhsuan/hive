import { expect, test } from 'claude-code/testing'

import { githubSource } from '../hooks/github-source'
import type { SourceEnv } from '../hooks/ticket-source'

// The GitHub source on its own, with a fake `gh`: the replies below have the
// shape `gh api repos/<owner>/<repo>/issues/<n>` (and its `/sub_issues` and
// `/dependencies/blocked_by`) really return, with the fields the source reads.

type Reply = { exitCode?: number; stdout?: string; stderr?: string } | Error

function ghEnv(replies: Record<string, unknown | Reply>, calls: string[] = []): SourceEnv {
  return {
    fs: { list: async () => [], read: async () => '' },
    now: async () => 7,
    async run(argv) {
      const endpoint = argv.find(a => a.startsWith('repos/')) ?? argv.join(' ')
      calls.push(endpoint)
      const key = endpoint.replace('repos/{owner}/{repo}/', '')
      // the whole argument vector is checked: the list endpoints are asked with
      // `--paginate --slurp`, every other one is a plain `gh api <endpoint>`
      const isList = key.includes('/sub_issues?') || key.startsWith('issues?')
      const expected = isList ? ['gh', 'api', '--paginate', '--slurp', endpoint] : ['gh', 'api', endpoint]
      if (JSON.stringify(argv) !== JSON.stringify(expected)) return { exitCode: 2, stdout: '', stderr: `unexpected argv: ${argv.join(' ')}` }
      // an issue nothing blocks has an empty list, as GitHub answers
      const reply = replies[key] ?? (key.endsWith('/dependencies/blocked_by') ? [] : undefined)
      if (reply instanceof Error) throw reply
      if (reply === undefined) return { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
      const r = reply as { exitCode?: number; stdout?: string; stderr?: string; __json?: never }
      if ('exitCode' in r || 'stderr' in r) return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      // `--paginate --slurp` wraps the list in one page
      return { exitCode: 0, stdout: JSON.stringify(isList ? [reply] : reply), stderr: '' }
    },
  }
}

const SPEC = { number: 10, title: 'Login feature', state: 'open', body: 'spec' }
const issue = (number: number, title: string, state: string, body = '') => ({ number, title, state, body })

test('load: sub-issues become tickets: closed is resolved, the body gives the acceptance counts', async () => {
  const env = ghEnv({
    'issues/10': SPEC,
    'issues/10/sub_issues?per_page=100': [
      issue(11, 'Schema', 'closed', '- [x] a\n- [x] b'),
      issue(12, 'API', 'open', '- [x] a\n- [ ] b\n- [ ] c'),
    ],
    'issues/11/dependencies/blocked_by': [],
    'issues/12/dependencies/blocked_by': [{ number: 11, title: 'Schema', state: 'closed' }],
  })
  const result = await githubSource.load(env, '10')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const f = result.feature
  expect(f.sourceId).toBe('github')
  expect(f.origin).toBe('10')
  expect(f.name).toBe('Login feature')
  expect(f.tickets.map(t => [t.number, t.title, t.status, t.checked, t.checks, t.step, t.blockedBy])).toEqual([
    ['11', 'Schema', 'resolved', 2, 2, 1, []],
    ['12', 'API', 'open', 1, 3, 2, ['11']],
  ])
})

test('load: the native blocked-by and the body section give the same time-steps', async () => {
  const subs = (body: string) => [issue(11, 'A', 'open'), issue(12, 'B', 'open', body), issue(13, 'C', 'open', body)]
  const native = ghEnv({
    'issues/10': SPEC,
    'issues/10/sub_issues?per_page=100': subs(''),
    'issues/11/dependencies/blocked_by': [],
    'issues/12/dependencies/blocked_by': [{ number: 11 }],
    'issues/13/dependencies/blocked_by': [{ number: 11 }, { number: 12 }, { number: 99 }],
  })
  // no native relation (it is empty): the body's `## Blocked by` section is read
  const inBody = ghEnv({
    'issues/10': SPEC,
    'issues/11/dependencies/blocked_by': [],
    'issues/12/dependencies/blocked_by': [],
    'issues/13/dependencies/blocked_by': [],
    'issues/10/sub_issues?per_page=100': [
      issue(11, 'A', 'open'),
      issue(12, 'B', 'open', '## What\n\nx\n\n## Blocked by\n\n- #11\n\n## Notes\n\n#5'),
      issue(13, 'C', 'open', '## Blocked by\n\n- #11\n- #12\n- #99'),
    ],
  })
  const steps = async (env: SourceEnv) => {
    const r = await githubSource.load(env, '10')
    return r.ok ? r.feature.tickets.map(t => [t.number, t.step, t.blockedBy]) : r
  }
  const expected = [['11', 1, []], ['12', 2, ['11']], ['13', 3, ['11', '12']]]
  expect(await steps(native)).toEqual(expected)
  expect(await steps(inBody)).toEqual(expected)
})

test('load: numbers are not padded and sort as numbers', async () => {
  const env = ghEnv({
    'issues/1': SPEC,
    'issues/1/sub_issues?per_page=100': [issue(100, 'Z', 'open'), issue(9, 'Y', 'open')],
  })
  const result = await githubSource.load(env, '1')
  expect(result.ok && result.feature.tickets.map(t => t.number)).toEqual(['9', '100'])
})

test('load: without sub-issues, the issues that say Part of #N (or a Parent section) are the tickets', async () => {
  const env = ghEnv({
    'issues/10': SPEC,
    'issues/10/sub_issues?per_page=100': [],
    'issues?state=all&per_page=100': [
      issue(11, 'One', 'open', 'Part of #10\n\n- [ ] a'),
      issue(12, 'Two', 'closed', '## Parent\n\n#10\n'),
      issue(13, 'Other spec', 'open', 'Part of #99'),
      { ...issue(14, 'A PR', 'open', 'Part of #10'), pull_request: {} },
      issue(10, 'Spec itself', 'open', 'Part of #10'),
    ],
  })
  const result = await githubSource.load(env, '10')
  expect(result.ok && result.feature.tickets.map(t => [t.number, t.status])).toEqual([['11', 'open'], ['12', 'resolved']])
})

test('load: a failing gh gives a reason, it does not throw', async () => {
  const cases: [Reply, RegExp][] = [
    [new Error('spawn gh ENOENT'), /`gh` 不存在/],
    [{ exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, /`gh` 未登入/],
    [{ exitCode: 1, stderr: 'dial tcp: lookup api.github.com: no such host' }, /連不上/],
    [{ exitCode: 1, stderr: 'gh: Something odd happened' }, /`gh` 呼叫失敗：gh: Something odd/],
    [{ exitCode: 0, stdout: 'not json' }, /讀不懂/],
  ]
  for (const [reply, reason] of cases) {
    const result = await githubSource.load(ghEnv({ 'issues/10': reply }), '10')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(reason)
  }
  const none = await githubSource.load({ ...ghEnv({}), run: undefined }, '10')
  expect(none.ok).toBe(false)
})

test('originOfArgs: every #N, bare number and issue URL in order, kept for load to sort into spec or standalone; a path or other text is none', () => {
  const o = githubSource.originOfArgs
  expect(o('#12')).toBe('args:12')
  expect(o('12')).toBe('args:12')
  expect(o(' 12 ')).toBe('args:12')
  expect(o('https://github.com/Cyuhsuan/hive/issues/12')).toBe('args:12')
  expect(o('look at #7 please')).toBe('args:7')
  expect(o('#7 https://github.com/o/r/issues/5 and #7, #9')).toBe('args:7,5,9')
  expect(o('11 14')).toBe('args:11,14')
  expect(o('.scratch/f/spec.md')).toBeUndefined()
  expect(o('')).toBeUndefined()
  expect(githubSource.originOfCommand('#3 #4')).toBe('args:3,4')
})

// 30 and 31 are standalone (31 is blocked by 30), 12 is a ticket of spec 10, 98 does not exist, 97 is a pull request.
const standaloneEnv = (extra: Record<string, unknown> = {}, calls: string[] = []) =>
  ghEnv(
    {
      'issues/10': SPEC,
      'issues/10/sub_issues?per_page=100': [issue(12, 'API', 'open')],
      'issues/12/parent': issue(10, 'Login feature', 'open'),
      'issues/12': issue(12, 'API', 'open'),
      'issues/30/parent': NO_PARENT,
      'issues/30': issue(30, 'Lone A', 'open', '- [x] a\n- [ ] b'),
      'issues/30/sub_issues?per_page=100': [],
      'issues/31/parent': NO_PARENT,
      'issues/31': issue(31, 'Lone B', 'closed'),
      'issues/31/sub_issues?per_page=100': [],
      'issues/31/dependencies/blocked_by': [{ number: 30 }, { number: 77 }],
      'issues?state=all&per_page=100': [],
      'issues/97/parent': NO_PARENT,
      'issues/97': { ...issue(97, 'A PR', 'open'), pull_request: {} },
      'issues/98/parent': NO_PARENT,
      ...extra,
    },
    calls,
  )

test('load: issues named with no spec among them are one feature called 獨立票, steps by blocked-by inside the feature only', async () => {
  const result = await githubSource.load(standaloneEnv(), 'args:31,30')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.feature.name).toBe('獨立票')
  expect(result.feature.sourceId).toBe('github')
  expect(result.feature.tickets.map(t => [t.number, t.title, t.status, t.checked, t.checks, t.step, t.blockedBy])).toEqual([
    ['30', 'Lone A', 'open', 1, 2, 1, []],
    ['31', 'Lone B', 'resolved', 0, 0, 2, ['30']],
  ])
  // the feature names its tickets, so it is read again from its origin alone
  expect(githubSource.isStandalone!(result.feature.origin)).toBe(true)
  const again = await githubSource.load(standaloneEnv(), result.feature.origin)
  expect(again.ok && again.feature.tickets.map(t => t.number)).toEqual(['30', '31'])
  expect(githubSource.isStandalone!('10')).toBe(false)
  expect(githubSource.isStandalone!('args:10')).toBe(false)
})

test('load: a ticket of a spec named loads its spec; the first spec named wins, standalone issues named are left out', async () => {
  const viaChild = await githubSource.load(standaloneEnv(), 'args:12')
  expect(viaChild.ok && [viaChild.feature.name, viaChild.feature.origin]).toEqual(['Login feature', '10'])
  const mixed = await githubSource.load(standaloneEnv(), 'args:30,10,31')
  expect(mixed.ok && [mixed.feature.name, mixed.feature.tickets.map(t => t.number)]).toEqual(['Login feature', ['12']])
  // an issue with sub-issues is a spec; one with Part of children too
  const byPartOf = await githubSource.load(
    standaloneEnv({
      'issues/40/parent': NO_PARENT,
      'issues/40': issue(40, 'Old spec', 'open'),
      'issues/40/sub_issues?per_page=100': [],
      'issues/41/dependencies/blocked_by': [],
      'issues?state=all&per_page=100': [issue(41, 'Child', 'open', 'Part of #40')],
    }),
    'args:30,40',
  )
  expect(byPartOf.ok && [byPartOf.feature.name, byPartOf.feature.tickets.map(t => t.number)]).toEqual(['Old spec', ['41']])
})

test('load: numbers that do not exist or are pull requests are left out; if none is left it fails, not an empty feature', async () => {
  const some = await githubSource.load(standaloneEnv(), 'args:98,30,97')
  expect(some.ok && some.feature.tickets.map(t => t.number)).toEqual(['30'])
  const none = await githubSource.load(standaloneEnv(), 'args:98,97')
  expect(none.ok).toBe(false)
  if (!none.ok) expect(none.reason).toMatch(/讀不到/)
})

test('load: one failing call fails the whole standalone feature', async () => {
  const boom = { exitCode: 1, stderr: 'gh: HTTP 500 Server Error' }
  expect((await githubSource.load(standaloneEnv({ 'issues/31': boom }), 'args:30,31')).ok).toBe(false)
  expect((await githubSource.load(standaloneEnv({ 'issues/31/dependencies/blocked_by': boom }), 'standalone:30,31')).ok).toBe(false)
  expect((await githubSource.load(standaloneEnv({ 'issues/30/sub_issues?per_page=100': boom }), 'args:30')).ok).toBe(false)
})

test('resolveRef: an open issue with no parent is a standalone ticket; a closed one or a pull request is nothing', async () => {
  const env = standaloneEnv()
  expect(await githubSource.resolveRef!(env, 'do #30')).toEqual({ ok: true, ref: { origin: 'standalone:30', ticket: '30', number: '30' } })
  expect(await githubSource.resolveRef!(env, 'do #31')).toEqual({ ok: true })
  expect(await githubSource.resolveRef!(env, 'do #97')).toEqual({ ok: true })
  // a ticket of a spec stays the spec's, and the first number that counts wins
  expect(await githubSource.resolveRef!(env, 'do #31 then #12')).toEqual({ ok: true, ref: { origin: '10', ticket: '12', number: '12' } })
  expect(githubSource.isStandalone!('standalone:30')).toBe(true)
  expect(githubSource.isStandalone!('10')).toBe(false)
})

test('joinStandalone: the origin of the standalone feature with the tickets of both, never twice; anything else is the second', () => {
  expect(githubSource.joinStandalone!('standalone:30', 'standalone:31')).toBe('standalone:30,31')
  expect(githubSource.joinStandalone!('standalone:30,31', 'standalone:30')).toBe('standalone:30,31')
  expect(githubSource.joinStandalone!('10', 'standalone:31')).toBe('standalone:31')
  expect(githubSource.joinStandalone!('standalone:30', '10')).toBe('10')
})

test('emptyText: a standalone feature is not described as a spec', () => {
  expect(githubSource.emptyText('standalone:30')).not.toMatch(/#standalone/)
})

test('refOfText: only numbers in the loaded feature point at a ticket', async () => {
  const loaded = await githubSource.load(
    ghEnv({ 'issues/10': SPEC, 'issues/10/sub_issues?per_page=100': [issue(11, 'A', 'open'), issue(120, 'B', 'open')] }),
    '10',
  )
  if (!loaded.ok) throw new Error('not loaded')
  const f = loaded.feature
  expect(githubSource.refOfText('implement #11 now', f)).toEqual({ origin: '10', ticket: '11', number: '11' })
  expect(githubSource.refOfText('see https://github.com/o/r/issues/120', f)).toEqual({ origin: '10', ticket: '120', number: '120' })
  expect(githubSource.refOfText('the PR #12 changed it', f)).toBeUndefined()
  expect(githubSource.refOfText('fixes #1200', f)).toBeUndefined()
  expect(githubSource.refOfText('implement #11', undefined)).toBeUndefined()
})

// `GET issues/{n}/parent` answers the parent issue when there is one, and
// `404 No parent issue found` when there is none. (The 404 is what this repo's
// own issues answer; the parent's shape is GitHub's documented issue object.)
const NO_PARENT = { exitCode: 1, stderr: 'gh: No parent issue found (HTTP 404)' }

test('resolveRef: the parent of the issue a prompt names, by the parent endpoint or by Part of', async () => {
  const env = ghEnv({
    'issues/12/parent': issue(10, 'Login feature', 'open'),
    'issues/13/parent': NO_PARENT,
    'issues/13': issue(13, 'Page', 'open', 'Part of #10'),
    'issues/14/parent': NO_PARENT,
    'issues/14': issue(14, 'Lone', 'open'),
  })
  expect(await githubSource.resolveRef!(env, 'see https://github.com/o/r/issues/12')).toEqual({ ok: true, ref: { origin: '10', ticket: '12', number: '12' } })
  expect(await githubSource.resolveRef!(env, 'do #13')).toEqual({ ok: true, ref: { origin: '10', ticket: '13', number: '13' } })
  // an open issue with no parent is a standalone ticket
  expect(await githubSource.resolveRef!(env, 'do #14')).toEqual({ ok: true, ref: { origin: 'standalone:14', ticket: '14', number: '14' } })
  expect(await githubSource.resolveRef!(env, 'no number here')).toEqual({ ok: true })
  const failed = await githubSource.resolveRef!(ghEnv({ 'issues/12/parent': { exitCode: 4, stderr: 'run gh auth login' } }), '#12')
  expect(failed).toEqual({ ok: false, reason: '`gh` 未登入' })
  // a failure that is not "no parent" is a failure, not "none"
  const broken = await githubSource.resolveRef!(ghEnv({ 'issues/12/parent': { exitCode: 1, stderr: 'gh: HTTP 500' } }), '#12')
  expect(broken.ok).toBe(false)
})

test('load: any failing gh call fails the whole load, an empty sub-issue list is not a failure', async () => {
  const subs = [issue(11, 'A', 'open'), issue(12, 'B', 'open')]
  const boom = { exitCode: 1, stderr: 'gh: HTTP 500 Server Error' }
  // sub-issues failing must not fall back to Part of
  const noSubs = await githubSource.load(
    ghEnv({ 'issues/10': SPEC, 'issues/10/sub_issues?per_page=100': boom, 'issues?state=all&per_page=100': [] }),
    '10',
  )
  expect(noSubs.ok).toBe(false)
  // one blocked-by failing fails it too
  const noBlocked = await githubSource.load(
    ghEnv({ 'issues/10': SPEC, 'issues/10/sub_issues?per_page=100': subs, 'issues/12/dependencies/blocked_by': boom }),
    '10',
  )
  expect(noBlocked.ok).toBe(false)
  // the Part of scan failing fails it
  const noScan = await githubSource.load(
    ghEnv({ 'issues/10': SPEC, 'issues/10/sub_issues?per_page=100': [], 'issues?state=all&per_page=100': boom }),
    '10',
  )
  expect(noScan.ok).toBe(false)
})

test('mergedTicket: a branch name with the issue number, only for a ticket of the feature', async () => {
  const loaded = await githubSource.load(
    ghEnv({ 'issues/10': SPEC, 'issues/10/sub_issues?per_page=100': [issue(11, 'A', 'open'), issue(12, 'B', 'open')] }),
    '10',
  )
  if (!loaded.ok) throw new Error('not loaded')
  const m = (c: string) => githubSource.mergedTicket(c, loaded.feature)
  expect(m('git merge --no-ff feat-ticket-12')).toBe('12')
  expect(m('git merge ticket-11 -m "x"')).toBe('11')
  // only the branch names count, not the message or other option values
  expect(m('git merge -m "Merge ticket-12" feat-x')).toBeUndefined()
  expect(m("git merge feat-x -m 'done ticket-11; next'")).toBeUndefined()
  expect(m('git merge --message="ticket-12" feat-x')).toBeUndefined()
  expect(m('git merge -m "x; y" feat/ticket-12')).toBe('12')
  expect(m('git merge feat-x && echo ticket-12')).toBeUndefined()
  expect(m('git merge feat/ticket-112')).toBeUndefined()
  expect(m('git merge ticket-99')).toBeUndefined()
  expect(m('git checkout ticket-12')).toBeUndefined()
  expect(githubSource.mergedTicket('git merge ticket-12', undefined)).toBeUndefined()
})

// ---------------------------------------------------- what the tests above leave open

const failing = async (reply: Reply, key = 'issues/10') => {
  const r = await githubSource.load(ghEnv({ [key]: reply }), '10')
  return r.ok ? undefined : r.reason
}

test('load: a failing gh gives the first non-blank stderr line as the reason, cut at 60 characters', async () => {
  expect(await failing({ exitCode: 1, stderr: '\n  \n  gh: odd thing  \nsecond line' })).toBe('`gh` 呼叫失敗：gh: odd thing')
  // no stderr at all, or only blanks: the exit code is all there is
  expect(await failing({ exitCode: 3, stderr: '' })).toBe('`gh` 呼叫失敗：exit 3')
  expect(await failing({ exitCode: 5, stderr: ' \n\t\n' })).toBe('`gh` 呼叫失敗：exit 5')
  const sixty = `gh: ${'x'.repeat(56)}`
  expect(await failing({ exitCode: 1, stderr: sixty })).toBe(`\`gh\` 呼叫失敗：${sixty}`)
  const sixtyOne = `${sixty}y`
  expect(await failing({ exitCode: 1, stderr: sixtyOne })).toBe(`\`gh\` 呼叫失敗：${sixty.slice(0, 59)}…`)
})

test('load: no way to run gh, or a gh that cannot start, is told apart from a gh that is missing', async () => {
  const none = await githubSource.load({ ...ghEnv({}), run: undefined }, '10')
  expect(none).toEqual({ ok: false, reason: '`gh` 無法執行' })
  expect(await failing(new Error('permission denied'))).toBe('`gh` 無法執行')
  expect(await failing(new Error('spawn gh ENOENT'))).toBe('`gh` 不存在')
  expect(await failing({ exitCode: 0, stdout: 'not json' })).toBe('`gh` 回傳的內容讀不懂')
})

test('load: every call is a plain gh api, and the lists are asked with --paginate --slurp', async () => {
  const argvs: string[][] = []
  const env = ghEnv({ 'issues/10': SPEC, 'issues/10/sub_issues?per_page=100': [issue(11, 'A', 'open')] })
  const run = env.run!
  env.run = async argv => {
    argvs.push([...argv])
    return run(argv)
  }
  const result = await githubSource.load(env, '10')
  expect(result.ok).toBe(true)
  expect(argvs).toEqual([
    ['gh', 'api', 'repos/{owner}/{repo}/issues/10'],
    ['gh', 'api', '--paginate', '--slurp', 'repos/{owner}/{repo}/issues/10/sub_issues?per_page=100'],
    ['gh', 'api', 'repos/{owner}/{repo}/issues/11/dependencies/blocked_by'],
  ])
})

test('load: a list that does not come back as pages is an empty list', async () => {
  const env = ghEnv({
    'issues/10': SPEC,
    'issues/10/sub_issues?per_page=100': { exitCode: 0, stdout: '{}' },
    'issues?state=all&per_page=100': [],
  })
  const result = await githubSource.load(env, '10')
  expect(result.ok && result.feature.tickets).toEqual([])
})

test('load: a ticket without a title is named by its number, a feature without one by the spec number', async () => {
  const env = ghEnv({ 'issues/10': { number: 10, state: 'open' }, 'issues/10/sub_issues?per_page=100': [{ number: 11, state: 'open' }] })
  const result = await githubSource.load(env, '10')
  if (!result.ok) throw new Error('not loaded')
  expect(result.feature.name).toBe('#10')
  expect(result.feature.merged).toEqual([])
  expect(result.feature.loadedAt).toBe(7)
  expect(result.feature.tickets.map(t => [t.number, t.slug, t.title])).toEqual([['11', '', '#11']])
})

test('load: a ticket is never listed as blocking itself, nor by an issue outside the batch', async () => {
  const env = ghEnv({
    'issues/10': SPEC,
    'issues/10/sub_issues?per_page=100': [issue(11, 'A', 'open'), issue(12, 'B', 'open')],
    'issues/11/dependencies/blocked_by': [{ number: 11 }, { number: 12 }, { number: 50 }],
    'issues/12/dependencies/blocked_by': [{ number: 12 }],
  })
  const result = await githubSource.load(env, '10')
  expect(result.ok && result.feature.tickets.map(t => [t.number, t.step, t.blockedBy])).toEqual([
    ['12', 1, []],
    ['11', 2, ['12']],
  ])
})

test('load: a blocked-by answer that is not a list falls back to the body section', async () => {
  const env = ghEnv({
    'issues/10': SPEC,
    'issues/10/sub_issues?per_page=100': [issue(11, 'A', 'open'), issue(12, 'B', 'open', '## Blocked by\n\n- #11')],
    'issues/12/dependencies/blocked_by': { exitCode: 0, stdout: 'null' },
  })
  const result = await githubSource.load(env, '10')
  expect(result.ok && result.feature.tickets.map(t => [t.number, t.blockedBy])).toEqual([['11', []], ['12', ['11']]])
})

test('load: Part of may have extra blanks, a line break, or an owner/repo before the number', async () => {
  const env = ghEnv({
    'issues/10': SPEC,
    'issues/10/sub_issues?per_page=100': [],
    'issues?state=all&per_page=100': [
      issue(11, 'Blanks', 'open', 'Part of  #10'),
      issue(12, 'Repo', 'open', 'Part of my.org/re-po_x#10'),
      issue(13, 'Lines', 'open', 'part of\n#10'),
      issue(14, 'Word', 'open', 'Counterpart of #10'),
      issue(15, 'Longer', 'open', 'Part of #100'),
      issue(16, 'Elsewhere', 'open', 'Part of other/repo#99'),
    ],
  })
  const result = await githubSource.load(env, '10')
  expect(result.ok && result.feature.tickets.map(t => t.number)).toEqual(['11', '12', '13'])
})

test('originOfArgs: a bare number is the whole text, not a prefix or a suffix of it', () => {
  expect(githubSource.originOfArgs('12abc')).toBeUndefined()
  expect(githubSource.originOfArgs('abc 12')).toBeUndefined()
})

test('resolveRef: numbers are tried in the order they appear in the text, three at most', async () => {
  const calls: string[] = []
  const replies: Record<string, unknown> = {}
  for (const n of [5, 6, 7, 8]) {
    replies[`issues/${n}/parent`] = NO_PARENT
    replies[`issues/${n}`] = issue(n, 'Lone', 'closed')
  }
  const env = ghEnv(replies, calls)
  const text = 'see #5 and https://github.com/o/r/issues/7 and #6, then #8'
  expect(await githubSource.resolveRef!(env, text)).toEqual({ ok: true })
  expect(calls.map(c => c.replace('repos/{owner}/{repo}/', ''))).toEqual([
    'issues/5/parent', 'issues/5',
    'issues/7/parent', 'issues/7',
    'issues/6/parent', 'issues/6',
  ])
})

test('resolveRef: a missing parent whose issue cannot be read is a failure, the first failure is the one told', async () => {
  const unreadable = await githubSource.resolveRef!(
    ghEnv({ 'issues/13/parent': NO_PARENT, 'issues/13': { exitCode: 4, stderr: 'run gh auth login' } }),
    'do #13',
  )
  expect(unreadable).toEqual({ ok: false, reason: '`gh` 未登入' })
  const first = await githubSource.resolveRef!(
    ghEnv({
      'issues/5/parent': { exitCode: 1, stderr: 'gh: HTTP 500 first' },
      'issues/7/parent': NO_PARENT,
      'issues/7': { exitCode: 1, stderr: 'gh: HTTP 500 second' },
    }),
    '#5 and #7',
  )
  expect(first).toEqual({ ok: false, reason: '`gh` 呼叫失敗：gh: HTTP 500 first' })
  // a later number that does resolve wins over the failure before it
  const later = await githubSource.resolveRef!(
    ghEnv({ 'issues/5/parent': { exitCode: 1, stderr: 'gh: HTTP 500' }, 'issues/7/parent': issue(10, 'Spec', 'open') }),
    '#5 and #7',
  )
  expect(later).toEqual({ ok: true, ref: { origin: '10', ticket: '7', number: '7' } })
})

test('mergedTicket: any of several merged branches may be the ticket', async () => {
  const loaded = await githubSource.load(
    ghEnv({ 'issues/10': SPEC, 'issues/10/sub_issues?per_page=100': [issue(11, 'A', 'open'), issue(12, 'B', 'open')] }),
    '10',
  )
  if (!loaded.ok) throw new Error('not loaded')
  expect(githubSource.mergedTicket('git merge a ticket-12', loaded.feature)).toBe('12')
  expect(githubSource.mergedTicket('git merge ticket-12 a', loaded.feature)).toBe('12')
  expect(githubSource.mergedTicket('git merge a b', loaded.feature)).toBeUndefined()
})

test('emptyText: names the spec issue', () => {
  expect(githubSource.emptyText('10')).toBe('#10 底下沒有讀到票')
})
