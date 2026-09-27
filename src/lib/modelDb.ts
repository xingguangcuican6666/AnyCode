// Online, continuously-updated model → context-window database. Rather than
// only guessing a window from a built-in family table (see lib/usage), we pull
// real per-model context limits from models.dev — a community-maintained,
// frequently-updated catalog of ~8k models across every major provider — and
// cache them on disk. Lookups are synchronous (served from an in-memory map
// seeded from the cache at import); a stale/missing cache is refreshed in the
// background so the numbers track upstream without ever blocking a turn.
//
// Resolution order for a window (see usage.contextLimit): explicit override →
// this online DB → the built-in family table → the default. So being offline or
// unrefreshed only ever falls back to the old behavior, never breaks.
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from '../config'

// models.dev publishes one big JSON keyed by provider, each with a `models` map
// whose entries carry `limit.context` (the total context window in tokens).
const SOURCE_URL = 'https://models.dev/api.json'
const CACHE_FILE = path.join(CONFIG_DIR, 'model-windows.json')
// Refresh at most once a day; a stale cache is still used while the refresh runs.
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 12_000

interface CacheShape {
  fetchedAt: number
  source: string
  windows: Record<string, number>   // normalized model key → context tokens
}

// In-memory index (normalized key → window). Seeded from the on-disk cache at
// import so the very first render already benefits from a prior fetch.
let memWindows: Record<string, number> = {}
let fetchedAt = 0
// Guard so concurrent callers don't launch overlapping network refreshes.
let refreshing: Promise<boolean> | null = null

// Normalize a model id to a match key: lowercase, strip everything but
// alphanumerics. So `claude-opus-4-8`, `Claude Opus 4.8` and `claude/opus-4-8`
// all collapse to the same key, absorbing punctuation/spacing differences.
function normKey(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// Flatten the models.dev payload into a normalized key → window map. Keeps the
// largest window when two providers expose the same model id with different
// numbers (a relayed model should never report LESS than its real window).
function indexPayload(payload: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const providers = (payload && typeof payload === 'object') ? payload as Record<string, any> : {}
  for (const prov of Object.values(providers)) {
    const models = prov?.models
    if (!models || typeof models !== 'object') continue
    for (const [id, m] of Object.entries<any>(models)) {
      const ctx = Number(m?.limit?.context)
      if (!Number.isFinite(ctx) || ctx <= 0) continue
      for (const key of [normKey(id), normKey(m?.id ?? id)]) {
        if (!key) continue
        if (!out[key] || ctx > out[key]) out[key] = ctx
      }
    }
  }
  return out
}

// Read the on-disk cache into memory (best-effort — a missing/corrupt cache just
// leaves the map empty so lookups fall back to the built-in table).
function loadCache(): void {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as CacheShape
    if (parsed && parsed.windows && typeof parsed.windows === 'object') {
      memWindows = parsed.windows
      fetchedAt = Number(parsed.fetchedAt) || 0
    }
  } catch { /* no/invalid cache — leave memWindows empty */ }
}

function writeCache(): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    const data: CacheShape = { fetchedAt, source: SOURCE_URL, windows: memWindows }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8')
  } catch { /* cache is an optimization; ignore write failures */ }
}

// Seed the in-memory map from disk at import so synchronous lookups work on the
// first render, before any network refresh has run.
loadCache()

/** The online context window (tokens) for a model id, or undefined if unknown. */
export function lookupRemoteWindow(model: string): number | undefined {
  if (!model) return undefined
  const key = normKey(model)
  if (memWindows[key]) return memWindows[key]
  // Fuzzy fallback: a stored key that is a prefix of ours, or vice-versa (e.g.
  // `claudeopus48` vs `claudeopus4820250101`). Take the longest overlapping key
  // so a specific dated id still resolves to its family entry.
  let best: number | undefined
  let bestLen = 0
  for (const k of Object.keys(memWindows)) {
    if ((key.startsWith(k) || k.startsWith(key)) && k.length > bestLen) {
      best = memWindows[k]
      bestLen = k.length
    }
  }
  return best
}

/** Whether the online DB currently has any entries (cache hit or after a fetch). */
export function hasRemoteWindows(): boolean {
  return Object.keys(memWindows).length > 0
}

// Fetch the catalog once, updating the in-memory map + on-disk cache. Resolves
// true when new data was stored. Network/parse failures resolve false (the old
// cache and built-in table remain in force).
async function fetchWindows(): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(SOURCE_URL, { signal: ctrl.signal })
    if (!res.ok) return false
    const payload = await res.json()
    const windows = indexPayload(payload)
    if (Object.keys(windows).length === 0) return false
    memWindows = windows
    fetchedAt = Date.now()
    writeCache()
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ensure the online DB is reasonably fresh. Called once at app startup. If the
 * cache is missing or older than the TTL, a single background refresh is kicked
 * off; `onUpdate` fires when it lands new data so the UI can re-render with the
 * corrected window. Never blocks: it returns immediately and the fetch runs on
 * its own. Concurrent calls share one in-flight refresh.
 */
export function ensureModelDb(onUpdate?: () => void): void {
  const fresh = fetchedAt > 0 && Date.now() - fetchedAt < TTL_MS
  if (fresh) return
  if (refreshing) return
  refreshing = fetchWindows()
  refreshing.then((updated) => {
    refreshing = null
    if (updated) onUpdate?.()
  }).catch(() => { refreshing = null })
}

/** Force a refresh regardless of TTL (used by an explicit refresh command). */
export async function refreshModelDb(): Promise<boolean> {
  if (refreshing) return refreshing
  refreshing = fetchWindows()
  try { return await refreshing } finally { refreshing = null }
}
