import React from 'react'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { App, type SessionSnapshot } from './app'
import type { AppConfig } from './types'
import { loadConfig } from './config'
import { getProvider } from './providers'
import { NAME, VERSION } from './version'
import { newSessionId, saveSession, loadSession, latestSession, forkSession } from './lib/sessions'
import { KITTY_ON, KITTY_OFF, createKittyTranslator } from './lib/kittykeys'
import { StringDecoder } from 'node:string_decoder'
// Fullscreen control sequences (alternate screen + mouse/paste enables). MeowCode
// owns the whole viewport the way Claude Code does — the transcript is a
// self-managed scroll container, NOT native terminal scrollback: no <Static>, so
// the terminal never accumulates a scrollback buffer and overlays repaint cleanly.
// The exact sequences (and the Terminal.app mouse gate) live in lib/termmodes so
// the /editor bridge in app.tsx can leave and re-enter the same modes.
import { ALT_ON, ALT_OFF, MOUSE_ON, MOUSE_OFF, CLEAR } from './lib/termmodes'

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
      --fork-session [id]  Open a copy of a saved session, leaving the original intact
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
  // True only while `snapshot` came from /resume or --continue (not a /compact
  // remount), so App shows the session recap exactly once on a real reopen.
  let resumed = !!resume
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

  process.stdout.write(ALT_ON + MOUSE_ON + KITTY_ON + CLEAR)

  // Sit a translator in front of Ink's stdin so the kitty keyboard protocol
  // (enabled above) gives us Shift/Alt+Enter as a newline while every other key
  // — including ctrl+c — still reaches Ink as the legacy byte it expects (see
  // lib/kittykeys). `wrapped` is a plain readable Ink and the mouse listener both
  // consume; we forward process.stdin through the translator into it and proxy
  // the TTY controls Ink needs (isTTY / setRawMode) back to the real stdin.
  const source = process.stdin
  const wrapped = new PassThrough() as PassThrough & {
    isTTY?: boolean
    setRawMode?: (mode: boolean) => unknown
    ref?: () => unknown
    unref?: () => unknown
  }
  wrapped.isTTY = source.isTTY
  wrapped.setRawMode = (mode: boolean) => { source.setRawMode?.(mode); return wrapped }
  wrapped.ref = () => wrapped
  wrapped.unref = () => wrapped
  const translate = createKittyTranslator((out) => { wrapped.write(out) })
  // Decode raw stdin with a persistent StringDecoder, NOT chunk.toString('utf8').
  // `source` (process.stdin, raw mode) emits Buffers with no encoding set — Ink's
  // own stdin.setEncoding runs on the downstream `wrapped` PassThrough, i.e. AFTER
  // this decode, so it can't help. A multibyte code point (3-byte CJK, 4-byte
  // emoji) that straddles a chunk boundary — common on any paste larger than the
  // pty buffer — would decode to U+FFFD (�) with per-chunk toString, silently
  // corrupting pasted Chinese/emoji. StringDecoder holds the incomplete trailing
  // bytes until the next chunk completes the sequence, so nothing is mangled.
  const decoder = new StringDecoder('utf8')
  const forward = (chunk: Buffer): void => { translate(decoder.write(chunk)) }
  source.on('data', forward)

  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    source.off('data', forward)
    process.stdout.write(KITTY_OFF + MOUSE_OFF + ALT_OFF)
  }
  // Always restore the terminal, even on a crash or signal — a stuck alternate
  // screen / mouse mode would otherwise leave the user's shell unusable. 'exit'
  // covers normal completion and process.exit(); async termination signals do
  // NOT fire 'exit' on their own, so bind them too and then re-exit. We skip
  // SIGINT: in raw mode the terminal delivers ctrl+c to App as a 0x03 byte (its
  // press-twice-to-exit handler) rather than raising SIGINT, so a SIGINT handler
  // here would only shadow that without benefit.
  process.on('exit', restore)
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    process.once(sig, () => { restore(); process.exit(sig === 'SIGTERM' ? 143 : sig === 'SIGHUP' ? 129 : 131) })
  }

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
      const onClear = (next: AppConfig): void => { sessionId = newSessionId(); last = null; resumed = false; remount(next, null) }
      // /compact: keep the (folded) transcript, remount cleanly (same session).
      const onRepaint = (snap: SessionSnapshot): void => { resumed = false; remount(snap.config, snap) }
      // /resume: reopen a saved session — adopt its id so autosaves keep updating
      // that file, and re-inject the env API key the stored config never carries.
      const onResume = (snap: SessionSnapshot, id: string): void => {
        sessionId = id
        last = null
        resumed = true
        remount({ ...snap.config, apiKey: process.env.ANTHROPIC_API_KEY }, snap)
      }
      // /fork: branch the current conversation. Freeze the original session file as
      // it stands now, then rotate to a fresh id so continued work lands in a new
      // session — the original stays on disk, reopenable via /resume. No remount:
      // the live transcript carries on unchanged, only its autosave target moves.
      // Returns the new id (or null when there's no transcript saved yet to fork).
      const onFork = (): string | null => {
        if (!last) return null
        saveSession(sessionId, last) // freeze the original at the fork point
        sessionId = newSessionId()   // future autosaves target the branch
        saveSession(sessionId, last) // materialize the branch immediately
        return sessionId
      }
      const onSnapshot = (snap: SessionSnapshot): void => { last = snap; scheduleSave() }
      // App owns ctrl+c (interrupt / press-twice-to-exit), so keep Ink from
      // exiting on the first ctrl+c itself.
      instance = render(
        <App config={config} initial={snapshot} resumed={resumed} sessionId={sessionId} onClear={onClear} onRepaint={onRepaint} onSnapshot={onSnapshot} onResume={onResume} onFork={onFork} />,
        { exitOnCtrlC: false, stdin: wrapped as unknown as NodeJS.ReadStream },
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
  if (has('--fork-session')) {
    // `--fork-session [id]` opens a COPY of a saved session (the latest when no id
    // is given) under a fresh id, leaving the original untouched — a branch point
    // straight from launch, symmetric with `--resume`.
    const wanted = flagValue('--fork-session')
    const srcId = wanted || latestSession()?.id
    const forkedId = srcId ? forkSession(srcId) : null
    const snap = forkedId ? loadSession(forkedId) : null
    if (forkedId && snap) {
      resume = { snapshot: snap, id: forkedId }
      config = { ...snap.config, apiKey: process.env.ANTHROPIC_API_KEY }
      if (model) config.model = model
      if (provider) config.provider = provider
    } else {
      process.stderr.write('No saved session to fork.\n')
    }
  } else if (has('-c', '--continue', '--resume')) {
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
