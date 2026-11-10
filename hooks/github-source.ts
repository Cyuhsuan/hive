import type { Feature, Ticket } from '../types'
import { assignSteps, countChecks, mergedBranches } from './ticket-source'
import type { LoadResult, ResolveResult, SourceEnv, TicketSource } from './ticket-source'

// GitHub issues as tickets. A feature starts from a spec issue; its tickets are
// the spec's sub-issues, or else the issues whose body says `Part of #N`. Every
// call to GitHub goes through the logged-in `gh` CLI, and only from here.

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

export const githubSource: TicketSource = {
  id: GITHUB_ID,
  label: 'GitHub',
  showsFailure: true,
  refreshSeconds: 30,

  async load(env, origin): Promise<LoadResult> {
    const specNumber = Number(origin)
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

    const inBatch = new Set(children.map(c => c.number))
    // GitHub's own blocked-by relation first; the body's section when it has none.
    const natives = await Promise.all(children.map(issue => gh<GhIssue[]>(env, ['api', `${REPO}/issues/${issue.number}/dependencies/blocked_by`])))
    const failed = natives.find(n => !n.ok)
    if (failed && !failed.ok) return failed
    const tickets: Ticket[] = children.map((issue, i): Ticket => {
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

    const feature: Feature = {
      sourceId: GITHUB_ID,
      origin: String(specNumber),
      name: spec.data.title ?? `#${specNumber}`,
      tickets: assignSteps(tickets),
      merged: [],
      loadedAt: await env.now(),
    }
    return { ok: true, feature }
  },

  originOfArgs(args) {
    const url = args.match(/github\.com\/[^\s/]+\/[^\s/]+\/issues\/(\d+)/)?.[1]
    const hash = args.match(/(?<![\w/&])#(\d+)\b/)?.[1]
    const bare = args.trim().match(/^(\d+)$/)?.[1]
    return url ?? hash ?? bare
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
      const ref = (parent: number): ResolveResult => ({ ok: true, ref: { origin: String(parent), ticket: String(n), number: String(n) } })
      // GitHub's own parent relation; a 404 says there is none, and the body may still say `Part of`.
      const parent = await gh<GhIssue>(env, ['api', `${REPO}/issues/${n}/parent`])
      if (parent.ok) return ref(parent.data.number)
      if (!parent.isMissing) {
        failure ??= parent.reason
        continue
      }
      const issue = await gh<GhIssue>(env, ['api', `${REPO}/issues/${n}`])
      if (!issue.ok) {
        failure ??= issue.reason
        continue
      }
      const fromBody = parentOfBody(issue.data.body ?? '')
      if (fromBody !== undefined) return ref(fromBody)
    }
    return failure === undefined ? { ok: true } : { ok: false, reason: failure }
  },

  mergedTicket(command, feature) {
    if (!feature) return undefined
    const branches = mergedBranches(command)
    if (branches === undefined) return undefined
    return feature.tickets.find(t => branches.some(b => new RegExp(`(?<!\\d)${t.number}(?!\\d)`).test(b)))?.number
  },

  emptyText: origin => `#${origin} 底下沒有讀到票`,
}
