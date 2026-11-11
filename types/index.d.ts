export type AgentPhase =
  | 'spawned'
  | 'reading'
  | 'editing'
  | 'testing'
  | 'merging'
  | 'committing'
  | 'reviewing'
  | 'done'
  | 'failed'

export type SwarmAgent = {
  id: string
  type: string
  description: string
  model: string
  /** The ticket the prompt pointed at, as the pane names it (`03-login-api`, `12`). */
  ticket?: string
  /** That ticket's number as the feature lists it (`03`, `12`). */
  ticketNumber?: string
  isBackground: boolean
  phase: AgentPhase
  tools: number
  errors: number
  lastTool?: string
  startedAt: number
  endedAt?: number
  tokens?: number
  parentId?: string
}

/**
 * What the pane says that is its own words, kept as a code and its arguments so
 * the language is chosen when it is drawn, not when it is stored. An argument
 * that is a `Say` may itself be a message; any other is a plain value.
 */
export type MsgArgs = {
  // session log
  spawned: [type: string, model: string, isBackground: boolean]
  phaseMoved: [phase: AgentPhase]
  ticketMerged: [ticket: string]
  /** `reason` is empty for an ordinary answer. */
  agentEnded: [isFailed: boolean, duration: string, tools: number, reason: string]
  sourceReadFailed: [reason: Say]
  ticketResolved: [checked: number, checks: number]
  featureRead: [name: Say, tickets: number, steps: number]
  workflowStarted: [skill: string]
  // ticket sources: labels, why no tickets, why a read failed, what an empty batch says
  sourceLocal: []
  sourceGithub: []
  sourceGitlab: []
  sourceUnrecognized: []
  gitlabUnsupported: []
  trackerUnrecognized: [file: string]
  folderUnreadable: [folder: string]
  needSpecRef: []
  ghNotLoggedIn: []
  ghOffline: []
  /** `first` is the first line of what `gh` said, as it said it. */
  ghFailed: [first: string]
  ghCannotRun: []
  ghMissing: []
  ghUnreadable: []
  ticketsNotFound: [numbers: number[]]
  emptyFolder: [folder: string]
  emptySpec: [number: number]
  emptyStandalone: []
  standaloneName: []
}

export type Msg = { [K in keyof MsgArgs]: { code: K; args: MsgArgs[K] } }[keyof MsgArgs]

/** A message, or the text an earlier version stored, which is shown as it was. */
export type Say = string | Msg

export type SwarmLogLine = { at: number; who: string; text: Say }

/** One ticket of the feature; for local markdown, the file `issues/NN-slug.md`; for GitHub, an issue (`slug` empty, `number` not padded). */
export type Ticket = {
  number: string
  slug: string
  title: string
  blockedBy: string[]
  /** The file's `**Status:**` line, lower-cased (`ready-for-agent`, `resolved`, ...). */
  status: string
  checked: number
  checks: number
  /** Topological depth in the task graph: 1 for a ticket with no blockers. */
  step: number
}

export type Feature = {
  /** The id of the ticket source that loaded it. */
  sourceId: string
  /** What the source loaded from: for local markdown, the issues folder (relative or absolute); for GitHub, the spec issue's number, or `standalone:<n>,<n>` for the standalone tickets of one piece of work. */
  origin: string
  name: Say
  tickets: Ticket[]
  /** Ticket numbers the lead has merged into the integration branch. */
  merged: string[]
  loadedAt: number
}

export type Swarm = {
  startedAt?: number
  leadModel?: string
  /**
   * `observe`: subagents are recorded, no tickets. `workflow`: a workflow was
   * applied (a timing fired), so the tickets are read and drawn.
   */
  mode: 'observe' | 'workflow'
  /** The workflow screen came from `/swarm <folder>` under `none`, not from a workflow. */
  isManual?: boolean
  agents: SwarmAgent[]
  log: SwarmLogLine[]
  feature?: Feature
  /** The ticket source the tracker setting named, as the status line says it. */
  sourceLabel?: Say
  /** The id of that ticket source, when it is one the workflow reads. */
  sourceId?: string
  /** Why the last load failed, as the status line says it after the label; the tickets loaded before stay. */
  loadFailure?: Say
  /** Why no tickets are loaded, when the workflow cannot read tickets from the ticket source. */
  noTicketsReason?: Say
  /**
   * What a source that failed to load was reading, so a scheduled re-read tries
   * it again when no feature is loaded yet.
   */
  pending?: { sourceId: string; origin: string }
  /** When the last failed load happened; a spawn does not try again at once. */
  failedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    hive: { swarm: Shaped<Swarm> }
  }
}
