// The goal "Stop hook": after each turn the goal drives, a model OUTSIDE the
// working session looks at the goal + a transcript and decides whether the
// agent should stop (goal genuinely done) or keep iterating (with a reason that
// becomes the next instruction). This is what makes a goal keep working instead
// of quitting the moment the model emits a first reply.
import type { AppConfig, Message } from '../types'
import { getProvider } from '../providers'

export interface GoalVerdict {
  decision: 'continue' | 'complete'
  reason: string
}

const JUDGE_SYSTEM =
  'You are a Stop hook — a reviewer OUTSIDE the working session. You are given a GOAL and a transcript of what the agent has done so far. ' +
  'Decide whether the agent should STOP (the goal is genuinely and verifiably achieved) or CONTINUE (there is still work to do). ' +
  'Bias strongly toward "continue": a reply that only answers a question, restates or outlines a plan, acknowledges the task, or reports partial progress is NOT completion. ' +
  'Only choose "complete" when the goal is fully accomplished AND the result was verified (e.g. the build or tests pass). ' +
  'Respond with ONLY a JSON object and nothing else: {"decision":"continue"|"complete","reason":"<one sentence>"}. ' +
  'When continuing, the reason must be a concrete, actionable instruction for the next step.'

function transcript(messages: Message[], limit = 14): string {
  const rel = messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool').slice(-limit)
  return rel
    .map((m) => {
      const who = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'AGENT' : 'TOOL'
      return `${who}: ${m.content.slice(0, 800)}`
    })
    .join('\n\n')
}

export function parseVerdict(raw: string): GoalVerdict {
  try {
    const m = /\{[\s\S]*\}/.exec(raw)
    const obj = JSON.parse(m ? m[0] : raw) as Partial<GoalVerdict>
    const decision = obj.decision === 'complete' ? 'complete' : 'continue'
    const reason =
      typeof obj.reason === 'string' && obj.reason.trim()
        ? obj.reason.trim()
        : decision === 'complete'
          ? 'Goal satisfied.'
          : 'Keep working toward the goal.'
    return { decision, reason }
  } catch {
    // Unparseable → continue. Over-working is a milder failure than quitting
    // prematurely, which is exactly what this hook exists to prevent.
    return { decision: 'continue', reason: 'Continue working toward the goal.' }
  }
}

export async function judgeGoal(
  goal: string,
  runs: number,
  messages: Message[],
  config: AppConfig,
  signal?: AbortSignal,
): Promise<GoalVerdict> {
  const provider = getProvider(config)
  if (!provider.complete) return { decision: 'complete', reason: 'No judge model available; stopping.' }
  const prompt =
    `GOAL: ${goal}\nTURNS=${runs}\n\n` +
    `Transcript (most recent last):\n${transcript(messages)}\n\n` +
    'Should the agent stop or continue? Reply with the JSON object only.'
  try {
    const raw = await provider.complete([{ id: 'judge', role: 'user', content: prompt }], {
      model: config.model,
      system: JUDGE_SYSTEM,
      signal,
    })
    return parseVerdict(raw)
  } catch {
    return { decision: 'continue', reason: 'Judge call failed; keep working toward the goal.' }
  }
}
