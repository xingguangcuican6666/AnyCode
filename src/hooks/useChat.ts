import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig, LoopSpec, Message, MessageMeta, PanelTab, Role, WorkflowSnapshot } from '../types'
import { getProvider } from '../providers'
import { isCommand, runCommand } from '../commands'
import { saveConfig } from '../config'
import { loadMemory, goalPreamble } from '../lib/memory'
import { effortDirective, getSetting, thinkingBudgetFor } from '../lib/settings'
import { randomStatusWord } from '../lib/spinner'
import { summarizeToolCall } from '../tools'
import { estimateTokens } from '../lib/tokens'
import { emptyUsage, type SessionUsage } from '../lib/usage'
import { computeCost } from '../lib/pricing'
import { recordSession, recordTurn } from '../lib/stats'

let counter = 0
const nextId = (): string => `m${++counter}`

const BANNER: Message = { id: 'banner', role: 'system', content: '__banner__' }

// Base instructions so a real model behaves like a coding agent: lean on the
// tools, and actually finish (verify) rather than narrate a plan and stop.
const AGENT_SYSTEM =
  'You are AnyCode, a coding agent working in the user\'s project directory. ' +
  'Use the provided tools (bash, read_file, write_file, edit_file, grep, glob, list_dir) to inspect and change the project yourself instead of only describing what to do. ' +
  'For a self-contained sub-task, delegate it with the `task` tool (a fresh sub-agent with the same file/search/shell tools); to fan several independent sub-tasks out in parallel, use the `workflow` tool. ' +
  'For any non-trivial or multi-file change, first call the `plan` tool to have a read-only sub-agent produce a concrete step-by-step implementation plan, then follow it. ' +
  'Keep going until the request is genuinely done — read what you need, make the edits, and verify with a build or tests before you stop. ' +
  'Do not stop after merely acknowledging or outlining a plan.'

export type ChatStatus = 'idle' | 'streaming'

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
  startLoop?: (spec: LoopSpec) => void
  stopLoop?: () => void
  loopStatus?: () => string | null
  startGoal?: (text: string) => void
  stopGoal?: () => void
  goalStatus?: () => string | null
  send?: (text: string) => void
  compact?: () => number
  openPanel?: (tab: PanelTab) => void
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
  // Live progress of in-flight `workflow` tool calls (per-agent state + timing).
  // One entry per running workflow — a turn can fan out several, so the UI shows
  // one collapsed line each (↓ to select, ↵ to expand). Empty when none run.
  workflows: WorkflowSnapshot[]
  status: ChatStatus
  statusWord: string
  config: AppConfig
  usage: SessionUsage
  setConfig: (patch: Partial<AppConfig>) => void
  print: (content: string, role?: Role, meta?: MessageMeta) => void
  submit: (raw: string, actions: ChatActions) => Promise<void>
  interrupt: () => void
}

// Render a tool result as an indented, dimmed block, truncated for the transcript.
function formatToolResult(content: string, isError?: boolean): string {
  const lines = content.split('\n')
  const shown = lines.slice(0, 12)
  const more = lines.length - shown.length
  const body = shown.join('\n') + (more > 0 ? `\n… (+${more} more lines)` : '')
  const mark = isError ? '⎿ ⚠️ ' : '⎿ '
  return mark + body.split('\n').join('\n   ')
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
  // Live progress of in-flight `workflow` tool calls (null → an empty list). Each
  // arriving snapshot is upserted by id, so several workflows in one turn each
  // keep their own collapsed line; the whole list is cleared when the turn ends.
  const [workflows, setWorkflows] = useState<WorkflowSnapshot[]>([])
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

  // Count one lifetime session per process (idempotent — App remounts on
  // resize/compact/clear must not re-count).
  useEffect(() => { recordSession() }, [])

  const messagesRef = useRef<Message[]>(messages)
  const configRef = useRef<AppConfig>(config)
  const abortRef = useRef<AbortController | null>(null)

  // Keep refs in sync with the value we hand to React, avoiding stale closures.
  const commitMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setMessages((prev) => {
      const next = updater(prev)
      messagesRef.current = next
      return next
    })
  }, [])

  const setConfig = useCallback((patch: Partial<AppConfig>) => {
    const next = { ...configRef.current, ...patch }
    configRef.current = next
    setConfigState(next)
    // Persist the change so /model and /provider survive a restart. saveConfig
    // strips the apiKey before writing, so the key never touches disk.
    saveConfig(next)
  }, [])

  const print = useCallback((content: string, role: Role = 'system', meta?: MessageMeta) => {
    commitMessages((prev) => [...prev, { id: nextId(), role, content, meta }])
  }, [commitMessages])

  const interrupt = useCallback(() => {
    abortRef.current?.abort()
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
      })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatusWord(randomStatusWord())
    setStatus('streaming')

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
    const system = [AGENT_SYSTEM, effort, preamble, configRef.current.system].filter(Boolean).join('\n\n')
    // Extended thinking is opt-in via /effort (high+); providers that don't
    // support it ignore thinkingBudget (see providers/anthropic, settings).
    const opts = {
      model: configRef.current.model,
      system,
      signal: controller.signal,
      thinkingBudget: thinkingBudgetFor(effortLevel),
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
            print(formatToolResult(ev.content, ev.isError), 'tool', ev.isError ? { error: true } : undefined)
          }
          else if (ev.type === 'usage') {
            sawUsage = true
            turnInput += ev.inputTokens; turnOutput += ev.outputTokens
            turnCacheRead += ev.cacheReadTokens; turnCacheCreation += ev.cacheCreationTokens
            // Snap the live ↓ counter to the provider's real output count.
            if (turnOutput > 0) setLive((l) => (l ? { ...l, dir: 'down', tokens: turnOutput } : l))
          }
          else if (ev.type === 'retry') {
            const secs = Math.max(1, Math.round(ev.delayMs / 1000))
            print(`⟳ Retrying (${ev.attempt}/${ev.max}) in ${secs}s — ${ev.reason}`, 'system', { retry: true })
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
    setWorkflows([])
    setStatus('idle')
    abortRef.current = null
  }, [status, commitMessages, setConfig, print, bumpUsage])

  return { messages, streaming, thinking, live, workflows, status, statusWord, config, usage, setConfig, print, submit, interrupt }
}
