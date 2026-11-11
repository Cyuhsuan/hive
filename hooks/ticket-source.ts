import type { Feature, Msg, Ticket } from '../types'
import { msg } from './i18n'

// A ticket source is where a feature's tickets live. The pane talks to it
// through this interface alone, so a source whose tickets are not files (a
// GitHub issue: loaded over the network, can fail, number not zero-padded) fits
// beside the local markdown one.

/** Which ticket a piece of text points at, and the origin that ticket belongs to. */
export type TicketRef = {
  /** What `load` starts from: for local markdown, the issues folder. */
  origin: string
  /** The ticket's identity as the pane names it: `03-login-api`, `12`. */
  ticket: string
  /** The ticket's number as the feature lists it: `03`, `12`. */
  number: string
}

/** What a source may use from the engine: reading, the clock, and (for a source that talks to a CLI) running a command. */
export type SourceEnv = {
  /** Runs a command by its argument vector (no shell); rejects when it cannot start. */
  run?(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>
  fs: {
    list(path: string): Promise<ReadonlyArray<{ name: string; kind: string }>>
    read(path: string): Promise<string>
  }
  now(): Promise<number>
}

export type LoadResult = { ok: true; feature: Feature } | { ok: false; reason: Msg }

/** What a prompt points at when the point must be looked up: the ticket, or why it could not be. */
export type ResolveResult = { ok: true; ref?: TicketRef } | { ok: false; reason: Msg }

export interface TicketSource {
  /** Stored on a `Feature`, so the pane finds its source again. */
  readonly id: string
  /** How the workflow's status line names this source. */
  readonly label: Msg
  /** Whether a failed load is told to the person (a remote source can fail; a folder just has no tickets). */
  readonly showsFailure: boolean
  /** Seconds between the re-reads while a subagent runs. */
  readonly refreshSeconds: number
  /**
   * Loads the feature at `origin`; asynchronous, and may fail with a reason. The
   * feature's own `origin` may differ from the one asked for (an origin made of
   * the numbers a skill named is sorted into a spec or a standalone feature).
   */
  load(env: SourceEnv, origin: string): Promise<LoadResult>
  /** Whether a feature's origin names a feature of standalone tickets (no spec above them). */
  isStandalone?(origin: string): boolean
  /** The origin of the standalone feature that has the tickets of both `a` and `b`; `b` when they are not both standalone. */
  joinStandalone?(a: string, b: string): string
  /** The origin a skill's arguments name, if any; it may name several tickets. */
  originOfArgs(args: string): string | undefined
  /** The origin the text after `/swarm` names, if any; a source may take the whole text as one. */
  originOfCommand(args: string): string | undefined
  /** The ticket a prompt or text points at; `feature` is the one already loaded, if any. */
  refOfText(text: string, feature?: Feature): TicketRef | undefined
  /** A cheap check, before anything is read: could `text` name a ticket to look up? */
  mayNameTicket?(text: string): boolean
  /**
   * Asks the source which ticket a prompt points at when no feature is loaded
   * yet, and which origin it belongs to. Only a source that has to look it up has it.
   */
  resolveRef?(env: SourceEnv, text: string): Promise<ResolveResult>
  /** The ticket the lead's shell command merges into the integration branch, if any; `feature` is the one loaded. */
  mergedTicket(command: string, feature?: Feature): string | undefined
  /** Whether the lead's shell command changes the tickets themselves (a GitHub issue closed, reopened, edited), so they are read again once it succeeds. */
  changesTickets?(command: string): boolean
  /** What the pane says when the feature at `origin` has no tickets. */
  emptyText(origin: string): Msg
}

/** The numbers of an acceptance list: `- [ ]` and `- [x]` items. */
export function countChecks(text: string): { checks: number; checked: number } {
  return {
    checks: (text.match(/^\s*- \[[ xX]\]/gm) ?? []).length,
    checked: (text.match(/^\s*- \[[xX]\]/gm) ?? []).length,
  }
}

// ------------------------------------------------------- local markdown

// `.scratch/<feature>/issues/03-login-api.md` → dir `.scratch/<feature>/issues`, ticket `03-login-api`
const TICKET_PATH_RE = /((?:[^\s`'"()<>]*\/)?issues)\/(\d+)(-[^\s`'"()<>]*?)?\.md/
const TICKET_FILE_RE = /^(\d+)(?:-(.*))?\.md$/

/** How the pane names a ticket: `03-login-api` for a ticket with a slug, else its number. */
export const ticketName = (ticket: Pick<Ticket, 'number' | 'slug'>): string =>
  ticket.slug ? `${ticket.number}-${ticket.slug}` : ticket.number

// Options of `git merge` whose next word is their value, not a branch.
const MERGE_VALUE_OPTIONS = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name'])

/**
 * The branches a `git merge` in `command` names, or undefined when it has no
 * such command. Options and their values (a `-m` message) are not branches.
 */
export function mergedBranches(command: string): string[] | undefined {
  const at = command.match(/\bgit merge\b/)
  if (at?.index === undefined) return undefined
  const words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (const ch of command.slice(at.index + at[0].length)) {
    if (quote) {
      if (ch === quote) quote = undefined
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      word ??= ''
    } else if (ch === '\n' || ch === ';' || ch === '&' || ch === '|') {
      break
    } else if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else {
      word = (word ?? '') + ch
    }
  }
  if (word !== undefined) words.push(word)
  const branches: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (MERGE_VALUE_OPTIONS.has(w)) i += 1
    else if (!w.startsWith('-')) branches.push(w)
  }
  return branches
}

/** Paths are matched with `/` only, so a Windows path is read the same way. */
export const toPosix = (text: string): string => text.replace(/\\/g, '/')

export function parseTicket(name: string, text: string): Ticket | undefined {
  const file = name.match(TICKET_FILE_RE)
  if (!file) return undefined
  const number = file[1]!
  const slug = file[2] ?? ''
  const title = text.match(/^#\s*\d+\s*[:：]\s*(.+?)\s*$/m)?.[1] ?? slug
  const blockedLine = text.match(/\*\*Blocked by:?\*\*:?\s*(.*)/i)?.[1] ?? ''
  const blockedBy = /none/i.test(blockedLine)
    ? []
    : Array.from(new Set((blockedLine.match(/\b\d{1,3}\b/g) ?? []).map(n => n.padStart(number.length, '0'))))
  const status = (text.match(/\*\*Status:?\*\*:?\s*([^\s*]+)/i)?.[1] ?? 'unknown').toLowerCase()
  const { checks, checked } = countChecks(text)

  return { number, slug, title, blockedBy, status, checked, checks, step: 1 }
}

/** Gives each ticket its time-step: one later than every ticket that blocks it. */
export function assignSteps(tickets: Ticket[]): Ticket[] {
  const byNumber = new Map(tickets.map(t => [t.number, t]))
  const depth = new Map<string, number>()
  const visit = (t: Ticket, seen: Set<string>): number => {
    const known = depth.get(t.number)
    if (known !== undefined) return known
    if (seen.has(t.number)) return 1
    seen.add(t.number)
    let d = 1
    for (const b of t.blockedBy) {
      const blocker = byNumber.get(b)
      if (blocker) d = Math.max(d, visit(blocker, seen) + 1)
    }
    depth.set(t.number, d)
    return d
  }
  return tickets
    .map(t => ({ ...t, step: visit(t, new Set()) }))
    .sort((a, b) => a.step - b.step || a.number.localeCompare(b.number, undefined, { numeric: true }))
}

/** The issues folder a spec path implies: `.scratch/<feature>/spec.md` → `.scratch/<feature>/issues`. */
function issuesDirOfArgs(raw: string): string | undefined {
  const args = toPosix(raw)
  const direct = args.match(/([^\s`'"()<>]*\/issues)(?:\/|\b)/)?.[1]
  if (direct) return direct
  const spec = args.match(/([^\s`'"()<>]+)\/(?:spec|design)\.md/)?.[1]
  if (spec) return `${spec}/issues`
  const scratch = args.match(/(\.scratch\/[^\s/`'"()<>]+)/)?.[1]
  return scratch ? `${scratch}/issues` : undefined
}

const MARKDOWN_ID = 'local-markdown'

export const markdownSource: TicketSource = {
  id: MARKDOWN_ID,
  label: msg('sourceLocal'),
  showsFailure: false,
  refreshSeconds: 10,

  async load(env, issuesDir) {
    let entries
    try {
      entries = await env.fs.list(issuesDir)
    } catch {
      return { ok: false, reason: msg('folderUnreadable', issuesDir) }
    }
    const files = entries.filter(e => e.kind === 'file' && TICKET_FILE_RE.test(e.name))
    const tickets: Ticket[] = []
    for (const file of files) {
      try {
        const text = await env.fs.read(`${issuesDir}/${file.name}`)
        const ticket = parseTicket(file.name, text)
        if (ticket) tickets.push(ticket)
      } catch {
        // a ticket that cannot be read is left out of the graph
      }
    }
    const parts = issuesDir.replace(/\/+$/, '').split('/')
    const name = parts[parts.length - 2] ?? parts[parts.length - 1] ?? issuesDir

    return {
      ok: true,
      feature: {
        sourceId: MARKDOWN_ID,
        origin: issuesDir,
        name,
        tickets: assignSteps(tickets),
        merged: [],
        loadedAt: await env.now(),
      },
    }
  },

  originOfArgs: issuesDirOfArgs,

  // A folder is what is left of the text when no spec path is found in it.
  originOfCommand: args => issuesDirOfArgs(args) ?? args,

  refOfText(text) {
    const m = toPosix(text).match(TICKET_PATH_RE)
    if (!m) return undefined
    return { origin: m[1]!, ticket: `${m[2]}${m[3] ?? ''}`, number: m[2]! }
  },

  mergedTicket(command) {
    return command.match(/\bgit merge\b[^\n]*?ticket-(\d+)/)?.[1]
  },

  emptyText: origin => msg('emptyFolder', origin),
}
