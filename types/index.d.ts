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
  ticket?: string
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

/** One ticket file of the feature: `issues/NN-slug.md`. */
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
  /** The issues folder, relative to the working directory or absolute. */
  issuesDir: string
  name: string
  tickets: Ticket[]
  /** Ticket numbers the lead has merged into the integration branch. */
  merged: string[]
  loadedAt: number
}

export type Swarm = {
  startedAt?: number
  leadModel?: string
  isActive: boolean
  agents: SwarmAgent[]
  log: SwarmLogLine[]
  feature?: Feature
}

declare module 'claude-code' {
  interface PluginState {
    'implement-swarm': { swarm: Shaped<Swarm> }
  }
}
