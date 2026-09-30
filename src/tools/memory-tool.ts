// The `memory` tool — the agent's own persistent, cross-session memory, modeled
// on a real agent memory tool. The model saves durable facts it learns and reads
// them back in later sessions; the store is file-based (see lib/memory). Writes
// land only under ~/.anycode/memory/ (never the workspace, never secrets), so the
// tool is read-only from the *project's* point of view and auto-runs like the
// search tools rather than prompting (see tools/permission — not in MUTATING).
import type { ToolDef, ToolResult } from './types'
import {
  listMemories, getMemory, saveMemoryEntry, deleteMemory, memoryIndexText,
  MEMORY_TYPES, type MemoryType,
} from '../lib/memory'

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export const memoryTool: ToolDef = {
  name: 'memory',
  description:
    'Your persistent, cross-session memory. Use it to remember durable, non-obvious facts and recall them in future sessions. ' +
    'Actions: "list" — index of all memories (name — description); "read" {name} — the full text of one; ' +
    '"save" {description, body, type?, name?} — create or update a fact (type ∈ user|feedback|project|reference; name auto-derived from the description if omitted); ' +
    '"delete" {name} — forget one. ' +
    'Save the user\'s preferences/identity (user), corrections and confirmed approaches (feedback), ongoing goals/constraints (project), and useful pointers (reference). ' +
    'Do NOT save what the repo, git history, or this single turn already captures. The index of existing memories is also shown in your system prompt each turn.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'save', 'delete'], description: 'The operation to perform.' },
      name: { type: 'string', description: 'Memory slug (for read/delete, or to force a name on save).' },
      description: { type: 'string', description: 'One-line summary used for recall relevance (required for save).' },
      type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Fact category (save). Defaults to reference.' },
      body: { type: 'string', description: 'The fact itself, in Markdown (required for save).' },
    },
    required: ['action'],
  },
  async run(input): Promise<ToolResult> {
    const action = str(input.action)
    switch (action) {
      case 'list': {
        const idx = memoryIndexText()
        return { content: idx || '(no memories saved yet)', display: `memory · list (${listMemories().length})` }
      }
      case 'read': {
        const name = str(input.name)
        if (!name) return { content: 'memory read: `name` is required', isError: true }
        const e = getMemory(name)
        if (!e) return { content: `memory read: no memory named "${name}"`, isError: true }
        return {
          content: `# ${e.name} (${e.type})\n${e.description}\n\n${e.body}`,
          display: `memory · read ${e.name}`,
        }
      }
      case 'save': {
        const description = str(input.description)
        const body = str(input.body)
        if (!description || !body) return { content: 'memory save: `description` and `body` are both required', isError: true }
        const type = (str(input.type) || 'reference') as MemoryType
        const saved = saveMemoryEntry({ name: str(input.name) || undefined, description, type, body })
        if (!saved) return { content: 'memory save: failed to write the memory file', isError: true }
        return { content: `saved memory "${saved.name}" (${saved.type})`, display: `memory · save ${saved.name}` }
      }
      case 'delete': {
        const name = str(input.name)
        if (!name) return { content: 'memory delete: `name` is required', isError: true }
        const ok = deleteMemory(name)
        return ok
          ? { content: `deleted memory "${name}"`, display: `memory · delete ${name}` }
          : { content: `memory delete: no memory named "${name}"`, isError: true }
      }
      default:
        return { content: `memory: unknown action "${action}" (use list | read | save | delete)`, isError: true }
    }
  },
}
