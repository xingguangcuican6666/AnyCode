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

// OSC 52: ESC ] 52 ; c ; <base64> BEL — the terminal copies it for us. Inside a
// tmux or GNU screen session the sequence is consumed by the multiplexer and
// never reaches the outer terminal unless we wrap it in that multiplexer's
// device-control passthrough, so detect it and wrap accordingly (best-effort:
// tmux still needs `set-clipboard on` + `allow-passthrough on`, screen a
// compatible config). Very large payloads are left to the native tools — many
// terminals cap the OSC 52 length and the DCS passthrough is size-limited.
const OSC52_MAX_B64 = 100000
function osc52(text: string, out: NodeJS.WriteStream): void {
  try {
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    if (b64.length > OSC52_MAX_B64) return // oversized → rely on the native path
    const seq = `\x1b]52;c;${b64}\x07`
    const term = process.env.TERM ?? ''
    if (process.env.TMUX) {
      // tmux passthrough: \x1bPtmux; … \x1b\\ with every inner ESC doubled.
      out.write(`\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`)
    } else if (term.startsWith('screen') || term.startsWith('tmux')) {
      // GNU screen DCS passthrough: \x1bP … \x1b\\ (no ESC-doubling).
      out.write(`\x1bP${seq}\x1b\\`)
    } else {
      out.write(seq)
    }
  } catch { /* ignore */ }
}

// Copy `text` to the system clipboard through every available channel. `out` is
// the TTY to emit the OSC 52 sequence on (the app's stdout).
export function copyToClipboard(text: string, out: NodeJS.WriteStream): void {
  if (!text) return
  osc52(text, out)
  tryNative(text)
}
