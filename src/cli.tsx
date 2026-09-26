import React from 'react'
import { render } from 'ink'
import { App, type SessionSnapshot } from './app'
import type { AppConfig } from './types'
import { loadConfig } from './config'
import { getProvider } from './providers'
import { NAME, VERSION } from './version'
import { newSessionId, saveSession, loadSession, latestSession } from './lib/sessions'

// Fullscreen (alternate-screen) control sequences. AnyCode owns the whole
// viewport the way Claude Code does — the transcript is a self-managed scroll
// container, NOT native terminal scrollback. That means: no <Static>, so the
// terminal never accumulates a scrollback buffer (hence no native scrollbar and
// no mouse-wheel-scrolls-the-terminal), and modal overlays repaint cleanly with
// nothing underneath to ghost.
//   \x1b[?1049h  enter the alternate screen buffer (a fresh, scrollback-less
//                screen; leaving it restores the pre-launch terminal intact).
//   \x1b[?1000h  report mouse button events — crucially the wheel (buttons
//   \x1b[?1006h  64/65) — in SGR form (\x1b[<b;x;y M/m), which App parses to
//                scroll ITS viewport instead of the terminal. Text selection
//                then needs Shift/Option-drag (the usual full-TUI trade-off).
const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'
// ?1000h button events + ?1002h button-event MOTION (so a left-drag streams as
// button 32, which App turns into a text selection) + ?1006h SGR coordinates.
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1006l'
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

const argv = process.argv.slice(2)

function has(...flags: string[]): boolean {
  return argv.some((a) => flags.includes(a))
}

// Returns the value for --flag / -f. Distinguishes three cases:
//   undefined -> flag absent
//   ''        -> flag present but no usable value (next token is another flag,
//                or the flag was last) — callers decide whether that's an error
//   <string>  -> the value (from `--flag value` or `--flag=value`)
function flagValue(...names: string[]): string | undefined {
  for (const name of names) {
    const i = argv.findIndex((a) => a === name)
    if (i >= 0) {
      const next = argv[i + 1]
      // Don't greedily swallow the following option as if it were the value.
      return next !== undefined && !next.startsWith('-') ? next : ''
    }
    const eq = argv.find((a) => a.startsWith(name + '='))
    if (eq) return eq.slice(eq.indexOf('=') + 1)
  }
  return undefined
}

function printHelp(): void {
  process.stdout.write(`${NAME} v${VERSION} — a Claude Code–style coding agent

Usage:
  meowcode                      Start an interactive session
  meowcode -p "<prompt>"        Print mode: one-shot, non-interactive
  echo "<prompt>" | meowcode    Same, reading the prompt from stdin

Options:
  -p, --print <prompt>   Run a single prompt and stream the response to stdout
  -c, --continue         Resume the most recent session
      --resume [id]      Resume a saved session (the latest, or the given id)
      --model <id>       Model to use for this run
      --provider <id>    Provider to use (mock | anthropic)
  -h, --help             Show this help
  -v, --version          Show the version

Environment:
  ANTHROPIC_API_KEY      When set, the real Anthropic API is used by default
`)
}

async function runPrint(prompt: string, config: AppConfig): Promise<void> {
  const provider = getProvider(config)
  const messages = [{ id: 'u1', role: 'user' as const, content: prompt }]
  for await (const chunk of provider.stream(messages, { model: config.model, system: config.system })) {
    process.stdout.write(chunk)
  }
  process.stdout.write('\n')
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

// Interactive session. Both /clear and /compact tear down the Ink instance and
// remount a fresh one — the reliable way to reset Ink's log-update accounting
// and re-seed the transcript. /clear starts empty; /compact carries the folded
// transcript forward via a SessionSnapshot. Resize no longer remounts (the
// owned viewport reflows on a dims state change), so there is no <Static> to
// desync. We own the whole screen via the alternate buffer for the session's
// lifetime and, on a clean exit, leave the terminal tidy the way Claude Code
// does — no full-transcript dump, just a one-line closing trace (see finally).
async function runInteractive(initial: AppConfig, resume?: { snapshot: SessionSnapshot; id: string }): Promise<void> {
  let config = initial
  let snapshot: SessionSnapshot | null = resume?.snapshot ?? null
  // Latest live session state, kept current by App via onSnapshot, so the exit
  // dump prints the final transcript after we leave the alternate screen.
  let last: SessionSnapshot | null = null
  // The id of the session file we autosave into. One per process, EXCEPT /clear
  // (rotates to a fresh session) and /resume (adopts the reopened session's id).
  let sessionId = resume?.id ?? newSessionId()
  // Debounce autosaves: transcripts change on every token while streaming, so we
  // coalesce writes to at most one per idle window rather than hitting the disk
  // per frame. The finally block flushes a final save on exit.
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; if (last) saveSession(sessionId, last) }, 1500)
  }

  process.stdout.write(ALT_ON + MOUSE_ON + CLEAR)
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    process.stdout.write(MOUSE_OFF + ALT_OFF)
  }
  // Always restore the terminal, even on a crash or signal — a stuck alternate
  // screen / mouse mode would otherwise leave the user's shell unusable.
  process.on('exit', restore)

  try {
    for (;;) {
      let again = false
      let instance: ReturnType<typeof render> | undefined
      const remount = (next: AppConfig, snap: SessionSnapshot | null): void => {
        config = next
        snapshot = snap
        again = true
        instance?.unmount()
        process.stdout.write(CLEAR)
      }
      // /clear: drop the transcript AND start a brand-new session file (the old one
      // stays saved on disk and is reachable via /resume).
      const onClear = (next: AppConfig): void => { sessionId = newSessionId(); last = null; remount(next, null) }
      // /compact: keep the (folded) transcript, remount cleanly (same session).
      const onRepaint = (snap: SessionSnapshot): void => remount(snap.config, snap)
      // /resume: reopen a saved session — adopt its id so autosaves keep updating
      // that file, and re-inject the env API key the stored config never carries.
      const onResume = (snap: SessionSnapshot, id: string): void => {
        sessionId = id
        last = null
        remount({ ...snap.config, apiKey: process.env.ANTHROPIC_API_KEY }, snap)
      }
      const onSnapshot = (snap: SessionSnapshot): void => { last = snap; scheduleSave() }
      // App owns ctrl+c (interrupt / press-twice-to-exit), so keep Ink from
      // exiting on the first ctrl+c itself.
      instance = render(
        <App config={config} initial={snapshot} onClear={onClear} onRepaint={onRepaint} onSnapshot={onSnapshot} onResume={onResume} />,
        { exitOnCtrlC: false },
      )
      await instance.waitUntilExit()
      if (!again) break
    }
  } finally {
    if (saveTimer) clearTimeout(saveTimer)
    if (last) saveSession(sessionId, last) // flush a final autosave before we leave
    restore()
    // Clean exit, the way Claude Code leaves the terminal: leaving the alternate
    // screen already restored the pre-launch terminal, so we do NOT re-dump the
    // whole transcript into the normal buffer — that just leaves clutter behind
    // ("退出后残留"). We print a single closing line as a trace the session ran.
    const snap = last as SessionSnapshot | null
    const n = snap ? snap.messages.filter((m) => m.content !== '__banner__' && m.content.trim()).length : 0
    if (n > 0) {
      process.stdout.write(`\n${NAME} session ended · ${n} message${n === 1 ? '' : 's'}. Run \`meowcode\` to start again.\n`)
    }
  }
}

async function main(): Promise<void> {
  if (has('-h', '--help')) { printHelp(); return }
  if (has('-v', '--version')) { process.stdout.write(VERSION + '\n'); return }

  let config = loadConfig()
  const model = flagValue('--model')
  if (model) config.model = model
  const provider = flagValue('--provider')
  if (provider) config.provider = provider

  if (has('-p', '--print')) {
    const prompt = flagValue('-p', '--print')
    if (!prompt) {
      process.stderr.write('Error: -p/--print requires a prompt argument.\n')
      process.exit(1)
    }
    await runPrint(prompt, config)
    return
  }

  if (!process.stdin.isTTY) {
    const piped = await readStdin()
    if (piped) { await runPrint(piped, config); return }
    process.stderr.write(
      'Error: no prompt provided and stdin is not a TTY.\n' +
      'Use `meowcode -p "<prompt>"`, pipe a prompt in, or start `meowcode` in an interactive terminal.\n',
    )
    process.exit(1)
  }

  // Session resume: `--continue`/`-c` reopens the most recent session; `--resume
  // [id]` reopens a specific one (or the latest when no id is given). The stored
  // config drives the reopened session (model/theme/settings), with the API key
  // re-injected from the environment since it's never written to disk.
  let resume: { snapshot: SessionSnapshot; id: string } | undefined
  if (has('-c', '--continue', '--resume')) {
    const wanted = flagValue('--resume')
    const id = wanted || latestSession()?.id
    const snap = id ? loadSession(id) : null
    if (id && snap) {
      resume = { snapshot: snap, id }
      config = { ...snap.config, apiKey: process.env.ANTHROPIC_API_KEY }
      if (model) config.model = model
      if (provider) config.provider = provider
    } else {
      process.stderr.write('No saved session to resume.\n')
    }
  }

  await runInteractive(config, resume)
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n')
  process.exit(1)
})
