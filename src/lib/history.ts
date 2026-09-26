// Persistent prompt history for the input box (↑/↓ recall), so submitted prompts
// survive a restart the way a shell's history does — matching Claude Code, where
// ↑ recalls what you typed in earlier sessions. Kept in its own file (a plain
// JSON string array) rather than settings.json: it's append-mostly, unbounded-ish
// user text, and has nothing to do with configuration.
//
// On-disk order is newest-first (index 0 = most recent), which is exactly the
// order PromptInput's ↑/↓ walk, so a load plugs straight into its ref. Every
// call is best-effort and never throws — a missing/corrupt file just means "no
// history yet", and a failed write silently drops that one entry.
import path from 'node:path'
import fs from 'node:fs'
import { CONFIG_DIR } from '../config'

export const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json')

// Cap the stored list so the file can't grow without bound over months of use.
// Plenty for ↑-recall; older entries fall off the end (they're the least recent).
const MAX_ENTRIES = 1000

// Load the saved prompts, newest-first. Returns [] on any failure. Treat the file
// as untrusted data: keep only non-empty strings, so a hand-edited/corrupt file
// can never inject non-string junk into the input box.
export function loadHistory(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is string => typeof e === 'string' && e.length > 0).slice(0, MAX_ENTRIES)
  } catch {
    return [] // no history yet, or unreadable — start fresh
  }
}

// Record a freshly-submitted prompt at the front (read-modify-write, best-effort).
// Collapses an immediate repeat (same as the current newest) so holding ↑ after
// re-running a command doesn't wade through duplicates, and trims to MAX_ENTRIES.
export function appendHistory(entry: string): void {
  const v = entry.trim()
  if (!v) return
  try {
    const list = loadHistory()
    if (list[0] === v) return // don't store consecutive duplicates
    list.unshift(v)
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list))
  } catch {
    // best-effort; losing one history entry is non-critical
  }
}
