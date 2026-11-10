// Animation says a subagent is at work, and nothing else: with none live the
// pane is still. A frame is read off the clock, so nothing about it is kept.
// No engine API here, so these can be tested without a mock.

const FRAME_MS = 120
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// One pass of the feature bar's light over its filled cells, however many.
const SWEEP_MS = 2000
// The light is a soft band: full at its middle, fading to the bar's own color
// this many cells either side. Where it sits between two cells, both glow in part.
const GLOW_REACH = 3
// The bar's color as the default themes paint `claude`, and the light at its
// brightest; a cell is tinted somewhere between the two.
const GLOW_FROM = [215, 119, 87] as const
const GLOW_TO = [255, 226, 208] as const
const GLOW_SHADES = 8

/** The spinner's glyph at `now`: every card and ticket at work draws the same one. */
export function spinnerAt(now: number): string {
  return SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length]!
}

/** A stretch of bar cells drawn alike; `glow` is the tint of lit cells, absent for the bar's own color. */
export type BarRun = { text: string; glow?: string }

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

export function tint(amount: number): string {
  return '#' + GLOW_FROM.map((from, i) => Math.round(from + (GLOW_TO[i]! - from) * amount).toString(16).padStart(2, '0')).join('')
}
