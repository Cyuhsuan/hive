// The pane's own words, in the language the person chose. A language is one
// table of strings (`Strings`); every table must have every key, which the type
// checks. There is no falling back from one language to another at run time.
//
// What the pane says that must outlive a language change (the log, the ticket
// source's label, why a read failed) is kept in the state as a `Msg`: a code and
// its arguments, put into words by `say` when drawn.

import type { AgentPhase, Msg, MsgArgs, Say } from '../types'
import { en } from './strings-en'
import { ja } from './strings-ja'
import { zhTW } from './strings-zh-TW'

export type Language = 'en' | 'zh-TW' | 'ja'

/** An argument that may be a message arrives at its sentence already in words. */
type Rendered<T extends unknown[]> = { [I in keyof T]: Msg extends T[I] ? string : T[I] }

export type Strings = {
  phase: Record<AgentPhase, string>
  msg: { [K in keyof MsgArgs]: (...args: Rendered<MsgArgs[K]>) => string }
  commandDescription: string
  /** The reply to `/swarm`; `workflowLine` is the workflow's own line, when a workflow is applied. */
  paneOpened: (workflowLine: string | undefined) => string
  /** The status line: counts, and the ticket count once a feature is loaded. */
  statusLine: (live: number, done: number, failed: number, tickets: { done: number; total: number } | undefined) => string
  summary: (live: number, done: number, failed: number, elapsed: string | undefined) => string
  /** The summary under 40 columns. */
  summaryNarrow: (live: number, done: number, failed: number) => string
  noAgents: string
  workflowLine: (workflow: string, sourceLabel: string | undefined, failure: string | undefined) => string
  featureTail: (percent: string, done: number, total: number, step: number, steps: number) => string
  leadTally: (dispatched: number, merged: number | undefined) => string
  dispatchHint: string
  noAgentsYet: string
  hiddenDone: (n: number) => string
  allDone: string
  logEmpty: string
  toolCount: (n: number) => string
}

const TABLES: Record<Language, Strings> = { en, 'zh-TW': zhTW, ja }

/** The table a `language` option names; a value outside the options is none, so English. */
export function stringsOf(name: unknown): Strings {
  return typeof name === 'string' && Object.hasOwn(TABLES, name) ? TABLES[name as Language] : en
}

export function msg<K extends keyof MsgArgs>(code: K, ...args: MsgArgs[K]): Msg {
  return { code, args } as Msg
}

function isMsg(value: unknown): value is Msg {
  return typeof value === 'object' && value !== null && typeof (value as Msg).code === 'string' && Array.isArray((value as Msg).args)
}

/** Whether two sayings are the same, for "has this already been said". */
export function isSameSay(a: Say | undefined, b: Say | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A saying in words. Text an earlier version stored is shown as it was; a
 * message this version does not know is shown as nothing, so a state it cannot
 * read never breaks the pane.
 */
export function say(strings: Strings, value: Say | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (!isMsg(value)) return ''
  const make = strings.msg[value.code] as ((...args: unknown[]) => string) | undefined
  if (!make) return ''
  return make(...value.args.map(arg => (isMsg(arg) ? say(strings, arg) : arg)))
}
