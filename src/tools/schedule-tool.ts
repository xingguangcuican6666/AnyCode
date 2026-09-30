// The `schedule` tool — the model's own timer, backed by lib/scheduler. It lets
// the agent set a one-shot reminder ("in 10 minutes, re-check the build") or a
// recurring prompt ("every 5 minutes, poll the deploy"): when a job fires, its
// prompt is enqueued as a fresh turn by the sink the app registers, so the work
// resumes without the user asking. Session-scoped and in-memory — jobs die with
// the process. This mirrors Claude Code's CronCreate/CronDelete/CronList, but
// keyed on elapsed time rather than wall-clock cron, since MeowCode drives turns
// from an idle loop instead of a cron daemon.
import type { ToolDef, ToolResult } from './types'
import { scheduleOnce, scheduleInterval, listJobs, cancelJob, type SchedJob } from '../lib/scheduler'

function fmtDelay(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`
}

function describe(j: SchedJob): string {
  const when = j.kind === 'interval' ? `every ${fmtDelay(j.intervalMs ?? 0)}` : `in ${fmtDelay(j.nextAt - Date.now())}`
  return `${j.id} · ${when} · ${j.label}${j.fires ? ` (fired ${j.fires}×)` : ''}`
}

export const scheduleTool: ToolDef = {
  name: 'schedule',
  description:
    'Schedule your OWN future turns — a session timer, not a promise to the user. ' +
    'action "create": arm a job that, when it fires, injects `prompt` as a brand-new turn so you resume that work automatically. ' +
    'Give EITHER `delay_seconds` (a one-shot reminder, e.g. re-check a build in 600s) OR `every_seconds` (a recurring prompt, e.g. poll a deploy every 300s; minimum 5s). ' +
    'action "list": show pending jobs. action "cancel": remove a job by `id`. ' +
    'Jobs are session-scoped and vanish when the process exits. Use this for genuine deferred/repeating work, not to pester the user.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'cancel'], description: 'create a job, list pending jobs, or cancel one.' },
      prompt: { type: 'string', description: 'For "create": the turn text enqueued when the job fires (write it as an instruction to yourself).' },
      delay_seconds: { type: 'number', description: 'For "create": fire ONCE after this many seconds.' },
      every_seconds: { type: 'number', description: 'For "create": fire repeatedly every this many seconds (min 5). Mutually exclusive with delay_seconds.' },
      label: { type: 'string', description: 'For "create": optional short label shown in listings.' },
      id: { type: 'string', description: 'For "cancel": the job id (from create/list).' },
    },
    required: ['action'],
  },
  async run(input): Promise<ToolResult> {
    const action = String(input.action ?? '')
    if (action === 'list') {
      const jobs = listJobs()
      if (jobs.length === 0) return { content: 'No scheduled jobs.', display: 'schedule · none' }
      const view = jobs.map(describe).join('\n')
      return { content: `Scheduled jobs:\n${view}`, display: view }
    }
    if (action === 'cancel') {
      const id = String(input.id ?? '')
      if (!id) return { content: 'schedule cancel: `id` is required', isError: true }
      const ok = cancelJob(id)
      return ok ? { content: `Cancelled ${id}.`, display: `schedule · cancelled ${id}` } : { content: `No such job: ${id}`, isError: true }
    }
    if (action === 'create') {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (!prompt) return { content: 'schedule create: `prompt` is required', isError: true }
      const label = typeof input.label === 'string' ? input.label.trim() : undefined
      const hasDelay = typeof input.delay_seconds === 'number' && isFinite(input.delay_seconds)
      const hasEvery = typeof input.every_seconds === 'number' && isFinite(input.every_seconds)
      if (hasDelay && hasEvery) return { content: 'schedule create: pass EITHER delay_seconds OR every_seconds, not both', isError: true }
      if (!hasDelay && !hasEvery) return { content: 'schedule create: pass delay_seconds (one-shot) or every_seconds (recurring)', isError: true }
      const outcome = hasEvery
        ? scheduleInterval(prompt, Math.round((input.every_seconds as number) * 1000), label)
        : scheduleOnce(prompt, Math.round((input.delay_seconds as number) * 1000), label)
      if (outcome.error || !outcome.job) return { content: `schedule create: ${outcome.error ?? 'failed'}`, isError: true }
      const d = describe(outcome.job)
      return { content: `Scheduled ${d}. It will inject its prompt as a new turn when it fires.`, display: `schedule · ${d}` }
    }
    return { content: `schedule: unknown action "${action}" (use create | list | cancel)`, isError: true }
  },
}
