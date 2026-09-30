// The `todo_write` tool — a live, agent-maintained task checklist for multi-step
// work, modeled on Claude Code's TodoWrite. The model sends the WHOLE list each
// call (it replaces the stored one), marking exactly what's done, what's in
// progress, and what's left. It's a planning/visibility aid: the rendered list
// goes into the transcript so the user can follow long autonomous runs, and the
// full list is fed back to the model so it doesn't lose the thread across many
// tool calls. Session-scoped and in-memory (like the background registry) — it's
// working state, not something to persist.
import type { ToolDef, ToolResult } from './types'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface Todo {
  content: string        // imperative form, e.g. "Add the web_fetch tool"
  status: TodoStatus
  activeForm?: string     // present-continuous form shown while in progress, e.g. "Adding the web_fetch tool"
}

// One list per process. Module-level so it outlives a single turn (the App may
// remount on resize) and the UI could read it if it wants a live task line.
let todos: Todo[] = []
export function getTodos(): Todo[] { return todos }

const MARK: Record<TodoStatus, string> = { pending: '☐', in_progress: '◐', completed: '☑' }

function render(list: Todo[]): string {
  if (list.length === 0) return '(todo list cleared)'
  return list
    .map((t) => {
      const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content
      return `${MARK[t.status]} ${label}`
    })
    .join('\n')
}

function normalize(raw: unknown): Todo[] | { error: string } {
  if (!Array.isArray(raw)) return { error: '`todos` must be an array of {content, status, activeForm?} items' }
  const out: Todo[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'each todo must be an object' }
    const o = item as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content.trim() : ''
    const status = String(o.status ?? 'pending')
    if (!content) return { error: 'each todo needs a non-empty `content`' }
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return { error: `invalid status "${status}" (use pending | in_progress | completed)` }
    const activeForm = typeof o.activeForm === 'string' && o.activeForm.trim() ? o.activeForm.trim() : undefined
    out.push({ content, status: status as TodoStatus, activeForm })
  }
  return out
}

export const todoWrite: ToolDef = {
  name: 'todo_write',
  description:
    'Record and update your task list for the current multi-step work. Pass the ENTIRE list every time — it replaces the stored one. ' +
    'Use it to plan a non-trivial task up front and to keep exactly ONE item `in_progress` as you work, flipping items to `completed` the moment each is done. ' +
    'Each item: {content: imperative ("Add the tool"), status: pending|in_progress|completed, activeForm: present-continuous shown while active ("Adding the tool")}. ' +
    'Skip it for trivial single-step requests. The rendered list is shown to the user and kept in your context so you don\'t lose track across many tool calls.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list (replaces the current one).',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative description of the task.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status.' },
            activeForm: { type: 'string', description: 'Present-continuous form shown while the task is in progress.' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(input): Promise<ToolResult> {
    const norm = normalize(input.todos)
    if (!Array.isArray(norm)) return { content: `todo_write: ${norm.error}`, isError: true }
    todos = norm
    const done = norm.filter((t) => t.status === 'completed').length
    const active = norm.find((t) => t.status === 'in_progress')
    const view = render(norm)
    // Model sees the full list plus a progress line; the user sees the same list.
    const summary = norm.length ? `${done}/${norm.length} done${active ? ` · now: ${active.activeForm || active.content}` : ''}` : 'cleared'
    return { content: `Todo list updated (${summary}):\n${view}`, display: view }
  },
}
