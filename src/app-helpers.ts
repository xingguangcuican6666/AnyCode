// Pure formatters + the small session-state types they describe, split out of
// app.tsx so the App component reads as UI wiring rather than string-building.
// The active-loop / active-goal status lines and the interval pretty-printer live
// here; SessionSnapshot stays in app.tsx (it's the CLI-facing session shape).
import type { LoopSpec } from './types'

export type ActiveLoop = LoopSpec & { runs: number }

export function formatInterval(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000}h`
  if (ms % 60000 === 0) return `${ms / 60000}m`
  return `${Math.round(ms / 1000)}s`
}

export function formatLoop(l: ActiveLoop): string {
  const cadence = l.intervalMs !== null ? `every ${formatInterval(l.intervalMs)}` : 'self-paced'
  return `Looping "${l.payload}" ${cadence} · ${l.runs} run${l.runs === 1 ? '' : 's'} done · /loop stop to cancel`
}

// A goal AnyCode autonomously works toward, like Claude Code's /goal. `startedAt`
// drives the live "◎ /goal active (Ns)" timer; `runs` counts turns spent on it.
// `paused` freezes the autonomous loop (esc, or a turn that got no model
// response) WITHOUT clearing the goal — the driver skips a paused goal and waits
// for the user; any submit (or /goal) resumes it.
export type ActiveGoal = { text: string; startedAt: number; runs: number; paused?: boolean }

export function formatGoal(g: ActiveGoal, elapsed: number, judging = false): string {
  if (g.paused) return `◎ /goal 已暂停 · ${g.text} · 输入任意内容或 /goal 继续`
  const tail = judging ? ' · evaluating whether to continue…' : ''
  return `◎ /goal active (${elapsed}s) · working toward: ${g.text}${tail} · /goal clear to stop`
}
