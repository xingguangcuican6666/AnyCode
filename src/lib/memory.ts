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
    saveMemoryEntry({ name: '', description, type: 'reference', body })
  }
}

// --- The structured memory store: one Markdown file per fact + an index. ---
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

export interface MemoryEntry {
  name: string          // kebab-case slug; also the file stem
  description: string   // one line; used for recall relevance in the index
  type: MemoryType
  body: string          // the fact itself (Markdown)
  created: string
  modified: string
}

export const MEMORY_DIR = path.join(os.homedir(), '.anycode', 'memory')
export const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md')

function isType(v: string): v is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(v)
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

function fileFor(name: string): string {
  return path.join(MEMORY_DIR, `${name}.md`)
}

// Serialize an entry to `---frontmatter---\n\nbody`. Front-matter values are kept
// single-line (the flat parser in lib/frontmatter can't do multi-line YAML), so
// description newlines collapse to spaces; the body keeps its Markdown intact.
function serialize(e: MemoryEntry): string {
  const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()
  const fm = [
    '---',
    `name: ${e.name}`,
    `description: ${oneLine(e.description)}`,
    `type: ${e.type}`,
    `created: ${e.created}`,
    `modified: ${e.modified}`,
    '---',
    '',
    e.body.trim(),
    '',
  ]
  return fm.join('\n')
}

function readEntry(file: string): MemoryEntry | null {
  try {
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
    const name = meta.name || path.basename(file, '.md')
    const type = isType(meta.type) ? meta.type : 'reference'
    return {
      name,
      description: meta.description || name,
      type,
      body,
      created: meta.created || '',
      modified: meta.modified || meta.created || '',
    }
  } catch {
    return null
  }
}

/** All stored memories, newest-modified first. */
export function listMemories(): MemoryEntry[] {
  let files: string[]
  try {
    files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
  } catch {
    return [] // no memory dir yet
  }
  const entries = files.map((f) => readEntry(path.join(MEMORY_DIR, f))).filter((e): e is MemoryEntry => e !== null)
  return entries.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''))
}

export function getMemory(name: string): MemoryEntry | null {
  return readEntry(fileFor(slugify(name)))
}

/**
 * Create or update a memory. A blank name is derived from the description. If an
 * entry with the resolved name exists its `created` is preserved. Rewrites the
 * MEMORY.md index. Best-effort — a write failure never throws.
 */
export function saveMemoryEntry(input: { name?: string; description: string; type?: MemoryType; body: string }): MemoryEntry | null {
  const now = new Date().toISOString()
  const name = slugify(input.name?.trim() || input.description)
  const existing = readEntry(fileFor(name))
  const entry: MemoryEntry = {
    name,
    description: input.description.trim() || name,
    type: input.type && isType(input.type) ? input.type : existing?.type ?? 'reference',
    body: input.body.trim(),
    created: existing?.created || now,
    modified: now,
  }
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    fs.writeFileSync(fileFor(name), serialize(entry))
    writeIndex()
    return entry
  } catch {
    return null
  }
}

export function deleteMemory(name: string): boolean {
  const slug = slugify(name)
  try {
    fs.rmSync(fileFor(slug))
    writeIndex()
    return true
  } catch {
    return false
  }
}

/** Regenerate MEMORY.md — one line per memory, grouped by type. */
export function writeIndex(): void {
  const entries = listMemories()
  const lines: string[] = ['# MeowCode memory index', '']
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
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    fs.writeFileSync(MEMORY_INDEX, lines.join('\n') + '\n')
  } catch {
    // best-effort
  }
}

/** Compact index text (grouped `name — description`) for the system preamble. */
export function memoryIndexText(): string {
  const entries = listMemories()
  if (entries.length === 0) return ''
  const lines: string[] = []
  for (const type of MEMORY_TYPES) {
    const group = entries.filter((e) => e.type === type)
    if (group.length === 0) continue
    lines.push(`[${type}]`)
    for (const e of group) lines.push(`- ${e.name} — ${e.description}`)
  }
  return lines.join('\n')
}

/** Human-readable listing for the /memory command. */
export function formatMemoryList(): string {
  const entries = listMemories()
  const lines: string[] = ['**Memory** — cross-session facts', '']
  if (entries.length === 0) {
    lines.push('_(no memories yet — the agent saves them as it learns, or add one with `/memory save`)_')
    return lines.join('\n')
  }
  for (const type of MEMORY_TYPES) {
    const group = entries.filter((e) => e.type === type)
    if (group.length === 0) continue
    lines.push(`**${type}**`)
    for (const e of group) lines.push(`- \`${e.name}\` — ${e.description}`)
    lines.push('')
  }
  lines.push(`_${entries.length} mem${entries.length === 1 ? 'ory' : 'ories'} · ${MEMORY_DIR}_`)
  return lines.join('\n')
}

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
  const index = memoryIndexText()
  if (index) {
    parts.push(
      'You have a persistent cross-session memory. Facts you have saved (read the full text of any with the `memory` tool, action "read"):\n' +
        index +
        '\n\nRecall the relevant ones before acting. As you learn durable, non-obvious facts — the user\'s preferences and identity (user), corrections and confirmed working approaches (feedback), ongoing goals and constraints (project), useful pointers (reference) — save them with the `memory` tool (action "save"). Do not save what the repo or git history already records, or what only matters to this one turn.',
    )
  } else {
    parts.push(
      'You have a persistent cross-session memory (currently empty). As you learn durable, non-obvious facts — user preferences/identity, corrections and confirmed approaches, ongoing constraints, useful pointers — save them with the `memory` tool (action "save") so future sessions keep them.',
    )
  }
  return parts.length ? parts.join('\n\n') : undefined
}
