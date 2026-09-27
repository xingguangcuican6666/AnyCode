// Cross-turn background task registry. The orchestration tools (`task`,
// `workflow`) can run in the background (`background: true`): instead of the
// agent loop awaiting the sub-agents inline, the work is registered here and a
// handle id is returned immediately, so the main agent keeps its turn free.
//
// The registry is a module-level singleton so tasks OUTLIVE the turn (and even a
// resize/compact remount of the App) that started them. Two consumers read it:
//   • the `agent_status` / `agent_wait` tools, when the model explicitly checks
//     on or collects background work mid-turn;
//   • useChat's turn-end wake-up, which — when the main agent ends its turn with
//     background work still pending — waits for the next batch to finish and
//     feeds the results back as a fresh turn, so the agent resumes instead of
//     stopping dead (fixes "main stops after a sub-agent completes").
// `collected` guards against double-feeding: whoever consumes a finished task
// marks it collected and drops it, so the other consumer won't re-report it.

export type BgStatus = 'running' | 'done' | 'error'

export interface BgTask {
  id: string
  label: string
  kind: string          // 'task' | 'workflow' (for the status listing)
  status: BgStatus
  result?: string       // the sub-agent(s)' final prose, once done
  error?: string        // set when the run failed
  startedAt: number
  endedAt?: number
  collected: boolean     // taken by agent_wait or the wake-up drain
  promise: Promise<void> // settles when the run finishes (never rejects)
}

const tasks = new Map<string, BgTask>()
let seq = 0

/**
 * Register and start a background run. `run` performs the actual sub-agent work
 * (it may reject; the rejection is captured as the task's error). Returns the
 * handle id immediately — the caller does NOT await the work.
 */
export function startBackground(label: string, kind: string, run: () => Promise<{ text: string; error?: string }>): string {
  const id = `bg${++seq}`
  const task: BgTask = { id, label, kind, status: 'running', startedAt: Date.now(), collected: false, promise: Promise.resolve() }
  task.promise = run().then(
    (r) => { task.status = r.error ? 'error' : 'done'; task.result = r.text; task.error = r.error; task.endedAt = Date.now() },
    (e) => { task.status = 'error'; task.error = (e as Error)?.message ?? String(e); task.endedAt = Date.now() },
  )
  tasks.set(id, task)
  return id
}

/** All known background tasks (running + finished-but-uncollected), for a status listing. */
export function listBackground(): BgTask[] {
  return [...tasks.values()]
}

/** Whether anything still needs attention: a running task, or a finished one not yet collected. */
export function hasPendingBackground(): boolean {
  for (const t of tasks.values()) {
    if (t.status === 'running' || !t.collected) return true
  }
  return false
}

/**
 * Return finished-but-uncollected tasks, marking them collected and removing
 * them from the registry so they're reported exactly once. Does not block.
 */
export function takeCompleted(): BgTask[] {
  const done: BgTask[] = []
  for (const t of [...tasks.values()]) {
    if (t.status !== 'running' && !t.collected) {
      t.collected = true
      tasks.delete(t.id)
      done.push(t)
    }
  }
  return done
}

/**
 * Await specific handle ids (or, when none are given, every currently-known
 * task) to finish, then return + collect them. Unknown ids are ignored.
 */
export async function waitForBackground(ids?: string[]): Promise<BgTask[]> {
  const targets = ids && ids.length
    ? ids.map((id) => tasks.get(id)).filter((t): t is BgTask => Boolean(t))
    : [...tasks.values()]
  await Promise.all(targets.map((t) => t.promise))
  const out: BgTask[] = []
  for (const t of targets) {
    if (!t.collected) { t.collected = true; out.push(t) }
    tasks.delete(t.id)
  }
  return out
}

/** Await the earliest still-running task to settle (drives the turn-end drain). */
export async function settleNextBackground(): Promise<void> {
  const running = [...tasks.values()].filter((t) => t.status === 'running').map((t) => t.promise)
  if (running.length === 0) return
  await Promise.race(running)
}

/** Drop all tasks (e.g. a brand-new session via /clear). */
export function clearBackground(): void {
  tasks.clear()
}
