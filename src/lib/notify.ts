// Desktop notifications for the `localNotifications` setting. Terminals expose
// several notification escapes; we emit the two broadly-supported ones plus a
// BEL fallback, all no-ops when stdout isn't a TTY. This never blocks and never
// throws — a notification is cosmetic and must not disturb the session.
//   OSC 9    \x1b]9;<body>\x07            — iTerm2 (and some others)
//   OSC 777  \x1b]777;notify;<t>;<b>\x07  — urxvt / notify-send bridges
const BEL = '\x07'

/** Fire a best-effort desktop notification with a title and body. */
export function notifyDesktop(title: string, body: string): void {
  try {
    if (!process.stdout.isTTY) return
    const t = title.replace(/[\x00-\x1f]/g, ' ')
    const b = body.replace(/[\x00-\x1f]/g, ' ')
    process.stdout.write(`\x1b]777;notify;${t};${b}${BEL}`)
    process.stdout.write(`\x1b]9;${t} — ${b}${BEL}`)
    process.stdout.write(BEL)
  } catch {
    // A closed/redirected stdout must never crash the app over a notification.
  }
}
