// Orchestration tools: single sub-agents (`task`, `plan`) and parallel fan-out
// (`workflow`), plus the background check/collect tools (`agent_status`,
// `agent_wait`). All delegate through ctx.spawnAgent, which the agent loop
// supplies only at the top level, so a sub-agent can't recurse into more
// sub-agents. task/plan/workflow run in the BACKGROUND by default (see lib/background).
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SpawnResult, ToolContext, ToolDef } from './types'
import type { AgentEvent, AgentSnapshot, WorkflowAgent } from '../types'
import { startBackground, listBackground, waitForBackground } from '../lib/background'
import { clip } from './util'

// Named sub-agent roles → a system-prompt hint. Kept small; the concrete
// toolset a sub-agent gets is decided by the agent loop, not here.
const SUBAGENT_ROLES: Record<string, string> = {
  general: 'You are a focused sub-agent. Complete the assigned task end-to-end using your tools, then report the result concisely.',
  explore: 'You are a read-only exploration sub-agent. Investigate the codebase with read_file/grep/glob/list_dir (do not modify files) and report precise findings with file:line references.',
  code: 'You are an implementation sub-agent. Make the requested code changes, then verify them with a build or tests before reporting what you did.',
  plan: 'You are a planning sub-agent. Investigate the codebase READ-ONLY (read_file/grep/glob/list_dir; do NOT modify files or run mutating commands) and produce a concrete, step-by-step implementation plan: the approach, the exact files to change, the key risks, and a short ordered checklist. Do not implement anything — only return the plan.',
}

// Cap how many sub-tasks a single `workflow` call fans out, and how many run at
// once — a backstop against runaway spawning and API stampedes.
const WORKFLOW_MAX_TASKS = 8
const WORKFLOW_CONCURRENCY = 4
// `agent_wait` always waits for a BOUNDED time so the model can never spin
// forever holding the turn open: it must pass a timeout, and we cap it here.
const WAIT_TIMEOUT_CAP = 120

async function runBatched<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  // Called before each item is picked up; awaiting it (while paused) is how the
  // workflow's `p` control holds back new sub-agents without killing the batch.
  gate?: () => Promise<void>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (gate) await gate()
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
// Render a workflow run as a Markdown report (what `s` in the expanded view
// saves). `texts[i]` is a sub-agent's final prose, present once it has returned.
export function renderWorkflowReport(title: string, agents: WorkflowAgent[], texts: Array<string | undefined> = []): string {
  const glyph = (s: WorkflowAgent['state']): string => (s === 'done' ? '✓' : s === 'running' ? '▶' : s === 'error' ? '✗' : '⋯')
  const when = new Date().toISOString()
  const rows = agents.map((a, i) => {
    const secs = a.elapsedMs != null ? ` · ${Math.max(1, Math.round(a.elapsedMs / 1000))}s` : ''
    const calls = a.state === 'done' ? ` · ${a.steps} tool call${a.steps === 1 ? '' : 's'}` : ''
    const err = a.error ? ` · error: ${a.error}` : ''
    const body = texts[i]?.trim() ? `\n\n${texts[i]!.trim()}` : ''
    return `## ${glyph(a.state)} ${i + 1}. ${a.label}\n${a.state}${secs}${calls}${err}${body}`
  })
  return `# ${title}\n\n_generated ${when}_\n\n${rows.join('\n\n')}\n`
}

// Appended to every sub-agent's system prompt. Sub-agents that only make tool
// calls and then stop leave the orchestrator with an empty result ("(no output)"
// in the report) — this forces them to finish with prose, which IS their result.
const REPORT_RULE =
  ' Your FINAL message is captured verbatim as your result and shown to the orchestrator, so it MUST be a self-contained written report — a short paragraph with the concrete findings or changes (file:line references, conclusions, remaining risks). NEVER stop after only tool calls: a run whose last message is a tool call, or is empty, produces no usable result. Once your tools have gathered what you need, write the summary instead of poking around further.'

function spawnHint(kind: unknown): string | undefined {
  const key = String(kind ?? 'general').toLowerCase()
  return (SUBAGENT_ROLES[key] ?? SUBAGENT_ROLES.general) + REPORT_RULE
}

interface BatchTask { prompt: string; label: string; type?: unknown }

// Shared engine behind `task`, `plan`, and `workflow`: run a batch of sub-agents
// through ctx.spawnAgent while pushing live snapshots to the UI (ctx.onWorkflow)
// on every queued→running→done/error transition. This is what gives a single
// `task`/`plan` the SAME collapsed line + expandable tree + save/pause controls
// as a parallel `workflow` — the UI keys purely off the snapshot, so a 1-agent
// batch is just a workflow of size one. `p` pause holds back not-yet-started
// sub-agents (a running one can't be interrupted mid-await); `s` saves a report.
async function runAgentBatch(
  ctx: ToolContext,
  tasks: BatchTask[],
  opts: { title: string; idPrefix: string; concurrency: number },
  // Governs abort for THIS batch: a background run passes its own signal so it
  // cancels independently of the turn; foreground falls back to the turn's signal.
  signal?: AbortSignal,
): Promise<Array<SpawnResult & { label: string }>> {
  const spawn = ctx.spawnAgent!
  const sig = signal ?? ctx.signal
  const wfId = `${opts.idPrefix}-${Date.now().toString(36)}`
  const title = opts.title
  const agents: WorkflowAgent[] = tasks.map((t, i) => ({ label: t.label || `task ${i + 1}`, state: 'queued', steps: 0 }))
  const texts: Array<string | undefined> = new Array(tasks.length)
  let paused = false
  let waiters: Array<() => void> = []
  const wake = (): void => { const w = waiters; waiters = []; w.forEach((fn) => fn()) }
  ctx.signal?.addEventListener('abort', wake, { once: true })
  sig?.addEventListener('abort', wake, { once: true })
  const gate = async (): Promise<void> => { while (paused && !sig?.aborted) await new Promise<void>((res) => waiters.push(res)) }
  const controls = {
    pause: (): void => { if (!paused) { paused = true; emit() } },
    resume: (): void => { if (paused) { paused = false; wake(); emit() } },
    save: async (): Promise<string> => {
      const file = path.join(ctx.cwd, '.anycode', 'workflows', `${wfId}.md`)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, renderWorkflowReport(title, agents, texts), 'utf8')
      return file
    },
  }
  const emit = (done = false): void => {
    ctx.onWorkflow?.({ id: wfId, title, agents: agents.map((a) => ({ ...a })), done, paused, controls })
  }
  emit() // initial: all queued
  const results = await runBatched(tasks, opts.concurrency, async (t, i) => {
    const label = agents[i].label
    agents[i].state = 'running'
    agents[i].startedAt = Date.now()
    emit()
    try {
      const r = await spawn({ prompt: t.prompt, system: spawnHint(t.type), label, signal: sig })
      texts[i] = r.text
      agents[i] = { ...agents[i], state: 'done', steps: r.steps, elapsedMs: Date.now() - (agents[i].startedAt ?? Date.now()), error: r.error }
      if (r.error) agents[i].state = 'error'
      emit()
      return { label, ...r }
    } catch (e) {
      const msg = (e as Error).message
      agents[i] = { ...agents[i], state: 'error', elapsedMs: Date.now() - (agents[i].startedAt ?? Date.now()), error: msg }
      emit()
      return { label, text: '', steps: 0, error: msg } as SpawnResult & { label: string }
    }
  }, gate)
  emit(true) // final snapshot
  return results
}
// Run ONE sub-agent (`task`/`plan`) as a SWITCHABLE transcript view. Unlike a
// `workflow` (a collapsed line + an expandable progress tree), a switchable agent
// streams its OWN events, which we accumulate and push to the UI via ctx.onAgent
// so the user can pick it in the bottom switcher (○ main / ● <type> <activity>)
// and swap the main viewport to its chat. The sub-agent's transcript IS the view;
// there is no tree. Returns the final SpawnResult for the tool's inline report.
async function runSwitchableAgent(
  ctx: ToolContext,
  task: { prompt: string; label: string; type?: unknown },
  idPrefix: string,
  // A background run passes its own signal so it cancels independently of the turn.
  signal?: AbortSignal,
): Promise<SpawnResult> {
  const spawn = ctx.spawnAgent!
  const id = `${idPrefix}-${Date.now().toString(36)}`
  const type = String(task.type ?? 'general')
  const startedAt = Date.now()
  const events: AgentEvent[] = []
  let steps = 0
  let activity = 'starting'
  const emit = (state: AgentSnapshot['state'], done = false, error?: string): void => {
    ctx.onAgent?.({
      id, type, label: task.label, activity, state,
      events: events.slice(), steps, startedAt,
      elapsedMs: done ? Date.now() - startedAt : undefined,
      error, done,
    })
  }
  emit('running')
  const r = await spawn({
    prompt: task.prompt,
    system: spawnHint(task.type),
    label: task.label,
    signal: signal ?? ctx.signal,
    // Each sub-agent event feeds the live transcript + the switcher's activity word.
    onEvent: (ev) => {
      events.push(ev)
      if (ev.type === 'tool_use') { steps++; activity = ev.name }
      else if (ev.type === 'text' && activity === 'starting') activity = 'responding'
      else if (ev.type === 'error') activity = 'error'
      emit('running')
    },
  })
  activity = r.error ? 'error' : 'done'
  emit(r.error ? 'error' : 'done', true, r.error)
  return r
}

const task: ToolDef = {
  name: 'task',
  description:
    'Delegate a self-contained sub-task to a fresh sub-agent that has the same file/search/shell tools and its own context. ' +
    'Use for focused work you want handled independently (deep research, a scoped edit, a broad search). Sub-agents cannot spawn further sub-agents. ' +
    'Runs in the BACKGROUND by default (non-blocking): you get a handle id immediately, so you are free to end your turn (the system feeds finished work back and wakes you to continue), keep doing other work, or call `agent_wait` when you actually need the result. Pass `background: false` only to block and get the sub-agent\'s report inline in this call.',
  orchestration: true,
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-6 word) label for the sub-task.' },
      prompt: { type: 'string', description: 'The full, self-contained instructions for the sub-agent.' },
      subagent_type: { type: 'string', enum: Object.keys(SUBAGENT_ROLES), description: 'Sub-agent role (default: general).' },
      background: { type: 'boolean', description: 'Default true (background/non-blocking): returns a handle id immediately. Set false to block and return the report inline.' },
    },
    required: ['prompt'],
  },
  async run(input, ctx) {
    if (!ctx.spawnAgent) return { content: 'sub-agents are not available here (nested sub-agents are not allowed).', isError: true }
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return { content: 'task requires a `prompt`.', isError: true }
    const label = String(input.description ?? 'task').trim() || 'task'
    // Non-blocking by default: register the run and return a handle immediately.
    // The work keeps going after this turn; the main agent stays free to stop
    // (turn-end wake-up feeds it back), do other work, or agent_wait to collect.
    if (input.background !== false && ctx.allowBackground) {
      const id = startBackground(label, 'task', (signal) =>
        runSwitchableAgent(ctx, { prompt, label, type: input.subagent_type }, 'task', signal)
          .then((r) => ({ text: `▸ sub-agent "${label}" · ${r.steps} tool call${r.steps === 1 ? '' : 's'}${r.error ? ` · error: ${r.error}` : ''}\n\n${r.text || '(no output)'}`, error: r.error })))
      return { content: `▸ 后台子代理已启动 "${label}" · 句柄 ${id}。你可以结束本轮（完成后系统自动喂回并唤醒你继续）、继续做别的事，或用 agent_wait 主动收集结果。`, display: `▸ 后台子代理已启动 "${label}"` }
    }
    // A `task` is a single switchable sub-agent: it streams its own transcript
    // through ctx.onAgent so the user can switch the viewport to it (distinct
    // from `workflow`, which shows a progress tree).
    const r = await runSwitchableAgent(ctx, { prompt, label, type: input.subagent_type }, 'task')
    const head = `▸ sub-agent "${label}" · ${r.steps} tool call${r.steps === 1 ? '' : 's'}${r.error ? ` · error: ${r.error}` : ''}`
    return { content: clip(`${head}\n\n${r.text || '(no output)'}`), isError: Boolean(r.error) && !r.text }
  },
}
const plan: ToolDef = {
  name: 'plan',
  description:
    'Think through an approach BEFORE implementing: spawn a read-only planning sub-agent that investigates the code and returns a concrete, step-by-step implementation plan (approach, files to change, risks, ordered checklist). ' +
    'Use this proactively for any non-trivial or multi-file task so you commit to a plan before editing anything. It changes nothing on disk. Sub-agents cannot spawn further sub-agents. ' +
    'Runs in the BACKGROUND by default (non-blocking): you get a handle id immediately and can keep working or end your turn (the system feeds the plan back and wakes you); or call `agent_wait` to collect it. Pass `background: false` to block and get the plan inline in this call.',
  orchestration: true,
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-6 word) label for what is being planned.' },
      prompt: { type: 'string', description: 'What to plan — the task/goal to produce an implementation plan for, with any relevant context.' },
      background: { type: 'boolean', description: 'Default true (background/non-blocking): returns a handle id immediately. Set false to block and return the plan inline.' },
    },
    required: ['prompt'],
  },
  async run(input, ctx) {
    if (!ctx.spawnAgent) return { content: 'the planning sub-agent is not available here (nested sub-agents are not allowed).', isError: true }
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return { content: 'plan requires a `prompt` describing what to plan.', isError: true }
    const label = String(input.description ?? 'plan').trim() || 'plan'
    // Non-blocking by default, like `task`: the plan is produced in the
    // background and fed back when ready (or collected via agent_wait).
    if (input.background !== false && ctx.allowBackground) {
      const id = startBackground(label, 'plan', (signal) =>
        runSwitchableAgent(ctx, { prompt, label, type: 'plan' }, 'plan', signal)
          .then((r) => ({ text: `▸ plan "${label}" · ${r.steps} tool call${r.steps === 1 ? '' : 's'}${r.error ? ` · error: ${r.error}` : ''}\n\n${r.text || '(no plan produced)'}`, error: r.error })))
      return { content: `▸ 后台规划子代理已启动 "${label}" · 句柄 ${id}。你可以结束本轮（完成后系统自动喂回并唤醒你继续）、继续做别的事，或用 agent_wait 主动收集计划。`, display: `▸ 后台规划子代理已启动 "${label}"` }
    }
    const r = await runSwitchableAgent(ctx, { prompt, label, type: 'plan' }, 'plan')
    const head = `▸ plan "${label}" · ${r.steps} tool call${r.steps === 1 ? '' : 's'}${r.error ? ` · error: ${r.error}` : ''}`
    return { content: clip(`${head}\n\n${r.text || '(no plan produced)'}`), isError: Boolean(r.error) && !r.text }
  },
}
const workflow: ToolDef = {
  name: 'workflow',
  description:
    'Run several independent sub-tasks in parallel across sub-agents and collect their reports. ' +
    'Use for fan-out work where the sub-tasks do not depend on each other (review N files, research N angles, migrate N sites). ' +
    `At most ${WORKFLOW_MAX_TASKS} tasks per call; up to ${WORKFLOW_CONCURRENCY} run at once. ` +
    'Runs in the BACKGROUND by default (non-blocking): you get a handle id immediately, so you can end your turn (the system feeds the reports back and wakes you), keep working, or call `agent_wait` to collect them. Pass `background: false` to block and get the collected reports inline in this call.',
  orchestration: true,
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'The independent sub-tasks to run in parallel.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A short label for this sub-task.' },
            prompt: { type: 'string', description: 'Self-contained instructions for this sub-agent.' },
            subagent_type: { type: 'string', enum: Object.keys(SUBAGENT_ROLES), description: 'Sub-agent role (default: general).' },
          },
          required: ['prompt'],
        },
      },
      background: { type: 'boolean', description: 'Default true (background/non-blocking): returns a handle id immediately. Set false to block and return the collected reports inline.' },
    },
    required: ['tasks'],
  },
  async run(input, ctx) {
    if (!ctx.spawnAgent) return { content: 'sub-agents are not available here (nested workflows are not allowed).', isError: true }
    const raw = Array.isArray(input.tasks) ? (input.tasks as Array<Record<string, unknown>>) : []
    const tasks = raw
      .map((t) => ({ prompt: String(t?.prompt ?? '').trim(), label: String(t?.label ?? '').trim(), type: t?.subagent_type }))
      .filter((t) => t.prompt)
    if (tasks.length === 0) return { content: 'workflow requires a non-empty `tasks` array, each with a `prompt`.', isError: true }
    const capped = tasks.slice(0, WORKFLOW_MAX_TASKS)
    const dropped = tasks.length - capped.length
    const runBatch = (signal?: AbortSignal): Promise<string> => runAgentBatch(ctx, capped, {
      title: `workflow · ${capped.length} sub-agent${capped.length === 1 ? '' : 's'}`,
      idPrefix: 'wf', concurrency: WORKFLOW_CONCURRENCY,
    }, signal).then((results) => {
      const totalSteps = results.reduce((n, r) => n + r.steps, 0)
      const errored = results.filter((r) => r.error).length
      const body = results
        .map((r, i) => `### ${r.error ? '✗' : '✓'} ${i + 1}. ${r.label}${r.error ? ` — error: ${r.error}` : ''}\n${r.text || '(no output)'}`)
        .join('\n\n')
      const header = `▸ workflow · ${capped.length} sub-agent${capped.length === 1 ? '' : 's'} · ${totalSteps} tool calls${errored > 0 ? ` · ✗ ${errored} failed` : ''}${dropped > 0 ? ` · ${dropped} extra task(s) dropped (max ${WORKFLOW_MAX_TASKS})` : ''}`
      return clip(`${header}\n\n${body}`)
    })
    // Non-blocking by default: register the fan-out and return a handle immediately.
    if (input.background !== false && ctx.allowBackground) {
      const id = startBackground(`workflow · ${capped.length}`, 'workflow', async (signal) => ({ text: await runBatch(signal) }))
      return { content: `▸ 后台工作流已启动 · ${capped.length} 个子代理 · 句柄 ${id}。你可以结束本轮（完成后系统自动喂回并唤醒你继续）、继续做别的事，或用 agent_wait 主动收集报告。`, display: `▸ 后台工作流已启动 · ${capped.length} 个子代理` }
    }
    // Same live-snapshot engine as `task`/`plan`, just fanned out: up to
    // WORKFLOW_CONCURRENCY sub-agents run at once, each transition pushed to the UI.
    return { content: await runBatch() }
  },
}
// --- Background orchestration: check on / collect non-blocking task/workflow runs.

const agentStatus: ToolDef = {
  name: 'agent_status',
  description:
    'List the background sub-agent tasks you started (task/plan/workflow, which run in the background by default) and their current status (running / done / error). Non-blocking. Use it to see what background work is still in flight.',
  orchestration: true,
  input_schema: { type: 'object', properties: {} },
  async run(_input, ctx) {
    if (!ctx.allowBackground) return { content: 'background tasks are not available here.', isError: true }
    const list = listBackground()
    if (list.length === 0) return { content: 'No background tasks.' }
    const lines = list.map((t) => {
      const secs = (((t.endedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(0)
      return `• ${t.id} · ${t.label} · ${t.kind} · ${t.status} (${secs}s)`
    })
    return { content: `Background tasks (${list.length}):\n${lines.join('\n')}` }
  },
}

const agentWait: ToolDef = {
  name: 'agent_wait',
  description:
    'Wait — for a BOUNDED time — for background sub-agent work (task/plan/workflow) to finish, then return whatever has completed. ' +
    `You MUST pass \`timeout_seconds\` (capped at ${WAIT_TIMEOUT_CAP}s); this tool NEVER blocks indefinitely. ` +
    'If the timeout elapses with work still running, it returns the finished results (if any) plus how many are still in flight and hands control back to you — then DECIDE: call `agent_wait` again to keep waiting, do other useful work, or write your summary and end the turn (the system wakes you with the results once the background work finishes). Never spin idly. ' +
    'Pass `ids` to wait for specific handles, or omit to wait for ALL running background tasks.',
  orchestration: true,
  input_schema: {
    type: 'object',
    properties: {
      timeout_seconds: { type: 'number', description: `How long to wait, in seconds, before returning control (required; capped at ${WAIT_TIMEOUT_CAP}s). On timeout you get whatever finished plus a count still running.` },
      ids: { type: 'array', items: { type: 'string' }, description: 'Handle ids (from a background task/workflow) to wait for. Omit to wait for all.' },
    },
    required: ['timeout_seconds'],
  },
  async run(input, ctx) {
    if (!ctx.allowBackground) return { content: 'background tasks are not available here.', isError: true }
    const timeoutSec = Number(input.timeout_seconds)
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      return { content: 'agent_wait 需要一个正的 `timeout_seconds`（最长等待秒数）。它不会无限阻塞：超时后会把已完成的结果连同仍在运行的数量返回给你，你再决定是继续等、去做别的事，还是先总结并结束本轮（后台完成后系统会自动唤醒你）。', isError: true }
    }
    const ids = Array.isArray(input.ids) ? input.ids.map((x) => String(x)) : undefined
    if (listBackground().length === 0) return { content: 'No background tasks to wait for.' }
    const capped = Math.min(timeoutSec, WAIT_TIMEOUT_CAP)
    // Thread the turn's signal so an Esc/Ctrl-C while this call is waiting returns
    // control at once; the timeout bounds the wait even without an interrupt.
    const { tasks: done, aborted, timedOut, pending } = await waitForBackground(ids, ctx.signal, capped * 1000)
    if (aborted) return { content: '(已中断等待；后台任务仍在后台运行，可稍后用 agent_status 查看或结束本轮让其自动回传)', display: '(已中断等待)', isError: true }
    const body = done.map((t) => `### ${t.label} (${t.id}) · ${t.status}${t.error ? ` · error: ${t.error}` : ''}\n${t.result || '(no output)'}`).join('\n\n')
    if (timedOut) {
      const head = done.length > 0
        ? `等待 ${capped}s 后：已收集 ${done.length} 个完成的任务，仍有 ${pending} 个在后台运行。`
        : `等待 ${capped}s 后：${pending} 个后台任务仍在运行，暂无完成。`
      const tail = '现在你自己决定：再次调用 agent_wait 继续等、去做别的有用的事，或者直接写出总结并结束本轮——后台任务完成时系统会自动把结果喂回并唤醒你继续。不要空转干等。'
      // Frontend sees only the factual head line; the body + decision guidance
      // stay in `content` for the model.
      return { content: clip(`${head}${body ? `\n\n${body}` : ''}\n\n${tail}`), display: head }
    }
    if (done.length === 0) return { content: 'No matching background tasks (already collected or unknown ids).' }
    return { content: clip(`Collected ${done.length} background task${done.length === 1 ? '' : 's'}:\n\n${body}`), display: `已收集 ${done.length} 个后台任务` }
  },
}

// The orchestration tools, in registry order.
export { task, plan, workflow, agentStatus, agentWait }
