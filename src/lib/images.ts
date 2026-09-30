// Image attachments for prompts: turn image references in the typed/pasted text
// (a dropped or typed image-file PATH) and the system clipboard (a pasted
// screenshot) into base64 `image` blocks the model can see. Dependency-free —
// only node builtins and, for the clipboard, the platform's native tools.
//
// The submit path (hooks/useChat) calls processImagePrompt on every non-command
// prompt: recognized image paths are swapped for "[Image #N]" placeholders and
// their bytes returned as attachments (carried on the user Message's meta and
// emitted as image blocks by wire.toApiMessages). The input box (PromptInput)
// calls stashClipboardImage on ctrl+v — a clipboard image is written to a temp
// file and its path inserted into the line, so it flows through the SAME
// path-based pipeline on submit.
import { spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import type { ImageAttachment } from '../types'

// Anthropic-accepted raster formats. Keyed by lowercased extension (no dot).
const MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}
// Skip anything larger (raw bytes): the API rejects oversized images and base64
// would bloat the request. Matches read_file's own per-image cap (~5MB).
const MAX_BYTES = 5 * 1024 * 1024

function mediaTypeFor(p: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(p)
  return m ? (MEDIA[m[1].toLowerCase()] ?? null) : null
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

// Read one image file into an attachment, or null when it is missing, empty,
// too big, or not an accepted image type. Never throws.
export function loadImageAttachment(path: string): ImageAttachment | null {
  try {
    const mt = mediaTypeFor(path)
    if (!mt) return null
    const st = statSync(path)
    if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null
    return { media_type: mt, data: readFileSync(path).toString('base64') }
  } catch { return null }
}

// Matches a DELIBERATE image reference in prompt text: a quoted path, a file://
// URI, an absolute/~//./../ path, or a Windows drive path — always ending in an
// image extension. Bare relative names typed in prose ("fix logo.png") have no
// path prefix and are intentionally NOT matched, so normal writing is untouched.
const REF_RE = new RegExp(
  [
    String.raw`'[^']*\.(?:png|jpe?g|gif|webp)'`,               // 'single quoted'
    String.raw`"[^"]*\.(?:png|jpe?g|gif|webp)"`,               // "double quoted"
    String.raw`file://\S*\.(?:png|jpe?g|gif|webp)`,            // file:// URI (drag-drop)
    String.raw`(?:~|\.{1,2})?/(?:\\ |[^\s'"])*\.(?:png|jpe?g|gif|webp)`, // /abs, ~/, ./, ../
    String.raw`[A-Za-z]:[\\/](?:\\ |[^\s'"])*\.(?:png|jpe?g|gif|webp)`,  // C:\ or C:/ (Windows)
  ].join('|'),
  'gi',
)

// Normalize a matched token to an absolute filesystem path.
function cleanPath(tok: string, cwd: string): string {
  let s = tok.trim()
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1)
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length)
    if (!s.startsWith('/')) { const i = s.indexOf('/'); s = i >= 0 ? s.slice(i) : s } // drop file://host
    try { s = decodeURIComponent(s) } catch { /* keep raw */ }
  }
  s = s.replace(/\\ /g, ' ') // unescape backslash-escaped spaces (macOS drag-drop)
  s = expandHome(s)
  if (!isAbsolute(s) && !/^[A-Za-z]:[\\/]/.test(s)) s = resolve(cwd, s)
  return s
}

// Replace every recognized, loadable image reference in `text` with an
// "[Image #N]" placeholder and return the rewritten text + the attachments in
// order. A reference that does not resolve to a usable image is left untouched.
export function processImagePrompt(text: string, cwd: string): { text: string; attachments: ImageAttachment[] } {
  const attachments: ImageAttachment[] = []
  const out = text.replace(REF_RE, (match) => {
    const att = loadImageAttachment(cleanPath(match, cwd))
    if (!att) return match
    attachments.push(att)
    return `[Image #${attachments.length}]`
  })
  return { text: out, attachments }
}

// Spawn a native command and capture its stdout as bytes; null on error,
// non-zero exit, empty output, or output over the size cap.
function runCapture(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((res) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      const chunks: Buffer[] = []
      child.on('error', () => res(null))
      child.stdout?.on('data', (d: Buffer) => chunks.push(d))
      child.on('close', (code) => {
        const buf = Buffer.concat(chunks)
        res(code === 0 && buf.length > 0 && buf.length <= MAX_BYTES ? buf : null)
      })
    } catch { res(null) }
  })
}

// PowerShell one-liner that dumps a clipboard image to stdout as PNG bytes.
const PS_CLIP =
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
  '$i=[Windows.Forms.Clipboard]::GetImage(); ' +
  'if($i){ $m=New-Object System.IO.MemoryStream; $i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png); ' +
  '$o=[Console]::OpenStandardOutput(); $b=$m.ToArray(); $o.Write($b,0,$b.Length) }'

// Native clipboard-image readers per platform, tried in order.
function clipboardImageCommands(): Array<[string, string[]]> {
  if (process.platform === 'darwin') return [['pngpaste', ['-']]]
  if (process.platform === 'win32') return [['powershell', ['-NoProfile', '-Command', PS_CLIP]]]
  // Linux/BSD: Wayland first, then X11.
  return [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ]
}

// Best-effort read of an image sitting on the system clipboard (all producers
// above emit PNG). Returns null when there is no image or no tool available.
export async function readClipboardImage(): Promise<ImageAttachment | null> {
  for (const [cmd, args] of clipboardImageCommands()) {
    const buf = await runCapture(cmd, args)
    if (buf) return { media_type: 'image/png', data: buf.toString('base64') }
  }
  return null
}

// Read a clipboard image and stash it to a temp PNG, returning the path (so the
// caller can insert it into the prompt and let processImagePrompt pick it up).
// Null when the clipboard holds no image.
export async function stashClipboardImage(): Promise<string | null> {
  const att = await readClipboardImage()
  if (!att) return null
  try {
    const file = join(tmpdir(), `meowcode-clip-${Date.now()}.png`)
    writeFileSync(file, Buffer.from(att.data, 'base64'))
    return file
  } catch { return null }
}
