import { describe, it, expect } from 'vitest'
import { estimateTokens, formatTokens } from './tokens'

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  it('never returns less than 1 for non-empty input', () => {
    expect(estimateTokens('hi')).toBe(1)
  })
})

describe('formatTokens', () => {
  it('formats small numbers as-is', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('formats thousands with a k suffix', () => {
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2000)).toBe('2k')
  })
})
