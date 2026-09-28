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
  abort: () => void      // cancel the run (aborts its own AbortController)
  promise: Promise<void> // settles when the run finishes (never rejects)
}

const tasks = new Map<string, BgTask>()
let seq = 0

/**
 * Register and start a background run. `run` performs the actual sub-agent work
 * (it may reject; the rejection is captured as the task's error). Returns the
 * handle id immediately — the caller does NOT await the work.
 */
export function startBackground(label: string, kind: string, run: (signal: AbortSignal) => Promise<{ text: string; error?: string }>): string {
  const id = `bg${++seq}`
  // Each background run gets its own AbortController so it can be cancelled
  // independently of the turn that started it (the idle esc-to-cancel path).
  const controller = new AbortController()
  const task: BgTask = { id, label, kind, status: 'running', startedAt: Date.now(), collected: false, abort: () => controller.abort(), promise: Promise.resolve() }
  task.promise = run(controller.signal).then(
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

/** The outcome of a bounded wait: the finished tasks that were collected, plus
 *  WHY the wait ended — all targets done, the turn was aborted, or the timeout
 *  elapsed with work still running. On abort NOTHING is collected and the
 *  registry is left intact; on timeout the already-finished targets ARE
 *  collected and the still-running ones are left for a later wait or the drain. */
export interface WaitOutcome {
  tasks: BgTask[]
  aborted: boolean
  timedOut: boolean
  pending: number // targets still running (not collected)
}

/**
 * Wait for specific handle ids (or, when none are given, every currently-known
 * task). Unknown ids are ignored. The wait ends on the FIRST of: all targets
 * finish, `signal` aborts, or `timeoutMs` elapses.
 *
 * `signal` keeps Esc/Ctrl-C responsive — an abort returns control immediately
 * (the background work has its OWN controller and keeps running). `timeoutMs`
 * bounds the wait so `agent_wait` can never hold the turn open forever: on
 * timeout we collect whatever FINISHED and report how many are still running,
 * so the model can decide to wait again, do other work, or stop and be woken.
 * On abort we collect nothing and leave the registry intact.
 */
export async function waitForBackground(ids?: string[], signal?: AbortSignal, timeoutMs?: number): Promise<WaitOutcome> {
  const targets = ids && ids.length
    ? ids.map((id) => tasks.get(id)).filter((t): t is BgTask => Boolean(t))
    : [...tasks.values()]
  const all = Promise.all(targets.map((t) => t.promise))
  let aborted = false
  let timedOut = false
  if (signal?.aborted) {
    aborted = true
  } else {
    const races: Array<Promise<'done' | 'aborted' | 'timeout'>> = [all.then(() => 'done' as const)]
    let onAbort: (() => void) | undefined
    if (signal) {
      races.push(new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted')
        signal.addEventListener('abort', onAbort!, { once: true })
      }))
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs != null && timeoutMs > 0) {
      races.push(new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) }))
    }
    const winner = await Promise.race(races)
    if (onAbort && signal) signal.removeEventListener('abort', onAbort)
    if (timer) clearTimeout(timer)
    aborted = winner === 'aborted'
    timedOut = winner === 'timeout'
  }
  // Abort: collect nothing, leave the registry intact (tasks run on under their
  // own controllers, to be drained later).
  if (aborted) return { tasks: [], aborted: true, timedOut: false, pending: targets.filter((t) => t.status === 'running').length }
  // Done OR timeout: collect the finished targets, leave the still-running ones.
  const out: BgTask[] = []
  let pending = 0
  for (const t of targets) {
    if (t.status === 'running') { pending++; continue }
    if (!t.collected) { t.collected = true; out.push(t) }
    tasks.delete(t.id)
  }
  return { tasks: out, aborted: false, timedOut, pending }
}

/** Await the earliest still-running task to settle (drives the turn-end drain). */
export async function settleNextBackground(): Promise<void> {
  const running = [...tasks.values()].filter((t) => t.status === 'running').map((t) => t.promise)
  if (running.length === 0) return
  await Promise.race(running)
}

/**
 * Abort background tasks — the given handle ids, or ALL running tasks when none
 * are given. Each aborted run's AbortController fires, so its sub-agent(s) stop
 * at the next await and the task settles as done/error. Drives the idle
 * esc-to-cancel path (see useChat.interrupt); pair with clearBackground to drop
 * the settled tasks without feeding their results back.
 */
export function abortBackground(ids?: string[]): void {
  const targets = ids && ids.length
    ? ids.map((id) => tasks.get(id)).filter((t): t is BgTask => Boolean(t))
    : [...tasks.values()]
  for (const t of targets) if (t.status === 'running') t.abort()
}

/** Drop all tasks (e.g. a brand-new session via /clear). */
export function clearBackground(): void {
  tasks.clear()
}
