// Pure, stateless helpers for the chat hook (useChat): the agent base prompt,
// the banner sentinel, per-turn footer formatting, tool-result rendering, and the
// background wake-up text. Kept out of useChat so the hook reads as turn
// orchestration and a fresh sub-agent needn't re-read the whole hook to touch a
// display detail.
import type { Message } from '../types'
import { getLang } from '../lib/i18n'
import type { BgTask } from '../lib/background'

export const BANNER: Message = { id: 'banner', role: 'system', content: '__banner__' }

// Base instructions so a real model behaves like a coding agent: lean on the
// tools, and actually finish (verify) rather than narrate a plan and stop.
export const AGENT_SYSTEM =
  'You are MeowCode, a coding agent working in the user\'s project directory. ' +
  'Use the provided tools (bash, read_file, write_file, edit_file, grep, glob, list_dir) to inspect and change the project yourself instead of only describing what to do. ' +
  'For a self-contained sub-task, delegate it with the `task` tool (a fresh sub-agent with the same file/search/shell tools); to fan several independent sub-tasks out in parallel, use the `workflow` tool; for a non-trivial or multi-file change, first use the `plan` tool to have a read-only sub-agent produce a concrete step-by-step implementation plan, then follow it. ' +
  'These orchestration tools (`task`/`plan`/`workflow`) run in the BACKGROUND by default: they return a handle id immediately instead of blocking. After you dispatch background work, YOU choose what to do next — all three are valid: ' +
  '(1) end your turn and go idle — if background work is still running, the system waits for it and feeds the results back as a fresh turn so you resume automatically; ' +
  '(2) call `agent_wait` WITH a timeout to wait for a bounded time and collect whatever has finished — it never blocks indefinitely, so if it times out with work still running you simply decide again (wait more, do other work, or stop and be woken); ' +
  '(3) keep doing other useful work in the meantime (more reads/edits, or dispatching further tasks), checking progress with `agent_status`. ' +
  'Never stall or spin waiting on a sub-agent, and never assume you MUST end your turn either — pick whichever of the three fits. Pass `background: false` only when you want a tool to block and hand back its result inline in that one call. ' +
  'Keep going until the request is genuinely done — read what you need, make the edits, and verify with a build or tests before you stop. ' +
  'Do not stop after merely acknowledging or outlining a plan.'

// Per-turn completion footer helpers: elapsed as "10m 10s" / "9s" (zh: "10分10秒"
// / "9秒"), finish time as a 12-hour "h:mm" clock (matches Claude Code's line).
export function fmtDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  const zh = getLang() === 'zh'
  const m = Math.floor(s / 60)
  if (s < 60) return zh ? `${s}秒` : `${s}s`
  return zh ? `${m}分${s % 60}秒` : `${m}m ${s % 60}s`
}
export function fmtClock(d: Date, fmt24: boolean): string {
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (fmt24) return `${String(d.getHours()).padStart(2, '0')}:${mm}`
  const h = d.getHours() % 12 || 12
  const ampm = d.getHours() < 12 ? 'am' : 'pm'
  return `${h}:${mm}${ampm}`
}

// Render a tool result as an indented, dimmed block, truncated for the transcript.
export function formatToolResult(content: string, isError?: boolean): string {
  const lines = content.split('\n')
  const shown = lines.slice(0, 12)
  const more = lines.length - shown.length
  const body = shown.join('\n') + (more > 0 ? `\n… (+${more} more lines)` : '')
  const mark = isError ? '⎿ ⚠️ ' : '⎿ '
  return mark + body.split('\n').join('\n   ')
}

// Render a batch of finished background tasks (see lib/background) as the text of
// a synthetic user turn. Fed back to the model when the main agent ended its turn
// with background work still pending, so it resumes instead of stopping.
export function renderWakeup(tasks: BgTask[]): string {
  const parts = tasks.map((t) =>
    `### ${t.label} (${t.id}) — ${t.status}${t.error ? ` · error: ${t.error}` : ''}\n${t.result || '(no output)'}`)
  const noun = tasks.length === 1 ? 'A background task' : `${tasks.length} background tasks`
  return `[System] ${noun} you started ${tasks.length === 1 ? 'has' : 'have'} finished. Review the result${tasks.length === 1 ? '' : 's'} below and continue the original task — do not stop until it is genuinely done.\n\n${parts.join('\n\n')}`
}
