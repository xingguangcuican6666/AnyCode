import type { AgentEvent, Message, Provider, StreamOpts, WorkflowAgent } from '../types'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { runTool, renderWorkflowReport } from '../tools'

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

function buildReply(userText: string): string {
  const quoted = (userText.trim() || '(nothing yet)')
    .split('\n').map((l) => '> ' + l).join('\n')
  return [
    "I'm **AnyCode** on the built-in `mock` provider — no API key required, so this is a canned reply that *streams* like the real thing.",
    '',
    'You said:',
    quoted,
    '',
    'Real tool calls work offline too — try:',
    '- `run: ls -la` to exercise the **bash** tool',
    '- `read: package.json` to exercise **read_file**',
    '- `ls: src` to exercise **list_dir**',
    '',
    'Set `ANTHROPIC_API_KEY` and `/provider anthropic` for a real model.',
  ].join('\n')
}

async function* streamText(text: string, opts: StreamOpts): AsyncGenerator<AgentEvent, void, unknown> {
  const tokens = text.match(/\s+|\S+/g) ?? [text]
  await sleep(200, opts.signal)
  for (let i = 0; i < tokens.length; i++) {
    if (opts.signal?.aborted) return
    yield { type: 'text', text: tokens[i] }
    if (i < tokens.length - 1) await sleep(10 + Math.random() * 24, opts.signal)
  }
}

// Like streamText but emits `thinking` deltas, so the offline demo shows a
// reasoning block ("✻ Thought for Ns") the way extended thinking does.
async function* streamThinking(text: string, opts: StreamOpts): AsyncGenerator<AgentEvent, void, unknown> {
  const tokens = text.match(/\s+|\S+/g) ?? [text]
  await sleep(150, opts.signal)
  for (let i = 0; i < tokens.length; i++) {
    if (opts.signal?.aborted) return
    yield { type: 'thinking', text: tokens[i] }
    if (i < tokens.length - 1) await sleep(12 + Math.random() * 20, opts.signal)
  }
}

// A synthetic, offline workflow driver: advances a set of sub-agents through
// queued→running→done on timers, pushing snapshots via opts.onWorkflow (the same
// side-channel the real tool uses) and honoring live pause/resume/save controls.
// Returns handles so the demo can run several concurrently (multiple collapsed
// lines) and yield tool_use/tool_result around them. `kind` overrides the title
// and id prefix so the same driver backs a single `task`/`plan` (one agent) as
// well as a parallel `workflow` — the UI is identical, keyed off the snapshot.
function makeMockWorkflow(gi: number, names: string[], opts: StreamOpts, cwd: string, kind?: { title?: string; idPrefix?: string }): {
  id: string; names: string[]; drive: () => Promise<void>; report: () => string
} {
  const now = (): number => Date.now?.() ?? 0
  const id = `${kind?.idPrefix ?? 'wf'}-mock-${gi}-${now().toString(36)}`
  const title = kind?.title ?? `workflow · ${names.length} sub-agent${names.length === 1 ? '' : 's'}`
  const agents: WorkflowAgent[] = names.map((label) => ({ label, state: 'queued', steps: 0 }))
  let paused = false
  let waiters: Array<() => void> = []
  const wake = (): void => { const w = waiters; waiters = []; w.forEach((fn) => fn()) }
  opts.signal?.addEventListener('abort', wake, { once: true })
  const gate = async (): Promise<void> => { while (paused && !opts.signal?.aborted) await new Promise<void>((res) => waiters.push(res)) }
  const controls = {
    pause: (): void => { if (!paused) { paused = true; emit() } },
    resume: (): void => { if (paused) { paused = false; wake(); emit() } },
    save: async (): Promise<string> => {
      const file = path.join(cwd, '.anycode', 'workflows', `${id}.md`)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, renderWorkflowReport(title, agents), 'utf8')
      return file
    },
  }
  const emit = (done = false): void => opts.onWorkflow?.({ id, title, agents: agents.map((a) => ({ ...a })), done, paused, controls })
  const drive = async (): Promise<void> => {
    emit() // all queued
    await sleep(300 + gi * 150, opts.signal)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        await gate() // held here while paused
        if (opts.signal?.aborted) return
        const i = next++
        if (i >= agents.length) return
        agents[i].state = 'running'; agents[i].startedAt = now(); emit()
        await sleep(700 + (i % 3) * 150, opts.signal)
        if (opts.signal?.aborted) return
        agents[i].state = 'done'; agents[i].steps = 2 + (i % 4); agents[i].elapsedMs = now() - (agents[i].startedAt ?? now()); emit()
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, agents.length) }, worker))
    emit(true) // final
  }
  return { id, names, drive, report: () => renderWorkflowReport(title, agents) }
}

// A deterministic mini-agent so the tool-use loop + UI can be exercised with no
// API key: `run:/read:/ls:` prefixes drive a real tool call; `error:`/`retry:`
// demo the failure + retry chrome; anything else streams a canned reply, led by
// a short thinking block.
async function* agent(messages: Message[], opts: StreamOpts): AsyncGenerator<AgentEvent, void, unknown> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const cwd = process.cwd()
  const trimmed = lastUser.trim()

  // Demo a terminal error (Feature: visible error messages).
  if (/^error:/i.test(trimmed)) {
    await sleep(250, opts.signal)
    if (opts.signal?.aborted) return
    yield { type: 'error', message: trimmed.slice(6).trim() || 'simulated API failure (mock) — this is how a real error surfaces' }
    return
  }
  // Demo the retry chrome, then succeed (Feature: retry mechanism + info).
  if (/^retry:/i.test(trimmed)) {
    for (let a = 1; a <= 2; a++) {
      yield { type: 'retry', attempt: a, max: 5, delayMs: 500 * a, reason: 'HTTP 529 (overloaded, mock)' }
      await sleep(500 * a, opts.signal)
      if (opts.signal?.aborted) return
    }
    for await (const ev of streamText(buildReply(lastUser), opts)) yield ev
    return
  }
  // Demo the live workflow progress tree (Feature: workflow效果). Emits synthetic
  // per-agent snapshots through opts.onWorkflow so the collapsed line(s) + the
  // expandable tree render with no API key. `workflow: a, b, c` sets sub-task
  // labels; `workflow: a, b || c, d` runs TWO workflows at once so you can select
  // between multiple collapsed lines (↓ to select · ↵ to expand).
  if (/^workflow:/i.test(trimmed)) {
    const spec = trimmed.slice(9).trim()
    const groups = spec ? spec.split('||').map((s) => s.trim()).filter(Boolean) : ['']
    const wfs = groups.map((grp, gi) => {
      const labels = grp ? grp.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : []
      const names = (labels.length ? labels : ['review src/app.tsx', 'audit providers', 'check tests']).slice(0, 8)
      return makeMockWorkflow(gi, names, opts, cwd)
    })
    for (const wf of wfs) yield { type: 'tool_use', id: wf.id, name: 'workflow', input: { tasks: wf.names.map((label) => ({ label })) } }
    // Drive them concurrently — snapshots flow through the callback, not the
    // generator, so awaiting all drivers lets every collapsed line advance live.
    await Promise.all(wfs.map((wf) => wf.drive()))
    if (opts.signal?.aborted) return
    for (const wf of wfs) yield { type: 'tool_result', id: wf.id, name: 'workflow', content: wf.report() }
    const hint = wfs.length > 1
      ? `${wfs.length} workflows finished. Press ↓ to select a line, ↵ to expand it.`
      : 'Workflow finished. Press ↓ then ↵ to expand the tree; p pauses, s saves a report.'
    for await (const ev of streamText(`\n\n${hint}`, opts)) yield ev
    return
  }

  // Demo a SINGLE sub-agent getting the same live collapsed line + expandable
  // tree as a workflow (Feature: subagent 同样处理). `task: <label>` and
  // `plan: <label>` each drive a one-agent snapshot through the same channel, so
  // esc-return-doesn't-interrupt / below-input placement all apply identically.
  {
    const m = /^(task|plan):\s*([\s\S]*)/i.exec(trimmed)
    if (m) {
      const kind = m[1].toLowerCase() as 'task' | 'plan'
      const label = m[2].trim() || (kind === 'plan' ? 'draft a plan' : 'a sub-task')
      const wf = makeMockWorkflow(0, [label], opts, cwd, { title: `${kind} · ${label}`, idPrefix: kind })
      yield { type: 'tool_use', id: wf.id, name: kind, input: { description: label } }
      await wf.drive()
      if (opts.signal?.aborted) return
      yield { type: 'tool_result', id: wf.id, name: kind, content: wf.report() }
      const hint = kind === 'plan'
        ? 'Plan ready. Press ↓ then ↵ to expand the plan sub-agent; esc returns without interrupting.'
        : 'Sub-agent finished. Press ↓ then ↵ to expand it; esc returns without interrupting.'
      for await (const ev of streamText(`\n\n${hint}`, opts)) yield ev
      return
    }
  }

  const triggers: Array<[RegExp, string, (v: string) => Record<string, unknown>]> = [
    [/^run:\s*([\s\S]+)/i, 'bash', (v) => ({ command: v })],
    [/^read:\s*(.+)/i, 'read_file', (v) => ({ path: v.trim() })],
    [/^ls:\s*(.*)/i, 'list_dir', (v) => ({ path: v.trim() || '.' })],
  ]
  for (const [re, tool, mk] of triggers) {
    const m = re.exec(trimmed)
    if (!m) continue
    for await (const ev of streamText(`Running \`${tool}\` for you:`, opts)) yield ev
    if (opts.signal?.aborted) return
    const id = `mock_${Date.now?.() ?? '0'}`
    const input = mk(m[1])
    yield { type: 'tool_use', id, name: tool, input }
    const r = await runTool(tool, input, { cwd, signal: opts.signal })
    if (opts.signal?.aborted) return
    yield { type: 'tool_result', id, name: tool, content: r.content, isError: r.isError }
    for await (const ev of streamText(`\n\nThat's the \`${tool}\` output above.`, opts)) yield ev
    return
  }
  for await (const ev of streamThinking(
    `The user said: "${trimmed.slice(0, 80)}". I'm the offline mock, so I'll explain what I am and point at the real tool triggers before replying.`,
    opts,
  )) yield ev
  if (opts.signal?.aborted) return
  for await (const ev of streamText(buildReply(lastUser), opts)) yield ev
}

// Stand-in for the detached stop-hook judge: continue for the first couple of
// turns, then report completion. The judge prompt carries `TURNS=<n>`.
async function complete(messages: Message[], opts: StreamOpts): Promise<string> {
  const prompt = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const n = Number(/TURNS=(\d+)/.exec(prompt)?.[1] ?? 0)
  await sleep(400, opts.signal)
  if (n >= 2) return JSON.stringify({ decision: 'complete', reason: 'Goal looks satisfied after iterating and verifying.' })
  return JSON.stringify({ decision: 'continue', reason: 'Only an initial response so far — keep going: make the change and verify the build/tests before stopping.' })
}

export const mockProvider: Provider = {
  id: 'mock',
  label: 'Mock (offline demo)',
  agent,
  complete,
  async *stream(messages: Message[], opts: StreamOpts) {
    for await (const ev of agent(messages, opts)) {
      if (ev.type === 'text') yield ev.text
    }
  },
}
