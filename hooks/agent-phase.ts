// What a subagent is doing, read off its tool calls. Types only from the
// engine, so these can be tested without a mock.

import type { AgentPhase, SwarmAgent } from '../types'
import { shortType } from './text-format'
import { toPosix } from './ticket-source'

export const PHASE_PERCENT: Record<AgentPhase, number> = {
  spawned: 5,
  reading: 20,
  editing: 45,
  testing: 65,
  merging: 80,
  committing: 92,
  reviewing: 50,
  done: 100,
  failed: 100,
}

const TEST_RE = /\b(dotnet test|npm (run )?test|pnpm (run )?test|yarn test|vitest|jest|pytest|go test|cargo test|mvn test|gradle test)\b/
const MERGE_RE = /\bgit (merge|rebase|pull)\b/
const COMMIT_RE = /\bgit commit\b/

export function isLive(agent: SwarmAgent): boolean {
  return agent.phase !== 'done' && agent.phase !== 'failed'
}

export function phaseOfCall(agent: SwarmAgent, tool: string, args: Record<string, unknown>): AgentPhase {
  if (agent.phase === 'done' || agent.phase === 'failed') return agent.phase
  if (/review/i.test(agent.type)) return 'reviewing'
  if (tool === 'Bash') {
    const cmd = String(args['command'] ?? '')
    if (COMMIT_RE.test(cmd)) return 'committing'
    if (MERGE_RE.test(cmd)) return 'merging'
    if (TEST_RE.test(cmd)) return 'testing'
    return agent.phase === 'spawned' ? 'reading' : agent.phase
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'editing'
  if (/(edit|write|replace|insert)/i.test(tool.replace(/^mcp__[^_]+__/, ''))) return 'editing'
  if (typeof args['code'] === 'string' && /\.edit\./.test(args['code'])) return 'editing'
  return agent.phase === 'spawned' ? 'reading' : agent.phase
}

export function describeCall(tool: string, args: Record<string, unknown>): string {
  const name = tool.replace(/^mcp__[^_]+__/, '')
  const path = args['file_path'] ?? args['path'] ?? args['notebook_path']
  if (typeof path === 'string') return `${name} ${toPosix(path).split('/').slice(-2).join('/')}`
  if (tool === 'Bash') return `$ ${String(args['command'] ?? '').replace(/\s+/g, ' ')}`
  if (typeof args['pattern'] === 'string') return `${name} /${args['pattern']}/`
  if (typeof args['skill'] === 'string') return `${name} ${args['skill']}`
  if (typeof args['description'] === 'string') return `${name} ${args['description']}`
  return name
}

export function whoOf(agent: SwarmAgent | undefined): string {
  if (!agent) return 'lead'
  return agent.ticket ?? shortType(agent.type)
}
