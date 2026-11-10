// The hive: the lead's frame, shaped after the plugin's icon. Honeycomb cells
// in staggered rows (a cell sits between the two above it), most of them capped
// in the accent, a few deeper or brighter, some open; along the outer rows some
// are missing, so the outline is ragged. Every cell is read off its place, so
// the hive is the same from one drawing to the next. No engine API here.

import { ACCENT } from './accent'

/** A stretch of a hive row drawn alike: cells and the blanks after them. No color: blanks alone. */
export type HiveRun = { text: string; color?: string; isDim?: boolean }

/** The hive's rows: two above the lead's two, and two below. */
export const HIVE_ROWS = 6
/** The cells either side of the lead's rows. */
export const HIVE_SIDE = 2

const CAPPED = '⬢'
const OPEN = '⬡'
// The icon's cells: capped in the accent (L), deeper (F), brighter (B), and open (O).
const TONE = {
  L: { glyph: CAPPED, color: ACCENT, isDim: false },
  F: { glyph: CAPPED, color: '#a855f7', isDim: false },
  B: { glyph: CAPPED, color: '#f3e8ff', isDim: false },
  O: { glyph: OPEN, color: ACCENT, isDim: true },
} as const
// Which tone a cell takes, and which cells of an outer row are missing ('.'). Both
// runs are a prime number of cells long, so no two rows fall in step.
const TONES = 'LOFLLBOLFLOLLFOBLLOFLOL'
const GAPS = 'x.xx..x.x..xx'

/** The cell at `row`, `column` of the hive, or none: rows are staggered, and an outer row has gaps. */
function cellAt(row: number, column: number): (typeof TONE)[keyof typeof TONE] | undefined {
  if ((row + column) % 2 !== 0) return undefined
  const nth = Math.floor(column / 2)
  const isOuter = row === 0 || row === HIVE_ROWS - 1
  if (isOuter && GAPS[(nth + row * 4) % GAPS.length] === '.') return undefined
  return TONE[TONES[(nth + row * 5) % TONES.length] as keyof typeof TONE]
}

/** `length` cells of the hive's `row`, from `column` on, as stretches drawn alike. */
export function hiveRow(row: number, column: number, length: number): HiveRun[] {
  const runs: HiveRun[] = []
  for (let c = column; c < column + length; c++) {
    const cell = cellAt(row, c)
    const last = runs[runs.length - 1]
    if (!cell) {
      // A blank rides with the cells before it: it shows no color.
      if (last) last.text += ' '
      else runs.push({ text: ' ' })
    } else if (last && last.color === cell.color && last.isDim === cell.isDim) last.text += cell.glyph
    else runs.push({ text: cell.glyph, color: cell.color, isDim: cell.isDim })
  }
  return runs
}
