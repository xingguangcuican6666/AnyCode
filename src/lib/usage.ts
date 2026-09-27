// Token/context accounting shared by /usage, /status, the context warning line,
// and auto-compaction. Token counts are rough estimates (~4 chars/token, see
// lib/tokens) — good enough to drive a fill bar and a compaction threshold, not
// billing. Real byte-exact counts would need the provider's tokenizer.
import type { Message, SessionUsage } from '../types'
import { estimateTokens } from './tokens'
import { lookupRemoteWindow } from './modelDb'

// Built-in model → context-window fallback (tokens), matched by pattern against
// the model id so version suffixes (e.g. -20251001) and families resolve without
// an exact-id table. This is only the FALLBACK: the online models.dev database
// (see lib/modelDb) is consulted first for a real per-model number, and this
// table catches anything it doesn't know. Order matters — earlier, more specific
// patterns win (e.g. gpt-4.1 before gpt-4o).
const CONTEXT_LIMITS: Array<[RegExp, number]> = [
  // OpenAI
  [/gpt-5|gpt5/i, 272_000],
  [/gpt-4\.1/i, 1_047_576],
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/o[134](-|$)|o-mini/i, 200_000],
  // Google Gemini (1.5 / 2.x and newer all ~1M)
  [/gemini/i, 1_048_576],
  // Open models
  [/deepseek/i, 128_000],
  [/qwen/i, 131_072],
  [/llama/i, 128_000],
  [/mistral|mixtral/i, 128_000],
  // Anthropic Claude
  [/claude|opus|sonnet|haiku|fable/i, 200_000],
]
const DEFAULT_CONTEXT = 200_000

// The built-in fallback window for a model id (no network).
function builtinLimit(model: string): number {
  for (const [re, n] of CONTEXT_LIMITS) if (re.test(model)) return n
  return DEFAULT_CONTEXT
}

/**
 * The context-window size (in tokens) for a model id. Prefers the online
 * models.dev database (kept fresh in the background, see lib/modelDb) and falls
 * back to the built-in family table when the model is unknown or the DB hasn't
 * loaded yet — so an accurate, self-updating number wins over a static guess.
 */
export function contextLimit(model: string): number {
  return lookupRemoteWindow(model) ?? builtinLimit(model)
}

/** Cumulative session totals, accumulated turn-by-turn in useChat. */
export type { SessionUsage }

export function emptyUsage(): SessionUsage {
  return {
    turns: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, compactions: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    apiMs: 0, startedAt: Date.now(),
    linesAdded: 0, linesRemoved: 0, costUsd: 0,
  }
}

/** Estimated tokens currently occupying the context window (all live messages). */
export function contextTokens(messages: Message[]): number {
  let n = 0
  for (const m of messages) {
    if (m.content === '__banner__') continue // UI-only, never sent to the model
    n += estimateTokens(m.content)
  }
  return n
}

export interface ContextState {
  used: number
  limit: number
  ratio: number       // 0..1
  remaining: number
}

export function contextState(messages: Message[], model: string, override?: number): ContextState {
  const limit = override && override > 0 ? override : contextLimit(model)
  const used = contextTokens(messages)
  return { used, limit, ratio: Math.min(1, used / limit), remaining: Math.max(0, limit - used) }
}

// Context fill fractions that drive the UI warning and auto-compaction. Claude
// Code warns as the window fills and auto-compacts near the top; mirror that.
export const WARN_RATIO = 0.7          // soft warning ("context filling up")
export const DANGER_RATIO = 0.85       // strong warning ("compact soon")
export const AUTO_COMPACT_RATIO = 0.92 // auto-compaction kicks in

export type ContextLevel = 'ok' | 'warn' | 'danger'

export function contextLevel(ratio: number): ContextLevel {
  if (ratio >= DANGER_RATIO) return 'danger'
  if (ratio >= WARN_RATIO) return 'warn'
  return 'ok'
}

/** A unicode fill bar, e.g. ██████░░░░ for width=10. */
export function bar(ratio: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

/** Format a token count compactly: 1234 → "1.2k", 200000 → "200k". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

/** Format a duration in ms as a compact human string: 0 → "0s", 200500 →
 *  "3m 20s", 30h → "1d 6h". Used for the Usage tab's API/wall durations. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
