import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Swarm, SwarmAgent, SwarmLogLine } from '../types'
import { isLive } from './agent-phase'
import type { Workflow } from './workflow'

export const PANE = 'implement-swarm'
export const TITLE = 'Implement swarm'

export const EMPTY: Swarm = { mode: 'observe', agents: [], log: [] }

// Bump the tag when Swarm's fields change: an earlier version's value
// outlives a reload and is then read as EMPTY instead of crashing the pane.
const swarm = atom({ plugin: 'implement-swarm', key: 'swarm' } as const, EMPTY, {
  shape: 'swarm-5',
})

// The state library only reads an atom written in the file that reads it, so a
// module that does not hold the atom reads and writes it through these two.
export function readSwarm($: EngineInterface): Promise<Swarm> {
  return read($, swarm)
}

export async function updateSwarm($: EngineInterface, fn: (s: Swarm) => Swarm) {
  await update($, swarm, fn)
}

export async function log($: EngineInterface, who: string, text: string) {
  const at = await $.clock.now()
  const line: SwarmLogLine = { at, who, text }
  await update($, swarm, s => ({ ...s, log: [...s.log, line].slice(-60) }))
}

export async function patchAgent(
  $: EngineInterface,
  id: string,
  fn: (agent: SwarmAgent) => SwarmAgent,
) {
  await update($, swarm, s => ({
    ...s,
    agents: s.agents.map(a => (a.id === id ? fn(a) : a)),
  }))
}

function refreshStatus($: EngineInterface, s: Swarm, hasTickets: boolean) {
  if (s.mode === 'observe' && s.agents.length === 0) {
    $.ui.status(undefined)
    return
  }
  const live = s.agents.filter(isLive).length
  const done = s.agents.filter(a => a.phase === 'done').length
  const failed = s.agents.filter(a => a.phase === 'failed').length
  const f = hasTickets ? s.feature : undefined
  const feat = f && f.tickets.length ? ` · 票 ${f.tickets.filter(t => t.status === 'resolved').length}/${f.tickets.length}` : ''
  $.ui.status(`swarm ${live} 跑 · ${done} 完${failed ? ` · ${failed} 敗` : ''}${feat}`)
}

/** The workflow screen is up: a timing fired, and the workflow (or `/swarm <folder>`) is still wanted. */
export function isWorkflowShown(s: Swarm, workflow: Workflow | undefined): boolean {
  return s.mode === 'workflow' && (s.isManual === true || workflow !== undefined)
}

export async function status($: EngineInterface, workflow: Workflow | undefined) {
  const s = await read($, swarm)
  refreshStatus($, s, isWorkflowShown(s, workflow))
}
