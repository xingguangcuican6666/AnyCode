// Terminal mode-setting escape sequences, shared by cli.tsx (which enters them
// for the session's lifetime and restores them on exit) and app.tsx's /editor
// bridge (which must LEAVE them so an external editor like vim/nano owns a clean
// terminal, then re-enter and repaint). Keeping them in one module avoids a
// cli.tsx ⇄ app.tsx import cycle and keeps the enter/leave pairs in lockstep.
//
//   \x1b[?1049h/l  alternate screen buffer (owned viewport; leaving restores the
//                  pre-launch terminal intact).
//   \x1b[2J\x1b[3J\x1b[H  clear screen + scrollback + home the cursor.

export const ALT_ON = '\x1b[?1049h'
export const ALT_OFF = '\x1b[?1049l'
export const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

// macOS Terminal.app honors legacy X10/normal mouse tracking (?1000h/?1002h) but
// does NOT implement SGR extended coordinates (?1006h). Every mouse listener in
// this app parses ONLY the SGR form (\x1b[<b;x;y M/m), so on Terminal.app enabling
// tracking would capture the mouse and stream legacy \x1b[M reports we can't
// decode — killing in-app scroll/select AND suppressing the terminal's own native
// wheel and text selection, leaving the user with neither. Since we can't read its
// reports anyway, we skip mouse tracking entirely there and let the native mouse
// work. This is the ONLY terminal-specific gate; on every other terminal the
// strings below are byte-for-byte what they always were (no behavior change).
const APPLE_TERMINAL = process.env.TERM_PROGRAM === 'Apple_Terminal'

// Session-level mouse enable/disable (written once at startup / on exit):
//   ?1000h button events + ?1002h button-event MOTION (drag streams as button 32)
//   + ?1006h SGR coordinates — the tracking triple, gated off on Terminal.app.
//   ?1004h focus reporting + ?2004h bracketed paste — harmless no-ops on terminals
//   that ignore them, so always requested. ?1003l (any-motion, only ever turned on
//   by a picker) is included in the OFF string so an abnormal exit can't leave it.
const MOUSE_TRACK_ON = APPLE_TERMINAL ? '' : '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
const MOUSE_TRACK_OFF = APPLE_TERMINAL ? '' : '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'
export const MOUSE_ON = MOUSE_TRACK_ON + '\x1b[?1004h\x1b[?2004h'
export const MOUSE_OFF = MOUSE_TRACK_OFF + '\x1b[?1004l\x1b[?2004l'

// Picker-level mouse motion: pickers turn on any-motion reporting (?1003h) while
// open so hover moves the highlight, then re-assert the app's base tracking on
// close (a bare ?1003l clears tracking entirely on some terminals, so we re-set
// ?1000h?1002h?1006h). Both are empty on Terminal.app so a picker can never
// re-enable the tracking the session-level gate deliberately left off.
export const PICKER_MOTION_ON = APPLE_TERMINAL ? '' : '\x1b[?1003h'
export const PICKER_MOTION_OFF = APPLE_TERMINAL ? '' : '\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h'
