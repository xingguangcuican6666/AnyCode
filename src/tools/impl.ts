// Concrete implementations of the agent toolset. Kept dependency-free (node
// builtins only) so the loop works anywhere the CLI runs.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { SpawnOpts, SpawnResult, ToolContext, ToolDef, ToolResult } from './types'
import type { WorkflowAgent } from '../types'

const MAX_OUT = 30000 // hard cap on any single tool's returned text

function clip(s: string, max = MAX_OUT): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`
}

function resolve(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

// Line-level added/removed counts between two texts, for the Usage tab's "Total
// code changes". Uses an LCS (longest common subsequence) so unchanged lines
// aren't double-counted; falls back to a plain size delta on very large files to
// avoid the O(m×n) table blowing up.
function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const m = a.length, n = b.length
  if (m === 0) return { added: n, removed: 0 }
  if (n === 0) return { added: 0, removed: m }
  if (m * n > 4_000_000) return { added: Math.max(0, n - m), removed: Math.max(0, m - n) }
  let prev = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0)
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  const lcs = prev[n]
  return { added: n - lcs, removed: m - lcs }
}

// Shared shell runner used by the bash + grep tools. Streams nothing; collects
// stdout/stderr, honors the abort signal and a timeout.
function runShell(command: string, ctx: ToolContext, timeoutMs: number): Promise<ToolResult> {
  return new Promise((res) => {
    const child = spawn(command, { cwd: ctx.cwd, shell: '/bin/bash', signal: ctx.signal })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (ctx.signal?.aborted) return res({ content: '(aborted)', isError: true })
      res({ content: `failed to run: ${(e as Error).message}`, isError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const body = [out.trim(), err.trim() ? `[stderr]\n${err.trim()}` : ''].filter(Boolean).join('\n')
      const tag = code === 0 ? '' : `\n[exit ${code}]`
      res({ content: clip((body || '(no output)') + tag), isError: code !== 0 })
    })
  })
}

const bash: ToolDef = {
  name: 'bash',
  description: 'Run a shell command in the working directory and return its combined stdout/stderr. Use for builds, tests, git, and any CLI task.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 120000).' },
    },
    required: ['command'],
  },
  run: (input, ctx) => runShell(String(input.command ?? ''), ctx, Number(input.timeout_ms) || 120000),
}

const readFile: ToolDef = {
  name: 'read_file',
  description: 'Read a UTF-8 text file and return its contents with line numbers.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to the working directory).' },
      offset: { type: 'number', description: '1-based line to start from.' },
      limit: { type: 'number', description: 'Max lines to read (default 2000).' },
    },
    required: ['path'],
  },
  async run(input, ctx) {
    const file = resolve(ctx.cwd, String(input.path ?? ''))
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const lines = raw.split('\n')
      const start = Math.max(1, Number(input.offset) || 1)
      const limit = Number(input.limit) || 2000
      const slice = lines.slice(start - 1, start - 1 + limit)
      const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n')
      return { content: clip(numbered || '(empty file)') }
    } catch (e) {
      return { content: `cannot read ${file}: ${(e as Error).message}`, isError: true }
    }
  },
}

const writeFile: ToolDef = {
  name: 'write_file',
  description: 'Write (create or overwrite) a UTF-8 text file. Creates parent directories as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write.' },
      content: { type: 'string', description: 'Full file contents.' },
    },
    required: ['path', 'content'],
  },
  async run(input, ctx) {
    const file = resolve(ctx.cwd, String(input.path ?? ''))
    const content = String(input.content ?? '')
    try {
      // Read the prior contents (if any) so we can report an accurate line diff
      // rather than counting a full rewrite as all-added.
      const before = await fsp.readFile(file, 'utf8').catch(() => '')
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, content, 'utf8')
      const { added, removed } = lineDiff(before, content)
      return { content: `wrote ${file} (${content.length} bytes)`, linesAdded: added, linesRemoved: removed }
    } catch (e) {
      return { content: `cannot write ${file}: ${(e as Error).message}`, isError: true }
    }
  },
}

const editFile: ToolDef = {
  name: 'edit_file',
  description: 'Replace an exact string in a file. old_string must be unique unless replace_all is true.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(input, ctx) {
    const file = resolve(ctx.cwd, String(input.path ?? ''))
    const oldStr = String(input.old_string ?? '')
    const newStr = String(input.new_string ?? '')
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const count = oldStr ? raw.split(oldStr).length - 1 : 0
      if (count === 0) return { content: `old_string not found in ${file}`, isError: true }
      if (count > 1 && !input.replace_all) return { content: `old_string is not unique in ${file} (${count} matches); pass replace_all or add context.`, isError: true }
      const next = input.replace_all ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr)
      await fsp.writeFile(file, next, 'utf8')
      const reps = input.replace_all ? count : 1
      const per = lineDiff(oldStr, newStr)
      return {
        content: `edited ${file} (${reps} replacement${reps === 1 ? '' : 's'})`,
        linesAdded: per.added * reps,
        linesRemoved: per.removed * reps,
      }
    } catch (e) {
      return { content: `cannot edit ${file}: ${(e as Error).message}`, isError: true }
    }
  },
}

const grep: ToolDef = {
  name: 'grep',
  description: 'Search file contents for a regular expression (ripgrep-style). Returns matching file:line: text.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory or file to search (default: working directory).' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. *.ts' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
    },
    required: ['pattern'],
  },
  run(input, ctx) {
    const where = input.path ? resolve(ctx.cwd, String(input.path)) : ctx.cwd
    const flags = ['-rnI', '--color=never']
    if (input.ignore_case) flags.push('-i')
    if (input.glob) flags.push(`--include=${String(input.glob)}`)
    flags.push('--exclude-dir=node_modules', '--exclude-dir=.git')
    const q = `grep ${flags.join(' ')} -e ${shellQuote(String(input.pattern ?? ''))} ${shellQuote(where)}`
    return runShell(q, ctx, 30000).then((r) => (r.isError && r.content.includes('(no output)') ? { content: 'no matches' } : r))
  },
}

function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}

// --- glob: dependency-free recursive match ---
function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

const IGNORE = new Set(['node_modules', '.git', 'dist', '.cache'])

async function walk(dir: string, base: string, out: string[], depth = 0): Promise<void> {
  if (depth > 25 || out.length > 5000) return
  let entries: fs.Dirent[]
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walk(full, base, out, depth + 1)
    else out.push(path.relative(base, full))
  }
}

const globTool: ToolDef = {
  name: 'glob',
  description: 'Find files whose path matches a glob pattern (e.g. **/*.ts, src/*.tsx). Returns relative paths.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      path: { type: 'string', description: 'Root directory to search from (default: working directory).' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const base = input.path ? resolve(ctx.cwd, String(input.path)) : ctx.cwd
    const re = globToRegex(String(input.pattern ?? '*'))
    const files: string[] = []
    await walk(base, base, files)
    const hits = files.filter((f) => re.test(f)).sort()
    return { content: clip(hits.length ? hits.join('\n') : 'no files match') }
  },
}

const listDir: ToolDef = {
  name: 'list_dir',
  description: 'List the entries of a directory (files and subdirectories).',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path (default: working directory).' } },
  },
  async run(input, ctx) {
    const dir = input.path ? resolve(ctx.cwd, String(input.path)) : ctx.cwd
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      const rows = entries
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      return { content: clip(rows.length ? rows.join('\n') : '(empty directory)') }
    } catch (e) {
      return { content: `cannot list ${dir}: ${(e as Error).message}`, isError: true }
    }
  },
}

// --- Orchestration: sub-agents (`task`) and parallel fan-out (`workflow`).
// Both delegate through ctx.spawnAgent, which the agent loop supplies only at
// the top level, so a sub-agent can't recurse into more sub-agents.

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

function spawnHint(kind: unknown): string | undefined {
  const key = String(kind ?? 'general').toLowerCase()
  return SUBAGENT_ROLES[key] ?? SUBAGENT_ROLES.general
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
): Promise<Array<SpawnResult & { label: string }>> {
  const spawn = ctx.spawnAgent!
  const wfId = `${opts.idPrefix}-${Date.now().toString(36)}`
  const title = opts.title
  const agents: WorkflowAgent[] = tasks.map((t, i) => ({ label: t.label || `task ${i + 1}`, state: 'queued', steps: 0 }))
  const texts: Array<string | undefined> = new Array(tasks.length)
  let paused = false
  let waiters: Array<() => void> = []
  const wake = (): void => { const w = waiters; waiters = []; w.forEach((fn) => fn()) }
  ctx.signal?.addEventListener('abort', wake, { once: true })
  const gate = async (): Promise<void> => { while (paused && !ctx.signal?.aborted) await new Promise<void>((res) => waiters.push(res)) }
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
      const r = await spawn({ prompt: t.prompt, system: spawnHint(t.type), label })
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

const task: ToolDef = {
  name: 'task',
  description:
    'Delegate a self-contained sub-task to a fresh sub-agent that has the same file/search/shell tools and its own context. ' +
    'Use for focused work you want handled independently (deep research, a scoped edit, a broad search). Returns the sub-agent\'s final report. Sub-agents cannot spawn further sub-agents.',
  orchestration: true,
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-6 word) label for the sub-task.' },
      prompt: { type: 'string', description: 'The full, self-contained instructions for the sub-agent.' },
      subagent_type: { type: 'string', enum: Object.keys(SUBAGENT_ROLES), description: 'Sub-agent role (default: general).' },
    },
    required: ['prompt'],
  },
  async run(input, ctx) {
    if (!ctx.spawnAgent) return { content: 'sub-agents are not available here (nested sub-agents are not allowed).', isError: true }
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return { content: 'task requires a `prompt`.', isError: true }
    const label = String(input.description ?? 'task').trim() || 'task'
    // A single sub-task is a workflow of one: routing it through runAgentBatch
    // gives it the live collapsed line + expandable view, same as `workflow`.
    const [r] = await runAgentBatch(ctx, [{ prompt, label, type: input.subagent_type }], {
      title: `task · ${label}`, idPrefix: 'task', concurrency: 1,
    })
    const head = `▸ sub-agent "${label}" · ${r.steps} tool call${r.steps === 1 ? '' : 's'}${r.error ? ` · error: ${r.error}` : ''}`
    return { content: clip(`${head}\n\n${r.text || '(no output)'}`), isError: Boolean(r.error) && !r.text }
  },
}

const plan: ToolDef = {
  name: 'plan',
  description:
    'Think through an approach BEFORE implementing: spawn a read-only planning sub-agent that investigates the code and returns a concrete, step-by-step implementation plan (approach, files to change, risks, ordered checklist). ' +
    'Use this proactively for any non-trivial or multi-file task so you commit to a plan before editing anything. Returns the plan; it changes nothing on disk. Sub-agents cannot spawn further sub-agents.',
  orchestration: true,
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-6 word) label for what is being planned.' },
      prompt: { type: 'string', description: 'What to plan — the task/goal to produce an implementation plan for, with any relevant context.' },
    },
    required: ['prompt'],
  },
  async run(input, ctx) {
    if (!ctx.spawnAgent) return { content: 'the planning sub-agent is not available here (nested sub-agents are not allowed).', isError: true }
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return { content: 'plan requires a `prompt` describing what to plan.', isError: true }
    const label = String(input.description ?? 'plan').trim() || 'plan'
    const [r] = await runAgentBatch(ctx, [{ prompt, label, type: 'plan' }], {
      title: `plan · ${label}`, idPrefix: 'plan', concurrency: 1,
    })
    const head = `▸ plan "${label}" · ${r.steps} tool call${r.steps === 1 ? '' : 's'}${r.error ? ` · error: ${r.error}` : ''}`
    return { content: clip(`${head}\n\n${r.text || '(no plan produced)'}`), isError: Boolean(r.error) && !r.text }
  },
}

const workflow: ToolDef = {
  name: 'workflow',
  description:
    'Run several independent sub-tasks in parallel across sub-agents and collect their reports. ' +
    'Use for fan-out work where the sub-tasks do not depend on each other (review N files, research N angles, migrate N sites). ' +
    `At most ${WORKFLOW_MAX_TASKS} tasks per call; up to ${WORKFLOW_CONCURRENCY} run at once.`,
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
    // Same live-snapshot engine as `task`/`plan`, just fanned out: up to
    // WORKFLOW_CONCURRENCY sub-agents run at once, each transition pushed to the UI.
    const results = await runAgentBatch(ctx, capped, {
      title: `workflow · ${capped.length} sub-agent${capped.length === 1 ? '' : 's'}`,
      idPrefix: 'wf', concurrency: WORKFLOW_CONCURRENCY,
    })
    const totalSteps = results.reduce((n, r) => n + r.steps, 0)
    const body = results
      .map((r, i) => `### ${i + 1}. ${r.label}${r.error ? ` (error: ${r.error})` : ''}\n${r.text || '(no output)'}`)
      .join('\n\n')
    const header = `▸ workflow · ${capped.length} sub-agent${capped.length === 1 ? '' : 's'} · ${totalSteps} tool calls${dropped > 0 ? ` · ${dropped} extra task(s) dropped (max ${WORKFLOW_MAX_TASKS})` : ''}`
    return { content: clip(`${header}\n\n${body}`) }
  },
}

export const TOOLS: ToolDef[] = [bash, readFile, writeFile, editFile, grep, globTool, listDir, task, plan, workflow]
