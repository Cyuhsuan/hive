// Where the returning bee starts and ends, as cells of the hive region: the
// lead's frame, the delegates line and the agent cards, laid in one Box so the
// bee can be laid over all three from that Box's top left. The pane's rows above
// it (the feature, the step chart) never matter, however tall they are.
// No engine API here, so these can be tested without a mock.

import type { Spot } from './animation'
import { BEE } from './animation'
import { cells, clip } from './text-format'

/** The lead's frame: its top border, its name line, its tally line, its bottom border. */
const LEAD_TALLY_ROW = 2
const LEAD_ROWS = 4
/** The delegates line under the lead. */
const DELEGATES_ROWS = 1
/** The cards sit this many rows down, two columns in, a column apart. */
const CARDS_TOP = LEAD_ROWS + DELEGATES_ROWS
const CARDS_LEFT = 2
const CARD_GAP = 1
/** The lead's frame and one cell of padding come before its tally. */
const LEAD_TEXT_LEFT = 2

/**
 * A card's height: its frame, its title and what lies under the title. A ticket
 * card has two more lines (the bar and the last tool) only while it works or has
 * failed; any other card has one status line.
 */
export function cardHeight(isTicketCard: boolean, hasProgress: boolean): number {
  return 3 + (isTicketCard ? (hasProgress ? 2 : 0) : 1)
}

/**
 * Each card's top left corner. Cards fill `cols` to a row and a row is as tall
 * as its tallest card, so a card on a later row is lower by the rows above it.
 */
export function cardSpots(heights: readonly number[], cols: number, cardW: number): Spot[] {
  const tops: number[] = []
  let top = CARDS_TOP
  for (let start = 0; start < heights.length; start += cols) {
    tops.push(top)
    top += Math.max(...heights.slice(start, start + cols))
  }
  return heights.map((_, i) => ({
    row: tops[Math.floor(i / cols)]!,
    col: CARDS_LEFT + (i % cols) * (cardW + CARD_GAP),
  }))
}

/**
 * Where the bee lands: the cell of the tally's bee. The tally is clipped to
 * `inner` cells; `isAtRight` is a tally set at the right end of its line (with a
 * hint on the left) instead of the left. A bee cut off by the clip lands on the
 * tally's last cells.
 */
export function tallySpot(tally: string, inner: number, isAtRight: boolean): Spot {
  const shown = clip(tally, inner)
  const at = shown.indexOf(BEE)
  const offset = at < 0 ? Math.max(0, cells(shown) - cells(BEE)) : cells(shown.slice(0, at))
  return { row: LEAD_TALLY_ROW, col: LEAD_TEXT_LEFT + (isAtRight ? inner - cells(shown) : 0) + offset }
}
