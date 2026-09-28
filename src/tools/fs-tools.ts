// The basic agent toolset: read/write/edit a file, run a shell command, search
// by content (grep) or by name (glob), list a directory. Dependency-free (node
// builtins only) so the loop works anywhere the CLI runs.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolContext, ToolDef, ToolResult } from './types'
import type { DiffLine } from '../types'
import { clip } from './util'
import { recordCheckpoint } from '../lib/checkpoints'

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

// A unified diff (context + / - rows) between two texts, for the write/edit diff
// view. Full LCS backtrack → per-line ops, then unchanged runs longer than
// 2×context are collapsed to a "⋯ N unchanged lines" hunk marker. Guards: bails
// (returns []) when the O(m×n) table would be huge, and caps total emitted rows
// so a massive rewrite can't flood the transcript.
const DIFF_CONTEXT = 3
const DIFF_MAX_ROWS = 200
function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const m = a.length, n = b.length
  if (m === 0 && n === 0) return []
  if (m * n > 1_000_000) return [] // too big to diff line-by-line; skip the view
  // LCS table, then backtrack into an ordered op list.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  type Op = { tag: 'context' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }
  const ops: Op[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ tag: 'context', text: a[i], oldNo: i + 1, newNo: j + 1 }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ tag: 'del', text: a[i], oldNo: i + 1 }); i++ }
    else { ops.push({ tag: 'add', text: b[j], newNo: j + 1 }); j++ }
  }
  while (i < m) { ops.push({ tag: 'del', text: a[i], oldNo: i + 1 }); i++ }
  while (j < n) { ops.push({ tag: 'add', text: b[j], newNo: j + 1 }); j++ }
  // Collapse long unchanged runs, keeping DIFF_CONTEXT lines around each change.
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].tag === 'context') continue
    for (let d = -DIFF_CONTEXT; d <= DIFF_CONTEXT; d++) {
      const idx = k + d
      if (idx >= 0 && idx < ops.length) keep[idx] = true
    }
  }
  const out: DiffLine[] = []
  let skipped = 0
  const flushHunk = () => { if (skipped > 0) { out.push({ tag: 'hunk', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` }); skipped = 0 } }
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) { skipped++; continue }
    flushHunk()
    out.push(ops[k])
    if (out.length >= DIFF_MAX_ROWS) { out.push({ tag: 'hunk', text: '⋯ diff truncated' }); return out }
  }
  flushHunk()
  return out
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
      // rather than counting a full rewrite as all-added. `prior === null` means
      // the file didn't exist — a rewind then deletes it.
      const prior = await fsp.readFile(file, 'utf8').then((c) => c).catch(() => null)
      if (ctx.rewind !== false) recordCheckpoint(file, prior, 'write_file', Date.now())
      const before = prior ?? ''
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, content, 'utf8')
      const { added, removed } = lineDiff(before, content)
      const diff = diffLines(before, content)
      return { content: `wrote ${file} (${content.length} bytes)`, linesAdded: added, linesRemoved: removed, diff: diff.length ? diff : undefined }
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
      if (ctx.rewind !== false) recordCheckpoint(file, raw, 'edit_file', Date.now())
      await fsp.writeFile(file, next, 'utf8')
      const reps = input.replace_all ? count : 1
      // Whole-file diff gives accurate counts and a proper context view; the
      // per-hunk multiply (below) was only a heuristic when we lacked the file.
      const whole = lineDiff(raw, next)
      const diff = diffLines(raw, next)
      return {
        content: `edited ${file} (${reps} replacement${reps === 1 ? '' : 's'})`,
        linesAdded: whole.added,
        linesRemoved: whole.removed,
        diff: diff.length ? diff : undefined,
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

// The basic (non-orchestration) tools, in the order they appear in the registry.
export { bash, readFile, writeFile, editFile, grep, globTool, listDir }
