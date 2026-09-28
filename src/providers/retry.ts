// Retry policy for the Anthropic provider: which HTTP statuses are transient,
// how long to back off, and how to read a server Retry-After. Pure and
// self-contained so the agent loop (providers/anthropic) stays focused on the
// stream/tool cycle.

// Default transient HTTP statuses worth retrying (rate limit, overload, gateway
// churn). Overridable per-request via StreamOpts.retryStatusCodes.
export const DEFAULT_RETRY_CODES = '408,409,429,500-599'

// Compile a retry-code spec ('408,409,429,500-599') into a fast predicate. Each
// comma-separated part is a single code or an inclusive `lo-hi` range; malformed
// parts are skipped. An empty/garbage spec yields a never-retry predicate.
export function parseRetryCodes(spec?: string): (s: number) => boolean {
  const ranges: Array<[number, number]> = []
  for (const part of (spec ?? DEFAULT_RETRY_CODES).split(',')) {
    const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part)
    if (!m) continue
    const lo = Number(m[1]), hi = m[2] ? Number(m[2]) : lo
    ranges.push([Math.min(lo, hi), Math.max(lo, hi)])
  }
  return ranges.length ? (s) => ranges.some(([a, b]) => s >= a && s <= b) : () => false
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

// Exponential backoff (0.5s, 1s, 2s, …) capped at 16s, plus a little jitter so
// retries don't thundering-herd. A server-sent Retry-After wins when present.
export function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter != null && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000)
  return Math.min(500 * 2 ** attempt, 16_000) + Math.floor(Math.random() * 250)
}

// Retry-After is either a number of seconds or an HTTP date.
export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined
  const n = Number(h)
  if (Number.isFinite(n)) return n
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : undefined
}
