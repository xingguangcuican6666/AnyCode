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
  'You are the compaction step of a coding-assistant CLI. A long session is about to exceed the context window, so the earlier messages will be dropped and REPLACED by your summary alone — anything you leave out is lost to the assistant permanently. ' +
  'Write dense, factual notes (not prose, no pleasantries, no praise), grouped under these headings and each only as long as it needs to be:\n' +
  '1. Task & intent — what the user is ultimately trying to accomplish and what they asked for most recently; quote wording that must be obeyed exactly.\n' +
  '2. Standing instructions & constraints — every directive about HOW to work that stays in force for the whole session (language to reply in, formatting rules, security/credential rules, commit/push policy, things never to do). Reproduce them verbatim; never soften or drop them.\n' +
  '3. Files, paths, symbols, commands & decisions — exact identifiers (file paths, function/variable names, flags, config keys, URLs, error text) and the design decisions already made. Never paraphrase an identifier.\n' +
  '4. Work done & outcome — what was changed, what worked, what failed, fixes applied, and whether builds/tests were run and their result. Do not claim anything is complete or verified unless the transcript shows it.\n' +
  '5. Current state & next steps — precisely where things stand and the concrete remaining actions, including any pending user request not yet fulfilled and anything awaiting the user’s confirmation.\n' +
  'Do not invent facts or fill gaps with assumptions. Output ONLY the summary text.'

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
// System prompt for the one-line session TITLE used by /resume and the peer
// mailbox. Deliberately much shorter and lighter than the compaction summary:
// this is a label, not a memory aid.
const TITLE_SYSTEM =
  'You write the one-line title for a coding-assistant session, shown in a session picker and to peer sessions. ' +
  'Read the transcript and answer with ONLY the title — a short phrase (ideally 4-10 words, under 60 characters) capturing what the USER is trying to accomplish. ' +
  'Name the project/feature concretely (e.g. "Fix login redirect loop", "Add dark mode toggle"), never generic ("Coding session", "Chat"). ' +
  'Never title the session after a slash command ("/resume", "/config"), a tool, or a system event — those are mechanics, not the task. ' +
  'No preamble or quotes.'

// Distill a session to a single title line via an independent model call.
// Resolves to the title text, or null when the provider can't summarize or the
// call fails (the caller then falls back to the first user message).
export async function summarizeTitle(
  messages: Message[],
  config: AppConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const provider = getProvider(config)
  if (!provider.complete) return null
  const prompt = 'Title this coding-assistant session:\n\n' + renderTranscript(messages, 800)
  try {
    const raw = await provider.complete([{ id: 'session-title', role: 'user', content: prompt }], {
      model: config.model,
      system: TITLE_SYSTEM,
      signal,
    })
    const s = raw.trim().replace(/^["']|["']$/g, '')
    return s || null
  } catch {
    return null
  }
}

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
