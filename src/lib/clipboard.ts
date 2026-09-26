// Best-effort clipboard write for the owned viewport's ctrl+c copy. Dependency
// free: it emits an OSC 52 escape (works in modern terminals, incl. over SSH,
// even while we're on the alternate screen buffer) AND spawns the platform's
// native copy command, so at least one path lands the text on the clipboard.
// All failures are swallowed — copying is a convenience, never fatal.
import { spawn } from 'node:child_process'

// The native copy command per platform, tried in order (first that exists wins).
function nativeCandidates(): string[][] {
  if (process.platform === 'darwin') return [['pbcopy']]
  if (process.platform === 'win32') return [['clip']]
  // Linux/BSD: Wayland first, then X11 (xclip / xsel).
  return [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]
}

function tryNative(text: string): void {
  for (const [cmd, ...args] of nativeCandidates()) {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => {}) // binary missing → try the next candidate quietly
      child.stdin?.on('error', () => {})
      child.stdin?.end(text)
      return // one spawn attempt is enough; the first present binary handles it
    } catch { /* keep trying */ }
  }
}

// OSC 52: ESC ] 52 ; c ; <base64> BEL — the terminal copies it for us.
function osc52(text: string, out: NodeJS.WriteStream): void {
  try {
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    out.write(`\x1b]52;c;${b64}\x07`)
  } catch { /* ignore */ }
}

// Copy `text` to the system clipboard through every available channel. `out` is
// the TTY to emit the OSC 52 sequence on (the app's stdout).
export function copyToClipboard(text: string, out: NodeJS.WriteStream): void {
  if (!text) return
  osc52(text, out)
  tryNative(text)
}
