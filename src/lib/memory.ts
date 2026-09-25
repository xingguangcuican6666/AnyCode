// Cross-session memory store for the "loop goal".
// Persists a high-level goal plus free-form notes to ~/.anycode/memory.json
// so they survive across CLI sessions and can steer the model each turn.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export interface MemoryStore {
  goal: string
  notes: string[]
  updatedAt: string
}

export const MEMORY_FILE = path.join(os.homedir(), '.anycode', 'memory.json')

function emptyStore(): MemoryStore {
  return { goal: '', notes: [], updatedAt: '' }
}

export function loadMemory(): MemoryStore {
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')) as Partial<MemoryStore>
    return {
      goal: typeof raw.goal === 'string' ? raw.goal : '',
      notes: Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string') : [],
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    }
  } catch {
    // no memory file yet, or unreadable/corrupt — start fresh
    return emptyStore()
  }
}

export function saveMemory(m: MemoryStore): void {
  m.updatedAt = new Date().toISOString()
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2))
  } catch {
    // best-effort; memory persistence is non-critical
  }
}

export function setGoal(goal: string): MemoryStore {
  const m = loadMemory()
  m.goal = goal.trim()
  saveMemory(m)
  return m
}

export function addNote(note: string): MemoryStore {
  const m = loadMemory()
  const trimmed = note.trim()
  if (!trimmed) return m
  m.notes.push(trimmed)
  saveMemory(m)
  return m
}

export function removeNote(index: number): MemoryStore {
  const m = loadMemory()
  const i = index - 1
  if (i < 0 || i >= m.notes.length) return m
  m.notes.splice(i, 1)
  saveMemory(m)
  return m
}

export function clearMemory(): MemoryStore {
  const m = emptyStore()
  saveMemory(m)
  return m
}

export function formatMemory(m: MemoryStore): string {
  const lines: string[] = ['**Memory**', '']
  lines.push(`**Goal:** ${m.goal || '_(none set)_'}`)
  if (m.notes.length > 0) {
    lines.push('', '**Notes:**')
    m.notes.forEach((note, i) => lines.push(`${i + 1}. ${note}`))
  }
  lines.push('', `_updated ${m.updatedAt || 'never'}_`)
  return lines.join('\n')
}

export function goalPreamble(m: MemoryStore): string | undefined {
  if (!m.goal && m.notes.length === 0) return undefined
  const parts: string[] = []
  if (m.goal) {
    // Completion is decided by the out-of-session stop-hook judge (see
    // lib/goalJudge), not by a sentinel the model emits — so we just state the
    // goal and the bar (verify before finishing).
    parts.push(
      `Standing goal — keep working toward it until it is genuinely satisfied, and verify it (build/tests) before you consider yourself finished: ${m.goal}.`,
    )
  }
  if (m.notes.length > 0) {
    parts.push(`Remembered notes:\n${m.notes.map((n) => `- ${n}`).join('\n')}`)
  }
  return parts.join('\n\n')
}
