import type { AgentEvent, Message, Provider, StreamOpts } from '../types'
import { loadConfig } from '../config'
import { runTool, toolSchemas, type SpawnOpts, type SpawnResult } from '../tools'

const API_VERSION = '2023-06-01'
const MAX_STEPS = 24 // safety cap on tool-use iterations within a single turn
const MAX_ATTEMPTS = 5 // total tries per request before giving up
// Transient HTTP statuses worth retrying (rate limit, overload, gateway churn).
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529])

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

// Exponential backoff (0.5s, 1s, 2s, …) capped at 16s, plus a little jitter so
// retries don't thundering-herd. A server-sent Retry-After wins when present.
function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter != null && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000)
  return Math.min(500 * 2 ** attempt, 16_000) + Math.floor(Math.random() * 250)
}

// Retry-After is either a number of seconds or an HTTP date.
function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined
  const n = Number(h)
  if (Number.isFinite(n)) return n
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : undefined
}

// How a given Anthropic-protocol provider resolves its endpoint + key. The env
// default (id 'anthropic') leaves baseUrl/apiKeyEnv unset; custom providers set
// both. Costs are always billed at official rates regardless (see lib/pricing).
export interface AnthropicOpts {
  id: string
  label: string
  baseUrl?: string     // host base; env ANTHROPIC_BASE_URL used when unset
  apiKeyEnv?: string   // env var holding the key; default resolution when unset
}

// Normalize a host base to the Messages endpoint — "/v1/messages" is appended
// unless already present (matching the Anthropic SDK convention).
function toMessagesUrl(base: string): string {
  const b = base.replace(/\/+$/, '')
  return /\/v1\/messages$/.test(b) ? b : `${b}/v1/messages`
}

function resolveUrl(opts: AnthropicOpts): string {
  return toMessagesUrl(opts.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')
}

// Custom providers read their key from a named env var (never persisted); the
// env default falls back to config.apiKey (itself env-sourced) then the standard
// ANTHROPIC_API_KEY.
function resolveKey(opts: AnthropicOpts): string | undefined {
  if (opts.apiKeyEnv) return process.env[opts.apiKeyEnv]
  return loadConfig().apiKey || process.env.ANTHROPIC_API_KEY
}

function keyHint(opts: AnthropicOpts): string {
  const envName = opts.apiKeyEnv || 'ANTHROPIC_API_KEY'
  return `⚠️  No \`${envName}\` found. Set it, or run \`/provider mock\` for the offline demo.`
}

type ApiBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
type ApiMsg = { role: 'user' | 'assistant'; content: string | ApiBlock[] }

// Real token usage reported by the API for one request (cache broken out).
interface StreamUsage { input: number; output: number; cacheRead: number; cacheCreation: number }
function emptyStreamUsage(): StreamUsage { return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }

// Prior transcript → API messages (text turns only; tool history is rebuilt as
// the loop runs so we never resend stale tool state).
function toApiMessages(messages: Message[]): ApiMsg[] {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

async function post(url: string, body: unknown, apiKey: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
    body: JSON.stringify(body),
    signal,
  })
}

// Parse a full SSE body, yielding text + thinking deltas live and collecting the
// assistant content blocks + stop_reason + real token usage for the tool loop.
async function* parseStream(res: Response, signal?: AbortSignal): AsyncGenerator<
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'done'; blocks: ApiBlock[]; stopReason: string; usage: StreamUsage },
  void,
  unknown
> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const blocks: ApiBlock[] = []
  const jsonBuf: Record<number, string> = {}
  let stopReason = 'end_turn'
  const usage = emptyStreamUsage()

  while (true) {
    let done = false
    let value: Uint8Array | undefined
    try { const r = await reader.read(); done = r.done; value = r.value } catch (e) { if (signal?.aborted) return; throw e }
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    const events = done ? [buffer] : buffer.split('\n\n')
    if (!done) buffer = events.pop() ?? ''
    for (const evt of events) {
      for (const line of evt.split('\n')) {
        const m = /^data:\s?(.*)$/.exec(line)
        if (!m || m[1] === '[DONE]') continue
        let json: any
        try { json = JSON.parse(m[1]) } catch { continue }
        if (json.type === 'message_start') {
          const u = json.message?.usage
          if (u) {
            usage.input = u.input_tokens ?? 0
            usage.cacheRead = u.cache_read_input_tokens ?? 0
            usage.cacheCreation = u.cache_creation_input_tokens ?? 0
            usage.output = u.output_tokens ?? usage.output
          }
        } else if (json.type === 'content_block_start') {
          const cb = json.content_block
          if (cb?.type === 'text') blocks[json.index] = { type: 'text', text: '' }
          else if (cb?.type === 'thinking') blocks[json.index] = { type: 'thinking', thinking: cb.thinking ?? '', signature: cb.signature ?? '' }
          else if (cb?.type === 'redacted_thinking') blocks[json.index] = { type: 'redacted_thinking', data: cb.data ?? '' }
          else if (cb?.type === 'tool_use') { blocks[json.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} }; jsonBuf[json.index] = '' }
        } else if (json.type === 'content_block_delta') {
          if (json.delta?.type === 'text_delta') {
            const b = blocks[json.index]; if (b?.type === 'text') b.text += json.delta.text
            yield { type: 'text', text: json.delta.text as string }
          } else if (json.delta?.type === 'thinking_delta') {
            const b = blocks[json.index]; if (b?.type === 'thinking') b.thinking += json.delta.thinking
            yield { type: 'thinking', text: json.delta.thinking as string }
          } else if (json.delta?.type === 'signature_delta') {
            const b = blocks[json.index]; if (b?.type === 'thinking') b.signature += json.delta.signature ?? ''
          } else if (json.delta?.type === 'input_json_delta') {
            jsonBuf[json.index] = (jsonBuf[json.index] ?? '') + json.delta.partial_json
          }
        } else if (json.type === 'content_block_stop') {
          const b = blocks[json.index]
          if (b?.type === 'tool_use') { try { b.input = JSON.parse(jsonBuf[json.index] || '{}') } catch { b.input = {} } }
        } else if (json.type === 'message_delta') {
          if (json.delta?.stop_reason) stopReason = json.delta.stop_reason
          if (json.usage?.output_tokens != null) usage.output = json.usage.output_tokens
        }
      }
    }
    if (done) break
  }
  yield { type: 'done', blocks: blocks.filter(Boolean), stopReason, usage }
}

// `sub` marks a nested sub-agent run: it is offered no orchestration tools and
// gets no spawnAgent in its tool context, so nesting is capped at one level.
async function* agent(messages: Message[], opts: StreamOpts, cfg: AnthropicOpts, sub = false): AsyncGenerator<AgentEvent, void, unknown> {
  const apiKey = resolveKey(cfg)
  if (!apiKey) { yield { type: 'text', text: keyHint(cfg) }; return }
  const url = resolveUrl(cfg)
  const convo = toApiMessages(messages)
  const cwd = process.cwd()

  // The orchestration tools (`task`, `workflow`) delegate through this callback.
  // Supplied only at the top level; a sub-agent receives `undefined` (so the
  // tools report they're unavailable) — this is what enforces the 1-level cap.
  const spawnAgent: ((sp: SpawnOpts) => Promise<SpawnResult>) | undefined = sub
    ? undefined
    : async (sp) => {
        const subMessages: Message[] = [{ id: 'sub-user', role: 'user', content: sp.prompt }]
        const subOpts: StreamOpts = { model: opts.model, system: sp.system, signal: opts.signal }
        let text = ''
        let steps = 0
        let error: string | undefined
        for await (const ev of agent(subMessages, subOpts, cfg, true)) {
          if (ev.type === 'text') text += ev.text
          else if (ev.type === 'tool_use') steps++
          else if (ev.type === 'error') error = ev.message
        }
        return { text: text.trim(), steps, error }
      }

  for (let step = 0; step < MAX_STEPS; step++) {
    // Extended thinking is opt-in via /effort (high+). Never for sub-agents (keep
    // them lean). max_tokens must exceed the thinking budget, so add headroom.
    const think = !sub && opts.thinkingBudget && opts.thinkingBudget >= 1024 ? opts.thinkingBudget : 0
    const body = {
      model: opts.model,
      max_tokens: think ? think + 4096 : 4096,
      stream: true,
      tools: toolSchemas(!sub),
      ...(think ? { thinking: { type: 'enabled', budget_tokens: think } } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      messages: convo,
    }

    // Send with bounded exponential-backoff retries on transient failures
    // (network errors + 408/409/429/5xx/529). Each wait is announced as a
    // `retry` event; a fatal or exhausted failure ends the turn via `error`.
    let res: Response | null = null
    for (let attempt = 0; ; attempt++) {
      try {
        res = await post(url, body, apiKey, opts.signal)
      } catch (e) {
        if (opts.signal?.aborted) return
        const reason = (e as Error).message || 'network error'
        if (attempt >= MAX_ATTEMPTS - 1) { yield { type: 'error', message: `network error after ${MAX_ATTEMPTS} attempts: ${reason}` }; return }
        const delay = backoffMs(attempt)
        yield { type: 'retry', attempt: attempt + 1, max: MAX_ATTEMPTS, delayMs: delay, reason }
        await sleep(delay, opts.signal)
        if (opts.signal?.aborted) return
        continue
      }
      if (res.ok && res.body) break
      const status = res.status
      const errText = await res.text().catch(() => '')
      if (!RETRY_STATUS.has(status) || attempt >= MAX_ATTEMPTS - 1) {
        yield { type: 'error', message: `API error ${status}: ${errText.slice(0, 400)}` }
        return
      }
      const delay = backoffMs(attempt, parseRetryAfter(res.headers.get('retry-after')))
      yield { type: 'retry', attempt: attempt + 1, max: MAX_ATTEMPTS, delayMs: delay, reason: `HTTP ${status}` }
      await sleep(delay, opts.signal)
      if (opts.signal?.aborted) return
    }

    let blocks: ApiBlock[] = []
    let stopReason = 'end_turn'
    for await (const ev of parseStream(res!, opts.signal)) {
      if (ev.type === 'text') yield { type: 'text', text: ev.text }
      else if (ev.type === 'thinking') yield { type: 'thinking', text: ev.text }
      else {
        blocks = ev.blocks; stopReason = ev.stopReason
        yield { type: 'usage', inputTokens: ev.usage.input, outputTokens: ev.usage.output, cacheReadTokens: ev.usage.cacheRead, cacheCreationTokens: ev.usage.cacheCreation }
      }
    }
    if (opts.signal?.aborted) return
    convo.push({ role: 'assistant', content: blocks })

    const toolUses = blocks.filter((b): b is Extract<ApiBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    if (stopReason !== 'tool_use' || toolUses.length === 0) return

    // Execute every requested tool, then feed all results back as one user turn.
    const results: ApiBlock[] = []
    for (const tu of toolUses) {
      yield { type: 'tool_use', id: tu.id, name: tu.name, input: tu.input }
      const r = await runTool(tu.name, tu.input, { cwd, signal: opts.signal, spawnAgent, onWorkflow: opts.onWorkflow })
      if (opts.signal?.aborted) return
      yield { type: 'tool_result', id: tu.id, name: tu.name, content: r.content, isError: r.isError, linesAdded: r.linesAdded, linesRemoved: r.linesRemoved }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, is_error: r.isError })
    }
    convo.push({ role: 'user', content: results })
  }
  yield { type: 'error', message: `stopped after ${MAX_STEPS} tool steps (safety cap)` }
}

async function complete(messages: Message[], opts: StreamOpts, cfg: AnthropicOpts): Promise<string> {
  const apiKey = resolveKey(cfg)
  if (!apiKey) throw new Error(`no ${cfg.apiKeyEnv || 'ANTHROPIC_API_KEY'}`)
  const body = {
    model: opts.model,
    max_tokens: 1024,
    ...(opts.system ? { system: opts.system } : {}),
    messages: toApiMessages(messages),
  }
  const res = await post(resolveUrl(cfg), body, apiKey, opts.signal)
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
        else if (ev.type === 'error') yield `⚠️  ${ev.message}`
      }
    },
  }
}

// The env-configured default (activates when ANTHROPIC_API_KEY / apiKey is set).
export const anthropicProvider: Provider = makeAnthropicProvider({ id: 'anthropic', label: 'Anthropic API' })




