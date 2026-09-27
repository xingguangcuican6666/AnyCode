// Model-driven conversation summarization for /compact and auto-compaction.
//
// Real Claude Code compacts by asking a model — in a call OUTSIDE the working
// session — to distill the older transcript into a dense summary, so the folded
// context is a genuine summary rather than a structural sketch. This mirrors the
// goal Stop-hook (see lib/goalJudge): a one-shot provider.complete() call with a
// dedicated system prompt, not part of the live turn's tool loop.
//
// It is best-effort: if the provider can't summarize (the mock/stub has no
// `complete`) or the call fails, the caller falls back to the offline
// heuristicSummary (see lib/compact), so compaction never blocks on the network.
import type { AppConfig, Message } from '../types'
import { getProvider } from '../providers'

const SUMMARY_SYSTEM =
  'You are compressing a long coding-assistant conversation so it can continue seamlessly after the older messages are dropped from the context window. ' +
  'Write a dense, factual summary — notes, not prose — that a fresh instance of the assistant could read to pick up exactly where things left off. ' +
  'Cover, in this order: (1) what the user is trying to accomplish and any explicit requirements or constraints they stated; ' +
  '(2) key files, paths, functions, commands, and decisions made; (3) what has been done so far and its outcome (what worked, what failed); ' +
  '(4) the current state and the concrete next steps. ' +
  'Preserve exact identifiers (file paths, symbol names, flags, error text) — do not paraphrase them away. Omit pleasantries and filler. ' +
  'Output ONLY the summary text.'

// Render the messages being folded as a compact transcript for the summarizer.
// Roles are labeled; each message is clipped so a huge transcript still fits the
// summarizer's own input budget.
function renderTranscript(messages: Message[], perMsg = 2000): string {
  return messages
    .filter((m) => m.content !== '__banner__' && m.content.trim())
    .map((m) => {
      const who = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : m.role === 'tool' ? 'TOOL' : 'SYSTEM'
      const body = m.content.length > perMsg ? m.content.slice(0, perMsg) + '…' : m.content
      return `${who}: ${body}`
    })
    .join('\n\n')
}

// Summarize the older slice via an independent model call. Resolves to the
// summary text, or null when no summarizer is available or the call fails (the
// caller then falls back to the offline heuristic).
export async function summarizeConversation(
  older: Message[],
  config: AppConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const provider = getProvider(config)
  if (!provider.complete) return null
  const prompt =
    'Summarize the following conversation so it can continue after the older messages are dropped:\n\n' +
    renderTranscript(older)
  try {
    const raw = await provider.complete([{ id: 'compact-summary', role: 'user', content: prompt }], {
      model: config.model,
      system: SUMMARY_SYSTEM,
      signal,
    })
    const s = raw.trim()
    return s || null
  } catch {
    return null
  }
}
