// The hive region's layout, as cells, and the route of a bee over it: the lead's
// frame, the delegates line and the agent cards, laid in one Box so the bee can be
// laid over all three from that Box's top left. The pane's rows above it (the
// feature, the step chart) never matter, however tall they are.
// pane-view lays its JSX out from the constants and functions here, so the two
// cannot drift. No engine API here, so these can be tested without a mock.

import type { SwarmAgent } from '../types'
import { BEE, beeLeft, isReturning } from './animation'
import type { Spot } from './animation'
import type { PaneModel } from './pane-model'
import { cells, clip } from './text-format'

// ---------------------------------------------------------------- the lead

/** The lead's frame is one cell wide and its text is padded by one more. */
export const LEAD_PAD_X = 1
/** The lead's text lines: its name, and its tally (with the hint). Each is one row, whatever the width. */
export const LEAD_LINES = 2
/** The tally's row: under the frame's top border and the name line. */
export const LEAD_TALLY_ROW = 1 + 1
/** The lead's frame: its top border, its lines, its bottom border. */
export const LEAD_ROWS = LEAD_LINES + 2
/** The lead's frame and the padding come before its text. */
export const LEAD_TEXT_LEFT = 1 + LEAD_PAD_X
/** The workflow's hint, at the left of the tally's line. */
export const LEAD_HINT = '派票 → merge → review'

/**
 * The lead's tally line, in `inner` cells: the tally is cut to the line, and the
 * hint (`isHinted`) is drawn only where it fits whole beside it with a cell
 * between, so the line is one row at any width. A tally with a hint is at the
 * right end of the line; with none, at the left.
 */
export function leadTallyLine(tally: string, inner: number, isHinted: boolean): { shown: string; isHintShown: boolean; left: number } {
  const shown = clip(tally, inner)
  const isHintShown = isHinted && cells(LEAD_HINT) + 1 + cells(shown) <= inner
  return { shown, isHintShown, left: isHintShown ? inner - cells(shown) : 0 }
}

/**
 * Where the bee lands: the cell of the tally's bee, as the tally will read once it
 * has landed. `isHinted` is a workflow lead, whose line carries the hint.
 * A bee cut off by the clip lands on the tally's last cells.
 */
export function tallySpot(tally: string, inner: number, isHinted: boolean): Spot {
  const { shown, left } = leadTallyLine(tally, inner, isHinted)
  const at = shown.indexOf(BEE)
  const offset = at < 0 ? Math.max(0, cells(shown) - cells(BEE)) : cells(shown.slice(0, at))
  return { row: LEAD_TALLY_ROW, col: LEAD_TEXT_LEFT + left + offset }
}

// ---------------------------------------------------------------- the cards

/** The delegates line under the lead. */
export const DELEGATES_ROWS = 1
/** The cards sit this many rows down, two columns in, a column apart. */
export const CARDS_TOP = LEAD_ROWS + DELEGATES_ROWS
export const CARDS_LEFT = 2
export const CARD_GAP = 1

/** A card's frame (two rows) and its title line. */
const CARD_BASE_ROWS = 3
/** The bar and the last tool of a ticket card at work. */
const PROGRESS_ROWS = 2

/**
 * The lines a card has under its title: a ticket card has the bar and the last
 * tool only while it works or has failed; any other card has one status line.
 * The card is drawn from this and `cardHeight` counts it, so they agree.
 */
export function cardLines(isTicketCard: boolean, isWorking: boolean): { hasStatus: boolean; hasProgress: boolean } {
  return { hasStatus: !isTicketCard, hasProgress: isTicketCard && isWorking }
}

/** A card's height: its frame, its title and the lines under the title. */
export function cardHeight(isTicketCard: boolean, isWorking: boolean): number {
  const { hasStatus, hasProgress } = cardLines(isTicketCard, isWorking)
  return CARD_BASE_ROWS + (hasStatus ? 1 : 0) + (hasProgress ? PROGRESS_ROWS : 0)
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

// ---------------------------------------------------------------- the bee on its card

/** The bee's first column on a card's top edge: past the corner. */
export const BEE_COL_MIN = 1

/** The columns the bee has between a card's corners: the card less the corners and the bee's own two cells. */
export function beeSpanOf(cardW: number): number {
  return cardW - 4
}

/** The bee's column on its card at `now`: where it is at work, and where it takes off from when the subagent finishes. */
export function beeColOnCard(now: number, span: number): number {
  return BEE_COL_MIN + beeLeft(now, span)
}

// ---------------------------------------------------------------- the bees home

/**
 * The cards whose bees are in the air at `now`, in the order they land: the ones
 * drawn, since a bee leaves from its card. With animation off nothing flies. A
 * done card folded into the "N more" line is not drawn, so its bee does not fly.
 */
export function returningCards(model: Pick<PaneModel, 'ordered'>, now: number, isAnimated: boolean): (SwarmAgent & { endedAt: number })[] {
  if (!isAnimated) return []
  return model.ordered
    .filter((a): a is SwarmAgent & { endedAt: number } => isReturning(a, now))
    .sort((a, b) => a.endedAt - b.endedAt)
}

/** The bees that came home: finished subagents, failed ones not counted, a bee still on its way left out. */
export function homeBeeCount(model: Pick<PaneModel, 'done' | 'ordered'>, now: number, isAnimated: boolean): number {
  return model.done.length - returningCards(model, now, isAnimated).length
}
