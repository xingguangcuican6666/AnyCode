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

// Stateful translator over a raw stdin byte stream. Rewrites complete CSI-u key
// events to legacy bytes and leaves everything else (plain text, unmodified
// keys, mouse SGR reports, arrow/nav sequences) untouched. A sequence split
// across two data chunks is held in `pending` until the rest arrives.
export function createKittyTranslator(): (chunk: string) => string {
  let pending = ''
  return (chunk: string): string => {
    let s = pending + chunk
    pending = ''
    // Hold a trailing, still-incomplete escape sequence (CSI-u or mouse SGR): a
    // lone ESC, or ESC + '[' + parameter bytes with no final byte yet. A COMPLETE
    // sequence ends in a final byte (a letter like 'u'/'M'/'m'/'A'), which is not
    // in the parameter class below, so the anchor can't reach it → not buffered.
    const tail = /\x1b(?:\[[0-9;:<>?]*)?$/.exec(s)
    if (tail) { pending = s.slice(tail.index); s = s.slice(0, tail.index) }
    // Replace every complete CSI-u event with its legacy form.
    return s.replace(/\x1b\[([0-9;:]+)u/g, (_full, params: string) => legacyForCsiU(params))
  }
}
