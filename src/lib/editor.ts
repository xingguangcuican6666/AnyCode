// External-editor bridge for the `/editor` command and the `lastResponseInEditor`
// setting. Writes the text to a temp file and opens it in $VISUAL/$EDITOR (vi as
// a last resort), giving the child the real TTY. We use spawnSync so Node blocks
// for the whole edit — that stops Ink from consuming stdin while the editor owns
// the screen. Callers pass suspend/resume to toggle Ink's raw mode and repaint.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The editor command line, honoring $VISUAL then $EDITOR, with a per-platform
// fallback. May include flags (e.g. "code --wait"), so callers split on spaces.
export function editorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi')
}

export interface EditorHooks {
  suspend?: () => void
  resume?: () => void
}

// Open `text` in the external editor and return the (possibly edited) contents,
// or null if the editor couldn't be launched. Best-effort; never throws.
export function openInEditor(text: string, hooks: EditorHooks = {}): string | null {
  let dir = ''
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meowcode-'))
    const file = path.join(dir, 'response.md')
    fs.writeFileSync(file, text, 'utf8')
    const [cmd, ...args] = editorCommand().split(/\s+/)
    hooks.suspend?.()
    try {
      const r = spawnSync(cmd, [...args, file], { stdio: 'inherit' })
      if (r.error) return null
      return fs.readFileSync(file, 'utf8')
    } finally {
      hooks.resume?.()
    }
  } catch {
    return null
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
}
