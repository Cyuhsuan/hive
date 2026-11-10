import type { EngineInterface } from 'claude-code'

import type { Swarm } from '../types'
import { isWorkflowShown, log, readSwarm, updateSwarm } from './swarm-state'
import { ticketName } from './ticket-source'
import type { SourceEnv, TicketRef, TicketSource } from './ticket-source'
import { sourceById } from './workflow'
import type { SourceChoice, Workflow } from './workflow'

export function envOf($: EngineInterface): SourceEnv {
  return {
    fs: { list: p => $.fs.list(p), read: p => $.fs.read(p) },
    now: () => $.clock.now(),
    run: argv => $.process.run(argv),
  }
}

// A spawn does not ask a failing source again within this long.
export const RETRY_AFTER_MS = 10_000

/** The workflow's own line: which workflow, which ticket source, and why its tickets could not be read. */
export function workflowLine(workflow: Workflow, s: Swarm): string {
  return `工作流 ${workflow.name} · 票來源 ${s.sourceLabel ?? '尚未判斷'}${s.loadFailure ? `（${s.loadFailure}）` : ''}`
}

/** Reads the project's tracker setting afresh and says which ticket source it names. */
export function chooseSource($: EngineInterface, workflow: Workflow): Promise<SourceChoice> {
  return workflow.chooseSource({ read: p => $.fs.read(p) })
}

/** Tells the person a source could not be read: the status line says why, and the log once. The tickets already loaded stay. */
export async function reportFailure($: EngineInterface, source: TicketSource, origin: string | undefined, reason: string) {
  const at = await $.clock.now()
  const before = (await readSwarm($)).loadFailure
  await updateSwarm($, s => ({
    ...s,
    loadFailure: reason,
    pending: origin !== undefined && !s.feature ? { sourceId: source.id, origin } : s.pending,
    failedAt: at,
  }))
  if (before !== reason) await log($, 'lead', `票來源讀取失敗：${reason}`)
}

/**
 * No feature is loaded and the prompt may name a ticket whose spec has to be
 * looked up (a GitHub issue's parent). Asks the ticket source, if it can.
 */
export async function resolveUnloaded($: EngineInterface, workflow: Workflow, text: string, now: number, s: Swarm): Promise<TicketRef | undefined> {
  if (s.failedAt !== undefined && now - s.failedAt < RETRY_AFTER_MS) return undefined
  // A source known not to look anything up is not asked for again: the setting is read once.
  if (s.sourceId !== undefined && !sourceById(s.sourceId, workflow).resolveRef) return undefined
  const choice = await chooseSource($, workflow)
  await updateSwarm($, cur => ({ ...cur, sourceId: choice.source?.id ?? cur.sourceId, sourceLabel: choice.label }))
  const source = choice.source
  if (!source?.resolveRef) return undefined
  const found = await source.resolveRef(envOf($), text)
  if (!found.ok) {
    await reportFailure($, source, undefined, found.reason)
    return undefined
  }
  return found.ref
}

/** Reads the tracker setting afresh and records which ticket source it names. */
export async function pickSource($: EngineInterface, workflow: Workflow | undefined): Promise<SourceChoice | undefined> {
  if (!workflow) return undefined
  const choice = await chooseSource($, workflow)
  const reason = choice.source ? undefined : choice.reason
  const before = (await readSwarm($)).noTicketsReason
  await updateSwarm($, s => ({
    ...s,
    sourceLabel: choice.label,
    sourceId: choice.source?.id,
    // a failure belongs to the source that had it
    loadFailure: s.sourceId === choice.source?.id ? s.loadFailure : undefined,
    noTicketsReason: reason,
  }))
  if (reason && reason !== before) await log($, 'lead', reason)
  return choice
}

/**
 * Loads the feature at `origin` and logs what it found, or what turned resolved
 * since the last read. Says whether the workflow screen may be up: it may not
 * when a source that tells its failures failed, since nothing was read.
 */
export async function loadFeature($: EngineInterface, source: TicketSource, origin: string): Promise<boolean> {
  const before = (await readSwarm($)).feature
  const result = await source.load(envOf($), origin)
  if (!result.ok) {
    if (!source.showsFailure) return true
    await reportFailure($, source, origin, result.reason)
    return false
  }
  const loaded = result.feature
  await updateSwarm($, cur => ({
    ...cur,
    feature: { ...loaded, merged: cur.feature?.origin === origin ? cur.feature.merged : [] },
    pending: undefined,
    failedAt: undefined,
    loadFailure: undefined,
  }))
  if (before && before.origin === origin) {
    for (const t of loaded.tickets) {
      const old = before.tickets.find(o => o.number === t.number)
      if (old && old.status !== 'resolved' && t.status === 'resolved') {
        await log($, ticketName(t), `票面 Status → resolved（${t.checked}/${t.checks} 驗收）`)
      }
    }
  } else {
    const steps = Math.max(0, ...loaded.tickets.map(t => t.step))
    await log($, 'lead', `讀到 ${loaded.name}：${loaded.tickets.length} 張票 · ${steps} 個時間步`)
  }
  return true
}

/** The workflow screen goes up; `isManual` when it is `/swarm <folder>` with no workflow. */
export async function enterWorkflow($: EngineInterface, isManual: boolean) {
  await updateSwarm($, (s): Swarm => ({ ...s, mode: 'workflow', isManual: isManual ? true : undefined }))
}

/** Reads again what is already loaded, or what a failed load was reading; a read that now succeeds brings the workflow screen up. */
export async function refreshFeature($: EngineInterface, workflow: Workflow | undefined) {
  const s = await readSwarm($)
  const target = s.feature ?? s.pending
  if (!target) return
  const isLoaded = await loadFeature($, sourceById(target.sourceId, workflow), target.origin)
  if (isLoaded && !s.feature) await enterWorkflow($, false)
}

/** Reads the tickets at `origin`; the workflow screen goes up unless the read failed. */
export async function openFeature($: EngineInterface, source: TicketSource, origin: string, isManual: boolean) {
  if (await loadFeature($, source, origin)) await enterWorkflow($, isManual)
}

/** The ticket a prompt points at, and the ticket source to load its feature from when that is not the one on the screen. */
export type PromptTicket = {
  ticket?: string
  ticketNumber?: string
  /** Set when the pointed-at ticket's feature is not loaded: where to read it. */
  loadFrom?: TicketSource
  /** Where in `loadFrom` the feature is. */
  origin?: string
}

/**
 * Which ticket the prompt points at: in the loaded feature's source, or in any
 * of the workflow's while none is loaded. `s` is the panel state before the
 * spawn is recorded; `now` is the clock then.
 */
export async function ticketOfPrompt($: EngineInterface, prompt: string, s: Swarm, workflow: Workflow | undefined, now: number): Promise<PromptTicket> {
  const shown = isWorkflowShown(s, workflow)
  const sources = shown && s.feature ? [sourceById(s.feature.sourceId, workflow)] : (workflow?.sources ?? [])
  let ref: TicketRef | undefined
  for (const src of sources) ref ??= src.refOfText(prompt, s.feature)
  if (!ref && !(shown && s.feature) && workflow?.sources.some(src => src.mayNameTicket?.(prompt))) ref = await resolveUnloaded($, workflow, prompt, now, s)

  if (!ref) return {}
  if (shown && s.feature?.origin === ref.origin) return { ticket: ref.ticket, ticketNumber: ref.number }
  if (!workflow) return {}
  // A ticket pointed at: the ticket source setting is read afresh before any tickets are.
  const choice = await pickSource($, workflow)
  if (!choice?.source) return {}
  return { ticket: ref.ticket, ticketNumber: ref.number, loadFrom: choice.source, origin: ref.origin }
}
