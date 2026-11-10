// What "done" means for a ticket, in one place so the pane and the status line
// agree. No engine API here, so the panel state module and the pane model can
// both import it.

import type { Ticket } from '../types'

/** A ticket is done once it is merged into the integration branch or resolved on its face. */
export function isDone(t: Ticket, merged: ReadonlySet<string>): boolean {
  return merged.has(t.number) || t.status === 'resolved'
}
