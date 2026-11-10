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

export type SwarmLogLine = { at: number; who: string; text: string }

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
  name: string
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
  sourceLabel?: string
  /** The id of that ticket source, when it is one the workflow reads. */
  sourceId?: string
  /** Why the last load failed, as the status line says it after the label; the tickets loaded before stay. */
  loadFailure?: string
  /** Why no tickets are loaded, when the workflow cannot read tickets from the ticket source. */
  noTicketsReason?: string
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
