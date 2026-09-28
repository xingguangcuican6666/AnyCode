// Terminal title / taskbar progress control for the `progressBar` setting.
// While a turn streams we advertise progress two ways: an OSC 0 window title
// (works everywhere) and an OSC 9;4 taskbar progress pulse (Windows Terminal,
// ConEmu, and other terminals that honor it; ignored elsewhere). Both are no-ops
// when stdout isn't a TTY so piped/CI runs stay clean.
const OSC = '\x1b]'
const BEL = '\x07'

function write(seq: string): void {
  try {
    if (process.stdout.isTTY) process.stdout.write(seq)
  } catch {
    // A closed/redirected stdout must never crash the app over a cosmetic title.
  }
}

/** Set the terminal window/tab title. */
export function setTermTitle(title: string): void {
  write(`${OSC}0;${title}${BEL}`)
}

/**
 * Drive the taskbar progress indicator. state 1 = indeterminate/normal (we use
 * the "indeterminate" pulse, code 3, while working), state 0 = clear.
 */
export function setTaskbarProgress(active: boolean): void {
  write(`${OSC}9;4;${active ? '3' : '0'};0${BEL}`)
}

/** Reset both title and taskbar progress to a clean idle state. */
export function clearTermProgress(idleTitle: string): void {
  setTaskbarProgress(false)
  setTermTitle(idleTitle)
}
