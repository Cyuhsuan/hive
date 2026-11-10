import { expect, test } from 'claude-code/testing'

import type { AgentPhase, SwarmAgent } from '../types'
import { phaseOfCall } from '../hooks/agent-phase'
import { BEE_LAP_MS, beeLeft, returnLeft, returnProgress, sweptBar } from '../hooks/animation'
import { bar as barOf, cells, clip } from '../hooks/text-format'

// The pane's pure functions on their own: no pane, no plugin, no mock.

function agent(phase: AgentPhase, type = 'ticket-implementer'): SwarmAgent {
  return { id: 'a', type, description: '', model: 'opus', isBackground: false, phase, tools: 0, errors: 0, startedAt: 0 }
}

test('cells counts CJK and full-width characters as two', () => {
  expect(cells('abc')).toBe(3)
  expect(cells('讀碼')).toBe(4)
  expect(cells('ａ')).toBe(2)
  expect(cells('あい')).toBe(4)
  expect(cells('한')).toBe(2)
})

test('clip returns text that fits unchanged', () => {
  expect(clip('abc', 3)).toBe('abc')
  expect(clip('讀碼', 4)).toBe('讀碼')
  expect(clip('', 0)).toBe('')
})

test('clip ends a cut text in an ellipsis within the width', () => {
  expect(clip('abcdef', 4)).toBe('abc…')
  for (const text of ['abcdefghij', '讀碼測試改碼', 'a讀b碼c測d試']) {
    for (let width = 1; width < 12; width++) {
      const out = clip(text, width)
      if (cells(text) > width) {
        expect(out.endsWith('…')).toBe(true)
        expect(cells(out)).toBeLessThanOrEqual(width)
      } else {
        expect(out).toBe(text)
      }
    }
  }
})

test('clip never splits a two-cell character', () => {
  // width 4 leaves 3 cells before the ellipsis: one wide char fits, a second would not
  expect(clip('讀碼測試', 4)).toBe('讀…')
  expect(clip('讀碼測試', 5)).toBe('讀碼…')
  expect(clip('讀碼測試', 1)).toBe('…')
})

test('phaseOfCall leaves a finished agent where it ended', () => {
  expect(phaseOfCall(agent('done'), 'Edit', {})).toBe('done')
  expect(phaseOfCall(agent('failed'), 'Bash', { command: 'git commit' })).toBe('failed')
})

test('phaseOfCall calls any type naming review a review', () => {
  expect(phaseOfCall(agent('spawned', 'code-reviewer'), 'Edit', {})).toBe('reviewing')
  expect(phaseOfCall(agent('editing', 'plugin:Review-Bot'), 'Bash', { command: 'git commit' })).toBe('reviewing')
})

test('phaseOfCall reads a Bash command as commit, then merge, then test', () => {
  const a = agent('reading')
  expect(phaseOfCall(a, 'Bash', { command: 'git merge main && npm test' })).toBe('merging')
  expect(phaseOfCall(a, 'Bash', { command: 'npm test && git commit -m x' })).toBe('committing')
  expect(phaseOfCall(a, 'Bash', { command: 'git rebase main; vitest' })).toBe('merging')
  expect(phaseOfCall(a, 'Bash', { command: 'git merge x && git commit -m y' })).toBe('committing')
  expect(phaseOfCall(a, 'Bash', { command: 'dotnet test' })).toBe('testing')
  expect(phaseOfCall(a, 'Bash', { command: 'ls' })).toBe('reading')
  expect(phaseOfCall(agent('spawned'), 'Bash', { command: 'ls' })).toBe('reading')
  expect(phaseOfCall(agent('testing'), 'Bash', {})).toBe('testing')
})

test('phaseOfCall reads editing tools as editing code', () => {
  const a = agent('reading')
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'mcp__serena__replace_symbol_body', 'mcp__x__insert_after', 'mcp__x__write_file']) {
    expect(phaseOfCall(a, tool, {})).toBe('editing')
  }
  expect(phaseOfCall(a, 'mcp__serena__serena_repl', { code: 's.edit.replace_content(...)' })).toBe('editing')
  expect(phaseOfCall(a, 'mcp__serena__serena_repl', { code: 's.lsp.find_symbol(...)' })).toBe('reading')
})

test('phaseOfCall turns a just-spawned agent to reading on any other tool, else keeps the phase', () => {
  expect(phaseOfCall(agent('spawned'), 'Read', {})).toBe('reading')
  expect(phaseOfCall(agent('testing'), 'Read', {})).toBe('testing')
  expect(phaseOfCall(agent('merging'), 'Grep', {})).toBe('merging')
})

test('sweptBar run sizes add up to the width', () => {
  for (const percent of [0, 1, 33, 50, 99, 100]) {
    for (const now of [0, 500, 1234, 1999]) {
      const runs = sweptBar(percent, 20, now)
      expect(runs.reduce((n, r) => n + [...r.text].length, 0)).toBe(20)
    }
  }
})

test('sweptBar fills as many cells as bar does, and never lights an empty cell', () => {
  for (const percent of [0, 10, 45, 80, 100]) {
    for (const now of [0, 700, 1500]) {
      const runs = sweptBar(percent, 24, now)
      const filledText = runs.map(r => r.text).join('')
      expect(filledText).toBe(barOf(percent, 24))
      for (const run of runs) {
        if (run.text.includes('░')) {
          expect(run.glow).toBeUndefined()
          expect(run.text).toBe('░'.repeat(run.text.length))
        }
      }
    }
  }
})

test('sweptBar merges neighbouring cells of one tint into one run', () => {
  const runs = sweptBar(100, 30, 1000)
  for (let i = 1; i < runs.length; i++) {
    expect(runs[i]!.glow).not.toBe(runs[i - 1]!.glow)
  }
  // the light is only on part of the bar, so the whole bar is not one run
  expect(runs.length).toBeGreaterThan(1)
  expect(runs.length).toBeLessThan(30)
})

test('sweptBar at 0 percent is only empty cells', () => {
  expect(sweptBar(0, 10, 777)).toEqual([{ text: '░'.repeat(10) }])
})

// ------------------------------------------------------------ the bee

test('cells counts the bee as two', () => {
  expect(cells('🐝')).toBe(2)
  expect(cells('已派 3 · 🐝 2')).toBe(cells('已派 3 · ') + 2 + cells(' 2'))
  expect(clip('🐝🐝🐝', 5)).toBe('🐝🐝…')
})

test('beeLeft flies out and back over the span, always inside it', () => {
  const span = 10
  const lefts = Array.from({ length: 100 }, (_, i) => beeLeft(i * 60, span))
  expect(Math.min(...lefts)).toBe(0)
  expect(Math.max(...lefts)).toBe(span)
  expect(lefts.every(n => Number.isInteger(n) && n >= 0 && n <= span)).toBe(true)
  // it turns around: rises first, then falls, one lap later it is where it started
  expect(beeLeft(BEE_LAP_MS / 2, span)).toBe(span)
  expect(beeLeft(BEE_LAP_MS / 4, span)).toBeGreaterThan(beeLeft(0, span))
  expect(beeLeft((BEE_LAP_MS * 3) / 4, span)).toBeLessThan(span)
  expect(beeLeft(BEE_LAP_MS, span)).toBe(beeLeft(0, span))
})

test('returnProgress runs from 0 at the finish to 1 a second later, and stays 1', () => {
  expect(returnProgress(5000, 5000)).toBe(0)
  expect(returnProgress(5500, 5000)).toBe(0.5)
  expect(returnProgress(6000, 5000)).toBe(1)
  expect(returnProgress(60_000, 5000)).toBe(1)
})

test('returnLeft carries the bee from where it was to past the card edge', () => {
  const span = 10
  const endedAt = 1234
  const edge = 14
  expect(returnLeft(endedAt, endedAt, span, edge)).toBe(beeLeft(endedAt, span))
  expect(returnLeft(endedAt + 1000, endedAt, span, edge)).toBe(edge)
  const mid = returnLeft(endedAt + 500, endedAt, span, edge)
  expect(mid).toBeGreaterThanOrEqual(Math.min(beeLeft(endedAt, span), edge))
  expect(mid).toBeLessThanOrEqual(edge)
})
