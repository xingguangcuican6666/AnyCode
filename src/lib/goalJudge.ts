// The goal "Stop hook": after each turn the goal drives, a model OUTSIDE the
// working session looks at the goal + a transcript and decides whether the
// agent should stop (goal genuinely done) or keep iterating (with a reason that
// becomes the next instruction). This is what makes a goal keep working instead
// of quitting the moment the model emits a first reply.
import type { AppConfig, Message } from '../types'
import { getProvider } from '../providers'

export interface GoalVerdict {
  decision: 'continue' | 'complete' | 'pause'
  reason: string
}

const JUDGE_SYSTEM =
  'You are a Stop hook — a reviewer OUTSIDE the working session. You are given a GOAL and a transcript of what the agent has done so far. ' +
  'Decide whether the agent should STOP (the goal is genuinely achieved) or CONTINUE (there is still work to do). ' +
  'Bias toward "continue" for genuinely partial work: a reply that only asks a question, acknowledges the task, or reports partial progress with more clearly left to do is NOT completion. ' +
  'But do NOT keep continuing once the thing the goal asked for exists. Choose "complete" when the deliverable is fully produced: for a code change, that the change is done and verified (build/tests pass where applicable); for a plan, document, analysis, answer, or review, that the finished artifact has been delivered. A complete plan is complete work — do not demand a build. ' +
  'CRITICAL: the transcript is an EXCERPT we trimmed for length. A passage cut off with a "[... trimmed ...]" marker means WE shortened it for you, NOT that the agent truncated its own output. Never conclude that the agent\'s output was cut off, incomplete, or truncated from what you see here, and never issue an instruction like "finish the truncated plan" or "re-output the rest" — assume the agent\'s actual output was complete unless the transcript shows it explicitly stopping mid-work. ' +
  'Respond with ONLY a JSON object and nothing else: {"decision":"continue"|"complete","reason":"<one sentence>"}. ' +
  'When continuing, the reason must be a concrete, actionable instruction for the next step that adds NEW work, never a request to redo or re-emit work already done.'

// Excerpt a message for the judge. When trimming, mark the cut EXPLICITLY so the
// judge can't mistake our shortening for the agent truncating its own output —
// that mistake produced a false "the plan was cut off, finish it" loop where the
// agent kept re-emitting a plan it had already delivered in full.
function excerpt(content: string, budget: number): string {
  if (content.length <= budget) return content
  const dropped = content.length - budget
  return `${content.slice(0, budget)}\n… [${dropped} chars trimmed by us for length — the agent's own output was complete, NOT truncated]`
}

function transcript(messages: Message[], limit = 14): string {
  const rel = messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool').slice(-limit)
  const last = rel.length - 1
  return rel
    .map((m, i) => {
      const who = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'AGENT' : 'TOOL'
      // Completion hinges on the latest output, so give the final message the most
      // room and recent ones more than old ones — a stingy budget made long, fully
      // finished outputs look truncated to the judge.
      const budget = i === last ? 8000 : i >= last - 3 ? 2500 : 700
      return `${who}: ${excerpt(m.content, budget)}`
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
    // The judge call itself failed — almost always because the SAME provider the
    // agent uses is down (expired login / HTTP 4xx-5xx). Returning 'continue' here
    // spun the goal forever ("Judge call failed; keep working" ×∞) while every
    // agent turn also 401'd. Pause instead and wait for the user to fix it.
    return { decision: 'pause', reason: '未能获得模型响应（判定调用失败），已暂停。' }
  }
}
