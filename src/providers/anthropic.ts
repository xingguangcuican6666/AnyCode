import type { AgentEvent, Message, Provider, StreamOpts, ToolResultBlock } from '../types'
import { loadConfig } from '../config'
import { runTool, toolSchemas, type SpawnOpts, type SpawnResult } from '../tools'
import { decidePermission, isPermissionMode, matchPermissionRule, DENY_RULE_REASON, type PermissionMode } from '../tools/permission'
import { loadHooks, runHooks } from '../lib/hooks'
import { estimateTokens } from '../lib/tokens'
import { contextLimit, AUTO_COMPACT_RATIO } from '../lib/usage'
import { parseRetryCodes, sleep, backoffMs, parseRetryAfter } from './retry'
import { type ApiBlock, type ApiMsg, type StreamUsage, emptyStreamUsage, toApiMessages, parseStream } from './wire'
import { t } from '../lib/i18n'

const API_VERSION = '2023-06-01'
// Last-resort guard against a runaway loop (e.g. a misbehaving provider that keeps
// returning tool_use forever). Deliberately high so it never fires on real work —
// like Claude Code, the real limits are the context window (→ auto-compaction) and
// the user's interrupt, not a small fixed step count.
const MAX_STEPS = 1000
const MAX_ATTEMPTS = 10 // default total tries per request before giving up
// Max times a single turn will wait out a usage limit when continueAtUsageLimit
// is on, so a permanent cap eventually surfaces as an error instead of hanging.
const USAGE_WAIT_CAP = 30
// Max times a single turn will react to a "context too large" API rejection by
// folding older messages and retrying, so a convo that can't shrink further (one
// giant message) surfaces the error instead of looping.
const MAX_OVERFLOW_COMPACTIONS = 3

// How a given Anthropic-protocol provider resolves its endpoint + key. The env
// default (id 'anthropic') leaves baseUrl/apiKeyEnv unset; custom providers set
// both. A logged-in provider (id 'newapi') instead supplies dynamic resolvers +
// bearer auth (see providers/index.ts). Costs are always billed at official
// rates regardless (see lib/pricing).
export interface AnthropicOpts {
  id: string
  label: string
  baseUrl?: string     // host base; env ANTHROPIC_BASE_URL used when unset
  apiKeyEnv?: string   // env var holding the key; default resolution when unset
  // Dynamic resolution (used by the logged-in `newapi` provider): when set these
  // win over baseUrl/apiKeyEnv, so a runtime credential (a login on disk) reaches
  // the request without ever touching settings.json. Read fresh on every call so
  // /login and /logout take effect immediately.
  resolveBaseUrl?: () => string | undefined
  resolveKey?: () => string | undefined
  // Async token resolution for OAuth logins: the at_ access token is refreshed
  // (a network call) when it's expired, so the resolver is async. Wins over
  // resolveKey/apiKeyEnv when set.
  resolveKeyAsync?: () => Promise<string | undefined>
  // Force-refresh hook, invoked once per turn when the server answers 401 (the
  // at_ token expired or was rotated out from under us). Returns a fresh token to
  // retry with, or undefined when nothing can be refreshed (→ surface the error).
  refreshKey?: () => Promise<string | undefined>
  auth?: 'x-api-key' | 'bearer'   // request auth header style; default 'x-api-key'
  noKeyHint?: string   // message shown when no key resolves (overrides the default)
}

// Normalize a host base to the Messages endpoint — "/v1/messages" is appended
// unless already present (matching the Anthropic SDK convention).
function toMessagesUrl(base: string): string {
  const b = base.replace(/\/+$/, '')
  return /\/v1\/messages$/.test(b) ? b : `${b}/v1/messages`
}

function resolveUrl(opts: AnthropicOpts): string {
  return toMessagesUrl(opts.resolveBaseUrl?.() || opts.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')
}

// Custom providers read their key from a named env var (never persisted); a
// logged-in provider resolves it from the credentials file; the env default
// falls back to config.apiKey (itself env-sourced) then ANTHROPIC_API_KEY.
function resolveKey(opts: AnthropicOpts): string | undefined {
  if (opts.resolveKey) return opts.resolveKey()
  if (opts.apiKeyEnv) return process.env[opts.apiKeyEnv]
  return loadConfig().apiKey || process.env.ANTHROPIC_API_KEY
}

function keyHint(opts: AnthropicOpts): string {
  if (opts.noKeyHint) return opts.noKeyHint
  const envName = opts.apiKeyEnv || 'ANTHROPIC_API_KEY'
  return `⚠ No \`${envName}\` found. Set it, or run \`/provider mock\` for the offline demo.`
}

// A bearer-auth provider (new-api relay) sends `Authorization: Bearer <key>`;
// the Anthropic default uses `x-api-key`. Both still send anthropic-version so
// the relay routes to the Messages protocol.
function authHeaders(apiKey: string, auth: 'x-api-key' | 'bearer' | undefined): Record<string, string> {
  return auth === 'bearer'
    ? { authorization: `Bearer ${apiKey}` }
    : { 'x-api-key': apiKey }
}

async function post(url: string, body: unknown, apiKey: string, auth: 'x-api-key' | 'bearer' | undefined, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(apiKey, auth), 'anthropic-version': API_VERSION },
    body: JSON.stringify(body),
    signal,
  })
}

// --- Mid-turn compaction --------------------------------------------------
// Like Claude Code, a turn that keeps calling tools must not run into the
// model's context limit. When the convo we're about to send nears the window,
// the older messages are folded into a model-written summary and the loop
// continues — the same idea as the between-turn /compact (see lib/compact,
// lib/summarize), applied inside the tool loop.

// Mirror of lib/summarize's SUMMARY_SYSTEM, kept local so the provider doesn't
// import lib/summarize (which imports providers → a module init cycle).
const SUMMARY_SYSTEM =
  'You are the compaction step of a coding-assistant CLI. A long session is about to exceed the context window, so the earlier messages will be dropped and REPLACED by your summary alone — anything you leave out is lost to the assistant permanently. ' +
  'Write dense, factual notes (not prose, no pleasantries, no praise), grouped under these headings and each only as long as it needs to be:\n' +
  '1. Task & intent — what the user is ultimately trying to accomplish and what they asked for most recently; quote wording that must be obeyed exactly.\n' +
  '2. Standing instructions & constraints — every directive about HOW to work that stays in force for the whole session (language to reply in, formatting rules, security/credential rules, commit/push policy, things never to do). Reproduce them verbatim; never soften or drop them.\n' +
  '3. Files, paths, symbols, commands & decisions — exact identifiers (file paths, function/variable names, flags, config keys, URLs, error text) and the design decisions already made. Never paraphrase an identifier.\n' +
  '4. Work done & outcome — what was changed, what worked, what failed, fixes applied, and whether builds/tests were run and their result. Do not claim anything is complete or verified unless the transcript shows it.\n' +
  '5. Current state & next steps — precisely where things stand and the concrete remaining actions, including any pending user request not yet fulfilled and anything awaiting the user’s confirmation.\n' +
  'Do not invent facts or fill gaps with assumptions. Output ONLY the summary text.'

// A tool_result's content is either a plain string or structured blocks
// (multimodal read). These flatten it for the two out-of-band consumers below —
// the context estimate and the summarizer's transcript render — neither of which
// can carry the actual image bytes. An image/document counts as a flat rough
// token cost (the real cost depends on its dimensions, billed by the API).
function estimateToolResult(content: string | ToolResultBlock[]): number {
  if (typeof content === 'string') return estimateTokens(content)
  let n = 0
  for (const blk of content) n += blk.type === 'text' ? estimateTokens(blk.text) : 1500
  return n
}
function toolResultText(content: string | ToolResultBlock[]): string {
  if (typeof content === 'string') return content
  return content.map((blk) => (blk.type === 'text' ? blk.text : `[${blk.type}]`)).join('\n')
}

// Rough token estimate of the API convo we'd send (the ~4-char/token heuristic
// the rest of the app uses for its fill bar and thresholds — see lib/tokens).
function estimateApiConvo(convo: ApiMsg[]): number {
  let n = 0
  for (const m of convo) {
    if (typeof m.content === 'string') { n += estimateTokens(m.content); continue }
    for (const b of m.content) {
      if (b.type === 'text') n += estimateTokens(b.text)
      else if (b.type === 'thinking') n += estimateTokens(b.thinking)
      else if (b.type === 'tool_use') n += estimateTokens(JSON.stringify(b.input)) + 4
      else if (b.type === 'tool_result') n += estimateToolResult(b.content)
    }
  }
  return n
}

// Render the folded slice as a labeled transcript for the summarizer. Blocks are
// flattened to text; tool calls/results are noted and clipped so a huge slice
// still fits the summarizer's own input budget.
function renderApiConvo(msgs: ApiMsg[], perMsg = 2000): string {
  const parts: string[] = []
  for (const m of msgs) {
    const who = m.role === 'user' ? 'USER' : 'ASSISTANT'
    let body: string
    if (typeof m.content === 'string') body = m.content
    else {
      const segs: string[] = []
      for (const b of m.content) {
        if (b.type === 'text') segs.push(b.text)
        else if (b.type === 'tool_use') segs.push(`\u2192 ${b.name}(${JSON.stringify(b.input).slice(0, 300)})`)
        else if (b.type === 'tool_result') segs.push(`\u2190 ${b.is_error ? 'error: ' : ''}${toolResultText(b.content).slice(0, 500)}`)
      }
      body = segs.join('\n')
    }
    if (!body.trim()) continue
    parts.push(`${who}: ${body.length > perMsg ? body.slice(0, perMsg) + '\u2026' : body}`)
  }
  return parts.join('\n\n')
}

// Pick a fold boundary: keep a recent suffix, but snap the cut to an assistant
// message so no tool_use/tool_result pair is split across the fold (the API
// rejects an orphaned tool_result). Returns -1 when no safe, worthwhile cut
// exists (nothing to fold, or the whole tail is one giant step).
function pickCut(convo: ApiMsg[]): number {
  if (convo.length < 4) return -1 // too short to fold anything worthwhile
  // Keep ~a third as the recent tail, but never so much that fewer than 2
  // messages remain to fold, and never fewer than the last couple of steps.
  const keep = Math.min(convo.length - 2, Math.max(4, Math.floor(convo.length / 3)))
  let cut = convo.length - keep
  while (cut < convo.length && convo[cut].role !== 'assistant') cut++
  return cut < convo.length ? cut : -1
}

// Fold the older slice into one summary "user" turn (relabeled like a compaction
// digest, exactly as toApiMessages does for the between-turn path). Returns the
// rewritten convo + how many messages were folded, or null when it can't (no
// safe cut, or the one-shot summary call failed → caller keeps the convo as-is).
async function compactConvo(convo: ApiMsg[], opts: StreamOpts, cfg: AnthropicOpts): Promise<{ convo: ApiMsg[]; folded: number } | null> {
  const cut = pickCut(convo)
  if (cut < 0) return null
  let summary: string
  try {
    const raw = await complete(
      [{ id: 'compact', role: 'user', content: 'Summarize the following conversation so it can continue after the older messages are dropped:\n\n' + renderApiConvo(convo.slice(0, cut)) }],
      { model: opts.model, system: SUMMARY_SYSTEM, signal: opts.signal },
      cfg,
    )
    summary = raw.trim()
  } catch { return null }
  if (!summary) return null
  const digest: ApiMsg = { role: 'user', content: `[Summary of the earlier conversation, which was compacted to save context]\n\n${summary}` }
  return { convo: [digest, ...convo.slice(cut)], folded: cut }
}

// Does a failed request look like a context-length overflow rather than a
// transient fault? Our token estimate can undercount (a big tool result, an
// image), so we sometimes only learn the request is too big from the API's own
// rejection. Different relays word it differently: the user's relay returns a
// bare `512 context too large`; Anthropic answers 400 "prompt is too long";
// OpenAI-style relays say "maximum context length … tokens". Match the status
// codes AND the common phrasings so we can fold + retry instead of erroring.
function isContextOverflow(status: number, errText: string): boolean {
  if (status === 413 || status === 512) return true
  return /context (?:length|window|too)|too long|too large|maximum context|max(?:imum)? tokens|token limit|reduce the (?:length|number of tokens)|prompt is too long/i.test(errText)
}

// Compact one-liner for a tool call the sub-agent made, used to reconstruct a
// report from its trace when it ends without writing prose. Picks the most
// telling string argument (path/command/pattern) so the line reads like an action.
function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  let detail = ''
  for (const k of ['path', 'command', 'pattern', 'file_path', 'query']) {
    const v = input?.[k]
    if (typeof v === 'string' && v.trim()) { detail = v.trim(); break }
  }
  if (!detail) { try { detail = JSON.stringify(input ?? {}) } catch { detail = '' } }
  return `${name}${detail ? ` · ${detail.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`
}

// Last-resort report synthesized from a sub-agent's tool trace when it finished
// WITHOUT writing its own summary — so the orchestrator still learns what the
// sub-agent did instead of getting an empty "no summary" error. Not a hard error:
// the run completed, it was just terse.
function traceReport(trace: string[], steps: number): string {
  if (trace.length === 0) return `子代理已结束，但未产出书面总结，也没有可追溯的工具调用（共 ${steps} 步）。`
  const lines = trace.slice(0, 30).map((t, i) => `${i + 1}. ${t}`)
  const more = trace.length > 30 ? `\n… 另有 ${trace.length - 30} 次工具调用未列出` : ''
  return `⚠ 子代理未自行撰写总结；以下为其 ${steps} 次工具调用的操作轨迹（系统自动汇总）：\n${lines.join('\n')}${more}`
}

// exit_plan_mode approval. Called by the top-level tool loop (below) instead of
// running the tool through runTool, because approval must change THIS turn's
// permission mode: the model that just proposed a plan should be able to start
// editing right away. Presents the finalized plan and asks the user to approve
// leaving plan mode, offering auto-accept (acceptEdits) vs. confirm-each (default).
// Returns the text to feed back as the tool_result and, when approved, the new
// mode the caller applies (and propagates to the host via onPermissionModeChange).
// Never approves for a sub-agent or a headless run (no interactive approver).
export async function handleExitPlanMode(
  input: Record<string, unknown>,
  opts: StreamOpts,
  sub: boolean,
  permMode: PermissionMode,
): Promise<{ content: string; isError: boolean; newMode?: PermissionMode }> {
  const plan = String((input as { plan?: unknown })?.plan ?? '').trim()
  // Only meaningful while planning; outside plan mode it's a no-op the model
  // shouldn't have reached for.
  if (permMode !== 'plan') return { content: t('exitPlan.notPlanning'), isError: false }
  // Sub-agents and headless runs can't raise a dialog, so there's no approver.
  if (sub || !opts.requestUserInput) return { content: t('exitPlan.noApprover'), isError: false }
  const autoLabel = t('exitPlan.optAuto')
  const manualLabel = t('exitPlan.optManual')
  const resp = await opts.requestUserInput({
    questions: [{
      question: t('exitPlan.approveQ'),
      header: t('exitPlan.approveHeader'),
      options: [
        { label: autoLabel, description: t('exitPlan.optAutoDesc') },
        { label: manualLabel, description: t('exitPlan.optManualDesc') },
        { label: t('exitPlan.optReject'), description: t('exitPlan.optRejectDesc') },
      ],
    }],
  })
  const choice = resp.cancelled ? '' : (resp.answers?.[0]?.[0] ?? '')
  if (choice === autoLabel) return { content: t('exitPlan.approvedAuto', { plan }), isError: false, newMode: 'acceptEdits' }
  if (choice === manualLabel) return { content: t('exitPlan.approvedManual', { plan }), isError: false, newMode: 'default' }
  // Reject, cancel, or a free-form "Other" answer → stay in plan mode.
  return { content: t('exitPlan.rejected'), isError: false }
}

// `sub` marks a nested sub-agent run: it is offered no orchestration tools and
// gets no spawnAgent in its tool context, so nesting is capped at one level.
async function* agent(messages: Message[], opts: StreamOpts, cfg: AnthropicOpts, sub = false): AsyncGenerator<AgentEvent, void, unknown> {
  let apiKey = cfg.resolveKeyAsync ? await cfg.resolveKeyAsync() : resolveKey(cfg)
  if (!apiKey) { yield { type: 'text', text: keyHint(cfg) }; return }
  const url = resolveUrl(cfg)
  let convo = toApiMessages(messages)
  const cwd = process.cwd()
  // Lifecycle shell hooks (see lib/hooks), read once per turn. `null` when none
  // are configured so the tool loop skips the machinery entirely.
  const hooksCfg = loadHooks(cwd)
  const hooksActive = (['PreToolUse', 'PostToolUse'] as const).some((e) => (hooksCfg[e]?.length ?? 0) > 0)
  // Permission mode governs whether each tool call runs freely, is denied, or
  // prompts the user (see tools/permission). Sub-agents inherit it but only ever
  // apply its deterministic part (plan mode denies mutations); they never prompt.
  // `let`, not `const`: an approved exit_plan_mode flips it to acceptEdits/default
  // mid-turn so the model can start editing immediately (see the tool loop below).
  let permMode: PermissionMode = isPermissionMode(opts.permissionMode) ? opts.permissionMode : 'default'

  // Retry policy is configurable per request (see settings retryStatusCodes /
  // retryMaxAttempts, threaded through StreamOpts); fall back to the built-ins.
  const shouldRetry = parseRetryCodes(opts.retryStatusCodes)
  const maxAttempts = opts.retryMaxAttempts && opts.retryMaxAttempts > 0 ? opts.retryMaxAttempts : MAX_ATTEMPTS

  // The orchestration tools (`task`, `workflow`) delegate through this callback.
  // Supplied only at the top level; a sub-agent receives `undefined` (so the
  // tools report they're unavailable) — this is what enforces the 1-level cap.
  const spawnAgent: ((sp: SpawnOpts) => Promise<SpawnResult>) | undefined = sub
    ? undefined
    : async (sp) => {
        const subMessages: Message[] = [{ id: 'sub-user', role: 'user', content: sp.prompt }]
        const subOpts: StreamOpts = { model: opts.model, system: sp.system, signal: sp.signal ?? opts.signal, retryStatusCodes: opts.retryStatusCodes, retryMaxAttempts: opts.retryMaxAttempts, continueAtUsageLimit: opts.continueAtUsageLimit, switchModelOnFlag: opts.switchModelOnFlag, fallbackModel: opts.fallbackModel, permissionMode: opts.permissionMode, autoModeInPlan: opts.autoModeInPlan, rewind: opts.rewind, permissionRules: opts.permissionRules }
        let text = ''
        let lastText = ''
        let steps = 0
        let error: string | undefined
        // Compact trace of the tools this sub-agent ran, so we can synthesize a
        // usable report if it ends without writing its own prose (see below).
        const trace: string[] = []
        for await (const ev of agent(subMessages, subOpts, cfg, true)) {
          sp.onEvent?.(ev) // forward the sub-agent's live events for the switchable view
          if (ev.type === 'text') { text += ev.text; lastText += ev.text }
          else if (ev.type === 'tool_use') { steps++; lastText = ''; trace.push(summarizeToolCall(ev.name, ev.input)) } // reset lastText so we keep only the FINAL prose block
          else if (ev.type === 'error') error = ev.message
        }
        // Prefer the sub-agent's final prose block, else all its prose. A run that
        // hit a transport error keeps whatever prose it managed (or a trace summary)
        // and surfaces the error so it shows as ✗ with the real reason.
        const prose = lastText.trim() || text.trim()
        if (error) return { text: prose || traceReport(trace, steps), steps, error }
        if (prose) return { text: prose, steps }
        // No prose even after the forced-summary nudge: the model kept investigating
        // and never wrote a report. Rather than surface an empty ✗ "no summary" — which
        // discards the work — synthesize a report from the tool trace so the orchestrator
        // still sees what was done. NOT flagged as an error: the sub-agent completed.
        return { text: traceReport(trace, steps), steps }
      }

  // At most one forced token refresh per turn (on a 401), so an unrecoverable
  // auth failure surfaces as an error instead of looping. OAuth logins only.
  let refreshedAuth = false
  // The model in use for this turn. Normally opts.model, but switchModelOnFlag
  // may swap it to opts.fallbackModel once if a message comes back flagged.
  let activeModel = opts.model
  let switchedModel = false
  // How many times we've waited out a usage limit (continueAtUsageLimit). Bounded
  // by USAGE_WAIT_CAP so a permanent cap can't loop forever.
  let usageWaits = 0
  // Convo length at the last mid-turn compaction — only re-compact once the
  // convo has grown again, so we never thrash on an already-folded transcript.
  let compactedLen = 0
  // How many times this turn has reacted to a "context too large" API rejection
  // by folding + retrying (bounded by MAX_OVERFLOW_COMPACTIONS).
  let overflowCompactions = 0
  // Sub-agent summary safety net: whether we've already nudged this run to write a
  // report. A sub-agent that ends on a bare tool-call trace (no closing prose) would
  // otherwise leave the orchestrator with "(no output)"; we prompt it ONCE to
  // summarize (see the end-of-turn branch below).
  let forcedSummary = false
  // Set once we've nudged a sub-agent for its report: the FOLLOW-UP request drops
  // tools entirely so the model physically can't keep poking around and MUST write
  // prose — the earlier "please summarize" nudge alone didn't stop tool-only runs.
  let summaryOnly = false
  for (let step = 0; step < MAX_STEPS; step++) {
    // Mid-turn auto-compaction (top level only — sub-agents stay lean): when the
    // request we're about to send nears the model's window, fold the older
    // messages into a summary and continue instead of hitting the hard limit.
    if (!sub && convo.length > compactedLen + 1 && estimateApiConvo(convo) >= contextLimit(opts.model) * AUTO_COMPACT_RATIO) {
      const res = await compactConvo(convo, opts, cfg)
      if (opts.signal?.aborted) return
      if (res) {
        convo = res.convo
        compactedLen = convo.length
        yield { type: 'text', text: `\n\u2397 Context compacted \u2014 folded ${res.folded} earlier messages to stay within the window.\n\n` }
      }
    }
    // Extended thinking is opt-in via /effort (high+). Never for sub-agents (keep
    // them lean). max_tokens must exceed the thinking budget, so add headroom.
    const think = !sub && opts.thinkingBudget && opts.thinkingBudget >= 1024 ? opts.thinkingBudget : 0
    const body = {
      model: activeModel,
      max_tokens: think ? think + 4096 : 4096,
      stream: true,
      // Drop tools on the forced-summary step so the model can only answer in prose.
      ...(summaryOnly ? {} : { tools: toolSchemas(!sub, opts.dynamicWorkflows !== false, cwd, permMode === 'plan' && !sub) }),
      ...(think ? { thinking: { type: 'enabled', budget_tokens: think } } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      messages: convo,
    }

    // One request + SSE stream per step, wrapped in bounded backoff retries that
    // cover BOTH the connection and the streaming read, so a transient failure is
    // retried (announced via `retry`) and a fatal one ends the turn via `error`.
    let blocks: ApiBlock[] = []
    let stopReason = 'end_turn'
    let streamed = false
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response
      try {
        res = await post(url, body, apiKey, cfg.auth, opts.signal)
      } catch (e) {
        if (opts.signal?.aborted) return
        const reason = (e as Error).message || 'network error'
        if (attempt >= maxAttempts - 1) { yield { type: 'error', message: `network error after ${maxAttempts} attempts: ${reason}` }; return }
        const delay = backoffMs(attempt)
        yield { type: 'retry', attempt: attempt + 1, max: maxAttempts, delayMs: delay, reason }
        await sleep(delay, opts.signal); if (opts.signal?.aborted) return
        continue
      }
      if (!res.ok || !res.body) {
        const status = res.status
        // An OAuth at_ token that expired mid-session: refresh once and retry the
        // same request immediately (doesn't count as a transient-status retry).
        if (status === 401 && cfg.refreshKey && !refreshedAuth) {
          refreshedAuth = true
          const nk = await cfg.refreshKey()
          if (opts.signal?.aborted) return
          if (nk && nk !== apiKey) { apiKey = nk; attempt--; continue }
        }
        const errText = await res.text().catch(() => '')
        // A 401/403 on the logged-in provider is almost always an expired/invalid or
        // insufficiently-scoped login rather than a transient fault — say so clearly.
        if ((status === 401 || status === 403) && cfg.refreshKey) {
          yield { type: 'error', message: `登录已失效或权限不足（HTTP ${status}）。请运行 /login 重新登录（OAuth 应用需具备 models.invoke 权限）。` }
          return
        }
        // A usage/rate limit (429): normally retried within the attempt budget.
        // With continueAtUsageLimit on we instead keep waiting it out — honoring
        // Retry-After, capped per-wait and in total — so the turn continues once
        // the limit clears rather than ending in an error at the attempt cap.
        if (status === 429 && opts.continueAtUsageLimit && usageWaits < USAGE_WAIT_CAP) {
          usageWaits++
          const delay = Math.min((parseRetryAfter(res.headers.get('retry-after')) ?? 30) * 1000, 300_000)
          yield { type: 'retry', attempt: attempt + 1, max: maxAttempts, delayMs: delay, reason: `usage limit (HTTP 429) — 等待后继续 ${usageWaits}/${USAGE_WAIT_CAP}` }
          await sleep(delay, opts.signal); if (opts.signal?.aborted) return
          attempt-- // a usage-limit wait doesn't consume the transient-retry budget
          continue
        }
        // A context-length overflow (e.g. the user's "512 context too large"):
        // our estimate undercounted and the request came back rejected for size.
        // Fold the older messages into a summary and retry this step instead of
        // erroring — the auto-compaction the user expected but wasn't happening.
        // Top level only (sub-agents stay lean); bounded so a convo that can't
        // shrink further still surfaces the error.
        if (!sub && isContextOverflow(status, errText) && overflowCompactions < MAX_OVERFLOW_COMPACTIONS) {
          const folded = await compactConvo(convo, opts, cfg)
          if (opts.signal?.aborted) return
          if (folded) {
            convo = folded.convo
            compactedLen = convo.length
            overflowCompactions++
            body.messages = convo
            yield { type: 'text', text: `\n⎗ Context compacted — the request exceeded the model's window; folded ${folded.folded} earlier messages and retrying.\n\n` }
            attempt-- // the fold+retry doesn't consume the transient-retry budget
            continue
          }
        }
        if (!shouldRetry(status) || attempt >= maxAttempts - 1) { yield { type: 'error', message: `API error ${status}: ${errText.slice(0, 400)}` }; return }
        const delay = backoffMs(attempt, parseRetryAfter(res.headers.get('retry-after')))
        yield { type: 'retry', attempt: attempt + 1, max: maxAttempts, delayMs: delay, reason: `HTTP ${status}` }
        await sleep(delay, opts.signal); if (opts.signal?.aborted) return
        continue
      }
      blocks = []; stopReason = 'end_turn'
      let stepStreamed = false
      try {
        for await (const ev of parseStream(res, opts.signal)) {
          if (ev.type === 'text') { stepStreamed = true; yield { type: 'text', text: ev.text } }
          else if (ev.type === 'thinking') { stepStreamed = true; yield { type: 'thinking', text: ev.text } }
          else {
            blocks = ev.blocks; stopReason = ev.stopReason
            yield { type: 'usage', inputTokens: ev.usage.input, outputTokens: ev.usage.output, cacheReadTokens: ev.usage.cacheRead, cacheCreationTokens: ev.usage.cacheCreation }
          }
        }
      } catch (e) {
        if (opts.signal?.aborted) return
        const reason = (e as Error).message || 'stream interrupted'
        if (stepStreamed || attempt >= maxAttempts - 1) { yield { type: 'error', message: `stream error: ${reason}` }; return }
        const delay = backoffMs(attempt)
        yield { type: 'retry', attempt: attempt + 1, max: maxAttempts, delayMs: delay, reason }
        await sleep(delay, opts.signal); if (opts.signal?.aborted) return
        continue
      }
      // A clean EOF carrying no content (truncated/empty upstream): retry while
      // nothing was shown, else surface it rather than returning a blank turn.
      if (!stepStreamed && blocks.length === 0) {
        if (attempt >= maxAttempts - 1) { yield { type: 'error', message: 'empty response from API (no content) after retries' }; return }
        const delay = backoffMs(attempt)
        yield { type: 'retry', attempt: attempt + 1, max: maxAttempts, delayMs: delay, reason: 'empty response' }
        await sleep(delay, opts.signal); if (opts.signal?.aborted) return
        continue
      }
      streamed = stepStreamed
      break
    }

    if (opts.signal?.aborted) return

    // switchModelOnFlag: a `refusal` stop reason means the message was flagged by
    // the model. If enabled and a distinct fallback model is available, swap to
    // it and redo this step ONCE (don't record the refused turn) rather than
    // surfacing the refusal. Guarded so it happens at most once per turn.
    if (stopReason === 'refusal' && opts.switchModelOnFlag && opts.fallbackModel && !switchedModel && opts.fallbackModel !== activeModel) {
      switchedModel = true
      activeModel = opts.fallbackModel
      yield { type: 'text', text: `\n⚠ 消息被标记，改用备用模型 ${activeModel} 重试…\n\n` }
      step--
      continue
    }

    convo.push({ role: 'assistant', content: blocks })

    const toolUses = blocks.filter((b): b is Extract<ApiBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    if (stopReason !== 'tool_use' || toolUses.length === 0) {
      // Never end a turn with a blank transcript: if the model produced no answer
      // text and no tool call, say why (stop reason) instead of stopping silently.
      const hadText = blocks.some((b) => b.type === 'text' && b.text.trim().length > 0)
      // A SUB-agent that stops WITHOUT closing prose gives the orchestrator only a
      // tool-call trace ("(no output)"). Nudge it ONCE — dropping tools on the
      // follow-up so it physically CANNOT keep poking around and MUST write its
      // report — so task/plan/workflow results are always useful synthesis. Bounded
      // by `forcedSummary` so it can't loop; only for sub-agents (the top-level
      // agent's edits/output stand on their own). We fire regardless of whether a
      // tool ran: any prose-less sub-agent turn gets the one summary prompt.
      if (sub && !hadText && !forcedSummary) {
        forcedSummary = true
        summaryOnly = true // next request carries no tools, so the model must answer
        // Ensure the assistant turn just pushed is a valid, non-empty message so the
        // follow-up request is accepted (endpoints reject blank/empty content).
        const last = convo[convo.length - 1]
        if (last && last.role === 'assistant' && Array.isArray(last.content)) {
          const kept = last.content.filter((b) => b.type !== 'text' || b.text.length > 0)
          last.content = kept.length > 0 ? kept : [{ type: 'text', text: '(investigated with tools)' }]
        }
        convo.push({ role: 'user', content: 'Now write your final report: a short paragraph summarizing what you found or changed, with concrete specifics (file:line references, conclusions, and any remaining risks). This message is captured verbatim as your result and shown to the orchestrator — do NOT call any tools, just write the summary.' })
        continue
      }
      if (!hadText && !streamed) {
        const why = stopReason && stopReason !== 'end_turn' ? ` (stop reason: ${stopReason})` : ''
        yield { type: 'text', text: `(no reply — the model ended the turn without output${why})` }
      }
      return
    }

    // Execute every requested tool, then feed all results back as one user turn.
    const results: ApiBlock[] = []
    for (const tu of toolUses) {
      yield { type: 'tool_use', id: tu.id, name: tu.name, input: tu.input }
      // PreToolUse hooks run first: a hook may DENY the call (short-circuits like a
      // permission denial, feeding its reason back to the model) or explicitly
      // ALLOW it (bypassing the normal permission prompt). Extra context a hook
      // emits is appended to the eventual tool result.
      let hookAllow = false
      let preContext = ''
      if (hooksActive) {
        const pre = await runHooks('PreToolUse', { tool_name: tu.name, tool_input: tu.input }, cwd, hooksCfg, opts.signal)
        if (opts.signal?.aborted) return
        if (pre.decision === 'deny') {
          const reason = `PreToolUse 钩子拒绝了本次调用：${pre.reason ?? '(no reason given)'}`
          yield { type: 'tool_result', id: tu.id, name: tu.name, content: reason, isError: true }
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: reason, is_error: true })
          continue
        }
        if (pre.decision === 'allow') hookAllow = true
        if (pre.context) preContext = pre.context
      }
      // exit_plan_mode is a control tool, not a workspace action: it presents the
      // finalized plan and asks the user to approve leaving plan mode. Handled here
      // (not via runTool) because approval flips THIS turn's permission mode —
      // `permMode` is reassigned so the model may edit immediately, and the change
      // is propagated to the host (onPermissionModeChange) so it also persists.
      if (tu.name === 'exit_plan_mode') {
        const outcome = await handleExitPlanMode(tu.input, opts, sub, permMode)
        if (opts.signal?.aborted) return
        if (outcome.newMode) { permMode = outcome.newMode; opts.onPermissionModeChange?.(outcome.newMode) }
        yield { type: 'tool_result', id: tu.id, name: tu.name, content: outcome.content, isError: outcome.isError }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: outcome.content, is_error: outcome.isError })
        continue
      }
      // Permission gate: decide whether this tool may run under the current mode.
      // 'deny' (plan-mode mutation, or the user declined) short-circuits — the
      // reason is fed back as an error tool_result so the model adapts instead of
      // the tool actually running; 'ask' prompts the user via requestPermission.
      // A PreToolUse hook that returned "allow" skips this gate.
      let decision: { action: 'allow' } | { action: 'ask' } | { action: 'deny'; reason: string } =
        hookAllow ? { action: 'allow' } : decidePermission(permMode, tu.name, { autoModeInPlan: opts.autoModeInPlan, sub })
      // Persistent permission rules modulate that decision: a matching `deny`
      // always blocks (overriding a hook/mode allow — a user's explicit veto), an
      // `allow` skips a prompt the mode would raise, and an `ask` forces a prompt
      // a mode would auto-allow (top-level only; a sub-agent can't prompt, and
      // never has a prompt in bypass mode either). Plan-mode mutation denials are
      // left intact — an allow rule doesn't override read-only planning intent.
      const rule = matchPermissionRule(tu.name, tu.input, opts.permissionRules)
      if (rule === 'deny') {
        decision = { action: 'deny', reason: DENY_RULE_REASON }
      } else if (rule === 'allow' && decision.action === 'ask') {
        decision = { action: 'allow' }
      } else if (rule === 'ask' && decision.action === 'allow' && !sub && permMode !== 'bypassPermissions') {
        decision = { action: 'ask' }
      }
      let denyReason: string | undefined
      if (decision.action === 'deny') {
        denyReason = decision.reason
      } else if (decision.action === 'ask' && opts.requestPermission) {
        const verdict = await opts.requestPermission({ tool: tu.name, input: tu.input, summary: summarizeToolCall(tu.name, tu.input) })
        if (opts.signal?.aborted) return
        if (verdict === 'deny') denyReason = '用户拒绝了本次工具调用。请据此调整方案，或改用其它方式。'
      }
      if (denyReason) {
        yield { type: 'tool_result', id: tu.id, name: tu.name, content: denyReason, isError: true }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: denyReason, is_error: true })
        continue
      }
      const r = await runTool(tu.name, tu.input, { cwd, signal: opts.signal, spawnAgent, onWorkflow: opts.onWorkflow, onAgent: opts.onAgent, allowBackground: !sub, artifacts: opts.artifacts, rewind: opts.rewind, requestUserInput: opts.requestUserInput })
      if (opts.signal?.aborted) return
      // PostToolUse hooks run after execution: a hook may feed extra context back
      // to the model, or "block" to flag the result (the reason is appended). The
      // tool has already run, so this shapes the feedback, not whether it ran.
      let extra = preContext
      let postError = false
      if (hooksActive) {
        const post = await runHooks('PostToolUse', { tool_name: tu.name, tool_input: tu.input, tool_response: { content: r.content, isError: r.isError } }, cwd, hooksCfg, opts.signal)
        if (opts.signal?.aborted) return
        if (post.decision === 'deny') { postError = true; extra = [extra, `PostToolUse 钩子：${post.reason ?? 'blocked'}`].filter(Boolean).join('\n\n') }
        if (post.context) extra = [extra, post.context].filter(Boolean).join('\n\n')
      }
      const content = extra ? `${r.content}\n\n[hook]\n${extra}` : r.content
      const isError = r.isError || postError
      yield { type: 'tool_result', id: tu.id, name: tu.name, content, display: r.display, isError, linesAdded: r.linesAdded, linesRemoved: r.linesRemoved, diff: r.diff }
      // Structured blocks (images/PDF from a multimodal read_file) go to the model
      // in place of the string; the UI event above still carries the text summary.
      const blocks = r.blocks && !extra ? r.blocks : undefined
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: blocks ?? content, is_error: isError })
    }
    // Mid-turn interjection: drain anything the user typed while this turn streamed
    // (type-ahead) and merge it into THIS same user turn, as extra text blocks after
    // the tool_results — the API needs a single user turn here, so it can't be a
    // second consecutive message. This is what makes an interjection land right
    // after the next tool call instead of waiting for the turn to end. Top level
    // only: a sub-agent's opts carries no takePending (see subOpts).
    const pending = !sub ? (opts.takePending?.() ?? []) : []
    const content: ApiBlock[] = pending.length > 0
      ? [...results, ...pending.map((text) => ({ type: 'text' as const, text }))]
      : results
    convo.push({ role: 'user', content })
  }
  yield { type: 'error', message: `stopped after ${MAX_STEPS} tool steps (safety cap)` }
}

async function complete(messages: Message[], opts: StreamOpts, cfg: AnthropicOpts): Promise<string> {
  const apiKey = cfg.resolveKeyAsync ? await cfg.resolveKeyAsync() : resolveKey(cfg)
  if (!apiKey) throw new Error(`no ${cfg.apiKeyEnv || 'ANTHROPIC_API_KEY'}`)
  const body = {
    model: opts.model,
    max_tokens: 1024,
    ...(opts.system ? { system: opts.system } : {}),
    messages: toApiMessages(messages),
  }
  const res = await post(resolveUrl(cfg), body, apiKey, cfg.auth, opts.signal)
  if (!res.ok) throw new Error(`API error ${res.status}`)
  const json: any = await res.json()
  return (json.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
}

/**
 * Build a Provider that speaks the Anthropic Messages API over global fetch +
 * SSE (no SDK). Reused for the env default and for user-defined
 * Anthropic-protocol providers — only the endpoint/key resolution differs.
 * `stream` is text-only; `agent` adds the tool-use loop; `complete` is one-shot.
 */
export function makeAnthropicProvider(cfg: AnthropicOpts): Provider {
  return {
    id: cfg.id,
    label: cfg.label,
    agent: (messages, opts) => agent(messages, opts, cfg),
    complete: (messages, opts) => complete(messages, opts, cfg),
    async *stream(messages: Message[], opts: StreamOpts) {
      for await (const ev of agent(messages, opts, cfg)) {
        if (ev.type === 'text') yield ev.text
        else if (ev.type === 'error') yield `⚠ ${ev.message}`
      }
    },
  }
}

// The env-configured default (activates when ANTHROPIC_API_KEY / apiKey is set).
export const anthropicProvider: Provider = makeAnthropicProvider({ id: 'anthropic', label: 'Anthropic API' })




