// Animation says a subagent is at work, and nothing else: with none live (and
// no bee still returning to the hive) the pane is still. A frame is read off the clock, so nothing about it is kept.
// No engine API here, so these can be tested without a mock.

import type { SwarmAgent } from '../types'
import { ACCENT } from './accent'

const FRAME_MS = 120
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// One pass of the feature bar's light over its filled cells, however many.
const SWEEP_MS = 2000
// The light is a soft band: full at its middle, fading to the bar's own color
// this many cells either side. Where it sits between two cells, both glow in part.
const GLOW_REACH = 3
// The bar's own color (the accent), and the light at its brightest; a cell is
// tinted somewhere between the two.
const channelsOf = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const GLOW_FROM = channelsOf(ACCENT)
const GLOW_PEAK = '#f3e8ff'
const GLOW_TO = channelsOf(GLOW_PEAK)
const GLOW_SHADES = 8

/** The spinner's glyph at `now`: every card and ticket at work draws the same one. */
export function spinnerAt(now: number): string {
  return SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length]!
}

/** The bee: two cells wide. */
export const BEE = '🐝'
/** A stretch of the hive's frame, `length` cells of honeycomb: full and empty cells by turns, `shift` moving which comes first. */
export function comb(length: number, shift = 0): string {
  return Array.from({ length: Math.max(0, length) }, (_, i) => ((i + shift) % 2 === 0 ? '⬢' : '⬡')).join('')
}
/** One lap of a bee along the top of its card: out to the far end and back. */
export const BEE_LAP_MS = 4000
/** How long a finished subagent's bee takes to leave its card. */
export const RETURN_MS = 1000

/** The bee's column along a card's top edge at `now`: 0 to `span`, out and back once a lap. */
export function beeLeft(now: number, span: number): number {
  const lap = (now % BEE_LAP_MS) / BEE_LAP_MS
  return Math.round((lap < 0.5 ? lap * 2 : 2 - lap * 2) * span)
}

/** How far the bee is through its return, 0 at the subagent's finish and 1 once it is gone. */
export function returnProgress(now: number, endedAt: number): number {
  return Math.min(1, Math.max(0, (now - endedAt) / RETURN_MS))
}

/** A subagent that finished, not failed, a moment ago: its bee is still on its way home. */
export function isReturning<A extends Pick<SwarmAgent, 'phase' | 'endedAt'>>(a: A, now: number): a is A & { endedAt: number } {
  return a.phase === 'done' && a.endedAt !== undefined && returnProgress(now, a.endedAt) < 1
}

/** The returning bee's column: from where it flew at the finish to `edge`, past the card. */
export function returnLeft(now: number, endedAt: number, span: number, edge: number): number {
  const from = beeLeft(endedAt, span)
  return Math.round(from + (edge - from) * returnProgress(now, endedAt))
}

/** A stretch of bar cells drawn alike; `glow` is the tint of lit cells, absent for the bar's own color. */
type BarRun = { text: string; glow?: string }

/**
 * A bar whose filled cells a band of light crosses left to right, once every
 * SWEEP_MS: it rises at the left end, glides at a steady pace and fades out
 * past the filled cells' last one, never lighting an empty cell.
 */
export function sweptBar(percent: number, width: number, now: number): BarRun[] {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  // The band's middle, in cells: from wholly before the first cell to wholly after the last.
  const middle = ((now % SWEEP_MS) / SWEEP_MS) * (filled + 2 * GLOW_REACH) - GLOW_REACH
  const runs: BarRun[] = []
  for (let i = 0; i < filled; i++) {
    const near = Math.max(0, 1 - Math.abs(i + 0.5 - middle) / GLOW_REACH)
    // Eased, so the band has a soft shoulder instead of a tent's point.
    const shade = Math.round(near * near * (3 - 2 * near) * GLOW_SHADES)
    const glow = shade === 0 ? undefined : tint(shade / GLOW_SHADES)
    const last = runs[runs.length - 1]
    if (last && last.glow === glow) last.text += '█'
    else runs.push({ text: '█', glow })
  }
  if (width > filled) runs.push({ text: '░'.repeat(width - filled) })
  return runs
}

function tint(amount: number): string {
  return '#' + GLOW_FROM.map((from, i) => Math.round(from + (GLOW_TO[i]! - from) * amount).toString(16).padStart(2, '0')).join('')
}
