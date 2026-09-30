// Cross-session memory for MeowCode — a structured, file-based knowledge base
// modeled on a real agent memory tool (not a flat notes list). Each fact is one
// Markdown file under ~/.anycode/memory/ with front-matter (name / description /
// type / timestamps); an MEMORY.md index lists them one line each and is what we
// inject into the system preamble every turn so the model knows what it can
// recall. The model reads/writes entries autonomously via the `memory` tool
// (see tools/memory-tool.ts); the user browses/edits them via `/memory`.
//
// The transient loop *goal* (set by /goal, judged by lib/goalJudge) is a separate
// concern and stays in ~/.anycode/memory.json — it is a standing directive, not a
// remembered fact. loadMemory()/setGoal() below manage only that.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { parseFrontmatter } from './frontmatter'

// --- The standing loop goal (unchanged storage, so /goal + the judge keep working). ---
export interface GoalStore {
  goal: string
  updatedAt: string
}

export const MEMORY_FILE = path.join(os.homedir(), '.anycode', 'memory.json')

export function loadMemory(): GoalStore {
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')) as Partial<GoalStore> & { notes?: unknown }
    // One-time migration: an older build kept free-form notes here; move each into
    // the structured store so nothing is lost, then drop them from the JSON.
    if (Array.isArray(raw.notes) && raw.notes.length > 0) migrateNotes(raw.notes)
    const store: GoalStore = {
      goal: typeof raw.goal === 'string' ? raw.goal : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    }
    if (Array.isArray(raw.notes) && raw.notes.length > 0) saveMemory(store) // rewrite without notes
    return store
  } catch {
    return { goal: '', updatedAt: '' }
  }
}

export function saveMemory(m: GoalStore): void {
  m.updatedAt = new Date().toISOString()
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ goal: m.goal, updatedAt: m.updatedAt }, null, 2))
  } catch {
    // best-effort; goal persistence is non-critical
  }
}

export function setGoal(goal: string): GoalStore {
  const m = loadMemory()
  m.goal = goal.trim()
  saveMemory(m)
  return m
}

function migrateNotes(notes: unknown[]): void {
  for (const n of notes) {
    if (typeof n !== 'string' || !n.trim()) continue
    const body = n.trim()
    const description = body.length > 72 ? body.slice(0, 69).replace(/\s+\S*$/, '') + '…' : body
    saveMemoryEntry({ name: '', description, type: 'reference', body, scope: 'global' })
  }
}

// --- The structured memory store: one Markdown file per fact + an index. ---
// Two scopes, mirroring Claude Code: a GLOBAL store shared across every project
// (the user's identity/preferences), and a per-PROJECT (workspace) store keyed by
// the working directory, so a project's facts don't leak into unrelated sessions.
// Both live under ~/.anycode (never in the repo): global at ~/.anycode/memory/,
// project at ~/.anycode/projects/<cwd-slug>/memory/. Each scope has its own
// MEMORY.md index. Saves default to the current workspace.
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

export type MemoryScope = 'global' | 'project'
export const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'project']

export interface MemoryEntry {
  name: string          // kebab-case slug; also the file stem
  description: string   // one line; used for recall relevance in the index
  type: MemoryType
  scope: MemoryScope    // which store it lives in (derived from its directory)
  body: string          // the fact itself (Markdown)
  created: string
  modified: string
}

const ANYCODE_DIR = path.join(os.homedir(), '.anycode')

// The global store, shared across every project.
export const MEMORY_DIR = path.join(ANYCODE_DIR, 'memory')
// Back-compat: the global index path (scope-aware callers use indexFile()).
export const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md')

// Key project memory by cwd the way Claude Code does: path separators (and ':' on
// Windows) collapse to '-', so /home/u/app → -home-u-app. The workspace store thus
// follows the directory you're working in.
function projectSlug(): string {
  return process.cwd().replace(/[/\\:]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

// The directory backing a given scope.
export function memoryDir(scope: MemoryScope): string {
  return scope === 'global' ? MEMORY_DIR : path.join(ANYCODE_DIR, 'projects', projectSlug(), 'memory')
}

function indexFile(scope: MemoryScope): string {
  return path.join(memoryDir(scope), 'MEMORY.md')
}

function isType(v: string): v is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(v)
}

export function isScope(v: string): v is MemoryScope {
  return (MEMORY_SCOPES as readonly string[]).includes(v)
}

export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-') // keep CJK, collapse the rest to dashes
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'memory-' + Math.abs(hash(s)).toString(36).slice(0, 6)
}

// Tiny deterministic string hash (no Math.random — keeps names stable/reproducible).
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function fileFor(name: string, scope: MemoryScope): string {
  return path.join(memoryDir(scope), `${name}.md`)
}

// Pull the `[[other-memory]]` link targets out of a body (normalized to slugs), so
// a read can surface which related memories a fact points to. Mirrors Claude Code's
// convention of linking related memories with [[their-name]].
export function extractLinks(body: string): string[] {
  const out = new Set<string>()
  const re = /\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const slug = slugify(m[1])
    if (slug) out.add(slug)
  }
  return [...out]
}

// Serialize an entry to `---frontmatter---\n\nbody`, matching Claude Code's shape:
// top-level `name`/`description`, then a nested `metadata:` block. Values are kept
// single-line (lib/frontmatter reads keys leniently by trimming each line, so the
// indented metadata leaves still parse); description newlines collapse to spaces.
// The body keeps its Markdown, including any `[[other-memory]]` links, intact.
function serialize(e: MemoryEntry): string {
  const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()
  const fm = [
    '---',
    `name: ${e.name}`,
    `description: ${oneLine(e.description)}`,
    'metadata:',
    `  type: ${e.type}`,
    `  created: ${e.created}`,
    `  modified: ${e.modified}`,
    '---',
    '',
    e.body.trim(),
    '',
  ]
  return fm.join('\n')
}

function readEntry(file: string, scope: MemoryScope): MemoryEntry | null {
  try {
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
    const name = meta.name || path.basename(file, '.md')
    const type = isType(meta.type) ? meta.type : 'reference'
    return {
      name,
      description: meta.description || name,
      type,
      scope,
      body,
      created: meta.created || '',
      modified: meta.modified || meta.created || '',
    }
  } catch {
    return null
  }
}

/** Memories in one scope, newest-modified first. Defaults to the workspace store. */
export function listMemories(scope: MemoryScope = 'project'): MemoryEntry[] {
  const dir = memoryDir(scope)
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
  } catch {
    return [] // no memory dir yet
  }
  const entries = files.map((f) => readEntry(path.join(dir, f), scope)).filter((e): e is MemoryEntry => e !== null)
  return entries.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''))
}

/** Every memory across both scopes — project (workspace) first, then global. */
export function listAllMemories(): MemoryEntry[] {
  return [...listMemories('project'), ...listMemories('global')]
}

// Look up a memory by name. With an explicit scope, only that store is searched;
// otherwise the workspace store shadows the global one (project first, then global).
export function getMemory(name: string, scope?: MemoryScope): MemoryEntry | null {
  const slug = slugify(name)
  if (scope) return readEntry(fileFor(slug, scope), scope)
  return readEntry(fileFor(slug, 'project'), 'project') || readEntry(fileFor(slug, 'global'), 'global')
}

/**
 * Create or update a memory. A blank name is derived from the description. If an
 * entry with the resolved name exists its `created` is preserved. Rewrites the
 * MEMORY.md index. Best-effort — a write failure never throws.
 */
export function saveMemoryEntry(input: { name?: string; description: string; type?: MemoryType; body: string; scope?: MemoryScope }): MemoryEntry | null {
  const scope: MemoryScope = input.scope && isScope(input.scope) ? input.scope : 'project'
  const now = new Date().toISOString()
  const name = slugify(input.name?.trim() || input.description)
  const existing = readEntry(fileFor(name, scope), scope)
  const entry: MemoryEntry = {
    name,
    description: input.description.trim() || name,
    type: input.type && isType(input.type) ? input.type : existing?.type ?? 'reference',
    scope,
    body: input.body.trim(),
    created: existing?.created || now,
    modified: now,
  }
  try {
    fs.mkdirSync(memoryDir(scope), { recursive: true })
    fs.writeFileSync(fileFor(name, scope), serialize(entry))
    writeIndex(scope)
    return entry
  } catch {
    return null
  }
}

// Delete a memory. With an explicit scope, only that store is touched; otherwise
// the workspace store is tried first, then global (first hit wins).
export function deleteMemory(name: string, scope?: MemoryScope): boolean {
  const slug = slugify(name)
  const scopes: MemoryScope[] = scope ? [scope] : ['project', 'global']
  for (const s of scopes) {
    try {
      if (fs.existsSync(fileFor(slug, s))) {
        fs.rmSync(fileFor(slug, s))
        writeIndex(s)
        return true
      }
    } catch {
      // try the next scope
    }
  }
  return false
}

/** Regenerate one scope's MEMORY.md — one line per memory, grouped by type. */
export function writeIndex(scope: MemoryScope): void {
  const entries = listMemories(scope)
  const lines: string[] = [`# MeowCode memory index (${scope})`, '']
  if (entries.length === 0) {
    lines.push('_(empty)_')
  } else {
    for (const type of MEMORY_TYPES) {
      const group = entries.filter((e) => e.type === type)
      if (group.length === 0) continue
      lines.push(`## ${type}`)
      for (const e of group) lines.push(`- [${e.name}](${e.name}.md) — ${e.description}`)
      lines.push('')
    }
  }
  try {
    fs.mkdirSync(memoryDir(scope), { recursive: true })
    fs.writeFileSync(indexFile(scope), lines.join('\n') + '\n')
  } catch {
    // best-effort
  }
}

/** Compact index text — workspace memories first, then global, each line tagged
 *  with its type. With `opts.limit`, only the N most-recently-modified entries per
 *  scope are listed and the rest are folded into a "…and M more" line pointing at
 *  the memory tool's "list" action; without a limit the full index is returned
 *  (the `memory` tool's list action and /memory use the full form). This is what
 *  bounds how much the system preamble injects when there are many memories. */
export function memoryIndexText(opts?: { limit?: number }): string {
  const limit = opts?.limit
  const sections: string[] = []
  for (const scope of MEMORY_SCOPES.slice().reverse()) { // project first, then global
    const entries = listMemories(scope) // newest-modified first
    if (entries.length === 0) continue
    const shown = limit && limit > 0 ? entries.slice(0, limit) : entries
    const lines: string[] = [scope === 'project' ? '[workspace memory]' : '[global memory]']
    for (const type of MEMORY_TYPES) {
      for (const e of shown.filter((x) => x.type === type)) lines.push(`- ${e.name} (${type}) — ${e.description}`)
    }
    const more = entries.length - shown.length
    if (more > 0) lines.push(`- …and ${more} more — use the memory tool (action "list") to see the full index`)
    sections.push(lines.join('\n'))
  }
  return sections.join('\n')
}

/** Human-readable listing for the /memory command. */
export function formatMemoryList(): string {
  const lines: string[] = ['**Memory** — cross-session facts', '']
  const all = listAllMemories()
  if (all.length === 0) {
    lines.push('_(no memories yet — the agent saves them as it learns, or add one with `/memory save`)_')
    return lines.join('\n')
  }
  for (const scope of MEMORY_SCOPES.slice().reverse()) { // workspace first, then global
    const entries = listMemories(scope)
    if (entries.length === 0) continue
    lines.push(`**${scope === 'project' ? 'workspace' : 'global'}** _(${memoryDir(scope)})_`)
    for (const type of MEMORY_TYPES) {
      const group = entries.filter((e) => e.type === type)
      if (group.length === 0) continue
      lines.push(`  _${type}_`)
      for (const e of group) lines.push(`  - \`${e.name}\` — ${e.description}`)
    }
    lines.push('')
  }
  lines.push(`_${all.length} mem${all.length === 1 ? 'ory' : 'ories'} across workspace + global_`)
  return lines.join('\n')
}

// Max index entries per scope injected into the system preamble each turn (the
// most-recently-modified win). Bounds context cost when the store is large; the
// full index stays reachable via the memory tool's "list" action and /memory.
const PREAMBLE_INDEX_LIMIT = 25

/**
 * The standing preamble injected into the system prompt every turn: the active
 * goal (kept verbatim so lib/goalJudge's bar is unchanged) plus the memory index
 * so the model recalls what it knows and keeps it current via the `memory` tool.
 */
export function standingPreamble(): string | undefined {
  const parts: string[] = []
  const goal = loadMemory().goal
  if (goal) {
    parts.push(
      `Standing goal — keep working toward it until it is genuinely satisfied, and verify it (build/tests) before you consider yourself finished: ${goal}.`,
    )
  }
  // Cap how much of the index the preamble injects: only the most-recent
  // PREAMBLE_INDEX_LIMIT entries per scope, so a large memory store doesn't bloat
  // every turn. The overflow line and the guidance below point the model at the
  // memory tool's "list" action for the full index, and "read" for full bodies.
  const index = memoryIndexText({ limit: PREAMBLE_INDEX_LIMIT })
  if (index) {
    parts.push(
      'You have a persistent cross-session memory. Below is the index of saved facts (this may be a recent subset when there are many — use the `memory` tool, action "list", to see the full index, and action "read" {name} for the full text of any one):\n' +
        index +
        '\n\nMemory has two scopes: [workspace memory] is specific to this project (the current directory); [global memory] applies across every project. Recall the relevant ones before acting. As you learn durable, non-obvious facts — the user\'s preferences and identity (user), corrections and confirmed working approaches (feedback), ongoing goals and constraints (project), useful pointers (reference) — save them with the `memory` tool (action "save"). Saves default to this workspace; pass scope:"global" only for facts that hold across all projects (e.g. the user\'s identity or universal preferences). Link related memories inline with [[their-name]]. Do not save what the repo or git history already records, or what only matters to this one turn.',
    )
  } else {
    parts.push(
      'You have a persistent cross-session memory (currently empty), with two scopes: a per-project workspace store (the default) and a cross-project global store (pass scope:"global"). As you learn durable, non-obvious facts — user preferences/identity, corrections and confirmed approaches, ongoing constraints, useful pointers — save them with the `memory` tool (action "save") so future sessions keep them.',
    )
  }
  return parts.length ? parts.join('\n\n') : undefined
}
