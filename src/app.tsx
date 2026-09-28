import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import type { AppConfig, Message as Msg, PanelTab, SessionUsage } from './types'
import { useChat, type ChatActions } from './hooks/useChat'
import { StatusLine } from './components/StatusLine'
import { PromptInput } from './components/PromptInput'
import { ThemePicker } from './components/ThemePicker'
import { ModelPicker } from './components/ModelPicker'
import { LoginPanel } from './components/LoginPanel'
import { SessionPicker } from './components/SessionPicker'
import { AutoCompactPicker, type AutoCompactChoice } from './components/AutoCompactPicker'
import { EffortPicker, type EffortChoice } from './components/EffortPicker'
import { SettingsPanel } from './components/SettingsPanel'
import { WorkflowView, WorkflowCollapsed } from './components/WorkflowView'
import { AgentSwitcher } from './components/AgentSwitcher'
import { getSetting, isEffortLevel, type EffortLevel } from './lib/settings'
import { contextState, contextLevel, contextLimit, AUTO_COMPACT_RATIO, fmtTokens, bar } from './lib/usage'
import { ensureModelDb } from './lib/modelDb'
import { setTermTitle, setTaskbarProgress, clearTermProgress } from './lib/termtitle'
import { tipFor } from './lib/tips'
import { notifyDesktop } from './lib/notify'
import { prStatus } from './lib/gitpr'
import { suggestFollowups } from './lib/suggest'
import { planCompaction, buildCompacted, heuristicSummary } from './lib/compact'
import { summarizeConversation } from './lib/summarize'
import { flattenMessages, thinkingLines, messagesFromEvents, type LineKind, type FlatLine } from './lib/transcript'
import { type Selection, lineSpan, splitByCols, stripAnsi, isEmpty, selectedText } from './lib/selection'
import { displayWidth } from './lib/text'
import { copyToClipboard } from './lib/clipboard'
import { loadSession } from './lib/sessions'
import { registry, isCommand } from './commands'
import { ThemeProvider, getTheme } from './theme'
import { LangProvider, resolveLang, setLang, translate } from './lib/i18n'
import { setGoal } from './lib/memory'
import { judgeGoal } from './lib/goalJudge'
import { formatInterval, formatLoop, formatGoal, type ActiveLoop, type ActiveGoal } from './app-helpers'

// Re-exported so existing importers (cli.tsx, lib/sessions) keep resolving these
// from './app'; the definitions now live in ./app-helpers.
export type { ActiveLoop, ActiveGoal } from './app-helpers'

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
  // the normal buffer on exit (the alternate screen is otherwise discarded) and
  // autosave it for /resume.
  onSnapshot?: (snapshot: SessionSnapshot) => void
  // Reopen a saved session picked in the /resume overlay: remounts a fresh Ink
  // instance seeded with that snapshot and adopts its session id so continued
  // autosaves keep updating the same file.
  onResume?: (snapshot: SessionSnapshot, sessionId: string) => void
  // True only when this instance was seeded by /resume or --continue (not a
  // /compact or resize remount), so App can show a one-time session recap.
  resumed?: boolean
}

export function App({ config, initial, onClear, onRepaint, onSnapshot, onResume, resumed }: Props): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { stdin } = useStdin()
  const chat = useChat(config, initial?.messages, initial?.usage)
  const [elapsed, setElapsed] = useState(0)
  // Ticks every 250ms while a retry countdown is showing, so the "Retrying in
  // Ns" line above the prompt counts down live (see chat.retry, #3). The value
  // itself is unused — bumping it just forces the re-render that re-reads the clock.
  const [, setRetryTick] = useState(0)
  // Bumped when the online model-window DB refreshes (see ensureModelDb), forcing
  // a re-render so the context bar reflects the freshly-fetched window.
  const [, setDbTick] = useState(0)
  const [exitArmed, setExitArmed] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  // The interactive model picker overlay (opened by bare /model). Search box +
  // API-pulled selector with optional group tabs; owns the keyboard while open.
  const [modelOpen, setModelOpen] = useState(false)
  // The interactive new-api login overlay (opened by /login). Like ThemePicker it
  // renders in place of the input cluster and owns the keyboard while open;
  // credentials typed here never reach the chat transcript.
  const [loginOpen, setLoginOpen] = useState(false)
  // The /resume session picker overlay (opened by /resume). Lists saved sessions;
  // selecting one remounts the app seeded with that transcript (see onResume).
  const [resumeOpen, setResumeOpen] = useState(false)
  // The /autocompact window picker overlay (opened by bare /autocompact). Chooses
  // when auto-compaction fires (off / auto / an explicit token window).
  const [autoCompactOpen, setAutoCompactOpen] = useState(false)
  // The /effort slider overlay (opened by bare /effort). A Faster↔Smarter slider
  // over the five effort levels plus the "ultracode" stop (xhigh + workflows).
  const [effortOpen, setEffortOpen] = useState(false)
  // Live "Compacting conversation… ▱▱▱ N%" indicator shown above the prompt while
  // a model-driven /compact (or auto-compaction) is summarizing. Null when idle;
  // the remount that applies the fold tears the indicator down.
  const [compacting, setCompacting] = useState<{ pct: number } | null>(null)
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
  // In-viewport mouse text selection. `sel` is an (anchor, head) pair in absolute
  // line-index + display-column space (see lib/selection). null = nothing
  // selected. A left press starts it, a left-drag extends the head, release
  // finalizes; because the coordinates are absolute, the highlight stays put as
  // the transcript scrolls. When the `copyOnSelect` setting is on, a drag-release
  // copies the highlight to the clipboard immediately; otherwise we just render
  // the highlight (copy stays an explicit action).
  const [sel, setSel] = useState<Selection | null>(null)
  // Ids of collapsed activity groups / diff views the user has toggled from their
  // default state (see lib/transcript FlattenOpts.expanded). A no-drag click on a
  // grouped row flips its membership; the transcript re-flattens accordingly.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Workflow overlay state. `wfExpanded` is the id of the workflow whose full
  // tree is open (null = none); it renders in the live region and owns the
  // keyboard while open. `wfSel` is the index of the collapsed line under the
  // selection cursor (null = not selecting) — entered with ↓ from the input,
  // moved with ↑↓, ↵ expands the selected line, esc cancels. Both auto-reset
  // when the workflows clear at turn end.
  const [wfExpanded, setWfExpanded] = useState<string | null>(null)
  const [wfSel, setWfSel] = useState<number | null>(null)
  // Switchable sub-agent view (`task`/`plan`). `viewingAgent` is the id of the
  // sub-agent whose OWN transcript the main viewport is showing (null = the main
  // conversation) — this is what makes a sub-agent a *switchable view*, unlike a
  // workflow's progress tree. `agentSel` is the row under the ↑↓ selection cursor
  // in the bottom switcher ([main, ...agents]); null = the input owns the
  // keyboard. Entered with a single ↓ past the input (onOverflowDown).
  const [viewingAgent, setViewingAgent] = useState<string | null>(null)
  const [agentSel, setAgentSel] = useState<number | null>(null)
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
  // Mirrors `queued` so the mid-turn interjection drain (takePending) and ↑-recall
  // read the live queue from callbacks captured earlier (makeActions / PromptInput).
  const queuedRef = useRef(queued); queuedRef.current = queued
  const loopRef = useRef(loop); loopRef.current = loop
  const goalRef = useRef(goal); goalRef.current = goal
  const panelRef = useRef(panel); panelRef.current = panel
  const effortOpenRef = useRef(effortOpen); effortOpenRef.current = effortOpen
  const scrollTopRef = useRef<number | null>(scrollTop); scrollTopRef.current = scrollTop
  // Terminal focus state, tracked from focus-reporting events (\x1b[I / \x1b[O,
  // enabled via ?1004h in cli.tsx). Drives the `localNotifications` setting so we
  // only notify when the user has switched away from the terminal.
  const focusedRef = useRef(true)
  // Tracks whether the previous render was mid-stream, so the notification effect
  // can fire exactly once on the streaming→idle edge.
  const wasStreamingRef = useRef(false)
  // One-line PR/branch status for the footer (the `prStatusFooter` setting),
  // refreshed on a slow poll; null while unknown or when the line is off.
  const [prLine, setPrLine] = useState<string | null>(null)
  // Tracks whether sub-agents existed on the previous render, so `openAgentsView`
  // can drop into the switcher exactly once on the none→some edge.
  const hadAgentsRef = useRef(false)
  const wfExpandedRef = useRef(wfExpanded); wfExpandedRef.current = wfExpanded
  const wfSelRef = useRef(wfSel); wfSelRef.current = wfSel
  const viewingAgentRef = useRef(viewingAgent); viewingAgentRef.current = viewingAgent
  const agentSelRef = useRef(agentSel); agentSelRef.current = agentSel
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
  // Live view extents the mouse listener reads to map a click's terminal (x,y)
  // to an absolute transcript point, and to ignore clicks while a modal overlay
  // owns the screen. `curRef` is the first visible line index; `selectingRef`
  // tracks whether a left-drag is in progress; `selRef` exposes the current
  // selection to the (esc-clears-it) key handler.
  const curRef = useRef(0)
  const modalOpenRef = useRef(false)
  const selectingRef = useRef(false)
  const selRef = useRef<Selection | null>(sel); selRef.current = sel
  // Click-to-expand support: `linesRef` mirrors the rendered flat lines (so the
  // mouse handler can read the group id under a click), `pressPtRef` records
  // where a left press landed, and `draggedRef` marks whether motion occurred —
  // a release with no drag is a click (toggle), a release after drag is a
  // selection (leave the highlight).
  const linesRef = useRef<FlatLine[]>([])
  const pressPtRef = useRef<{ line: number; col: number } | null>(null)
  const draggedRef = useRef(false)
  // Screen row (1-based) of the clickable "Jump to bottom" hint while scrolled up,
  // or -1 when it isn't shown. The mouse listener maps a left click on that row to
  // resumeFollow(). Set during render (the hint is the cluster's first row, which
  // sits just below the viewport → row viewportH + 1).
  const jumpRowRef = useRef(-1)
  // Screen row (1-based) of the clickable "previous message" hint at the very top
  // of the viewport while scrolled up (or -1 when hidden). It's rendered above the
  // viewport, so it always sits on screen row 1. A left click on it scrolls up to
  // the nearest message boundary above the current top row (see jumpToPrev).
  const prevRowRef = useRef(-1)
  // Screen row (1-based) of the viewport's FIRST content row. Normally 1, but the
  // "previous message" hint (when scrolled) occupies row 1 and pushes the viewport
  // down to row 2. The mouse listener uses this to map an SGR y to a transcript
  // line, and the bottom-hint row shifts by the same offset.
  const vpTopRef = useRef(1)
  // Live viewport height (content rows), so the mouse listener can tell a press
  // on the transcript from one on the bottom cluster (input box, footer, …): a
  // transcript selection only STARTS when the press row is within the viewport.
  const viewportHRef = useRef(1)

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
  //
  // The summary is model-driven: an independent provider.complete() call distills
  // the folded messages (see lib/summarize), with the offline heuristic as a
  // fallback when no summarizer is available or the call fails. While it runs, a
  // "Compacting conversation…" progress line shows above the prompt. `compacting`
  // guards against overlapping runs (auto-compaction can re-fire mid-summary).
  const compactingRef = useRef(false)
  const doCompact = async (force = false): Promise<number> => {
    if (compactingRef.current) return 0
    const plan = planCompaction(chatRef.current.messages, undefined, { force })
    if (!plan) return 0
    compactingRef.current = true
    setCompacting({ pct: 1 })
    try {
      const summary = (await summarizeConversation(plan.older, chatRef.current.config)) ?? heuristicSummary(plan.older)
      const { messages: folded, folded: n } = buildCompacted(plan, summary)
      onRepaint({
        config: chatRef.current.config,
        messages: folded,
        goal: goalRef.current,
        loop: loopRef.current,
        usage: { ...chatRef.current.usage, compactions: chatRef.current.usage.compactions + 1 },
      })
      return n
    } finally {
      compactingRef.current = false
      setCompacting(null)
    }
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
  // Scroll up to the previous USER message: the nearest FlatLine that starts a
  // user turn (msgStart + kind 'user') strictly above the current top row. "上一条
  // 消息" means the user's own input (including mid-stream insertions), never an
  // agent tool call. Message boundaries are marked by flattenMessages; no-op when
  // there's no earlier user message above.
  const jumpToPrev = (): void => {
    const lines = linesRef.current
    const from = curRef.current
    let target = -1
    for (let i = 0; i < from && i < lines.length; i++) if (lines[i]?.msgStart && lines[i]?.kind === 'user') target = i
    if (target >= 0) setScrollTop(target)
  }

  // Resize → just update dims; the viewport reflows (no remount, no <Static>).
  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => setDims({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  // Mouse events → scroll the transcript (wheel) or drive text selection
  // (left press/drag/release). cli.tsx enables SGR mouse reporting
  // (\x1b[?1000h\x1b[?1002h\x1b[?1006h); events arrive as \x1b[<b;x;y(M|m):
  // wheel up/down are button 64/65; a left press is button 0 + 'M', a left-drag
  // (motion with the button held) is button 32 + 'M', and release is 'm'. Ink's
  // useInput doesn't surface mouse events, so we read them off stdin directly.
  // SGR x,y are 1-based; the viewport's top content row is screen row vpTopRef
  // (1 normally, 2 when the top "previous message" hint occupies row 1), so the
  // absolute transcript point is { line: cur + (y - vpTop), col: x-1 }.
  useEffect(() => {
    if (!stdin) return
    const onData = (data: Buffer): void => {
      const s = data.toString('utf8')
      // Terminal focus reporting (?1004h): CSI I = focus in, CSI O = focus out.
      // Non-destructive — just track state for `localNotifications`.
      if (s.includes('\x1b[I')) focusedRef.current = true
      if (s.includes('\x1b[O')) focusedRef.current = false
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
      let m: RegExpExecArray | null
      let delta = 0
      while ((m = re.exec(s)) !== null) {
        const b = Number(m[1])
        const x = Number(m[2])
        const y = Number(m[3])
        const release = m[4] === 'm'
        // A left click on the "Jump to bottom" hint (the cluster row just below
        // the viewport, when scrolled up) snaps back to the live bottom — the same
        // as ctrl+End. Handle it before any modal/selection logic and skip the
        // rest so it doesn't also start a text selection.
        if (b === 0 && !release && jumpRowRef.current > 0 && y === jumpRowRef.current) {
          resumeFollow()
          continue
        }
        // A left click on the "previous message" hint (screen row 1, when scrolled
        // up) scrolls up to the nearest message boundary above. Same early-out so
        // it doesn't also start a text selection.
        if (b === 0 && !release && prevRowRef.current > 0 && y === prevRowRef.current) {
          jumpToPrev()
          continue
        }
        // A modal overlay owns the mouse entirely (it runs its own stdin listener
        // for hover/click/wheel); don't scroll or select the transcript behind it.
        if (modalOpenRef.current) continue
        if (b === 64) { delta -= 3; continue }
        if (b === 65) { delta += 3; continue }
        const pt = { line: curRef.current + (y - vpTopRef.current), col: Math.max(0, x - 1) }
        if (b === 0 && !release) {
          // Only START a transcript selection when the press lands on a viewport
          // row. A press on the bottom cluster — above all, inside the input box —
          // belongs to PromptInput's own in-box selection handler, so leave it be
          // here (the two listeners partition presses by screen row this way).
          const top = vpTopRef.current
          if (y < top || y >= top + viewportHRef.current) continue
          // Left press: begin (or restart) a selection anchored here. An
          // immediate release with no drag leaves anchor===head (empty) → the
          // prior highlight is cleared and nothing new is shown.
          selectingRef.current = true
          pressPtRef.current = pt
          draggedRef.current = false
          setSel({ anchor: pt, head: pt })
        } else if (b === 32 && !release) {
          // Left-drag: extend the head to the current cell.
          draggedRef.current = true
          if (selectingRef.current) setSel((cur) => (cur ? { anchor: cur.anchor, head: pt } : { anchor: pt, head: pt }))
        } else if (release) {
          // Release: a no-drag click on a grouped row toggles it expanded/
          // collapsed; otherwise stop tracking and keep any highlight.
          const wasSelecting = selectingRef.current
          selectingRef.current = false
          if (wasSelecting && !draggedRef.current) {
            const grp = linesRef.current[pressPtRef.current?.line ?? -1]?.group
            if (grp) {
              setExpanded((prev) => { const next = new Set(prev); if (next.has(grp)) next.delete(grp); else next.add(grp); return next })
              setSel(null)
            }
          } else if (wasSelecting && draggedRef.current && getSetting(chatRef.current.config.settings, 'copyOnSelect') === true) {
            // Auto-copy on release (the `copyOnSelect` setting): a drag that
            // produced a real highlight is copied to the clipboard immediately,
            // then cleared — no explicit copy key needed.
            const cur = selRef.current
            if (cur && !isEmpty(cur)) {
              copyToClipboard(selectedText(cur, linesRef.current), stdout)
              setSel(null)
            }
          }
        }
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
  // Active UI language, from the `language` setting (auto → shell locale). Handed
  // to the tree via <LangProvider>; the module-level mirror is kept in sync below
  // so non-React code (commands, lib helpers) translates in the same language.
  const lang = resolveLang(getSetting(chat.config.settings, 'language') as string)
  useEffect(() => { setLang(lang) }, [lang])
  // App renders <LangProvider>, so it sits above its own context — translate with
  // the resolved `lang` directly (correct on the same render the setting changes).
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string => translate(lang, key, params)

  // Live context-window fill, used for the warning line and auto-compaction.
  const ctx = contextState(chat.messages, chat.config.model, Number(getSetting(chat.config.settings, 'contextWindow')) || undefined)
  const ctxLevel = contextLevel(ctx.ratio)
  // The workflow whose tree is currently expanded (looked up by id), or null.
  const expandedWf = wfExpanded ? chat.workflows.find((w) => w.id === wfExpanded) ?? null : null

  // A modal overlay (theme picker / settings / workflow tree) replaces the whole
  // content area — you operate it rather than read the transcript behind it.
  const modalOpen = pickerOpen || modelOpen || loginOpen || resumeOpen || autoCompactOpen || !!panel || !!expandedWf
  modalOpenRef.current = modalOpen
  const scrolled = scrollTop !== null

  // Follow-up suggestions (the `promptSuggestions` setting): a single dim line
  // of contextual next-prompts derived from the last assistant reply. Shown only
  // when idle after at least one answer; empty otherwise (falls back to tips).
  let suggestLine = ''
  if (!streaming && getSetting(chat.config.settings, 'promptSuggestions') !== false) {
    const lastAssistant = [...chat.messages].reverse().find((m) => m.role === 'assistant')
    if (lastAssistant) {
      const items = suggestFollowups(stripAnsi(lastAssistant.content))
      if (items.length) suggestLine = translate(lang, 'footer.suggest', { items: items.join(' · ') })
    }
  }

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
    (chat.retry ? 1 : 0) +
    (compacting ? 1 : 0) +
    (ctxLevel !== 'ok' ? 1 : 0) +
    INPUT_ROWS +
    chat.workflows.length +
    (chat.agents.length > 0 ? chat.agents.length + 2 : 0) + // switcher: header + main row + agents
    1 + // footer
    (suggestLine ? 1 : 0) + // follow-up suggestions line
    (prLine && getSetting(chat.config.settings, 'prStatusFooter') !== false ? 1 : 0) + // PR status line
    (scrolled ? 1 : 0) + // bottom "jump to bottom" hint
    (scrolled ? 1 : 0)   // top "previous message" hint (rendered above the viewport)
  const viewportH = Math.max(1, dims.rows - clusterH)
  viewportHRef.current = viewportH
  // Screen rows rendered BELOW the input box's bottom border (agent switcher +
  // collapsed workflows + suggestion line + PR line + footer). PromptInput uses
  // this to locate its own content rows from the screen bottom for in-box mouse
  // selection — the box is bottom-anchored, so this is exact regardless of how
  // tall the transcript above it is or whether the command menu is open.
  const bottomOffset =
    (chat.agents.length > 0 ? chat.agents.length + 2 : 0) +
    chat.workflows.length +
    (suggestLine ? 1 : 0) +
    (prLine && getSetting(chat.config.settings, 'prStatusFooter') !== false ? 1 : 0) +
    1 // footer
  // Screen row of the viewport's first content row: 1 normally, 2 when the top
  // "previous message" hint occupies row 1 (only while scrolled, non-modal).
  vpTopRef.current = scrolled && !modalOpen ? 2 : 1
  // The "Jump to bottom" hint is the FIRST row of the bottom cluster (rendered
  // only when scrolled and no modal owns the screen), so it sits on the screen row
  // right below the viewport — which is offset by the top hint (vpTopRef).
  jumpRowRef.current = scrolled && !modalOpen ? vpTopRef.current + viewportH : -1

  // The whole transcript as flat, one-row-per-entry lines: banner + committed
  // messages + the live reasoning/reply tail. The committed part is memoized (it
  // changes only when a message is appended) so scrolling a long transcript
  // doesn't re-render every message's markdown per keystroke; the live tail
  // changes each frame while streaming.
  const expandAll = getSetting(chat.config.settings, 'verbose') === true
  const committed = useMemo(() => flattenMessages(chat.messages, width, { banner: true, expanded, expandAll }), [chat.messages, width, expanded, expandAll])
  const liveThink = useMemo(
    () => (chat.thinking && chat.thinking.content.trim() ? thinkingLines(chat.thinking, width) : []),
    [chat.thinking, width],
  )
  const liveStream = useMemo(
    () => (chat.streaming && chat.streaming.content.trim() ? flattenMessages([chat.streaming], width) : []),
    [chat.streaming, width],
  )
  const mainLines = useMemo(() => committed.concat(liveThink, liveStream), [committed, liveThink, liveStream])
  // When a sub-agent is selected in the switcher, the viewport shows ITS OWN
  // transcript (flattened from its event stream) instead of the main one, headed
  // by a divider naming the agent and its state. This is the "switch to another
  // agent and see its chat" behavior — falls back to main when nothing is viewed
  // or the viewed agent has vanished (turn cleared it).
  const viewedAgent = viewingAgent ? chat.agents.find((a) => a.id === viewingAgent) ?? null : null
  const agentLines = useMemo<FlatLine[] | null>(() => {
    if (!viewedAgent) return null
    const st = viewedAgent.state === 'done' ? 'done' : viewedAgent.state === 'error' ? `error: ${viewedAgent.error ?? 'failed'}` : `${viewedAgent.activity}…`
    const header: FlatLine = { text: `  ── sub-agent · ${viewedAgent.type} · ${viewedAgent.label} · ${st} ──`, kind: 'tool-header' }
    const body = flattenMessages(messagesFromEvents(viewedAgent.events), width)
    return [header, { text: '', kind: 'blank' }, ...(body.length ? body : [{ text: '  (no output yet)', kind: 'system' } as FlatLine])]
  }, [viewedAgent, width])
  const lines = agentLines ?? mainLines
  linesRef.current = lines
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
  curRef.current = cur
  // The "previous message" hint renders above the viewport (screen row 1) while
  // scrolled up, and previews the nearest USER message above the top row — the
  // one a click jumps to. Hidden when there's no earlier user message above.
  let prevUserIdx = -1
  for (let i = 0; i < cur && i < lines.length; i++) if (lines[i].msgStart && lines[i].kind === 'user') prevUserIdx = i
  const showPrevHint = scrolled && !modalOpen && prevUserIdx >= 0
  prevRowRef.current = showPrevHint ? 1 : -1
  // Preview text for the band: the user line as it renders ("> …"), clipped to
  // width with a leading ↑ so it reads as "jump up to this message".
  const prevPreview = prevUserIdx >= 0 ? `↑ ${stripAnsi(lines[prevUserIdx].text).trim()}` : ''
  // Pad a string with trailing spaces to the full terminal width, so a
  // backgroundColor band fills the whole row (never truncate here — Ink's
  // ansi-aware wrap="truncate" clips an over-long row at render).
  const padFull = (s: string): string => { const w = displayWidth(s); return w < width ? s + ' '.repeat(width - w) : s }
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
      // Shade hierarchy done with the FONT, not a background: thinking (inner
      // monologue) is the faintest, tool output reads at full text brightness (real
      // data you scan), so the two are clearly different depths at a glance.
      case 'thinking': return colors.dim
      case 'collapsed': return colors.dim
      case 'tool': return colors.text
      case 'system': return colors.system
      case 'diff-add': return colors.success
      case 'diff-del': return colors.error
      case 'diff-hunk': return colors.accent
      case 'diff-ctx': return colors.dim
      default: return colors.dim
    }
  }
  // Full-row background tint for +/− diff lines (GitHub/Claude Code style), so an
  // added/removed line reads at a glance instead of by its foreground alone. The
  // ANSI-only themes leave these empty (no subtle tint on 16 colours) → no bg.
  const bgFor = (k: LineKind): string | undefined => {
    if (k === 'diff-add') return colors.diffAddBg || undefined
    if (k === 'diff-del') return colors.diffDelBg || undefined
    return undefined
  }

  // Auto-compaction: when the context fills past the threshold and we're idle,
  // fold older messages into a digest exactly like Claude Code. The `autoCompact`
  // toggle can disable it entirely, and `/autocompact` sets a token window that
  // caps the trigger below the model's full context (effective threshold =
  // min(window, model context) × AUTO_COMPACT_RATIO). Fires once per crossing and
  // never mid-stream.
  const autoCompactOn = getSetting(chat.config.settings, 'autoCompact') !== false
  const autoCompactWindow = Number(getSetting(chat.config.settings, 'autoCompactWindow')) || 0
  const autoCompactLimit = autoCompactWindow > 0 ? Math.min(autoCompactWindow, ctx.limit) : ctx.limit
  const autoCompactTrigger = autoCompactOn && !streaming && ctx.used >= autoCompactLimit * AUTO_COMPACT_RATIO
  useEffect(() => {
    if (!autoCompactTrigger) return
    void doCompact() // remounts with the compacted transcript when it folds anything
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCompactTrigger])

  // Animate the "Compacting conversation…" progress while a compaction runs. The
  // summary call has no real progress, so ramp toward ~95% and let the remount
  // (which unmounts this instance) stand in for 100%.
  const isCompacting = compacting !== null
  useEffect(() => {
    if (!isCompacting) return
    const id = setInterval(() => setCompacting((c) => (c ? { pct: Math.min(95, c.pct + 7) } : c)), 200)
    return () => clearInterval(id)
  }, [isCompacting])

  // Kick the online model-window DB once at startup: if the on-disk cache is
  // stale/missing it refreshes from models.dev in the background, then re-renders
  // so the context bar picks up the accurate window. Never blocks a turn.
  useEffect(() => { ensureModelDb(() => setDbTick((n) => n + 1)) }, [])

  // Elapsed-time ticker while the model is working.
  useEffect(() => {
    if (!streaming) { setElapsed(0); return }
    const start = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(t)
  }, [streaming])

  // Auto-scroll (the `autoScroll` setting): when it's off, the viewport should
  // not chase the streaming bottom. On each turn start we freeze the scroll
  // position at the current bottom (if we were following) so new output lands
  // below the fold; the user can ctrl+F / click "jump to bottom" to catch up.
  useEffect(() => {
    if (!streaming) return
    if (getSetting(chat.config.settings, 'autoScroll') !== false) return
    if (scrollTopRef.current === null) setScrollTop(maxTopRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming])

  // Terminal title + taskbar progress (the `progressBar` setting): advertise a
  // working indicator while a turn streams, and reset to a clean idle title
  // otherwise. Disabled (and cleared) when the setting is off.
  useEffect(() => {
    const on = getSetting(chat.config.settings, 'progressBar') !== false
    if (!on) { clearTermProgress('MeowCode'); return }
    if (streaming) {
      setTaskbarProgress(true)
      setTermTitle(`✻ ${chat.statusWord || 'Working'}… · MeowCode`)
    } else {
      clearTermProgress('MeowCode')
    }
    return () => clearTermProgress('MeowCode')
  }, [streaming, chat.statusWord, chat.config.settings])

  // Desktop notification when a turn finishes while the terminal is unfocused
  // (the `localNotifications` setting). We fire on the streaming true→false edge
  // and only when focus reporting says the user has switched away, so an active
  // watcher isn't pinged. Best-effort escapes (see lib/notify); no-op off-TTY.
  useEffect(() => {
    if (streaming) { wasStreamingRef.current = true; return }
    if (!wasStreamingRef.current) return
    wasStreamingRef.current = false
    if (getSetting(chat.config.settings, 'localNotifications') === false) return
    if (focusedRef.current) return
    notifyDesktop('MeowCode', translate(lang, 'notify.turnDone'))
  }, [streaming, chat.config.settings])

  // One-time session recap (the `sessionRecap` setting): when this instance was
  // seeded by /resume or --continue, print a short system line summarizing what
  // was reopened. role 'system' keeps it out of the API history; runs once.
  const recapDoneRef = useRef(false)
  useEffect(() => {
    if (recapDoneRef.current) return
    recapDoneRef.current = true
    if (!resumed) return
    if (getSetting(chatRef.current.config.settings, 'sessionRecap') === false) return
    const real = chatRef.current.messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    if (real.length === 0) return
    const lastUser = [...real].reverse().find((m) => m.role === 'user')
    const preview = lastUser ? stripAnsi(lastUser.content).trim().replace(/\s+/g, ' ').slice(0, 60) : ''
    chatRef.current.print(translate(lang, 'app.sessionRecap', { n: real.length, last: preview }), 'system')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // PR/branch footer line (the `prStatusFooter` setting). Shelling out to git/gh
  // is slow, so we poll — once on mount and every 30s — rather than per render,
  // and only while the setting is on. Turning it off clears the line immediately.
  useEffect(() => {
    if (getSetting(chat.config.settings, 'prStatusFooter') === false) { setPrLine(null); return }
    let alive = true
    const refresh = (): void => { prStatus(process.cwd()).then((s) => { if (alive) setPrLine(s) }) }
    refresh()
    const id = setInterval(refresh, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [chat.config.settings])

  // `openAgentsView`: when sub-agents first appear (none→some), drop straight
  // into the switcher so the user lands on the agent list. Fires once per edge
  // and never while a modal picker owns the keyboard.
  useEffect(() => {
    const has = chat.agents.length > 0
    const had = hadAgentsRef.current
    hadAgentsRef.current = has
    if (has && !had && !pickerOpen && agentSel === null && getSetting(chat.config.settings, 'openAgentsView') === true) {
      setAgentSel(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.agents.length])

  // Drive the retry countdown: tick every 250ms while a retry notice is live so
  // the "Retrying in Ns" text ticks down toward its target time.
  useEffect(() => {
    if (!chat.retry) return
    const t = setInterval(() => setRetryTick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [chat.retry])

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

  // Switching which agent the viewport shows resets scroll to the live bottom and
  // clears any text selection (it indexed the previous transcript's lines).
  useEffect(() => { setScrollTop(null); setSel(null) }, [viewingAgent])

  // Keep the switcher consistent with the live agent list: if the viewed agent
  // vanishes (a new turn cleared the list) fall back to main; clamp/drop the
  // selection cursor when the list shrinks or empties.
  useEffect(() => {
    const ags = chat.agents
    if (viewingAgent !== null && !ags.some((a) => a.id === viewingAgent)) setViewingAgent(null)
    if (agentSel !== null) {
      if (ags.length === 0) setAgentSel(null)
      else if (agentSel > ags.length) setAgentSel(ags.length)
    }
  }, [chat.agents, viewingAgent, agentSel])

  // Destroy a COMPLETED workflow / sub-agent once it loses focus, so it stops
  // lingering at the bottom (instead of waiting for the turn boundary to clear).
  // A finished workflow that isn't the expanded one is dropped; a finished
  // switchable agent that isn't the one being viewed is dropped. The focused
  // instance survives until the user navigates away — that changes wfExpanded /
  // viewingAgent, re-runs these, and prunes it then.
  useEffect(() => {
    for (const w of chat.workflows) {
      if (w.done && wfExpanded !== w.id) chat.dropWorkflow(w.id)
    }
  }, [chat.workflows, wfExpanded, chat.dropWorkflow])
  useEffect(() => {
    for (const a of chat.agents) {
      if (a.state !== 'running' && viewingAgent !== a.id) chat.dropAgent(a.id)
    }
  }, [chat.agents, viewingAgent, chat.dropAgent])

  // Global keys: esc interrupts a streaming turn (never clears the goal — that's
  // /goal's job, so autonomous work isn't lost to a stray esc); ctrl+c twice exits.
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
    // The /effort picker renders inline (in place of the input box, transcript
    // still visible — not a modal), so it's NOT in modalOpen. It owns all keys
    // via its own useInput; here we only let ctrl+c dismiss it and swallow the
    // rest so App's esc/arrows don't double-fire.
    if (effortOpenRef.current) {
      if (key.ctrl && input === 'c') { setEffortOpen(false); return }
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
    // Agent switcher selection mode: a cursor runs across [main, ...agents]. ↑↓
    // move it, ↵ swaps the viewport to the selected agent's OWN transcript (row 0
    // = main = the conversation), x stops a running sub-agent (interrupts the
    // turn — sub-agents share its abort signal, no per-agent cancel), esc cancels.
    // PromptInput is inactive while this is on (its `active` requires agentSel===null).
    if (agentSelRef.current !== null) {
      const ags = chatRef.current.agents
      if (ags.length === 0) { setAgentSel(null); return }
      const listLen = ags.length + 1
      if (key.escape) { setAgentSel(null); return }
      if (key.upArrow) { setAgentSel((s) => ((s ?? 0) <= 0 ? null : (s as number) - 1)); return }
      if (key.downArrow) { setAgentSel((s) => Math.min(listLen - 1, (s ?? 0) + 1)); return }
      if (key.return) {
        const idx = Math.min(agentSelRef.current ?? 0, listLen - 1)
        setViewingAgent(idx === 0 ? null : ags[idx - 1].id)
        setAgentSel(null)
        return
      }
      if (input === 'x') {
        const idx = Math.min(agentSelRef.current ?? 0, listLen - 1)
        if (idx > 0 && streaming) chat.interrupt()
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
    // A running goal is AUTONOMOUS — one esc or ctrl+c must be able to halt it,
    // even while scrolled up reading its output. So this comes before the
    // selection-clear / scroll-snap esc steps (which would otherwise eat the
    // first press). PAUSE, never clear: the goal survives, the driver freezes,
    // and any later submit (or /goal) resumes it. ctrl+c with an active text
    // selection still falls through to copy it (handled below).
    const escOrCtrlC = key.escape || (key.ctrl && input === 'c')
    const hasSelection = !!(selRef.current && !isEmpty(selRef.current))
    if (escOrCtrlC && goalRef.current && !goalRef.current.paused && !(key.ctrl && hasSelection)) {
      if (streaming) chat.interrupt()
      setGoalRun((gv) => (gv ? { ...gv, paused: true } : gv))
      chat.print('◎ 目标已暂停 —— 输入任意内容或 /goal 继续。', 'system')
      return
    }
    // esc clears an active text selection first — before it snaps scroll back or
    // interrupts the turn — so dismissing a highlight is a distinct, cheap step.
    if (key.escape && selRef.current && !isEmpty(selRef.current)) { setSel(null); return }
    // esc while scrolled up snaps back to the bottom first, so a scrolled esc
    // never doubles as interrupting the running turn.
    if (key.escape && scrollTopRef.current !== null) { resumeFollow(); return }
    if (key.escape && streaming) {
      // Swallow the esc that just dismissed the workflow tree (and any immediate
      // repeat), so returning from the view never doubles as interrupting.
      if (Date.now() - wfClosedAtRef.current < 250) return
      chat.interrupt()
      return
    }
    // Idle with background sub-agents still running: esc cancels them (interrupt
    // routes to abortBackground when no turn is streaming). Comes after the
    // selection/scroll steps so those keep priority.
    if (key.escape && !streaming && chat.bgPending) {
      chat.interrupt()
      return
    }
    if (key.ctrl && input === 'c') {
      // With an active text selection, ctrl+c COPIES it (like a terminal) rather
      // than interrupting the turn or arming exit — the highlight is the user's
      // intent here. Clearing the selection is the visual "copied" feedback and
      // restores plain ctrl+c (interrupt/exit) on the next press.
      const cur = selRef.current
      if (cur && !isEmpty(cur)) {
        copyToClipboard(selectedText(cur, linesRef.current), stdout)
        setSel(null)
        return
      }
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
    openModelPicker: () => setModelOpen(true),
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
    // Mid-turn interjection drain (see StreamOpts.takePending): hand the provider
    // the PLAIN-TEXT lines type-ahead-queued during this turn so they land right
    // after the next tool call. Slash commands are left in the queue for the idle
    // flush (they must run as their own turn, not be fed to the model as text).
    // Removes exactly the drained lines by value, so anything queued between this
    // render and now (including further interjections) is preserved.
    takePending: (): string[] => {
      const drained = queuedRef.current.filter((s) => !isCommand(s.trim()))
      if (drained.length === 0) return []
      setQueued((q) => {
        const rest = [...q]
        for (const d of drained) {
          const i = rest.indexOf(d)
          if (i >= 0) rest.splice(i, 1)
        }
        return rest
      })
      return drained
    },
    compact: () => doCompact(true),
    openPanel: (tab) => setPanel(tab),
    openLogin: () => setLoginOpen(true),
    openResume: () => setResumeOpen(true),
    openAutoCompact: () => setAutoCompactOpen(true),
    openEffortPicker: () => setEffortOpen(true),
  })

  // Submitting while a response streams queues the line (type-ahead) rather than
  // dropping it; the idle driver flushes the queue as soon as the turn finishes.
  const handleSubmit = (v: string): void => {
    // A user submit while the goal is paused resumes it: run their line now, and
    // the idle driver picks the goal back up once that turn finishes.
    setGoalRun((gv) => (gv && gv.paused ? { ...gv, paused: false } : gv))
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

    if (goal && !goal.paused) {
      // If the just-finished goal turn produced no model response (auth/HTTP
      // error surfaced as an error system message), don't spin the loop — pause
      // and wait for the user to fix it. This is what stopped the endless
      // "Judge call failed; keep working" flood when the login had expired.
      const lastMsg = chatRef.current.messages[chatRef.current.messages.length - 1]
      if (goal.runs > 0 && lastMsg?.meta?.error) {
        setGoalRun((gv) => (gv ? { ...gv, paused: true } : gv))
        chatRef.current.print('◎ 目标已暂停 —— 上一轮未获得模型响应，请修复后输入任意内容继续。', 'system')
        return
      }
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
            } else if (verdict.decision === 'pause') {
              // No model response (judge call itself failed) — pause instead of
              // continuing into another doomed turn; the user resumes on submit.
              setGoalRun((gv) => (gv ? { ...gv, paused: true } : gv))
              chatRef.current.print(`◎ 目标已暂停 —— ${verdict.reason} 输入任意内容或 /goal 继续。`, 'system')
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
      <LangProvider value={lang}>
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
            ) : modelOpen ? (
              <ModelPicker
                current={chat.config.model}
                width={width}
                rows={dims.rows}
                onSelect={(name) => { chat.setConfig({ model: name }); setModelOpen(false); chat.print(`模型已切换为 \`${name}\`。`, 'system') }}
                onCancel={() => setModelOpen(false)}
              />
            ) : loginOpen ? (
              <LoginPanel
                width={width}
                onSuccess={(baseUrl) => {
                  chat.setConfig({ provider: 'newapi' })
                  setLoginOpen(false)
                  chat.print(`✓ 已登录 MeowArch API（${baseUrl}），已切换到 \`newapi\` 提供商。`, 'system')
                }}
                onCancel={() => setLoginOpen(false)}
              />
            ) : resumeOpen ? (
              <SessionPicker
                width={width}
                rows={dims.rows}
                onSelect={(id) => {
                  const snap = loadSession(id)
                  setResumeOpen(false)
                  if (snap && onResume) onResume(snap, id)
                  else chat.print('无法加载该会话（可能已被删除或损坏）。', 'system', { error: true })
                }}
                onCancel={() => setResumeOpen(false)}
              />
            ) : autoCompactOpen ? (
              <AutoCompactPicker
                width={width}
                rows={dims.rows}
                modelLimit={ctx.limit}
                current={
                  getSetting(chat.config.settings, 'autoCompact') === false
                    ? { kind: 'off' }
                    : autoCompactWindow > 0
                      ? { kind: 'tokens', tokens: autoCompactWindow }
                      : { kind: 'auto' }
                }
                onSelect={(choice: AutoCompactChoice) => {
                  const s = chat.config.settings
                  if (choice.kind === 'off') { chat.setConfig({ settings: { ...s, autoCompact: false } }); chat.print(t('cmd.autocompactOff'), 'system') }
                  else if (choice.kind === 'auto') { chat.setConfig({ settings: { ...s, autoCompact: true, autoCompactWindow: 0 } }); chat.print(t('cmd.autocompactAuto', { limit: fmtTokens(contextLimit(chat.config.model)) }), 'system') }
                  else { chat.setConfig({ settings: { ...s, autoCompact: true, autoCompactWindow: choice.tokens } }); chat.print(t('cmd.autocompactSet', { value: fmtTokens(choice.tokens) }), 'system') }
                  setAutoCompactOpen(false)
                }}
                onCancel={() => setAutoCompactOpen(false)}
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
          <>
          {/* "Previous message" hint, pinned above the viewport (screen row 1)
              while scrolled up: a single-line band (styled like an expanded
              block, colors.blockBg) previewing the USER message a click jumps to.
              Reserve the row whenever scrolled (clusterH counts it) so the
              viewport height stays consistent; paint the band only when there's
              an earlier user message above. */}
          {scrolled ? (
            showPrevHint ? (
              <Box width={width}>
                <Text backgroundColor={colors.blockBg || undefined} color={colors.dim} wrap="truncate">
                  {padFull(` ${prevPreview}`)}
                </Text>
              </Box>
            ) : (
              <Box><Text> </Text></Box>
            )
          ) : null}
          <Box flexGrow={1} flexDirection="column" overflow="hidden" justifyContent={anchor}>
            {visible.map((ln, i) => {
              const absIdx = cur + i
              // A selected line is re-rendered as before/highlight/after spans.
              // We strip ANSI on it and re-color plainly (the highlight uses
              // `inverse`), losing markdown color on that one line while it's
              // selected — an accepted trade so the SGR codes never tear.
              const plain = stripAnsi(ln.text)
              const span = sel && !isEmpty(sel) ? lineSpan(sel, absIdx, plain) : null
              // Background band for diff +/− rows (green/red carries the add/del
              // meaning) AND for every row of an EXPANDED collapsed block (ln.tint):
              // Claude Code paints those as one uniform box. The band is a SINGLE
              // shade (colors.blockBg) — think vs tool are set apart by FONT depth
              // (see colorFor), not by different tints — and it covers the tinted
              // blank spacer rows too, so the box stays continuous instead of
              // leaking the terminal wallpaper through as patchy holes. The
              // ANSI-only themes leave these empty → no bg. Pad-only to full width
              // (never truncate), letting Ink's ansi-aware wrap="truncate" clip any
              // rare over-long row.
              const bg = bgFor(ln.kind) ?? (ln.tint ? (colors.blockBg || undefined) : undefined)
              const padRow = (s: string): string => {
                const w = displayWidth(s)
                return w < width ? s + ' '.repeat(width - w) : s
              }
              if (span) {
                const [before, mid, after] = splitByCols(plain, span.a, span.b)
                const fill = bg ? Math.max(0, width - displayWidth(plain)) : 0
                return (
                  <Text key={absIdx} color={colorFor(ln.kind)} backgroundColor={bg} wrap="truncate">
                    {before}<Text inverse>{mid}</Text>{after}{fill ? ' '.repeat(fill) : ''}
                  </Text>
                )
              }
              if (bg) {
                return (
                  <Text key={absIdx} color={colorFor(ln.kind)} backgroundColor={bg} wrap="truncate">{padRow(ln.text)}</Text>
                )
              }
              return (
                <Text key={absIdx} color={colorFor(ln.kind)} wrap="truncate">{ln.text === '' ? ' ' : ln.text}</Text>
              )
            })}
          </Box>
          </>
        )}

        {/* Fixed bottom cluster: transient status + input box + collapsed
            workflows + footer, pinned to the terminal's last rows. Hidden while a
            modal overlay owns the screen; the transcript scrolls behind it. */}
        {!modalOpen ? (
          <Box flexDirection="column">
            {scrolled ? (
              <Box justifyContent="center">
                <Text backgroundColor={colors.blockBg || undefined} color={colors.accentBright} bold wrap="truncate">
                  {` ${t('app.jumpToBottom')} `}
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
                  <Text key={i} color={colors.dim} wrap="truncate">{t('app.queued', { q })}</Text>
                ))}
              </Box>
            ) : null}

            {streaming ? (
              <StatusLine
                word={chat.statusWord}
                elapsed={elapsed}
                tokens={chat.live?.tokens ?? 0}
                dir={chat.live?.dir ?? 'up'}
                suffix={chat.live?.thinking ? t('app.thinkingSuffix', { effort: String(getSetting(chat.config.settings, 'effort')) }) : undefined}
                reduceMotion={getSetting(chat.config.settings, 'reduceMotion') === true}
              />
            ) : null}

            {!streaming && chat.bgPending ? (
              <Box paddingLeft={1}>
                <Text color={colors.accent} wrap="truncate">⚙ 后台运行中 —— 完成后自动继续，按 Esc 取消。</Text>
              </Box>
            ) : null}

            {chat.retry ? (
              <Box paddingLeft={1}>
                <Text color={colors.warning} wrap="truncate">
                  {t('app.retryLine', {
                    reason: chat.retry.reason,
                    secs: Math.max(0, Math.ceil((chat.retry.until - Date.now()) / 1000)),
                    attempt: chat.retry.attempt,
                    max: chat.retry.max,
                  })}
                </Text>
              </Box>
            ) : null}

            {compacting ? (
              <Box paddingLeft={1}>
                <Text color={colors.accent} wrap="truncate">
                  {t('app.compacting', {
                    bar: '▰'.repeat(Math.round((compacting.pct / 100) * 5)) + '▱'.repeat(5 - Math.round((compacting.pct / 100) * 5)),
                    pct: compacting.pct,
                  })}
                </Text>
              </Box>
            ) : null}

            {ctxLevel !== 'ok' ? (
              <Box paddingLeft={1}>
                <Text color={ctxLevel === 'danger' ? colors.error : colors.warning} wrap="truncate">
                  {t('app.ctxWarn', {
                    pct: Math.round(ctx.ratio * 100),
                    bar: bar(ctx.ratio, 12),
                    used: fmtTokens(ctx.used),
                    limit: fmtTokens(ctx.limit),
                    tail: ctxLevel === 'danger' ? t('app.ctxCompactSoon') : t('app.ctxCompactHint'),
                  })}
                </Text>
              </Box>
            ) : null}

            {effortOpen ? (
              <EffortPicker
                width={width}
                current={
                  getSetting(chat.config.settings, 'ultracodeTrigger') === true
                    ? { kind: 'ultracode' }
                    : { kind: 'level', level: (isEffortLevel(String(getSetting(chat.config.settings, 'effort'))) ? String(getSetting(chat.config.settings, 'effort')) : 'medium') as EffortLevel }
                }
                onSelect={(choice: EffortChoice, sessionOnly: boolean) => {
                  const s = chat.config.settings
                  if (choice.kind === 'ultracode') {
                    chat.setConfig({ settings: { ...s, effort: 'xhigh', ultracodeTrigger: true, dynamicWorkflows: true } }, { persist: !sessionOnly })
                    chat.print(t(sessionOnly ? 'cmd.effortSetUltraSession' : 'cmd.effortSetUltra'), 'system')
                  } else {
                    chat.setConfig({ settings: { ...s, effort: choice.level, ultracodeTrigger: false } }, { persist: !sessionOnly })
                    chat.print(t(sessionOnly ? 'cmd.effortSetSession' : 'cmd.effortSet', { effort: choice.level }), 'system')
                  }
                  setEffortOpen(false)
                }}
                onCancel={() => setEffortOpen(false)}
              />
            ) : (
              <PromptInput
                active={wfSel === null && agentSel === null}
                width={width}
                commands={registry}
                placeholder={t('app.placeholder')}
                editorMode={String(getSetting(chat.config.settings, 'editorMode') || 'normal')}
                screenRows={dims.rows}
                bottomOffset={bottomOffset}
                mouseSelect
                copyOnSelect={getSetting(chat.config.settings, 'copyOnSelect') === true}
                onSubmit={handleSubmit}
                recallPending={() => {
                  // ↑ with the input empty pulls the most recent type-ahead line
                  // back into the box to edit or retract it (removed by value so a
                  // concurrent enqueue isn't clobbered). null = nothing queued.
                  const cur = queuedRef.current
                  if (cur.length === 0) return null
                  const last = cur[cur.length - 1]
                  setQueued((q) => {
                    const i = q.lastIndexOf(last)
                    return i >= 0 ? [...q.slice(0, i), ...q.slice(i + 1)] : q
                  })
                  return last
                }}
                onOverflowDown={() => {
                  // A single ↓ past the input drops into a selectable region below
                  // it. Prefer the agent switcher (switchable transcripts) when
                  // sub-agents exist, else the collapsed workflow lines.
                  if (chatRef.current.agents.length > 0) { setAgentSel(0); return true }
                  const wfs = chatRef.current.workflows
                  if (wfs.length === 0) return false
                  setWfSel(0)
                  return true
                }}
                onLeftAtStart={() => {
                  // `leftArrowOpensAgents`: ← at column 0 drops into the agent
                  // switcher when sub-agents exist, mirroring onOverflowDown.
                  if (getSetting(chatRef.current.config.settings, 'leftArrowOpensAgents') !== true) return false
                  if (chatRef.current.agents.length === 0) return false
                  setAgentSel(0)
                  return true
                }}
              />
            )}

            {/* The switchable agent list sits below the input, so a single ↓ past
                the input lands on it (see onOverflowDown). Selecting a row swaps
                the viewport above to that agent's own transcript. */}
            {chat.agents.length > 0 ? (
              <AgentSwitcher agents={chat.agents} sel={agentSel} viewing={viewingAgent} width={width} />
            ) : null}

            {/* Collapsed workflow lines sit BELOW the input box, so a single ↓
                past the input naturally lands on them (see onOverflowDown). */}
            {chat.workflows.length > 0 ? (
              <Box flexDirection="column">
                {chat.workflows.map((w, i) => (
                  <WorkflowCollapsed key={w.id} snapshot={w} selected={wfSel === i} />
                ))}
              </Box>
            ) : null}

            {suggestLine ? (
              <Box paddingLeft={1}>
                <Text color={colors.dim} wrap="truncate">{suggestLine}</Text>
              </Box>
            ) : null}

            {prLine && getSetting(chat.config.settings, 'prStatusFooter') !== false ? (
              <Box paddingLeft={1}>
                <Text color={colors.dim} wrap="truncate">{prLine}</Text>
              </Box>
            ) : null}

            <Box paddingLeft={1}>
              <Text color={colors.dim} wrap="truncate">
                {exitArmed
                  ? t('footer.exitArmed')
                  : scrolled
                    ? t('footer.scrolled')
                    : agentSel !== null
                      ? t('footer.agentSel')
                      : wfSel !== null
                        ? t('footer.wfSel')
                        : viewingAgent
                          ? t(streaming ? 'footer.viewingStreaming' : 'footer.viewingIdle')
                          : streaming
                            ? chat.agents.length > 0
                              ? t('footer.streamAgents')
                              : chat.workflows.length > 0
                                ? t('footer.streamWorkflows')
                                : t('footer.streaming')
                            : chat.agents.length > 0
                              ? t('footer.idleAgents')
                              : getSetting(chat.config.settings, 'showTips') !== false
                                ? tipFor(chat.usage.turns)
                                : t('footer.idle')}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
      </LangProvider>
    </ThemeProvider>
  )
}
