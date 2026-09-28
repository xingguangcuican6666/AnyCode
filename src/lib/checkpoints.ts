// In-session checkpoint store for the `rewindCode` setting and the `/rewind`
// command — MeowCode's take on Claude Code's checkpoints. Before a mutating file
// tool (write_file / edit_file) runs, fs-tools snapshots the file's PRIOR state
// here (gated on ctx.rewind). `/rewind` lists those snapshots and can restore one,
// writing the old contents back (or deleting a file that didn't exist before).
//
// The store is module-level and in-memory: the tool loop and the command run in
// the same process, so both share it. It lives for the session only (a fresh
// process starts empty) — snapshots are not persisted to disk.
import fs from 'node:fs'

export interface Checkpoint {
  id: number
  path: string          // absolute path of the file that was about to change
  before: string | null // prior contents, or null if the file did not exist yet
  tool: string          // 'write_file' | 'edit_file'
  ts: number            // epoch ms when captured
}

const MAX = 300 // bound memory; oldest snapshots drop off beyond this
let store: Checkpoint[] = []
let seq = 0

// Snapshot a file's pre-mutation state. `before` is null when the file is being
// created (nothing to restore to → a restore deletes it). Returns the checkpoint.
export function recordCheckpoint(path: string, before: string | null, tool: string, ts: number): Checkpoint {
  const cp: Checkpoint = { id: ++seq, path, before, tool, ts }
  store.push(cp)
  if (store.length > MAX) store = store.slice(store.length - MAX)
  return cp
}

/** All checkpoints, oldest first (callers reverse for newest-first display). */
export function listCheckpoints(): Checkpoint[] {
  return store.slice()
}

export function clearCheckpoints(): void {
  store = []
}

export type RestoreResult = { ok: boolean; path?: string; action?: 'restored' | 'deleted'; error?: string }

// Restore the checkpoint with the given id: write its `before` contents back, or
// delete the file if it hadn't existed. The checkpoint (and any newer than it)
// are left in place so a restore can itself be undone by an even-older snapshot.
export function restoreCheckpoint(id: number): RestoreResult {
  const cp = store.find((c) => c.id === id)
  if (!cp) return { ok: false, error: 'checkpoint not found' }
  try {
    if (cp.before === null) {
      fs.rmSync(cp.path, { force: true })
      return { ok: true, path: cp.path, action: 'deleted' }
    }
    fs.writeFileSync(cp.path, cp.before, 'utf8')
    return { ok: true, path: cp.path, action: 'restored' }
  } catch (e) {
    return { ok: false, path: cp.path, error: (e as Error).message }
  }
}
