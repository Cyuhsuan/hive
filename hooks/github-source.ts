import type { Feature, Msg, Say, Ticket } from '../types'
import { msg } from './i18n'
import { assignSteps, countChecks, mergedBranches } from './ticket-source'
import type { LoadResult, ResolveResult, SourceEnv, TicketSource } from './ticket-source'

// GitHub issues as tickets. A feature starts from a spec issue; its tickets are
// the spec's sub-issues, or else the issues whose body says `Part of #N`. Issues
// with no spec above them are standalone tickets, and one piece of work's
// standalone tickets are one feature. Every call to GitHub goes through the
// logged-in `gh` CLI, and only from here.

type GhIssue = {
  number: number
  title?: string
  body?: string | null
  state?: string
  pull_request?: unknown
}

/** `isMissing`: GitHub answered 404, the thing asked for is not there (as opposed to a call that failed). */
type Gh<T> = { ok: true; data: T } | { ok: false; reason: Msg; isMissing?: boolean }

const REPO = 'repos/{owner}/{repo}'

/** A short, human reason a `gh` call failed. */
function reasonOf(exitCode: number, stderr: string): Msg {
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401|bad credentials/i.test(stderr)) return msg('ghNotLoggedIn')
  if (/could not resolve|connection|network|timeout|timed out|dial tcp|offline|no such host/i.test(stderr)) return msg('ghOffline')
  const first = stderr.split('\n').find(l => l.trim() !== '')?.trim() ?? `exit ${exitCode}`
  return msg('ghFailed', first.length > 60 ? `${first.slice(0, 59)}…` : first)
}

/** Runs `gh <args>` and parses its JSON; never throws. */
async function gh<T>(env: SourceEnv, args: readonly string[]): Promise<Gh<T>> {
  if (!env.run) return { ok: false, reason: msg('ghCannotRun') }
  let result
  try {
    result = await env.run(['gh', ...args])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: /ENOENT|not found|no such file|cannot find|spawn/i.test(message) ? msg('ghMissing') : msg('ghCannotRun') }
  }
  if (result.exitCode !== 0) {
    return { ok: false, reason: reasonOf(result.exitCode, result.stderr), isMissing: /\(HTTP 404\)/.test(result.stderr) }
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T }
  } catch {
    return { ok: false, reason: msg('ghUnreadable') }
  }
}

/** Every page of a list endpoint, flattened. */
async function ghList<T>(env: SourceEnv, endpoint: string): Promise<Gh<T[]>> {
  const pages = await gh<T[][]>(env, ['api', '--paginate', '--slurp', endpoint])
  if (!pages.ok) return pages
  return { ok: true, data: Array.isArray(pages.data) ? pages.data.flat() : [] }
}

// ------------------------------------------------------------ issue bodies

function section(body: string, heading: string): string | undefined {
  const m = body.match(new RegExp(`^#{1,6}[ \\t]*${heading}[ \\t]*$([\\s\\S]*?)(?=^#{1,6}[ \\t]|(?![\\s\\S]))`, 'im'))
  return m?.[1]
}

const numbersIn = (text: string): number[] => Array.from(new Set((text.match(/#(\d+)/g) ?? []).map(n => Number(n.slice(1)))))

/** The spec an issue's body points at: `Part of #N`, or the first `#N` of a `## Parent` section. */
function parentOfBody(body: string): number | undefined {
  const part = body.match(/\bPart of\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i)?.[1]
  if (part) return Number(part)
  return numbersIn(section(body, 'Parent') ?? '')[0]
}

function blockersOfBody(body: string): number[] {
  return numbersIn(section(body, 'Blocked by') ?? '')
}

/** Issue numbers a text names: an issue URL, or `#N`. In the order they appear. */
function numbersOfText(text: string): number[] {
  const found: Array<{ at: number; n: number }> = []
  for (const m of text.matchAll(/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)/g)) found.push({ at: m.index ?? 0, n: Number(m[1]) })
  for (const m of text.matchAll(/(?<![\w/&])#(\d+)\b/g)) found.push({ at: m.index ?? 0, n: Number(m[1]) })
  return Array.from(new Set(found.sort((a, b) => a.at - b.at).map(f => f.n)))
}

// ------------------------------------------------------------------ source

const GITHUB_ID = 'github'

// A feature's origin: `10` is the spec issue #10. `standalone:30,31` is the
// tickets that have no spec, of one piece of work. `args:30,31` is only what a
// skill's arguments named: `load` sorts it into one of the other two. This is
// the one place that knows the shapes.
const STANDALONE_PREFIX = 'standalone:'
const ARGS_PREFIX = 'args:'
const STANDALONE_NAME = msg('standaloneName')

type Origin = { kind: 'spec'; number: number } | { kind: 'standalone'; numbers: number[] } | { kind: 'args'; numbers: number[] }

const numbersAfter = (origin: string, prefix: string): number[] => origin.slice(prefix.length).split(',').filter(n => n !== '').map(Number)

function parseOrigin(origin: string): Origin {
  if (origin.startsWith(ARGS_PREFIX)) return { kind: 'args', numbers: numbersAfter(origin, ARGS_PREFIX) }
  if (origin.startsWith(STANDALONE_PREFIX)) return { kind: 'standalone', numbers: numbersAfter(origin, STANDALONE_PREFIX) }
  return { kind: 'spec', number: Number(origin) }
}

function originOf(origin: Origin): string {
  if (origin.kind === 'spec') return String(origin.number)
  const prefix = origin.kind === 'args' ? ARGS_PREFIX : STANDALONE_PREFIX
  return `${prefix}${Array.from(new Set(origin.numbers)).join(',')}`
}

const standaloneOrigin = (...numbers: number[]): string => originOf({ kind: 'standalone', numbers })

/** The tickets of `issues` as one feature: their blockers (inside the feature only) and time-steps. */
async function ticketsOf(env: SourceEnv, issues: readonly GhIssue[]): Promise<Gh<Ticket[]>> {
  const inBatch = new Set(issues.map(c => c.number))
  // GitHub's own blocked-by relation first; the body's section when it has none.
  const natives = await Promise.all(issues.map(issue => gh<GhIssue[]>(env, ['api', `${REPO}/issues/${issue.number}/dependencies/blocked_by`])))
  const failed = natives.find(n => !n.ok)
  if (failed && !failed.ok) return failed
  const tickets = issues.map((issue, i): Ticket => {
    const body = issue.body ?? ''
    const native = natives[i]
    const blockers = native?.ok && Array.isArray(native.data) && native.data.length > 0 ? native.data.map(b => b.number) : blockersOfBody(body)
    return {
      number: String(issue.number),
      slug: '',
      title: issue.title ?? `#${issue.number}`,
      blockedBy: Array.from(new Set(blockers.filter(b => inBatch.has(b) && b !== issue.number).map(String))),
      status: issue.state === 'closed' ? 'resolved' : 'open',
      ...countChecks(body),
      step: 1,
    }
  })
  return { ok: true, data: assignSteps(tickets) }
}

/** The issues that are part of spec `n`: its sub-issues, else the ones whose body says so. `listAll` reads every issue, for a caller that asks about many. */
async function childrenOf(env: SourceEnv, n: number, listAll: () => Promise<Gh<GhIssue[]>> = () => ghList<GhIssue>(env, `${REPO}/issues?state=all&per_page=100`)): Promise<Gh<GhIssue[]>> {
  // A failing call fails the whole load; only an empty answer falls back.
  const subs = await ghList<GhIssue>(env, `${REPO}/issues/${n}/sub_issues?per_page=100`)
  if (!subs.ok || subs.data.length > 0) return subs
  // No sub-issues: the issues that say they are part of the spec.
  const all = await listAll()
  if (!all.ok) return all
  return { ok: true, data: all.data.filter(i => i.pull_request === undefined && i.number !== n && parentOfBody(i.body ?? '') === n) }
}

/** A feature of `issues`, already read. */
async function featureOf(env: SourceEnv, origin: string, name: Say, issues: readonly GhIssue[]): Promise<LoadResult> {
  const tickets = await ticketsOf(env, issues)
  if (!tickets.ok) return tickets
  return { ok: true, feature: { sourceId: GITHUB_ID, origin, name, tickets: tickets.data, merged: [], loadedAt: await env.now() } }
}

/** The feature of spec `specNumber`; `children` when the caller already asked for them. */
async function loadSpec(env: SourceEnv, specNumber: number, children?: readonly GhIssue[]): Promise<LoadResult> {
  const spec = await gh<GhIssue>(env, ['api', `${REPO}/issues/${specNumber}`])
  if (!spec.ok) return spec
  let issues = children
  if (!issues) {
    const found = await childrenOf(env, specNumber)
    if (!found.ok) return found
    issues = found.data
  }
  return featureOf(env, originOf({ kind: 'spec', number: specNumber }), spec.data.title ?? `#${specNumber}`, issues)
}

/** The feature of the standalone `issues`, already read. */
const standaloneFeature = (env: SourceEnv, issues: readonly GhIssue[]): Promise<LoadResult> =>
  featureOf(env, standaloneOrigin(...issues.map(i => i.number)), STANDALONE_NAME, issues)

async function loadStandalone(env: SourceEnv, numbers: readonly number[]): Promise<LoadResult> {
  const issues = await Promise.all(numbers.map(n => gh<GhIssue>(env, ['api', `${REPO}/issues/${n}`])))
  const failed = issues.find(i => !i.ok)
  if (failed && !failed.ok) return failed
  return standaloneFeature(env, issues.flatMap(i => (i.ok ? [i.data] : [])))
}

/**
 * What a number is: the spec above it, or, with the issue itself, no spec above
 * it (the parent relation first, then the body's `Part of`).
 */
async function parentOf(env: SourceEnv, n: number): Promise<Gh<{ parent?: number; issue?: GhIssue }>> {
  // GitHub's own parent relation; a 404 says there is none, and the body may still say `Part of`.
  const parent = await gh<GhIssue>(env, ['api', `${REPO}/issues/${n}/parent`])
  if (parent.ok) return { ok: true, data: { parent: parent.data.number } }
  if (!parent.isMissing) return parent
  const issue = await gh<GhIssue>(env, ['api', `${REPO}/issues/${n}`])
  if (!issue.ok) return issue
  return { ok: true, data: { parent: parentOfBody(issue.data.body ?? ''), issue: issue.data } }
}

/**
 * The feature the numbers a skill named make: the first spec among them (a ticket
 * of a spec stands for its spec), or else all of them as standalone tickets.
 * Numbers that are not there, or are pull requests, are left out.
 */
async function loadNamed(env: SourceEnv, numbers: readonly number[]): Promise<LoadResult> {
  const standalones: GhIssue[] = []
  let all: Promise<Gh<GhIssue[]>> | undefined
  const listAll = () => (all ??= ghList<GhIssue>(env, `${REPO}/issues?state=all&per_page=100`))
  for (const n of numbers) {
    const found = await parentOf(env, n)
    if (!found.ok) {
      if (found.isMissing) continue
      return found
    }
    const { parent, issue } = found.data
    if (parent !== undefined) return loadSpec(env, parent)
    if (!issue || issue.pull_request !== undefined) continue
    const children = await childrenOf(env, n, listAll)
    if (!children.ok) return children
    if (children.data.length > 0) return loadSpec(env, n, children.data)
    standalones.push(issue)
  }
  if (standalones.length === 0) return { ok: false, reason: msg('ticketsNotFound', [...numbers]) }
  return standaloneFeature(env, standalones)
}

/** Every issue a skill's arguments name, in the order they appear: a URL, `#N`, or numbers alone. */
function numbersOfArgs(args: string): number[] {
  const alone = args.trim().match(/^\d+(?:[\s,]+\d+)*$/)
  return alone ? Array.from(new Set((args.match(/\d+/g) ?? []).map(Number))) : numbersOfText(args)
}

export const githubSource: TicketSource = {
  id: GITHUB_ID,
  label: msg('sourceGithub'),
  showsFailure: true,
  refreshSeconds: 30,

  async load(env, origin): Promise<LoadResult> {
    const parsed = parseOrigin(origin)
    if (parsed.kind === 'args') return loadNamed(env, parsed.numbers)
    if (parsed.kind === 'standalone') return loadStandalone(env, parsed.numbers)
    return loadSpec(env, parsed.number)
  },

  isStandalone: origin => parseOrigin(origin).kind === 'standalone',

  joinStandalone(a, b) {
    const [first, second] = [parseOrigin(a), parseOrigin(b)]
    return first.kind === 'standalone' && second.kind === 'standalone' ? standaloneOrigin(...first.numbers, ...second.numbers) : b
  },

  originOfArgs(args) {
    const numbers = numbersOfArgs(args)
    return numbers.length === 0 ? undefined : originOf({ kind: 'args', numbers })
  },

  originOfCommand(args) {
    return githubSource.originOfArgs(args)
  },

  refOfText(text, feature) {
    if (!feature) return undefined
    const own = new Set(feature.tickets.map(t => t.number))
    const n = numbersOfText(text).find(x => own.has(String(x)))
    return n === undefined ? undefined : { origin: feature.origin, ticket: String(n), number: String(n) }
  },

  mayNameTicket: text => numbersOfText(text).length > 0,

  async resolveRef(env, text): Promise<ResolveResult> {
    let failure: Msg | undefined
    for (const n of numbersOfText(text).slice(0, 3)) {
      const found = await parentOf(env, n)
      if (!found.ok) {
        failure ??= found.reason
        continue
      }
      const { parent, issue } = found.data
      const ref = { ticket: String(n), number: String(n) }
      if (parent !== undefined) return { ok: true, ref: { origin: originOf({ kind: 'spec', number: parent }), ...ref } }
      // No spec above it: an open issue (not a pull request) is a standalone ticket.
      if (issue?.state === 'open' && issue.pull_request === undefined) return { ok: true, ref: { origin: standaloneOrigin(n), ...ref } }
    }
    return failure === undefined ? { ok: true } : { ok: false, reason: failure }
  },

  mergedTicket(command, feature) {
    if (!feature) return undefined
    const branches = mergedBranches(command)
    if (branches === undefined) return undefined
    return feature.tickets.find(t => branches.some(b => new RegExp(`(?<!\\d)${t.number}(?!\\d)`).test(b)))?.number
  },

  changesTickets: command => /\bgh\s+issue\s+(?:close|reopen|edit)\b/.test(command),

  emptyText(origin) {
    const parsed = parseOrigin(origin)
    return parsed.kind === 'spec' ? msg('emptySpec', parsed.number) : msg('emptyStandalone')
  },
}
