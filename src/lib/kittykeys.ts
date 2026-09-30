// Shift+Enter (and Alt+Enter) as a newline, the way Claude Code does it.
//
// The problem: in a legacy terminal, Shift+Enter sends the SAME bytes as Enter
// (a bare CR, \r) — there is no modifier information, so an app literally cannot
// tell them apart. Our editor could only insert a newline on terminals that
// happen to send LF for Shift+Enter; everywhere else Shift+Enter just submitted.
//
// The fix: enable the kitty keyboard protocol's "disambiguate escape codes" mode
// (CSI > 1 u). Terminals that support it (kitty, ghostty, WezTerm, foot, recent
// iTerm2, Konsole, Windows Terminal, …) then report MODIFIED keys as unambiguous
// "CSI u" sequences — e.g. Shift+Enter arrives as `\x1b[13;2u` instead of `\r`.
// Terminals that don't support it silently ignore the enable and keep sending
// legacy bytes, so this is strictly an improvement.
//
// The catch: disambiguate mode ALSO rewrites Ctrl+<key> (Ctrl+C, Ctrl+A, …) into
// CSI-u, which would break every ctrl binding in the app (including ctrl+c to
// interrupt). Rather than teach every useInput handler the new encoding, we sit
// a translator in front of Ink that turns CSI-u sequences back into the legacy
// bytes Ink already parses — Ctrl+C → 0x03, Ctrl+A → 0x01, and so on — while
// mapping the one thing legacy can't express, Shift/Alt+Enter, to LF ('\n'),
// which PromptInput already treats as "insert a newline". Everything else in the
// app keeps working byte-for-byte as before.

// Push disambiguate mode (flag 0b1); pop it on exit. Written to stdout by cli.tsx
// alongside the alternate-screen / mouse enables.
export const KITTY_ON = '\x1b[>1u'
export const KITTY_OFF = '\x1b[<u'

// Translate one kitty "CSI u" key event (its parameter string, the part between
// "\x1b[" and the trailing "u") into the legacy byte(s) Ink expects, or '' to
// drop an event with no sensible legacy form. Params look like
// `code[:shifted[:base]][;mods[:event]]` — we only need the base key code and
// the modifier field.
function legacyForCsiU(params: string): string {
  const groups = params.split(';')
  const keyCode = Number(groups[0].split(':')[0])
  if (!Number.isFinite(keyCode)) return ''
  const modField = groups[1] ? Number(groups[1].split(':')[0]) : 1
  const mods = (Number.isFinite(modField) ? modField : 1) - 1 // bitmask
  const shift = (mods & 1) !== 0
  const alt = (mods & 2) !== 0
  const ctrl = (mods & 4) !== 0

  // Functional keys that carry a legacy byte.
  switch (keyCode) {
    case 13: return shift || alt ? '\n' : '\r' // Enter: Shift/Alt+Enter → newline
    case 27: return '\x1b'                      // Escape
    case 9: return shift ? '\x1b[Z' : '\t'      // Tab / Shift+Tab
    case 127: case 8: return '\x7f'             // Backspace
  }

  // Printable code points.
  if (keyCode >= 32) {
    // Ctrl+<letter> → C0 control byte (Ctrl+A = 0x01 … Ctrl+Z = 0x1a); this is
    // what makes ctrl bindings (including ctrl+c interrupt) keep working.
    if (ctrl && keyCode >= 97 && keyCode <= 122) return String.fromCharCode(keyCode - 96)
    if (ctrl && keyCode >= 65 && keyCode <= 90) return String.fromCharCode(keyCode - 64)
    let ch = String.fromCodePoint(keyCode)
    if (shift && keyCode >= 97 && keyCode <= 122) ch = ch.toUpperCase()
    return alt ? '\x1b' + ch : ch // Alt+<key> → ESC-prefixed, which Ink reads as meta
  }
  return ''
}

// Grace window (ms) for reassembling an escape sequence split across two stdin
// data chunks. Only a chunk that ENDS mid-escape waits this long; complete
// sequences pass through with no delay. Kept short enough to be imperceptible.
const ESC_FLUSH_MS = 25

// Translate one cooked run: strip bracketed-paste wrappers and rewrite complete
// CSI-u events to their legacy bytes. Everything else passes through untouched.
function cook(s: string): string {
  // Strip bracketed-paste markers (?2004h, enabled in cli.tsx). The terminal
  // wraps a paste in \x1b[200~ … \x1b[201~; we drop the wrapper and keep the
  // content, which then inserts as normal text (PromptInput's CR/LF handling
  // splits multi-line pastes). Without this the markers leak as literal
  // "[200~"/"[201~" and the kitty protocol mangles the paste.
  return s.replace(/\x1b\[20[01]~/g, '')
    // Replace every complete CSI-u event with its legacy form.
    .replace(/\x1b\[([0-9;:]+)u/g, (_full, params: string) => legacyForCsiU(params))
}

// Stateful translator over a raw stdin byte stream. Rewrites complete CSI-u key
// events to legacy bytes and leaves everything else (plain text, unmodified
// keys, mouse SGR reports, arrow/nav sequences) untouched. Cooked output is
// handed to `emit` (usually a write into the stream Ink reads).
//
// A sequence split across two data chunks is briefly held in `pending` so the
// rest can arrive. Crucially it is NOT held forever: after ESC_FLUSH_MS with no
// continuation we flush it as-is. That is what makes a BARE Escape keypress work
// on legacy terminals — kitty reports Escape as a complete CSI-u (\x1b[27u), but
// every non-kitty terminal sends a lone \x1b, which would otherwise sit in
// `pending` until the next keystroke and make ESC (cancel/vim/stop) feel dead.
export function createKittyTranslator(emit: (out: string) => void): (chunk: string) => void {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancelTimer = (): void => { if (timer) { clearTimeout(timer); timer = null } }
  return (chunk: string): void => {
    cancelTimer()
    let s = pending + chunk
    pending = ''
    // Hold a trailing, still-incomplete escape sequence (a lone ESC, or ESC + '['
    // + parameter bytes with no final byte yet). A COMPLETE sequence ends in a
    // final byte (a letter like 'u'/'M'/'m'/'A'), outside the parameter class
    // below, so the anchor can't reach it → not buffered.
    const tail = /\x1b(?:\[[0-9;:<>?]*)?$/.exec(s)
    if (tail) { pending = s.slice(tail.index); s = s.slice(0, tail.index) }
    if (s) emit(cook(s))
    if (pending) {
      // Nothing more came in time → the held bytes are a real keypress (usually a
      // bare ESC), not a split sequence. Flush them so Ink sees the key.
      timer = setTimeout(() => {
        timer = null
        const held = pending; pending = ''
        if (held) emit(cook(held))
      }, ESC_FLUSH_MS)
      timer.unref?.()
    }
  }
}
