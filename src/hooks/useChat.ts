import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSnapshot, AppConfig, LoopSpec, Message, MessageMeta, PanelTab, Role, WorkflowSnapshot } from '../types'
import { getProvider } from '../providers'
import { isCommand, runCommand } from '../commands'
import { saveConfig } from '../config'
import { loadMemory, goalPreamble } from '../lib/memory'
import { changeSummary } from '../lib/transcript'
import { t } from '../lib/i18n'
import { effortDirective, getSetting, resolveThinkingBudget, outputStyleDirective } from '../lib/settings'
import { randomStatusWord, randomCompletedWord } from '../lib/spinner'
import { summarizeToolCall } from '../tools'
import { estimateTokens } from '../lib/tokens'
import { emptyUsage, type SessionUsage } from '../lib/usage'
import { computeCost } from '../lib/pricing'
import { recordSession, recordTurn } from '../lib/stats'
import { hasPendingBackground, takeCompleted, settleNextBackground, clearBackground, abortBackground } from '../lib/background'
import { BANNER, AGENT_SYSTEM, fmtDur, fmtClock, formatToolResult, renderWakeup } from './chat-helpers'

let counter = 0
const nextId = (): string => `m${++counter}`

export type ChatStatus = 'idle' | 'streaming'

// A transient, self-healing retry notice shown ABOVE the prompt (never written
// into the transcript/context): the attempt counter, the reason, and `until` —
// the epoch-ms moment the next attempt fires, so the UI can count down to it.
// Cleared the instant any non-retry event arrives and when the turn ends.
export interface RetryStatus {
  attempt: number
  max: number
  reason: string
  until: number
}

// The live token counter shown in the status line: `dir` is 'up' (input tokens,
// counted at submit) before the reply begins and 'down' (output tokens) once the
// model streams; `thinking` drives the "deep in thought…" suffix while a
// reasoning block is streaming.
export interface LiveStatus {
  dir: 'up' | 'down'
  tokens: number
  thinking: boolean
}

// Actions the host (App) provides for a submit — exit and clear are owned by
// the App/CLI so /clear can fully remount a fresh Ink instance.
export interface ChatActions {
  exit: () => void
  clear: () => void
  openThemePicker?: () => void
  openModelPicker?: () => void
  startLoop?: (spec: LoopSpec) => void
  stopLoop?: () => void
  loopStatus?: () => string | null
  startGoal?: (text: string) => void
  stopGoal?: () => void
  goalStatus?: () => string | null
  send?: (text: string) => void
  // Drain the type-ahead queue for a MID-TURN interjection: returns the plain-text
  // lines the user typed while the turn was streaming (commands are left queued for
  // the idle flush) and removes them from the queue. Called from useChat's provider
  // opts after each tool batch. Absent = no interjection support.
  takePending?: () => string[]
  compact?: () => number | Promise<number>
  openPanel?: (tab: PanelTab) => void
  openLogin?: () => void
  openResume?: () => void
  openAutoCompact?: () => void
  openEffortPicker?: () => void
}

export interface Chat {
  messages: Message[]
  streaming: Message | null
  // The reasoning block currently streaming (meta.thinking), or null. Rendered
  // above `streaming` in the live region and committed to the transcript when it
  // ends. See providers' `thinking` AgentEvents.
  thinking: Message | null
  // Live token counter for the status line (↑ input on submit, ↓ output while
  // the model works); null when idle.
  live: LiveStatus | null
  // A transient retry notice (attempt/max, reason, countdown target) shown above
  // the prompt while the provider retries a transient failure; null when none.
  // Never enters the transcript — it's ephemeral UI, cleared on the next event.
  retry: RetryStatus | null
  // Live progress of in-flight `workflow` tool calls (per-agent state + timing).
  // One entry per running workflow — a turn can fan out several, so the UI shows
  // one collapsed line each (↓ to select, ↵ to expand). Empty when none run.
  workflows: WorkflowSnapshot[]
  // Live switchable sub-agents from `task`/`plan` calls this turn — each is a
  // selectable transcript view in the bottom agent switcher (distinct from the
  // workflow tree). Kept until the NEXT turn starts, so a finished sub-agent's
  // chat can still be browsed after the turn ends.
  agents: AgentSnapshot[]
  // True when background sub-agent work (task/plan/workflow) is still running or
  // finished-but-uncollected while the main agent is idle — drives the idle
  // "后台运行中" indicator and lets Esc cancel it (see app.tsx).
  bgPending: boolean
  status: ChatStatus
  statusWord: string
  config: AppConfig
  usage: SessionUsage
  setConfig: (patch: Partial<AppConfig>, opts?: { persist?: boolean }) => void
  print: (content: string, role?: Role, meta?: MessageMeta) => void
  submit: (raw: string, actions: ChatActions) => Promise<void>
  interrupt: () => void
  // Destroy a finished workflow / switchable sub-agent snapshot once it loses UI
  // focus, so completed instances stop lingering at the bottom (see app.tsx).
  dropWorkflow: (id: string) => void
  dropAgent: (id: string) => void
}

export function useChat(initialConfig: AppConfig, initialMessages?: Message[], initialUsage?: SessionUsage): Chat {
  const [config, setConfigState] = useState<AppConfig>(initialConfig)
  // Seed with a carried-over transcript on a resize remount, else just the banner.
  const [messages, setMessages] = useState<Message[]>(() =>
    initialMessages && initialMessages.length > 0 ? initialMessages : [BANNER],
  )
  const [streaming, setStreaming] = useState<Message | null>(null)
  // The reasoning block being streamed this turn (null when none/committed).
  const [thinking, setThinking] = useState<Message | null>(null)
  // Live ↑/↓ token counter for the status line (null when idle).
  const [live, setLive] = useState<LiveStatus | null>(null)
  // Transient retry notice shown above the prompt (null when not retrying). Set
  // on a `retry` event, cleared on the next non-retry event and at turn end, so
  // it never lands in the transcript/context (see #3).
  const [retry, setRetry] = useState<RetryStatus | null>(null)
  // Live progress of in-flight `workflow` tool calls (null → an empty list). Each
  // arriving snapshot is upserted by id, so several workflows in one turn each
  // keep their own collapsed line; the whole list is cleared when the turn ends.
  const [workflows, setWorkflows] = useState<WorkflowSnapshot[]>([])
  // Live switchable sub-agents (`task`/`plan`). Upserted by id as each streams;
  // unlike workflows these survive turn end and are cleared when the NEXT turn
  // begins, so a completed sub-agent's transcript remains browsable.
  const [agents, setAgents] = useState<AgentSnapshot[]>([])
  // True while background work is still in flight (or finished-uncollected) with
  // the main agent idle. Set at turn end from hasPendingBackground(); drives the
  // idle indicator + Esc-cancel path.
  const [bgPending, setBgPending] = useState<boolean>(false)
  // Set by interrupt() when Esc is pressed while idle with background work
  // pending, so the turn-end drain drops the results instead of feeding them back.
  const bgCancelRef = useRef<boolean>(false)
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [statusWord, setStatusWord] = useState<string>('Working')
  // Cumulative session token/turn accounting (drives /usage, /status, warnings).
  const [usage, setUsage] = useState<SessionUsage>(() => initialUsage ?? emptyUsage())
  const usageRef = useRef<SessionUsage>(usage)
  const bumpUsage = useCallback((patch: Partial<SessionUsage>) => {
    const next: SessionUsage = { ...usageRef.current, ...patch }
    usageRef.current = next
    setUsage(next)
  }, [])
  // Destroy a finished workflow / switchable sub-agent snapshot. The UI calls
  // these once a COMPLETED instance loses focus (no longer expanded / viewed), so
  // it stops lingering at the bottom instead of waiting for the next turn to clear.
  const dropWorkflow = useCallback((id: string) => setWorkflows((prev) => prev.filter((w) => w.id !== id)), [])
  const dropAgent = useCallback((id: string) => setAgents((prev) => prev.filter((a) => a.id !== id)), [])

  // Count one lifetime session per process (idempotent — App remounts on
  // resize/compact/clear must not re-count).
  useEffect(() => { recordSession() }, [])

  const messagesRef = useRef<Message[]>(messages)
  const configRef = useRef<AppConfig>(config)
  const abortRef = useRef<AbortController | null>(null)
  // Tracks whether a retry notice is currently shown, so we clear it (once) on
  // the next non-retry event without a setState on every event.
  const retryRef = useRef<boolean>(false)

  // Keep refs in sync with the value we hand to React, avoiding stale closures.
  const commitMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setMessages((prev) => {
      const next = updater(prev)
      messagesRef.current = next
      return next
    })
  }, [])

  const setConfig = useCallback((patch: Partial<AppConfig>, opts?: { persist?: boolean }) => {
    const next = { ...configRef.current, ...patch }
    configRef.current = next
    setConfigState(next)
    // Persist the change so /model and /provider survive a restart. saveConfig
    // strips the apiKey before writing, so the key never touches disk. Pass
    // { persist: false } to apply a change for THIS session only (the "s" key in
    // the /effort slider), leaving the on-disk config untouched.
    if (opts?.persist !== false) saveConfig(next)
  }, [])

  const print = useCallback((content: string, role: Role = 'system', meta?: MessageMeta) => {
    commitMessages((prev) => [...prev, { id: nextId(), role, content, meta }])
  }, [commitMessages])

  const interrupt = useCallback(() => {
    // Streaming turn: abort the in-flight request (its controller). Background
    // work has its OWN controller, so a streaming interrupt leaves it running.
    if (abortRef.current) { abortRef.current.abort(); return }
    // Idle with background work pending: a second Esc cancels the background run.
    // Flag the drain so it drops the (aborted) results instead of feeding them
    // back, then abort every running background task.
    if (hasPendingBackground()) {
      bgCancelRef.current = true
      abortBackground()
    }
  }, [])

  const submit = useCallback(async (raw: string, actions: ChatActions) => {
    const text = raw.trim()
    if (!text || status === 'streaming') return

    const prior = messagesRef.current
    const userMsg: Message = { id: nextId(), role: 'user', content: text }
    commitMessages((prev) => [...prev, userMsg])

    if (isCommand(text)) {
      await runCommand(text, {
        config: configRef.current,
        setConfig,
        messages: messagesRef.current,
        clear: actions.clear,
        exit: actions.exit,
        print,
        openThemePicker: actions.openThemePicker,
        openModelPicker: actions.openModelPicker,
        startLoop: actions.startLoop,
        stopLoop: actions.stopLoop,
        loopStatus: actions.loopStatus,
        startGoal: actions.startGoal,
        stopGoal: actions.stopGoal,
        goalStatus: actions.goalStatus,
        usage: usageRef.current,
        send: actions.send,
        compact: actions.compact,
        openPanel: actions.openPanel,
        openLogin: actions.openLogin,
        openResume: actions.openResume,
        openAutoCompact: actions.openAutoCompact,
        openEffortPicker: actions.openEffortPicker,
      })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    const turnStart = Date.now()
    setStatusWord(randomStatusWord())
    setStatus('streaming')
    // Clear the prior turn's switchable sub-agents as a fresh turn begins (they
    // persist AFTER a turn so they stay browsable, unlike the workflow tree).
    setAgents([])

    // A single assistant turn can interleave text and tool calls. `assistantId`
    // is the id of the text chunk currently streaming; when a tool call arrives
    // we finalize that chunk as its own message and start a fresh one after, so
    // the transcript reads: text → ⏺ tool → ⎿ result → text …
    let assistantId = nextId()
    let base: Message = { id: assistantId, role: 'assistant', content: '' }
    let acc = ''
    setStreaming(base)

    const flushText = (): void => {
      if (acc.trim()) commitMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: acc }])
      acc = ''
      assistantId = nextId()
      base = { id: assistantId, role: 'assistant', content: '' }
      setStreaming(base)
    }

    const provider = getProvider(configRef.current)
    // Cross-session goal + notes steer every turn via the system preamble; the
    // agent base prompt makes the model use tools and finish the work; the
    // reasoning-effort level (set by /effort) tunes how much it explores/verifies.
    const preamble = goalPreamble(loadMemory())
    const effortLevel = String(getSetting(configRef.current.settings, 'effort'))
    const effort = effortDirective(effortLevel)
    // Output style (concise/explanatory) injects a preamble line like effort does.
    const outStyle = outputStyleDirective(String(getSetting(configRef.current.settings, 'outputStyle')))
    const system = [AGENT_SYSTEM, effort, outStyle, preamble, configRef.current.system].filter(Boolean).join('\n\n')
    // Extended thinking: effort sets the budget, `thinkingMode` (auto/off/on)
    // overrides it — off forces 0, on forces it on. Providers that don't support
    // thinking ignore thinkingBudget (see providers/anthropic, settings).
    const thinkingMode = String(getSetting(configRef.current.settings, 'thinkingMode'))
    const opts = {
      model: configRef.current.model,
      system,
      signal: controller.signal,
      thinkingBudget: resolveThinkingBudget(effortLevel, thinkingMode),
      // Configurable retry policy (see settings retryStatusCodes/retryMaxAttempts).
      retryStatusCodes: String(getSetting(configRef.current.settings, 'retryStatusCodes')),
      retryMaxAttempts: Number(getSetting(configRef.current.settings, 'retryMaxAttempts')) || undefined,
      // Keep going through a usage/rate limit instead of erroring at the cap.
      continueAtUsageLimit: getSetting(configRef.current.settings, 'continueAtUsageLimit') === true,
      // Swap to fallbackModel once if a message comes back flagged (refusal).
      switchModelOnFlag: getSetting(configRef.current.settings, 'switchModelOnFlag') === true,
      fallbackModel: String(getSetting(configRef.current.settings, 'fallbackModel') || '') || undefined,
      // Live workflow progress → React state so the UI can render the tree(s).
      // Snapshots are keyed by id: replace the matching one, else append. The
      // list is cleared on turn end (a workflow's final snapshot has done=true).
      onWorkflow: (snap: WorkflowSnapshot) =>
        setWorkflows((prev) => {
          const i = prev.findIndex((w) => w.id === snap.id)
          if (i < 0) return [...prev, snap]
          const next = prev.slice()
          next[i] = snap
          return next
        }),
      // Live switchable sub-agents (`task`/`plan`) → React state, upserted by id
      // so each keeps its own row in the bottom switcher and its transcript
      // updates in place. NOT cleared at turn end (see setAgents above).
      onAgent: (snap: AgentSnapshot) =>
        setAgents((prev) => {
          const i = prev.findIndex((a) => a.id === snap.id)
          if (i < 0) return [...prev, snap]
          const next = prev.slice()
          next[i] = snap
          return next
        }),
      // Mid-turn interjection: after each tool batch the provider calls this to
      // pull anything the user type-ahead-queued during the turn. We drain the
      // host queue (actions.takePending, which drops commands back for the idle
      // flush), commit each drained line to the transcript as a real user message
      // so it shows in-place and survives into the next turn's context, and hand
      // the lines to the provider to merge into the current request. Absent host
      // support (or nothing queued) → the turn is unaffected.
      takePending: actions.takePending
        ? (): string[] => {
            const pending = (actions.takePending?.() ?? []).map((p) => p.trim()).filter(Boolean)
            if (pending.length > 0) {
              commitMessages((prev) => [
                ...prev,
                ...pending.map((p) => ({ id: nextId(), role: 'user' as const, content: p })),
              ])
            }
            return pending
          }
        : undefined,
    }

    // Estimate the prompt size (system + full transcript) as a billing/context
    // fallback for providers that don't report real usage (e.g. mock). Real
    // token counts, when the provider sends them, override this below.
    const inputEstimate =
      estimateTokens(system) + [...prior, userMsg].reduce((n, m) => n + (m.content === '__banner__' ? 0 : estimateTokens(m.content)), 0)
    // Show the ↑ input count immediately; it flips to ↓ output once the reply
    // (or a thinking block) starts streaming.
    setLive({ dir: 'up', tokens: inputEstimate, thinking: false })
    let turnToolCalls = 0
    let turnInput = 0, turnOutput = 0, turnCacheRead = 0, turnCacheCreation = 0
    let turnLinesAdded = 0, turnLinesRemoved = 0
    let sawUsage = false
    // Accumulated output characters → an O(1)-per-delta ↓ token estimate.
    let outChars = 0
    // A terminal error from the provider, surfaced as its own message AFTER any
    // partial answer so the transcript reads [thinking] [answer] [⚠️ error].
    let errorMsg = ''
    // The reasoning block being streamed this turn (committed when text/tool
    // arrives or the turn ends).
    let thinkingAcc = ''
    let thinkingId = nextId()
    let thinkingStart = 0
    const flushThinking = (): void => {
      if (thinkingAcc.trim()) {
        const secs = thinkingStart ? Math.max(1, Math.round((Date.now() - thinkingStart) / 1000)) : 0
        const tId = thinkingId
        commitMessages((prev) => [...prev, { id: tId, role: 'assistant', content: thinkingAcc, meta: { thinking: true, thinkingSeconds: secs } }])
      }
      thinkingAcc = ''
      thinkingId = nextId()
      thinkingStart = 0
      setThinking(null)
    }
    const apiStart = Date.now()
    bumpUsage({ turns: usageRef.current.turns + 1 })

    try {
      if (provider.agent) {
        for await (const ev of provider.agent([...prior, userMsg], opts)) {
          // Any non-retry event means the request is progressing again — clear the
          // transient retry notice so it doesn't linger above the prompt.
          if (ev.type !== 'retry' && retryRef.current) { retryRef.current = false; setRetry(null) }
          if (ev.type === 'thinking') {
            if (!thinkingStart) thinkingStart = Date.now()
            thinkingAcc += ev.text
            outChars += ev.text.length
            setThinking({ id: thinkingId, role: 'assistant', content: thinkingAcc, meta: { thinking: true } })
            setLive({ dir: 'down', tokens: Math.round(outChars / 4), thinking: true })
          }
          else if (ev.type === 'text') {
            flushThinking()
            acc += ev.text
            outChars += ev.text.length
            setStreaming({ ...base, content: acc })
            setLive({ dir: 'down', tokens: Math.round(outChars / 4), thinking: false })
          }
          else if (ev.type === 'tool_use') { flushThinking(); turnToolCalls++; flushText(); print(`⏺ ${summarizeToolCall(ev.name, ev.input)}`, 'tool') }
          else if (ev.type === 'tool_result') {
            turnLinesAdded += ev.linesAdded ?? 0
            turnLinesRemoved += ev.linesRemoved ?? 0
            if (ev.diff && ev.diff.length && !ev.isError) {
              // A write/edit diff: show a one-line change summary carrying the
              // diff rows in meta, so the transcript can render the diff view.
              print(`⎿ ${changeSummary(ev.linesAdded ?? 0, ev.linesRemoved ?? 0)}`, 'tool', { diff: ev.diff })
            } else {
              // Prefer the tool's short `display` (keeps internal guidance/handles
              // out of the terminal); the model already got the full `content`.
              print(formatToolResult(ev.display ?? ev.content, ev.isError), 'tool', ev.isError ? { error: true } : undefined)
            }
          }
          else if (ev.type === 'usage') {
            sawUsage = true
            turnInput += ev.inputTokens; turnOutput += ev.outputTokens
            turnCacheRead += ev.cacheReadTokens; turnCacheCreation += ev.cacheCreationTokens
            // Snap the live ↓ counter to the provider's real output count.
            if (turnOutput > 0) setLive((l) => (l ? { ...l, dir: 'down', tokens: turnOutput } : l))
          }
          else if (ev.type === 'retry') {
            // Transient, self-healing — show it ABOVE the prompt as ephemeral UI,
            // never in the transcript (so it never re-enters the model's context).
            retryRef.current = true
            setRetry({ attempt: ev.attempt, max: ev.max, reason: ev.reason, until: Date.now() + ev.delayMs })
          }
          else if (ev.type === 'error') { errorMsg = ev.message }
        }
      } else {
        for await (const chunk of provider.stream([...prior, userMsg], opts)) {
          acc += chunk
          outChars += chunk.length
          setStreaming({ ...base, content: acc })
          setLive({ dir: 'down', tokens: Math.round(outChars / 4), thinking: false })
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) errorMsg = (err as Error)?.message ?? String(err)
    }

    // Commit any trailing reasoning first, then the answer, then a distinct
    // error message — preserving the [thinking] [answer] [⚠️ error] order.
    flushThinking()
    const interrupted = controller.signal.aborted
    if (acc.trim() || interrupted) {
      const meta: MessageMeta | undefined = interrupted ? { interrupted: true } : undefined
      commitMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: acc, meta }])
    }
    if (errorMsg && !interrupted) {
      print(`⚠️ ${errorMsg}`, 'system', { error: true })
    }
    // Per-turn completion footer at the bottom of the turn (like Claude Code's
    // "✻ Sautéed for 10m 10s · done 2:09"). Only when the turn actually produced a
    // reply and wasn't interrupted, and only if the `showTurnDuration` setting is
    // on. `timeFormat` (24h/12h) picks the clock format. role 'system' keeps it
    // out of the API history.
    if (!interrupted && acc.trim() && getSetting(configRef.current.settings, 'showTurnDuration') !== false) {
      const now = new Date()
      const line = t('app.turnDone', {
        word: randomCompletedWord(),
        dur: fmtDur(now.getTime() - turnStart),
        clock: fmtClock(now, getSetting(configRef.current.settings, 'timeFormat') !== '12h'),
      })
      commitMessages((prev) => [...prev, { id: nextId(), role: 'system', content: line, meta: { turnDone: true } }])
    }
    // Fold this turn into the running totals. Prefer the provider's real token
    // counts (incl. cache); fall back to estimates when none were reported. Cost
    // is always computed at official rates (see lib/pricing), whatever provider.
    const apiMs = Date.now() - apiStart
    const model = configRef.current.model
    const inTok = sawUsage ? turnInput : inputEstimate
    const outTok = sawUsage ? turnOutput : estimateTokens(acc)
    const cacheRead = sawUsage ? turnCacheRead : 0
    const cacheCreation = sawUsage ? turnCacheCreation : 0
    const turnCost = computeCost({ inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation }, model)
    const u = usageRef.current
    const wallMs = Date.now() - u.startedAt
    bumpUsage({
      inputTokens: u.inputTokens + inTok,
      outputTokens: u.outputTokens + outTok,
      cacheReadTokens: u.cacheReadTokens + cacheRead,
      cacheCreationTokens: u.cacheCreationTokens + cacheCreation,
      toolCalls: u.toolCalls + turnToolCalls,
      apiMs: u.apiMs + apiMs,
      linesAdded: u.linesAdded + turnLinesAdded,
      linesRemoved: u.linesRemoved + turnLinesRemoved,
      costUsd: u.costUsd + turnCost,
    })
    // Persist to the lifetime store (best-effort; never load-bearing).
    try { recordTurn({ model, input: inTok, output: outTok, cacheRead, cacheWrite: cacheCreation, cost: turnCost, wallMs }) } catch { /* ignore */ }
    setStreaming(null)
    setThinking(null)
    setLive(null)
    retryRef.current = false
    setRetry(null)
    setWorkflows([])
    setStatus('idle')
    abortRef.current = null
    // Reflect whether background work outlives this turn — drives the idle
    // "后台运行中" indicator and enables the Esc-cancel path while we drain below.
    setBgPending(hasPendingBackground())

    // #1/#2: don't stop dead if this turn launched background sub-agents that are
    // still running (or finished but uncollected). Wait for the next batch to
    // settle, then feed the results back as a fresh turn so the main agent resumes
    // on its own. Draining recurses through submit's own turn-end, so it continues
    // until nothing is pending. Runs even after an Esc-interrupt: the idle
    // indicator promises the work auto-continues when done, and a second Esc while
    // it drains cancels it (interrupt sets bgCancelRef; the check below honors it).
    if (hasPendingBackground()) {
      let collected = takeCompleted()
      if (collected.length === 0) {
        await settleNextBackground()
        // Esc while idle set the cancel flag (see interrupt): drop the aborted
        // results instead of feeding them back, and clear the pending state.
        if (bgCancelRef.current) {
          bgCancelRef.current = false
          clearBackground()
          setBgPending(false)
          print('⏹ 已取消后台任务。', 'system')
          return
        }
        if (abortRef.current) return // a new turn started meanwhile — let it drive
        collected = takeCompleted()
      }
      if (collected.length > 0) await submit(renderWakeup(collected), actions)
    }
  }, [status, commitMessages, setConfig, print, bumpUsage])

  return { messages, streaming, thinking, live, retry, workflows, agents, bgPending, status, statusWord, config, usage, setConfig, print, submit, interrupt, dropWorkflow, dropAgent }
}
