import type { Feature, Ticket } from '../types'
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
type Gh<T> = { ok: true; data: T } | { ok: false; reason: string; isMissing?: boolean }

const REPO = 'repos/{owner}/{repo}'

/** A short, human reason a `gh` call failed. */
function reasonOf(exitCode: number, stderr: string): string {
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401|bad credentials/i.test(stderr)) return '`gh` 未登入'
  if (/could not resolve|connection|network|timeout|timed out|dial tcp|offline|no such host/i.test(stderr)) return '`gh` 連不上 GitHub'
  const first = stderr.split('\n').find(l => l.trim() !== '')?.trim() ?? `exit ${exitCode}`
  return `\`gh\` 呼叫失敗：${first.length > 60 ? `${first.slice(0, 59)}…` : first}`
}

/** Runs `gh <args>` and parses its JSON; never throws. */
async function gh<T>(env: SourceEnv, args: readonly string[]): Promise<Gh<T>> {
  if (!env.run) return { ok: false, reason: '`gh` 無法執行' }
  let result
  try {
    result = await env.run(['gh', ...args])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: /ENOENT|not found|no such file|cannot find|spawn/i.test(message) ? '`gh` 不存在' : '`gh` 無法執行' }
  }
  if (result.exitCode !== 0) {
    return { ok: false, reason: reasonOf(result.exitCode, result.stderr), isMissing: /\(HTTP 404\)/.test(result.stderr) }
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T }
  } catch {
    return { ok: false, reason: '`gh` 回傳的內容讀不懂' }
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
// skill's arguments named: `load` sorts it into one of the other two.
const STANDALONE_PREFIX = 'standalone:'
const ARGS_PREFIX = 'args:'
const STANDALONE_NAME = '獨立票'

const numbersOfOrigin = (origin: string, prefix: string): number[] =>
  origin.slice(prefix.length).split(',').filter(n => n !== '').map(Number)

const standaloneOrigin = (numbers: readonly number[]): string => `${STANDALONE_PREFIX}${Array.from(new Set(numbers)).join(',')}`

/** The tickets of `issues` as one batch: their blockers (inside the batch only) and time-steps. */
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

async function loadSpec(env: SourceEnv, specNumber: number): Promise<LoadResult> {
  const spec = await gh<GhIssue>(env, ['api', `${REPO}/issues/${specNumber}`])
  if (!spec.ok) return spec

  // A failing call fails the whole load; only an empty answer falls back.
  const subs = await ghList<GhIssue>(env, `${REPO}/issues/${specNumber}/sub_issues?per_page=100`)
  if (!subs.ok) return subs
  let children = subs.data
  if (children.length === 0) {
    // No sub-issues: the issues that say they are part of the spec.
    const all = await ghList<GhIssue>(env, `${REPO}/issues?state=all&per_page=100`)
    if (!all.ok) return all
    children = all.data.filter(i => i.pull_request === undefined && i.number !== specNumber && parentOfBody(i.body ?? '') === specNumber)
  }

  const tickets = await ticketsOf(env, children)
  if (!tickets.ok) return tickets
  const feature: Feature = {
    sourceId: GITHUB_ID,
    origin: String(specNumber),
    name: spec.data.title ?? `#${specNumber}`,
    tickets: tickets.data,
    merged: [],
    loadedAt: await env.now(),
  }
  return { ok: true, feature }
}

/** The standalone batch of `issues`, already read. */
async function standaloneBatch(env: SourceEnv, issues: readonly GhIssue[]): Promise<LoadResult> {
  const tickets = await ticketsOf(env, issues)
  if (!tickets.ok) return tickets
  const feature: Feature = {
    sourceId: GITHUB_ID,
    origin: standaloneOrigin(issues.map(i => i.number)),
    name: STANDALONE_NAME,
    tickets: tickets.data,
    merged: [],
    loadedAt: await env.now(),
  }
  return { ok: true, feature }
}

async function loadStandalone(env: SourceEnv, numbers: readonly number[]): Promise<LoadResult> {
  const issues = await Promise.all(numbers.map(n => gh<GhIssue>(env, ['api', `${REPO}/issues/${n}`])))
  const failed = issues.find(i => !i.ok)
  if (failed && !failed.ok) return failed
  return standaloneBatch(env, issues.flatMap(i => (i.ok ? [i.data] : [])))
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
 * The batch the numbers a skill named make: the first spec among them (a ticket
 * of a spec stands for its spec), or else all of them as standalone tickets.
 * Numbers that are not there, or are pull requests, are left out.
 */
async function loadNamed(env: SourceEnv, numbers: readonly number[]): Promise<LoadResult> {
  const standalones: GhIssue[] = []
  let all: Gh<GhIssue[]> | undefined
  for (const n of numbers) {
    const found = await parentOf(env, n)
    if (!found.ok) {
      if (found.isMissing) continue
      return found
    }
    const { parent, issue } = found.data
    if (parent !== undefined) return loadSpec(env, parent)
    if (!issue || issue.pull_request !== undefined) continue
    const subs = await ghList<GhIssue>(env, `${REPO}/issues/${n}/sub_issues?per_page=100`)
    if (!subs.ok) return subs
    let isSpec = subs.data.length > 0
    if (!isSpec) {
      all ??= await ghList<GhIssue>(env, `${REPO}/issues?state=all&per_page=100`)
      if (!all.ok) return all
      isSpec = all.data.some(i => i.pull_request === undefined && i.number !== n && parentOfBody(i.body ?? '') === n)
    }
    if (isSpec) return loadSpec(env, n)
    standalones.push(issue)
  }
  if (standalones.length === 0) return { ok: false, reason: `讀不到票：${numbers.map(n => `#${n}`).join('、')} 不存在或是 PR` }
  return standaloneBatch(env, standalones)
}

/** Every issue a skill's arguments name, in the order they appear: a URL, `#N`, or numbers alone. */
function numbersOfArgs(args: string): number[] {
  const alone = args.trim().match(/^\d+(?:[\s,]+\d+)*$/)
  return alone ? Array.from(new Set((args.match(/\d+/g) ?? []).map(Number))) : numbersOfText(args)
}

export const githubSource: TicketSource = {
  id: GITHUB_ID,
  label: 'GitHub',
  showsFailure: true,
  refreshSeconds: 30,

  async load(env, origin): Promise<LoadResult> {
    if (origin.startsWith(ARGS_PREFIX)) return loadNamed(env, numbersOfOrigin(origin, ARGS_PREFIX))
    if (origin.startsWith(STANDALONE_PREFIX)) return loadStandalone(env, numbersOfOrigin(origin, STANDALONE_PREFIX))
    return loadSpec(env, Number(origin))
  },

  isStandalone: origin => origin.startsWith(STANDALONE_PREFIX),

  addToStandalone: (origin, ticket) => standaloneOrigin([...numbersOfOrigin(origin, STANDALONE_PREFIX), Number(ticket)]),

  originOfArgs(args) {
    const numbers = numbersOfArgs(args)
    return numbers.length === 0 ? undefined : `${ARGS_PREFIX}${numbers.join(',')}`
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
    let failure: string | undefined
    for (const n of numbersOfText(text).slice(0, 3)) {
      const found = await parentOf(env, n)
      if (!found.ok) {
        failure ??= found.reason
        continue
      }
      const { parent, issue } = found.data
      const ref = { ticket: String(n), number: String(n) }
      if (parent !== undefined) return { ok: true, ref: { origin: String(parent), ...ref } }
      // No spec above it: an open issue (not a pull request) is a standalone ticket.
      if (issue?.state === 'open' && issue.pull_request === undefined) {
        return { ok: true, ref: { origin: standaloneOrigin([n]), ...ref, isStandalone: true } }
      }
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

  emptyText: origin => (origin.startsWith(STANDALONE_PREFIX) ? '沒有讀到獨立票' : `#${origin} 底下沒有讀到票`),
}
