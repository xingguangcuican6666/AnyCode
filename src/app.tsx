import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import type { AppConfig, LoopSpec, Message as Msg, PanelTab, SessionUsage } from './types'
import { useChat, type ChatActions } from './hooks/useChat'
import { StatusLine } from './components/StatusLine'
import { PromptInput } from './components/PromptInput'
import { ThemePicker } from './components/ThemePicker'
import { SettingsPanel } from './components/SettingsPanel'
import { WorkflowView, WorkflowCollapsed } from './components/WorkflowView'
import { getSetting } from './lib/settings'
import { contextState, contextLevel, AUTO_COMPACT_RATIO, fmtTokens, bar } from './lib/usage'
import { compactMessages } from './lib/compact'
import { flattenMessages, thinkingLines, type LineKind } from './lib/transcript'
import { registry } from './commands'
import { ThemeProvider, getTheme } from './theme'
import { setGoal } from './lib/memory'
import { judgeGoal } from './lib/goalJudge'

export type ActiveLoop = LoopSpec & { runs: number }

function formatInterval(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000}h`
  if (ms % 60000 === 0) return `${ms / 60000}m`
  return `${Math.round(ms / 1000)}s`
}

function formatLoop(l: ActiveLoop): string {
  const cadence = l.intervalMs !== null ? `every ${formatInterval(l.intervalMs)}` : 'self-paced'
  return `Looping "${l.payload}" ${cadence} · ${l.runs} run${l.runs === 1 ? '' : 's'} done · /loop stop to cancel`
}

// A goal AnyCode autonomously works toward, like Claude Code's /goal. `startedAt`
// drives the live "◎ /goal active (Ns)" timer; `runs` counts turns spent on it.
export type ActiveGoal = { text: string; startedAt: number; runs: number }

function formatGoal(g: ActiveGoal, elapsed: number, judging = false): string {
  const tail = judging ? ' · evaluating whether to continue…' : ''
  return `◎ /goal active (${elapsed}s) · working toward: ${g.text}${tail} · /goal clear to stop`
}

// A snapshot of the live session, carried across a clean resize remount so the
// transcript, active goal, and active loop survive the fresh Ink instance.
export interface SessionSnapshot {
  config: AppConfig
  messages: Msg[]
  goal: ActiveGoal | null
  loop: ActiveLoop | null
  usage: SessionUsage
}

interface Props {
  config: AppConfig
  // Session state to seed the fresh instance with after a /compact remount.
  // Null/undefined on a normal start or after /clear.
  initial?: SessionSnapshot | null
  // Reset the session. The CLI unmounts and remounts a fresh Ink instance so
  // Ink's log-update accounting is truly cleared; the live config is handed
  // back so /model and /provider changes carry over.
  onClear: (config: AppConfig) => void
  // Clean remount preserving the (folded) snapshot — used by /compact and
  // auto-compaction to re-seed a shorter transcript.
  onRepaint: (snapshot: SessionSnapshot) => void
  // Report the latest live session state so the CLI can dump the transcript to
  // the normal buffer on exit (the alternate screen is otherwise discarded).
  onSnapshot?: (snapshot: SessionSnapshot) => void
}

export function App({ config, initial, onClear, onRepaint, onSnapshot }: Props): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { stdin } = useStdin()
  const chat = useChat(config, initial?.messages, initial?.usage)
  const [elapsed, setElapsed] = useState(0)
  const [exitArmed, setExitArmed] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  // The interactive settings/status overlay (Settings/Status/Config/Usage/Stats),
  // opened by /config /status /usage /stats. Null when closed. Like ThemePicker it
  // renders in place of the input cluster and owns the keyboard while open.
  const [panel, setPanel] = useState<PanelTab | null>(null)
  // Transcript scroll position: null = following the live bottom (auto-scroll as
  // content streams), a number = the index of the first visible line while the
  // user has scrolled up. The owned viewport windows the flattened transcript
  // itself (no <Static>, no native scrollback), so PageUp/PageDown, the mouse
  // wheel (SGR events parsed below) and ctrl+End all move THIS, with the input
  // bar staying fixed at the bottom.
  const [scrollTop, setScrollTop] = useState<number | null>(null)
  // Workflow overlay state. `wfExpanded` is the id of the workflow whose full
  // tree is open (null = none); it renders in the live region and owns the
  // keyboard while open. `wfSel` is the index of the collapsed line under the
  // selection cursor (null = not selecting) — entered with ↓ from the input,
  // moved with ↑↓, ↵ expands the selected line, esc cancels. Both auto-reset
  // when the workflows clear at turn end.
  const [wfExpanded, setWfExpanded] = useState<string | null>(null)
  const [wfSel, setWfSel] = useState<number | null>(null)
  const [loop, setLoop] = useState<ActiveLoop | null>(initial?.loop ?? null)
  const [goal, setGoalRun] = useState<ActiveGoal | null>(initial?.goal ?? null)
  const [goalElapsed, setGoalElapsed] = useState(0)
  // A turn just finished under a goal → the detached stop-hook judge is
  // deciding continue-vs-complete. Guarded by a ref so it fires exactly once
  // per finished turn; the boolean drives the indicator.
  const [judging, setJudging] = useState(false)
  const judgingRef = useRef(false)
  // Lines the user submitted while a response was streaming; flushed when idle.
  const [queued, setQueued] = useState<string[]>([])
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Refs so the idle driver always reads the live chat/loop/goal without re-subscribing.
  const chatRef = useRef(chat); chatRef.current = chat
  const loopRef = useRef(loop); loopRef.current = loop
  const goalRef = useRef(goal); goalRef.current = goal
  const panelRef = useRef(panel); panelRef.current = panel
  const scrollTopRef = useRef<number | null>(scrollTop); scrollTopRef.current = scrollTop
  const wfExpandedRef = useRef(wfExpanded); wfExpandedRef.current = wfExpanded
  const wfSelRef = useRef(wfSel); wfSelRef.current = wfSel
  // Timestamp of the last time the workflow tree was dismissed. The global esc
  // handler ignores esc for a short window afterwards so "esc to go back" from
  // the tree can never also interrupt the running turn — whether via a rapid
  // second esc or an Ink handler-ordering race across the closing re-render.
  const wfClosedAtRef = useRef(0)
  // Live windowing extents (updated each render) so the mouse-wheel listener and
  // the key handlers scroll against the current transcript size without stale
  // closures: maxTop = furthest-up first-visible line, pageStep = a page's worth.
  const maxTopRef = useRef(0)
  const pageStepRef = useRef(1)

  const streaming = chat.status === 'streaming'

  // Terminal size as reactive state. Ink reflows its own Yoga layout on resize
  // but does NOT re-run React components, so anything that wraps text against a
  // JS width value (the windowed transcript, the input's horizontal window)
  // would otherwise keep the width captured at the last render. Subscribing to
  // 'resize' re-renders at the new size. With the owned viewport there is no
  // <Static> to desync, so a resize is a plain state update — no remount.
  const [dims, setDims] = useState<{ cols: number; rows: number }>(() => ({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }))

  // Compaction folds older messages into a digest, then applies the result by
  // remounting a fresh Ink instance (via onRepaint) seeded with the shorter
  // transcript. A remount is required because history lives in Ink's
  // append-only <Static>, which can't drop or replace already-emitted lines —
  // only a fresh instance re-emits the compacted transcript cleanly. Returns
  // the number of messages folded (0 = nothing to do, no remount). Drives both
  // /compact and auto-compaction.
  const doCompact = (): number => {
    const { messages: folded, folded: n } = compactMessages(chatRef.current.messages)
    if (n <= 0) return 0
    onRepaint({
      config: chatRef.current.config,
      messages: folded,
      goal: goalRef.current,
      loop: loopRef.current,
      usage: { ...chatRef.current.usage, compactions: chatRef.current.usage.compactions + 1 },
    })
    return n
  }
  // Scroll helpers for the owned viewport. `null` scrollTop = following the live
  // bottom; a number pins the first visible line. Reaching the bottom resumes
  // following. All read the live extents via refs so the mouse listener and the
  // key handlers stay correct as the transcript grows while streaming.
  const applyScroll = (delta: number): void => {
    const maxTop = maxTopRef.current
    setScrollTop((st) => {
      const from = st === null ? maxTop : st
      const next = from + delta
      return next >= maxTop ? null : Math.max(0, next)
    })
  }
  const resumeFollow = (): void => setScrollTop(null)

  // Resize → just update dims; the viewport reflows (no remount, no <Static>).
  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => setDims({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  // Mouse wheel → scroll the transcript. cli.tsx enables SGR mouse reporting
  // (\x1b[?1000h\x1b[?1006h); wheel up/down arrive as button 64/65 in the
  // \x1b[<b;x;y(M|m) form. Ink's useInput doesn't surface mouse events, so we
  // read them off stdin directly and move the viewport a few lines per notch.
  useEffect(() => {
    if (!stdin) return
    const onData = (data: Buffer): void => {
      const s = data.toString('utf8')
      const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g
      let m: RegExpExecArray | null
      let delta = 0
      while ((m = re.exec(s)) !== null) {
        const b = Number(m[1])
        if (b === 64) delta -= 3
        else if (b === 65) delta += 3
      }
      if (delta !== 0) applyScroll(delta)
    }
    stdin.on('data', onData)
    return () => { stdin.off('data', onData) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  const width = dims.cols
  // Resolve the active palette from config and hand it to the whole tree.
  const colors = getTheme(chat.config.theme).colors

  // Live context-window fill, used for the warning line and auto-compaction.
  const ctx = contextState(chat.messages, chat.config.model)
  const ctxLevel = contextLevel(ctx.ratio)
  // The workflow whose tree is currently expanded (looked up by id), or null.
  const expandedWf = wfExpanded ? chat.workflows.find((w) => w.id === wfExpanded) ?? null : null

  // A modal overlay (theme picker / settings / workflow tree) replaces the whole
  // content area — you operate it rather than read the transcript behind it.
  const modalOpen = pickerOpen || !!panel || !!expandedWf
  const scrolled = scrollTop !== null

  // Report the latest transcript so the CLI can dump it to the normal buffer on
  // exit (the alternate screen buffer is discarded when we leave it).
  useEffect(() => {
    onSnapshot?.({ config: chat.config, messages: chat.messages, goal, loop, usage: chat.usage })
  }, [chat.config, chat.messages, chat.usage, goal, loop, onSnapshot])

  // Rows below the viewport, all fixed to the terminal's bottom edge: the
  // transient status lines + the input box (3 rows for the empty single-line box)
  // + the collapsed workflow lines + the footer, plus a scroll indicator while
  // scrolled up. This is an estimate — overflow:hidden on the viewport keeps a
  // miscount harmless (a small gap at worst, never a clipped input). The command
  // menu grows the input box, but you're typing (not scrolling) then, so we don't
  // model it here.
  const INPUT_ROWS = 3
  const clusterH =
    (goal || loop ? 1 : 0) +
    queued.length +
    (streaming ? 1 : 0) +
    (ctxLevel !== 'ok' ? 1 : 0) +
    INPUT_ROWS +
    chat.workflows.length +
    1 + // footer
    (scrolled ? 1 : 0)
  const viewportH = Math.max(1, dims.rows - clusterH)

  // The whole transcript as flat, one-row-per-entry lines: banner + committed
  // messages + the live reasoning/reply tail. The committed part is memoized (it
  // changes only when a message is appended) so scrolling a long transcript
  // doesn't re-render every message's markdown per keystroke; the live tail
  // changes each frame while streaming.
  const committed = useMemo(() => flattenMessages(chat.messages, width, { banner: true }), [chat.messages, width])
  const liveThink = useMemo(
    () => (chat.thinking && chat.thinking.content.trim() ? thinkingLines(chat.thinking, width) : []),
    [chat.thinking, width],
  )
  const liveStream = useMemo(
    () => (chat.streaming && chat.streaming.content.trim() ? flattenMessages([chat.streaming], width) : []),
    [chat.streaming, width],
  )
  const lines = useMemo(() => committed.concat(liveThink, liveStream), [committed, liveThink, liveStream])
  const total = lines.length

  // Windowing: `scrollTop === null` follows the bottom (the common case — new
  // lines append below and stay visible); a fixed number keeps a scrolled reader
  // put as content streams in below. maxTop/pageStep go into refs the keyboard
  // and mouse handlers read (they close over stale state otherwise).
  const maxTop = Math.max(0, total - viewportH)
  const pageStep = Math.max(1, viewportH - 1)
  maxTopRef.current = maxTop
  pageStepRef.current = pageStep
  const cur = scrollTop === null ? maxTop : Math.min(scrollTop, maxTop)
  const visible = lines.slice(cur, cur + viewportH)
  const below = Math.max(0, total - (cur + viewportH))
  // Fresh / short session → banner sits at the TOP, input at the BOTTOM, an empty
  // middle between them (exactly what real Claude Code shows — see #52). Once the
  // transcript overflows, the tail pins just above the input instead.
  const anchor = total > viewportH ? 'flex-end' : 'flex-start'
  const colorFor = (k: LineKind): string | undefined => {
    switch (k) {
      case 'user': return colors.user
      case 'assistant': return colors.text
      case 'error': return colors.error
      case 'retry': return colors.warning
      case 'tool-header': return colors.accent
      default: return colors.dim
    }
  }

  // Auto-compaction: when the context fills past the threshold and we're idle,
  // fold older messages into a digest exactly like Claude Code. Re-runs only
  // when the ratio changes, so it fires once per crossing and never mid-stream.
  useEffect(() => {
    if (streaming) return
    if (ctx.ratio < AUTO_COMPACT_RATIO) return
    doCompact() // remounts with the compacted transcript when it folds anything
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, ctx.ratio])

  // Elapsed-time ticker while the model is working.
  useEffect(() => {
    if (!streaming) { setElapsed(0); return }
    const start = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(t)
  }, [streaming])

  // Live "◎ /goal active (Ns)" timer while a goal is being worked.
  useEffect(() => {
    if (!goal) { setGoalElapsed(0); return }
    const tick = (): void => setGoalElapsed(Math.floor((Date.now() - goal.startedAt) / 1000))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [goal])

  // Keep the workflow overlay state consistent with the live list: when the
  // workflows clear (turn end) drop both the expansion and the selection; if the
  // expanded/selected line disappears (a workflow finishing early), close/clamp.
  useEffect(() => {
    const wfs = chat.workflows
    if (wfs.length === 0) {
      if (wfExpanded !== null) setWfExpanded(null)
      if (wfSel !== null) setWfSel(null)
      return
    }
    if (wfExpanded !== null && !wfs.some((w) => w.id === wfExpanded)) setWfExpanded(null)
    if (wfSel !== null && wfSel > wfs.length - 1) setWfSel(wfs.length - 1)
  }, [chat.workflows, wfExpanded, wfSel])

  // Global keys: esc interrupts a stream and stops autonomous goal work; ctrl+c
  // twice exits. Esc handles the goal even between turns (when not streaming), so
  // it's a reliable "stop working on this" — /goal clear also forgets the goal.
  useInput((input, key) => {
    // The expanded workflow tree owns the keyboard (its own useInput handles
    // ↑↓/x/esc) while open.
    if (wfExpandedRef.current) return
    // While the settings overlay is open it owns the keyboard (its own useInput
    // handles esc/arrows/typing); don't let esc here also interrupt/stop.
    if (panelRef.current) {
      if (key.ctrl && input === 'c') { setPanel(null); return }
      return
    }
    // Workflow selection mode: a cursor runs across the collapsed workflow lines.
    // ↑↓ move it, ↵ expands the selected line into the full tree, esc cancels.
    // PromptInput is inactive while this is on (active={wfSel===null}), so App
    // owns these keys with no double-fire. Entry is via PromptInput's
    // onOverflowDown (a single ↓ past the input), so there's one point of entry.
    if (wfSelRef.current !== null) {
      const wfs = chatRef.current.workflows
      if (wfs.length === 0) { setWfSel(null); return }
      if (key.escape) { setWfSel(null); return }
      // ↑ from the top collapsed line returns focus to the input box (mirroring
      // the single ↓ that entered selection via onOverflowDown); otherwise it
      // moves the cursor up one line. Without the escape-at-0, ↑ clamped at 0 and
      // the input became unreachable — you could only leave selection via esc.
      if (key.upArrow) { setWfSel((s) => ((s ?? 0) <= 0 ? null : (s as number) - 1)); return }
      if (key.downArrow) { setWfSel((s) => Math.min(wfs.length - 1, (s ?? 0) + 1)); return }
      if (key.return) {
        const w = wfs[Math.min(wfSelRef.current ?? 0, wfs.length - 1)]
        if (w) { setWfExpanded(w.id); setWfSel(null) }
        return
      }
      return // swallow other keys while selecting
    }
    // Transcript scrolling. The owned viewport windows the flattened transcript
    // in place, so PageUp/PageDown move the first-visible line while the input bar
    // stays fixed at the bottom — even mid-stream (scrolling pins the view while
    // new lines append below). ↑/↓ stay with PromptInput (history/cursor); the
    // mouse wheel scrolls too (see the SGR listener above).
    if (key.pageUp && !pickerOpen) { applyScroll(-pageStepRef.current); return }
    if (key.pageDown && !pickerOpen) { applyScroll(pageStepRef.current); return }
    // ctrl+End (best-effort ctrl+F/~, since terminals surface End inconsistently)
    // jumps back to the live bottom and resumes following.
    if (key.ctrl && /F|~/.test(input)) { resumeFollow(); return }
    // esc while scrolled up snaps back to the bottom first, so a scrolled esc
    // never doubles as interrupting the running turn.
    if (key.escape && scrollTopRef.current !== null) { resumeFollow(); return }
    if (key.escape && (streaming || goalRef.current)) {
      // Swallow the esc that just dismissed the workflow tree (and any immediate
      // repeat), so returning from the view never doubles as interrupting.
      if (Date.now() - wfClosedAtRef.current < 250) return
      if (streaming) chat.interrupt()
      if (goalRef.current) setGoalRun(null)
      return
    }
    if (key.ctrl && input === 'c') {
      if (streaming) { chat.interrupt(); return }
      if (exitArmed) { exit(); return }
      setExitArmed(true)
      if (exitTimer.current) clearTimeout(exitTimer.current)
      exitTimer.current = setTimeout(() => setExitArmed(false), 1200)
    }
  })

  // Build the action bundle handed to every submit (exit/clear/theme/loop hooks).
  const makeActions = (): ChatActions => ({
    exit,
    clear: () => onClear(chatRef.current.config),
    openThemePicker: () => setPickerOpen(true),
    startLoop: (spec) => setLoop({ ...spec, runs: 0 }),
    stopLoop: () => setLoop(null),
    loopStatus: () => (loopRef.current ? formatLoop(loopRef.current) : null),
    startGoal: (text) => setGoalRun({ text, startedAt: Date.now(), runs: 0 }),
    stopGoal: () => setGoalRun(null),
    goalStatus: () =>
      goalRef.current ? formatGoal(goalRef.current, Math.floor((Date.now() - goalRef.current.startedAt) / 1000), judgingRef.current) : null,
    // Custom commands / /skill run a prompt as if the user had typed it. Route
    // through the type-ahead queue so it starts on the next idle tick — never
    // re-entrantly inside the /command turn that requested it.
    send: (text: string) => setQueued((q) => [...q, text]),
    compact: () => doCompact(),
    openPanel: (tab) => setPanel(tab),
  })

  // Submitting while a response streams queues the line (type-ahead) rather than
  // dropping it; the idle driver flushes the queue as soon as the turn finishes.
  const handleSubmit = (v: string): void => {
    if (chatRef.current.status === 'streaming') setQueued((q) => [...q, v])
    else void chatRef.current.submit(v, makeActions())
  }

  // Idle driver: whenever nothing is streaming, pick the SINGLE next action, in
  // priority order, so type-ahead / goal / loop never race to start a turn:
  //   1. flush the user's type-ahead queue,
  //   2. drive the active goal (stop if the model signalled completion, else
  //      keep working — the first turn fires immediately, later ones after a gap),
  //   3. tick the recurring/self-paced loop.
  // The cleanup clears any pending timer, so exactly one run is ever queued.
  useEffect(() => {
    if (streaming) return

    if (queued.length > 0) {
      const [next, ...rest] = queued
      setQueued(rest)
      void chatRef.current.submit(next, makeActions())
      return
    }

    if (goal) {
      // First turn: start working on the goal immediately.
      if (goal.runs === 0) {
        const t = setTimeout(() => {
          setGoalRun((gv) => (gv ? { ...gv, runs: 1 } : gv))
          void chatRef.current.submit(goal.text, makeActions())
        }, 0)
        return () => clearTimeout(t)
      }
      // A turn just finished → run the detached stop-hook judge exactly once. It
      // decides, from the transcript, whether the goal is genuinely done (stop)
      // or needs another iteration (continue, with a reason that drives the next
      // turn). This is why merely "answering then stopping" doesn't end a goal.
      if (!judgingRef.current) {
        judgingRef.current = true
        setJudging(true)
        const goalAtJudge = goal
        void judgeGoal(goal.text, goal.runs, chatRef.current.messages, chatRef.current.config)
          .then((verdict) => {
            judgingRef.current = false
            setJudging(false)
            if (goalRef.current !== goalAtJudge) return // cleared/replaced while judging
            if (verdict.decision === 'complete') {
              setGoal('')
              setGoalRun(null)
              chatRef.current.print(`◎ Goal complete — ${verdict.reason}`, 'system')
            } else {
              chatRef.current.print(`◎ Continuing — ${verdict.reason}`, 'system')
              setGoalRun((gv) => (gv ? { ...gv, runs: gv.runs + 1 } : gv))
              void chatRef.current.submit(verdict.reason, makeActions())
            }
          })
          .catch(() => { judgingRef.current = false; setJudging(false) })
      }
      return
    }

    if (loop) {
      const delay = loop.runs === 0 ? 0 : (loop.intervalMs ?? 800)
      const t = setTimeout(() => {
        setLoop((l) => (l ? { ...l, runs: l.runs + 1 } : l))
        void chatRef.current.submit(loop.payload, makeActions())
      }, delay)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, queued, goal, loop])

  return (
    // App-owned screen (alternate buffer): a windowed transcript viewport fills
    // the space above a fixed bottom cluster. No <Static> → nothing writes native
    // scrollback (no terminal scrollbar), and modal overlays repaint cleanly over
    // nothing. History survives via the exit-time dump to the normal buffer (see
    // cli.tsx). The middle is "一个容器" with self-managed scroll.
    <ThemeProvider value={colors}>
      <Box flexDirection="column" width={width} height={dims.rows}>
        {modalOpen ? (
          <Box flexGrow={1} justifyContent="flex-end">
            {pickerOpen ? (
              <ThemePicker
                current={chat.config.theme ?? 'auto'}
                width={width}
                onSelect={(name) => { chat.setConfig({ theme: name }); setPickerOpen(false) }}
                onCancel={() => setPickerOpen(false)}
              />
            ) : panel ? (
              <SettingsPanel
                tab={panel}
                width={width}
                rows={dims.rows}
                config={chat.config}
                usage={chat.usage}
                messages={chat.messages}
                goalStatus={() =>
                  goalRef.current ? formatGoal(goalRef.current, Math.floor((Date.now() - goalRef.current.startedAt) / 1000), judgingRef.current) : null}
                loopStatus={() => (loopRef.current ? formatLoop(loopRef.current) : null)}
                setConfig={chat.setConfig}
                onChangeTab={(t) => setPanel(t)}
                onClose={() => setPanel(null)}
              />
            ) : expandedWf ? (
              <WorkflowView
                snapshot={expandedWf}
                width={width}
                onExit={() => { wfClosedAtRef.current = Date.now(); setWfExpanded(null) }}
                onStop={() => { chat.interrupt(); setWfExpanded(null) }}
              />
            ) : null}
          </Box>
        ) : (
          <Box flexGrow={1} flexDirection="column" overflow="hidden" justifyContent={anchor}>
            {visible.map((ln, i) => (
              <Text key={cur + i} color={colorFor(ln.kind)} wrap="truncate">{ln.text === '' ? ' ' : ln.text}</Text>
            ))}
          </Box>
        )}

        {/* Fixed bottom cluster: transient status + input box + collapsed
            workflows + footer, pinned to the terminal's last rows. Hidden while a
            modal overlay owns the screen; the transcript scrolls behind it. */}
        {!modalOpen ? (
          <Box flexDirection="column">
            {scrolled ? (
              <Box paddingLeft={1}>
                <Text color={colors.accentBright} wrap="truncate">
                  {`↓ ${below} more line${below === 1 ? '' : 's'} below · PgDn/ctrl+End/esc to resume`}
                </Text>
              </Box>
            ) : null}

            {goal ? (
              <Box paddingLeft={1}>
                <Text color={colors.accentBright} wrap="truncate">{formatGoal(goal, goalElapsed, judging)}</Text>
              </Box>
            ) : loop ? (
              <Box paddingLeft={1}>
                <Text color={colors.accentBright}>🔁 {formatLoop(loop)}</Text>
              </Box>
            ) : null}

            {queued.length > 0 ? (
              <Box flexDirection="column" paddingLeft={1}>
                {queued.map((q, i) => (
                  <Text key={i} color={colors.dim} wrap="truncate">⏳ queued · {q}</Text>
                ))}
              </Box>
            ) : null}

            {streaming ? (
              <StatusLine
                word={chat.statusWord}
                elapsed={elapsed}
                tokens={chat.live?.tokens ?? 0}
                dir={chat.live?.dir ?? 'up'}
                suffix={chat.live?.thinking ? `deep in thought with ${String(getSetting(chat.config.settings, 'effort'))} effort` : undefined}
              />
            ) : null}

            {ctxLevel !== 'ok' ? (
              <Box paddingLeft={1}>
                <Text color={ctxLevel === 'danger' ? colors.error : colors.warning} wrap="truncate">
                  {`⚠ Context ${Math.round(ctx.ratio * 100)}% full ${bar(ctx.ratio, 12)} · ${fmtTokens(ctx.used)}/${fmtTokens(ctx.limit)} · ${ctxLevel === 'danger' ? 'compacting soon — run /compact now' : '/compact to reclaim space'}`}
                </Text>
              </Box>
            ) : null}

            <PromptInput
              active={wfSel === null}
              width={width}
              commands={registry}
              placeholder="Ask AnyCode to build something…  (/help for commands)"
              onSubmit={handleSubmit}
              onOverflowDown={() => {
                const wfs = chatRef.current.workflows
                if (wfs.length === 0) return false
                setWfSel(0)
                return true
              }}
            />

            {/* Collapsed workflow lines sit BELOW the input box, so a single ↓
                past the input naturally lands on them (see onOverflowDown). */}
            {chat.workflows.length > 0 ? (
              <Box flexDirection="column">
                {chat.workflows.map((w, i) => (
                  <WorkflowCollapsed key={w.id} snapshot={w} selected={wfSel === i} />
                ))}
              </Box>
            ) : null}

            <Box paddingLeft={1}>
              <Text color={colors.dim} wrap="truncate">
                {exitArmed
                  ? 'press ctrl+c again to exit'
                  : scrolled
                    ? 'PgUp/PgDn page · wheel scroll · esc/ctrl+End to resume'
                    : wfSel !== null
                      ? '↑↓ select · ↵ expand · esc cancel'
                      : streaming
                        ? chat.workflows.length > 0
                          ? '↓ select workflow · PgUp scroll · esc to interrupt'
                          : '↵ queue a message while working · PgUp scroll · esc to interrupt'
                        : '↵ send · ↑↓ history · PgUp scroll · /help commands · ctrl+c to exit'}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    </ThemeProvider>
  )
}
