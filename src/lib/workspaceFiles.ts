import fs from 'node:fs'
import path from 'node:path'

// Workspace file lister for the @-mention file picker (see PromptInput). Walks
// the working tree and returns workspace-relative paths, optionally honoring
// .gitignore when the `respectGitignore` setting is on.
//
// The .gitignore support is best-effort, not a faithful reimplementation of
// git's spec: it reads the repo-root .gitignore only (no nested ignore files),
// supports comments, negation (!), directory-only (trailing /), anchored (/…)
// and basename patterns, and translates `*`/`?` globs — but not `**`, ranges,
// or the subtler precedence rules. That is plenty to keep node_modules/build
// output out of the picker while staying fast and dependency-free.

// Always pruned, gitignore or not — huge or noisy trees nobody @-mentions.
const HARD_IGNORE = new Set(['.git', 'node_modules', 'dist', '.cache', '.next', 'build', 'coverage', '.turbo'])
const MAX_FILES = 4000
const MAX_DEPTH = 12
const TTL_MS = 4000

interface Rule { re: RegExp; dirOnly: boolean; negate: boolean; slash: boolean }

// Translate one gitignore glob into an anchored regex matching a single path
// component (basename rules) or a full relative path (slash rules). `*` stops at
// a path separator; `**` is not modeled (rare in a picker context).
function globToRe(glob: string): RegExp {
  let re = ''
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

function parseGitignore(root: string): Rule[] {
  let text: string
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8') } catch { return [] }
  const rules: Rule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) { negate = true; line = line.slice(1) }
    let dirOnly = false
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1) }
    const anchored = line.startsWith('/')
    if (anchored) line = line.replace(/^\/+/, '')
    if (!line) continue
    const slash = anchored || line.includes('/')
    rules.push({ re: globToRe(line), dirOnly, negate, slash })
  }
  return rules
}

// A slash rule matches the full relative path; a basename rule matches the entry
// name alone (so `*.log` catches logs at any depth). Later rules win, so a
// negation (`!keep.txt`) can re-include something an earlier rule ignored.
function makeIgnored(rules: Rule[]): (rel: string, name: string, isDir: boolean) => boolean {
  return (rel, name, isDir) => {
    let ignored = false
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue
      if (r.re.test(r.slash ? rel : name)) ignored = !r.negate
    }
    return ignored
  }
}

function walk(root: string, respectGitignore: boolean): string[] {
  const rules = respectGitignore ? parseGitignore(root) : []
  const ignored = rules.length ? makeIgnored(rules) : null
  const out: string[] = []
  const rec = (abs: string, rel: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (out.length >= MAX_FILES) return
      const name = e.name
      if (HARD_IGNORE.has(name)) continue
      const childRel = rel ? `${rel}/${name}` : name
      const isDir = e.isDirectory()
      if (ignored && ignored(childRel, name, isDir)) continue
      if (isDir) rec(path.join(abs, name), childRel, depth + 1)
      else out.push(childRel)
    }
  }
  rec(root, '', 0)
  return out.sort()
}

// Small session cache: walking the tree on every keystroke would be wasteful, so
// results are memoized per (cwd, respectGitignore) for a few seconds. New files
// appear on the next miss. `now` is injectable for tests; defaults to wall time.
let cache: { key: string; at: number; files: string[] } | null = null

export function workspaceFiles(cwd: string, respectGitignore: boolean, now = Date.now()): string[] {
  const key = `${cwd}::${respectGitignore ? 1 : 0}`
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache.files
  const files = walk(cwd, respectGitignore)
  cache = { key, at: now, files }
  return files
}

// Rank matches for `query` the way a picker should: basename-prefix first (you
// usually type the start of a filename), then path-prefix, then any substring.
// Empty query returns the head of the list so `@` alone still shows something.
export function filterWorkspaceFiles(files: readonly string[], query: string, limit = 12): string[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, limit)
  const starts: string[] = []
  const pathStarts: string[] = []
  const contains: string[] = []
  for (const f of files) {
    const lf = f.toLowerCase()
    const base = lf.slice(lf.lastIndexOf('/') + 1)
    if (base.startsWith(q)) starts.push(f)
    else if (lf.startsWith(q)) pathStarts.push(f)
    else if (lf.includes(q)) contains.push(f)
    if (starts.length >= limit) break
  }
  return [...starts, ...pathStarts, ...contains].slice(0, limit)
}
