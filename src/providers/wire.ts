// Anthropic wire protocol: the on-the-wire content-block types, the transcript →
// API-message conversion, and the SSE stream parser. Kept separate from the
// agent loop (providers/anthropic) so the loop reads as orchestration, not
// byte-plumbing.
import type { Message } from '../types'

export type ApiBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type ApiMsg = { role: 'user' | 'assistant'; content: string | ApiBlock[] }

// Real token usage reported by the API for one request (cache broken out).
export interface StreamUsage { input: number; output: number; cacheRead: number; cacheCreation: number }
export function emptyStreamUsage(): StreamUsage { return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }

// Prior transcript → API messages (text turns only; tool history is rebuilt as
// the loop runs so we never resend stale tool state). Compaction digests are the
// one exception to "user/assistant only": they carry role 'system' for the UI,
// but must reach the model, so they're relabeled as a user turn here.
export function toApiMessages(messages: Message[]): ApiMsg[] {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant' || m.meta?.compacted) && m.content.trim())
    .map((m) => m.meta?.compacted
      ? { role: 'user' as const, content: `[Summary of the earlier conversation, which was compacted to save context]\n\n${m.content}` }
      : { role: m.role as 'user' | 'assistant', content: m.content })
}

// Parse a full SSE body, yielding text + thinking deltas live and collecting the
// assistant content blocks + stop_reason + real token usage for the tool loop.
export async function* parseStream(res: Response, signal?: AbortSignal): AsyncGenerator<
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