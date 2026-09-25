// Model pricing → the USD cost shown on the Usage tab. Costs are computed from
// token counts (real ones reported by the Anthropic API when available, else the
// rough estimator in lib/tokens) times a per-model rate.
//
// STUB SOURCE (by design): the rate table below is a hardcoded snapshot of
// Anthropic's public list prices. The real "price source" — and the default
// AnyCode vendor those prices would come from — are intentionally NOT wired yet
// (see providers/index.ts `defaultProvider`). Per the product decision, a custom
// Anthropic-protocol provider is billed at these OFFICIAL rates too, matched to a
// model by id substring. Swap PRICE_SOURCE + TABLE for a live source later.
export const PRICE_SOURCE = 'stub' as const

/** USD price per million tokens for one model. */
export interface ModelPrice {
  input: number
  output: number
  cacheWrite?: number // 5-minute cache write; defaults to input × 1.25
  cacheRead?: number  // cache hit; defaults to input × 0.1
}

// Matched by substring (like lib/usage contextLimit) so version suffixes and
// families resolve without an exact-id table. First match wins.
const TABLE: Array<[RegExp, ModelPrice]> = [
  [/opus/i, { input: 15, output: 75 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/haiku/i, { input: 0.8, output: 4 }],
  [/fable/i, { input: 1, output: 5 }],
]
// Unknown models fall back to mid-tier (sonnet-like) rates.
const FALLBACK: ModelPrice = { input: 3, output: 15 }

// Anthropic's standard cache multipliers, applied when a row omits explicit
// cache rates: writing the cache costs 25% more than input, reading it 90% less.
const CACHE_WRITE_MULT = 1.25
const CACHE_READ_MULT = 0.1

/** Resolve the (cache-filled) rate for a model id. */
export function priceFor(model: string): Required<ModelPrice> {
  const base = TABLE.find(([re]) => re.test(model))?.[1] ?? FALLBACK
  return {
    input: base.input,
    output: base.output,
    cacheWrite: base.cacheWrite ?? base.input * CACHE_WRITE_MULT,
    cacheRead: base.cacheRead ?? base.input * CACHE_READ_MULT,
  }
}

/** Token counts a turn (or session) accrued, any of which may be absent. */
export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/** USD cost of the given token counts at a model's official rate. */
export function computeCost(t: TokenCounts, model: string): number {
  const p = priceFor(model)
  const M = 1_000_000
  return (
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      (t.cacheReadTokens ?? 0) * p.cacheRead +
      (t.cacheCreationTokens ?? 0) * p.cacheWrite) /
    M
  )
}

/** Format a USD amount for display, e.g. 0 → "$0.0000", 1.5 → "$1.5000". */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0.0000'
  // Small amounts read better with 4 decimals (matches Claude Code's "$0.0000");
  // once it grows past a dollar, 2 decimals is plenty.
  return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4))
}
