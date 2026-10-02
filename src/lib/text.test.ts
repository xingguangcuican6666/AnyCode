import { describe, it, expect } from 'vitest'
import {
  toGraphemes,
  displayWidth,
  computeWindow,
  truncateToWidth,
  fitToWidth,
  wrapToWidth,
  expandTabs,
} from './text'

describe('toGraphemes', () => {
  it('splits ASCII into characters', () => {
    expect(toGraphemes('abc')).toEqual(['a', 'b', 'c'])
  })

  it('keeps multi-code-point emoji as one grapheme', () => {
    // Family emoji is a ZWJ sequence — must not be split.
    expect(toGraphemes('👨‍👩‍👧')).toHaveLength(1)
  })

  it('returns [] for empty input', () => {
    expect(toGraphemes('')).toEqual([])
  })
})

describe('displayWidth', () => {
  it('counts ASCII as 1 column per char', () => {
    expect(displayWidth('hello')).toBe(5)
  })

  it('counts CJK glyphs as 2 columns', () => {
    expect(displayWidth('你好')).toBe(4)
  })
})

describe('computeWindow', () => {
  it('returns the whole string when it fits', () => {
    const g = toGraphemes('abc')
    expect(computeWindow(g, 1, 10)).toEqual({ visible: ['a', 'b', 'c'], rel: 1 })
  })

  it('scrolls so the cursor stays visible', () => {
    const g = toGraphemes('abcdef')
    const { visible, rel } = computeWindow(g, 5, 3)
    expect(visible.join('')).toBe('def')
    expect(rel).toBe(2)
  })

  it('handles cursor at end of line', () => {
    const g = toGraphemes('abcd')
    const { visible, rel } = computeWindow(g, 4, 3)
    expect(visible.join('').length).toBeLessThanOrEqual(3)
    expect(rel).toBe(visible.length)
  })
})

describe('truncateToWidth', () => {
  it('leaves short strings untouched', () => {
    expect(truncateToWidth('abc', 10)).toBe('abc')
  })

  it('truncates with an ellipsis and respects display width', () => {
    const out = truncateToWidth('abcdef', 4)
    expect(out.endsWith('…')).toBe(true)
    expect(displayWidth(out)).toBeLessThanOrEqual(4)
  })

  it('handles CJK without splitting glyphs', () => {
    const out = truncateToWidth('你好世界', 5)
    expect(displayWidth(out)).toBeLessThanOrEqual(5)
  })
})

describe('fitToWidth', () => {
  it('pads short strings with spaces', () => {
    expect(fitToWidth('ab', 5)).toBe('ab   ')
  })

  it('truncates over-long strings to exactly the width', () => {
    const out = fitToWidth('abcdefgh', 4)
    expect(displayWidth(out)).toBe(4)
  })
})

describe('wrapToWidth', () => {
  it('returns [""] for empty input', () => {
    expect(wrapToWidth('', 5)).toEqual([''])
  })

  it('wraps on grapheme boundaries', () => {
    expect(wrapToWidth('abcdef', 3)).toEqual(['abc', 'def'])
  })

  it('returns input as-is when maxCols < 1', () => {
    expect(wrapToWidth('abc', 0)).toEqual(['abc'])
  })

  it('puts an over-wide grapheme alone on its row', () => {
    // '你好' is 4 cols; with maxCols 2 each glyph gets its own row.
    expect(wrapToWidth('你好', 2)).toEqual(['你', '好'])
  })
})

describe('expandTabs', () => {
  it('returns input unchanged when no tabs', () => {
    expect(expandTabs('abc')).toBe('abc')
  })

  it('advances to the next 8-column tab stop', () => {
    expect(expandTabs('a\tb')).toBe('a' + ' '.repeat(7) + 'b')
  })

  it('respects the start column', () => {
    expect(expandTabs('\tb', 2)).toBe(' '.repeat(6) + 'b')
  })
})
