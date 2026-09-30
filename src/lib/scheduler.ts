// Session-scoped, agent-facing scheduler — the model's own timer. The `schedule`
// tool registers jobs here; each fires by enqueuing its `payload` as a fresh turn
// (via the sink the app wires to setQueued), so a one-shot reminder or a recurring
// prompt runs on its own without the user asking. This is MeowCode's answer to
// Claude Code's CronCreate/CronDelete/CronList — but time-based rather than cron,
// since MeowCode drives turns from an idle loop, not a wall-clock cron daemon.
//
// A module-level singleton so jobs OUTLIVE the turn (and an App remount): the app
// re-registers its sink on mount. In-memory only — nothing is persisted, so all
// jobs vanish when the process exits (matching Claude Code's session-only cron).

export type SchedKind = 'once' | 'interval'

export interface SchedJob {
  id: string
  kind: SchedKind
  payload: string        // the prompt enqueued as a turn when the job fires
  label: string
  intervalMs?: number    // set for 'interval'; the gap between fires
  nextAt: number         // epoch ms of the next (or only) fire
  fires: number          // how many times it has fired so far
  createdAt: number
}

// The app registers a sink that enqueues the payload as a turn. `meta` lets the
// sink annotate the transcript (which job, one-shot vs recurring).
type Sink = (payload: string, meta: { jobId: string; label: string; kind: SchedKind; fires: number }) => void

let sink: Sink | null = null
const jobs = new Map<string, SchedJob>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let seq = 0

// Guard rails so a runaway `every 1s` job can't wedge the session.
const MIN_INTERVAL_MS = 5_000
const MAX_JOBS = 32

export function setScheduleSink(fn: Sink | null): void { sink = fn }

function arm(job: SchedJob): void {
  const delay = Math.max(0, job.nextAt - Date.now())
  const timer = setTimeout(() => {
    const j = jobs.get(job.id)
    if (!j) return
    j.fires += 1
    try { sink?.(j.payload, { jobId: j.id, label: j.label, kind: j.kind, fires: j.fires }) } catch { /* sink errors never kill the timer */ }
    if (j.kind === 'interval' && j.intervalMs) {
      j.nextAt = Date.now() + j.intervalMs
      arm(j)
    } else {
      jobs.delete(j.id)
      timers.delete(j.id)
    }
  }, delay)
  timers.set(job.id, timer)
}

export interface ScheduleOutcome { job?: SchedJob; error?: string }

export function scheduleOnce(payload: string, delayMs: number, label?: string): ScheduleOutcome {
  if (jobs.size >= MAX_JOBS) return { error: `too many scheduled jobs (max ${MAX_JOBS}); cancel some first` }
  const id = `job${++seq}`
  const job: SchedJob = { id, kind: 'once', payload, label: label || payload.slice(0, 40), nextAt: Date.now() + Math.max(0, delayMs), fires: 0, createdAt: Date.now() }
  jobs.set(id, job)
  arm(job)
  return { job }
}

export function scheduleInterval(payload: string, intervalMs: number, label?: string): ScheduleOutcome {
  if (jobs.size >= MAX_JOBS) return { error: `too many scheduled jobs (max ${MAX_JOBS}); cancel some first` }
  const ms = Math.max(MIN_INTERVAL_MS, intervalMs)
  const id = `job${++seq}`
  const job: SchedJob = { id, kind: 'interval', payload, label: label || payload.slice(0, 40), intervalMs: ms, nextAt: Date.now() + ms, fires: 0, createdAt: Date.now() }
  jobs.set(id, job)
  arm(job)
  return { job }
}

export function listJobs(): SchedJob[] {
  return [...jobs.values()].sort((a, b) => a.nextAt - b.nextAt)
}

export function cancelJob(id: string): boolean {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  return jobs.delete(id)
}

/** Drop every job and its timer (e.g. a brand-new session via /clear). */
export function clearJobs(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  jobs.clear()
}
