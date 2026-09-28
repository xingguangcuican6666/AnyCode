// Auto-update check for the `autoUpdateChannel` setting (stable | latest).
//
// Claude Code checks its release channel on startup and points you at a newer
// build when one exists. We mirror that: on startup we query the npm registry
// for the package's dist-tags, pick the tag for the configured channel
// (`stable` → `latest`, `latest` → `next`, falling back to `latest`), compare it
// to the running VERSION and, when it's newer, surface a one-line footer banner.
//
// Everything is best-effort and non-blocking: the lookup runs in the background,
// the result is cached on disk with a TTL, and any failure (offline, the package
// isn't published, a 404) simply leaves the banner hidden — never an error, and
// never a blocked turn. Mirrors lib/modelDb's cache-then-refresh shape.
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from '../config'
import { VERSION } from '../version'

// The published package (see package.json "name"). If it isn't on the registry
// the fetch 404s and we stay silent.
const PKG = 'meowcode'
const REGISTRY_URL = `https://registry.npmjs.org/${PKG}`
const CACHE_FILE = path.join(CONFIG_DIR, 'update-check.json')
// Re-check at most every 6 hours; a stale cache is still used while it refreshes.
const TTL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000

export type UpdateChannel = 'stable' | 'latest'

interface CacheShape {
  fetchedAt: number
  // The resolved latest version per channel (tag value), so a channel switch
  // reads the right number without waiting for a fresh fetch.
  tags: Partial<Record<UpdateChannel, string>>
}

let mem: CacheShape = { fetchedAt: 0, tags: {} }
let refreshing: Promise<boolean> | null = null

// Compare two dotted version cores (prerelease suffix ignored). Returns >0 when
// `a` is newer than `b`. "0.2.0" > "0.1.9"; "0.1.0-next.3" compares as "0.1.0".
function cmpVersions(a: string, b: string): number {
  const core = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number(n) || 0)
  const pa = core(a)
  const pb = core(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function loadCache(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CacheShape
    if (parsed && parsed.tags && typeof parsed.tags === 'object') {
      mem = { fetchedAt: Number(parsed.fetchedAt) || 0, tags: parsed.tags }
    }
  } catch { /* no/invalid cache — leave mem empty */ }
}

function writeCache(): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(mem), 'utf8')
  } catch { /* cache is an optimization; ignore write failures */ }
}

loadCache()

// The tag on the registry that a channel maps to.
function tagFor(channel: UpdateChannel, distTags: Record<string, string>): string | undefined {
  if (channel === 'latest') return distTags.next ?? distTags.latest
  return distTags.latest
}

async function fetchTags(): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return false
    const payload = (await res.json()) as { 'dist-tags'?: Record<string, string> }
    const distTags = payload['dist-tags'] || {}
    const tags: Partial<Record<UpdateChannel, string>> = {}
    const stable = tagFor('stable', distTags)
    const latest = tagFor('latest', distTags)
    if (stable) tags.stable = stable
    if (latest) tags.latest = latest
    if (!stable && !latest) return false
    mem = { fetchedAt: Date.now(), tags }
    writeCache()
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The newer version available on `channel`, or null when we're up to date (or
 * don't know yet). Reads only cached data — call ensureUpdateCheck to populate.
 */
export function availableUpdate(channel: UpdateChannel): string | null {
  const latest = mem.tags[channel]
  if (!latest) return null
  return cmpVersions(latest, VERSION) > 0 ? latest : null
}

/**
 * Kick off a background check if the cache is missing or older than the TTL.
 * `onUpdate` fires once a fresh result lands so the UI can re-render its banner.
 * Never blocks; concurrent calls share one in-flight fetch. Honors the channel
 * only for the freshness decision — a single fetch stores both channels' tags.
 */
export function ensureUpdateCheck(channel: UpdateChannel, onUpdate?: () => void): void {
  const fresh = mem.fetchedAt > 0 && Date.now() - mem.fetchedAt < TTL_MS
  // Even with a fresh cache, fire onUpdate synchronously-ish so a freshly-read
  // cache still paints the banner on this session's first render.
  if (fresh) { if (availableUpdate(channel)) onUpdate?.(); return }
  if (refreshing) return
  refreshing = fetchTags()
  refreshing
    .then((updated) => {
      refreshing = null
      if (updated) onUpdate?.()
    })
    .catch(() => { refreshing = null })
}
