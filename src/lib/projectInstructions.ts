// Project-root agent instructions — the CLAUDE.md/AGENTS.md auto-loading that
// real Claude Code does and MeowCode lacked. On every turn we collect the
// instruction file(s) from the working directory up to the project (git) root and
// fold their text into the system preamble, alongside the cross-session memory
// (see lib/memory standingPreamble) and the standing goal. This is how a project
// pins conventions ("use pnpm", "never touch generated/", commit style, etc.)
// that must steer the agent without the user re-typing them each session.
//
// Sync file reads, mirroring lib/memory: cheap, and the preamble is rebuilt once
// per turn where a stale read would be worse than a few extra stats.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Filenames recognized as project instructions, in priority order. MEOWCODE.md is
// our own brand; CLAUDE.md/AGENTS.md are honored so a repo already carrying
// instructions for another agent works with no extra file. Only the first that
// exists at a given directory level is used, so a repo needn't duplicate them.
export const INSTRUCTION_FILENAMES = ['MEOWCODE.md', 'CLAUDE.md', 'AGENTS.md'] as const

const MAX_FILE_BYTES = 32 * 1024 // per-file cap so one huge doc can't blow the budget
const MAX_TOTAL_BYTES = 64 * 1024 // combined cap across every collected file

export interface ProjectInstructionFile {
  /** Absolute path of the file. */
  path: string
  /** Display path: relative to cwd, or ~-prefixed for files under the home dir. */
  rel: string
  /** File text (truncated to MAX_FILE_BYTES, with a marker when clipped). */
  content: string
}

// A short display path: relative to cwd when inside it, else ~-prefixed for the
// home dir, else the absolute path.
function displayPath(abs: string, cwd: string): string {
  if (abs === cwd || abs.startsWith(cwd + path.sep)) {
    const rel = path.relative(cwd, abs)
    return rel || path.basename(abs)
  }
  const home = os.homedir()
  if (abs === home || abs.startsWith(home + path.sep)) return '~' + abs.slice(home.length)
  return abs
}

// The directory chain to search, from `cwd` upward. Stops at (and includes) the
// first directory that looks like a project root — one containing a `.git` entry —
// or, failing that, at the home directory or the filesystem root. This keeps us
// from walking the whole disk while still picking up a monorepo-root instruction
// file that sits above a package subdir.
function ancestorChain(cwd: string): string[] {
  const chain: string[] = []
  const home = os.homedir()
  let dir = path.resolve(cwd)
  // Hard cap on depth as a belt-and-braces guard against odd filesystems.
  for (let i = 0; i < 64; i++) {
    chain.push(dir)
    let isGitRoot = false
    try {
      isGitRoot = fs.existsSync(path.join(dir, '.git'))
    } catch {
      isGitRoot = false
    }
    if (isGitRoot) break
    const parent = path.dirname(dir)
    if (parent === dir) break // filesystem root
    if (dir === home) break // don't climb above the user's home
    dir = parent
  }
  return chain
}

// Read the first existing instruction file in a directory, truncating to the
// per-file cap. Returns null when the directory has none (or on any read error).
function readInstructionAt(dir: string, cwd: string): ProjectInstructionFile | null {
  for (const name of INSTRUCTION_FILENAMES) {
    const abs = path.join(dir, name)
    let raw: string
    try {
      const st = fs.statSync(abs)
      if (!st.isFile()) continue
      raw = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    let content = raw
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES) + '\n… (truncated)'
    }
    if (!content.trim()) return null
    return { path: abs, rel: displayPath(abs, cwd), content }
  }
  return null
}

// Collect the project instruction files in effect for `cwd`, ordered
// outermost-first so the most specific (cwd-level) file is read last and thus
// wins on any conflict. Deduped by resolved path; total size is capped.
export function collectProjectInstructions(cwd: string): ProjectInstructionFile[] {
  const chain = ancestorChain(cwd)
  const seen = new Set<string>()
  const found: ProjectInstructionFile[] = []
  // Walk cwd→up so cwd wins, then reverse to outermost-first for display/prompt.
  for (const dir of chain) {
    const f = readInstructionAt(dir, cwd)
    if (!f) continue
    let real = f.path
    try {
      real = fs.realpathSync(f.path)
    } catch {
      /* keep the plain path */
    }
    if (seen.has(real)) continue
    seen.add(real)
    found.push(f)
  }
  found.reverse()
  // Enforce the combined budget, keeping the most-specific (last) files: since
  // `found` is outermost-first, trim from the front if we blow the cap.
  let total = found.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0)
  while (found.length > 1 && total > MAX_TOTAL_BYTES) {
    const dropped = found.shift()!
    total -= Buffer.byteLength(dropped.content, 'utf8')
  }
  return found
}

// Assemble the collected instruction files into a single system-preamble section,
// or undefined when the project has none. Wired into the turn's system prompt (see
// hooks/useChat) next to the memory preamble.
export function projectInstructionsPreamble(cwd: string): string | undefined {
  const files = collectProjectInstructions(cwd)
  if (!files.length) return undefined
  const parts = [
    'The project provides standing instructions in the file(s) below. Treat them as directives from the user for all work in this project and follow them, unless they conflict with an explicit instruction in the current conversation (the conversation wins). When several files apply, the later (more specific) one takes precedence.',
  ]
  for (const f of files) {
    parts.push(`### ${f.rel}\n${f.content.trim()}`)
  }
  return parts.join('\n\n')
}
