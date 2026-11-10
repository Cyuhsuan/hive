// Pure text helpers for the pane: names, times and terminal cell widths.
// No engine API here, so they can be tested without a mock.

export function shortModel(model: string | undefined): string {
  if (!model) return '?'
  const m = model.match(/(fable|opus|sonnet|haiku)[-_ ]?(\d+(?:[-_.]\d+)?)?/i)
  if (!m) return model.slice(0, 12)
  const ver = m[2] ? ' ' + m[2].replace(/[-_]/g, '.') : ''
  return m[1]!.toLowerCase() + ver
}

export function shortType(type: string): string {
  // Any agent type works: only a plugin's `name:` prefix is dropped.
  return type.replace(/^.*:/, '')
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`
}

export function fmtClock(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}

// CJK and full-width characters take two cells; everything else one.
const WIDE_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += WIDE_RE.test(ch) ? 2 : 1
  return n
}

/** Cuts `text` to `width` cells, an ellipsis in its last cell when it was cut. */
export function clip(text: string, width: number): string {
  if (cells(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = WIDE_RE.test(ch) ? 2 : 1
    if (used + w > Math.max(0, width - 1)) break
    out += ch
    used += w
  }
  return out + '…'
}

export function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}
