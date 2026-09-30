// The `memory` tool — the agent's own persistent, cross-session memory, modeled
// on a real agent memory tool. The model saves durable facts it learns and reads
// them back in later sessions; the store is file-based (see lib/memory). Memory
// has two scopes: a per-project WORKSPACE store (the default, keyed by cwd) and a
// cross-project GLOBAL store. Writes land only under ~/.anycode/ (never the repo,
// never secrets), so the tool is read-only from the *project tree's* point of view
// and auto-runs like the search tools rather than prompting (see tools/permission).
import type { ToolDef, ToolResult } from './types'
import {
  listAllMemories, getMemory, saveMemoryEntry, deleteMemory, memoryIndexText,
  extractLinks, MEMORY_TYPES, isScope, type MemoryType, type MemoryScope,
} from '../lib/memory'

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// Normalize the tool's scope input to a store scope. "workspace" is the user-facing
// alias for the per-project "project" store. Returns undefined when unspecified
// (read/delete then search both; save defaults to project).
function scopeOf(v: unknown): MemoryScope | undefined {
  const s = str(v).toLowerCase()
  if (!s) return undefined
  if (s === 'workspace' || s === 'project') return 'project'
  return isScope(s) ? s : undefined
}

export const memoryTool: ToolDef = {
  name: 'memory',
  description:
    'Your persistent, cross-session memory. Use it to remember durable, non-obvious facts and recall them in future sessions. ' +
    'Actions: "list" — index of all memories (workspace + global); "read" {name, scope?} — the full text of one; ' +
    '"save" {description, body, type?, name?, scope?} — create or update a fact (type ∈ user|feedback|project|reference; name auto-derived from the description if omitted); ' +
    '"delete" {name, scope?} — forget one. ' +
    'Scope ∈ workspace (default — specific to this project) | global (applies across all projects). Use scope:"global" only for facts that hold everywhere (the user\'s identity/universal preferences); everything project-specific stays in the workspace. ' +
    'Save the user\'s preferences/identity (user), corrections and confirmed approaches (feedback), ongoing goals/constraints (project), and useful pointers (reference). ' +
    'Link related memories inline in the body with [[their-name]]. ' +
    'Do NOT save what the repo, git history, or this single turn already captures. The index of existing memories is also shown in your system prompt each turn.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'save', 'delete'], description: 'The operation to perform.' },
      name: { type: 'string', description: 'Memory slug (for read/delete, or to force a name on save).' },
      description: { type: 'string', description: 'One-line summary used for recall relevance (required for save).' },
      type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Fact category (save). Defaults to reference.' },
      scope: { type: 'string', enum: ['workspace', 'global'], description: 'workspace (default, this project) or global (all projects). For read/delete, omit to search workspace then global.' },
      body: { type: 'string', description: 'The fact itself, in Markdown (required for save).' },
    },
    required: ['action'],
  },
  async run(input): Promise<ToolResult> {
    const action = str(input.action)
    switch (action) {
      case 'list': {
        const idx = memoryIndexText()
        return { content: idx || '(no memories saved yet)', display: `memory · list (${listAllMemories().length})` }
      }
      case 'read': {
        const name = str(input.name)
        if (!name) return { content: 'memory read: `name` is required', isError: true }
        const e = getMemory(name, scopeOf(input.scope))
        if (!e) return { content: `memory read: no memory named "${name}"`, isError: true }
        // Surface any [[other-memory]] links, marking targets that don't resolve with "?".
        const links = extractLinks(e.body)
        const linked = links.length
          ? '\n\nLinked: ' + links.map((n) => (getMemory(n) ? `[[${n}]]` : `[[${n}]]?`)).join(' ')
          : ''
        return {
          content: `# ${e.name} (${e.type} · ${e.scope})\n${e.description}\n\n${e.body}${linked}`,
          display: `memory · read ${e.name}`,
        }
      }
      case 'save': {
        const description = str(input.description)
        const body = str(input.body)
        if (!description || !body) return { content: 'memory save: `description` and `body` are both required', isError: true }
        const type = (str(input.type) || 'reference') as MemoryType
        const saved = saveMemoryEntry({ name: str(input.name) || undefined, description, type, body, scope: scopeOf(input.scope) })
        if (!saved) return { content: 'memory save: failed to write the memory file', isError: true }
        const where = saved.scope === 'project' ? 'workspace' : 'global'
        return { content: `saved memory "${saved.name}" (${saved.type} · ${where})`, display: `memory · save ${saved.name}` }
      }
      case 'delete': {
        const name = str(input.name)
        if (!name) return { content: 'memory delete: `name` is required', isError: true }
        const ok = deleteMemory(name, scopeOf(input.scope))
        return ok
          ? { content: `deleted memory "${name}"`, display: `memory · delete ${name}` }
          : { content: `memory delete: no memory named "${name}"`, isError: true }
      }
      default:
        return { content: `memory: unknown action "${action}" (use list | read | save | delete)`, isError: true }
    }
  },
}
