// The `notebook_edit` tool — edit a Jupyter notebook (.ipynb) at the cell level,
// mirroring Claude Code's NotebookEdit. A .ipynb is JSON, so a plain edit_file
// against the raw source is brittle (escaping, cell boundaries, outputs); this
// tool parses the notebook, edits one cell by id, and writes it back in Jupyter's
// on-disk shape (nbformat 4, 1-space indent, arrayed sources).
//
// Modes: replace a cell's source (optionally changing its type), insert a new cell
// after a given cell (or at the top), or delete a cell.
import fs from 'node:fs'
import type { ToolDef, ToolResult } from './types'

type CellType = 'code' | 'markdown'
interface NbCell {
  cell_type: string
  id?: string
  metadata?: Record<string, unknown>
  source: string | string[]
  outputs?: unknown[]
  execution_count?: number | null
  [k: string]: unknown
}
interface Notebook {
  cells: NbCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
  [k: string]: unknown
}

// Store source as an array of lines, each keeping its trailing newline (except the
// last) — the shape Jupyter itself writes, which round-trips cleanly.
function toSourceLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  return parts.map((line, i) => (i < parts.length - 1 ? line + '\n' : line)).filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''))
}

function sourceToText(src: string | string[]): string {
  return Array.isArray(src) ? src.join('') : src
}

// A short, unique-enough cell id (nbformat 4.5 wants 1–64 of [A-Za-z0-9_-]).
function newCellId(existing: Set<string>): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10)
    if (!existing.has(id)) return id
  }
}

function makeCell(type: CellType, text: string, id: string): NbCell {
  const base: NbCell = { cell_type: type, id, metadata: {}, source: toSourceLines(text) }
  if (type === 'code') {
    base.outputs = []
    base.execution_count = null
  }
  return base
}

export const notebookEdit: ToolDef = {
  name: 'notebook_edit',
  description:
    'Edit a single cell of a Jupyter notebook (.ipynb) by cell id. Use this instead of edit_file for notebooks — it parses the JSON and preserves structure/outputs. ' +
    'Modes (`edit_mode`): "replace" (default) overwrites the cell\'s source with `new_source` (and its type if `cell_type` is given); "insert" adds a NEW cell with `new_source` right after the cell whose id is `cell_id` (or at the top when `cell_id` is omitted) — `cell_type` is required; "delete" removes the cell. ' +
    'For replace/delete, `cell_id` is required and must match a cell\'s id. `notebook_path` must be an absolute path.',
  input_schema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
      cell_id: { type: 'string', description: 'Id of the cell to replace/delete, or (for insert) the cell to insert after. Omit on insert to add at the top.' },
      new_source: { type: 'string', description: 'The new cell source (for replace/insert).' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type. Required for insert; on replace it changes the cell\'s type.' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'replace (default) | insert | delete.' },
    },
    required: ['notebook_path'],
  },
  async run(input): Promise<ToolResult> {
    const p = typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (!p) return { content: 'notebook_edit: `notebook_path` is required', isError: true }
    const mode = (typeof input.edit_mode === 'string' ? input.edit_mode : 'replace') as 'replace' | 'insert' | 'delete'
    const cellId = typeof input.cell_id === 'string' ? input.cell_id : undefined
    const newSource = typeof input.new_source === 'string' ? input.new_source : ''
    const cellType = input.cell_type === 'code' || input.cell_type === 'markdown' ? (input.cell_type as CellType) : undefined

    let raw: string
    try {
      raw = fs.readFileSync(p, 'utf8')
    } catch (e) {
      return { content: `notebook_edit: cannot read ${p}: ${(e as Error).message}`, isError: true }
    }
    let nb: Notebook
    try {
      nb = JSON.parse(raw) as Notebook
    } catch (e) {
      return { content: `notebook_edit: ${p} is not valid JSON: ${(e as Error).message}`, isError: true }
    }
    if (!Array.isArray(nb.cells)) return { content: `notebook_edit: ${p} has no cells array`, isError: true }

    const ids = new Set<string>(nb.cells.map((c) => (typeof c.id === 'string' ? c.id : '')).filter(Boolean))
    const idx = cellId ? nb.cells.findIndex((c) => c.id === cellId) : -1

    if (mode === 'insert') {
      if (!cellType) return { content: 'notebook_edit: `cell_type` is required for insert', isError: true }
      if (cellId && idx < 0) return { content: `notebook_edit: no cell with id "${cellId}"`, isError: true }
      const cell = makeCell(cellType, newSource, newCellId(ids))
      const at = cellId ? idx + 1 : 0
      nb.cells.splice(at, 0, cell)
      writeNotebook(p, nb)
      return { content: `Inserted a ${cellType} cell (id ${cell.id}) at position ${at} in ${p}.`, display: `notebook_edit · insert ${cellType}` }
    }

    if (mode === 'delete') {
      if (!cellId) return { content: 'notebook_edit: `cell_id` is required for delete', isError: true }
      if (idx < 0) return { content: `notebook_edit: no cell with id "${cellId}"`, isError: true }
      nb.cells.splice(idx, 1)
      writeNotebook(p, nb)
      return { content: `Deleted cell "${cellId}" from ${p}.`, display: `notebook_edit · delete` }
    }

    // replace
    if (!cellId) return { content: 'notebook_edit: `cell_id` is required for replace', isError: true }
    if (idx < 0) return { content: `notebook_edit: no cell with id "${cellId}"`, isError: true }
    const cell = nb.cells[idx]
    cell.source = toSourceLines(newSource)
    if (cellType && cellType !== cell.cell_type) {
      cell.cell_type = cellType
      if (cellType === 'code') {
        if (!Array.isArray(cell.outputs)) cell.outputs = []
        if (cell.execution_count === undefined) cell.execution_count = null
      } else {
        delete cell.outputs
        delete cell.execution_count
      }
    }
    writeNotebook(p, nb)
    return { content: `Replaced source of cell "${cellId}" in ${p}.`, display: `notebook_edit · replace` }
  },
}

// Write the notebook back in Jupyter's on-disk format: 1-space indent, trailing
// newline. Keeps diffs against Jupyter-saved files minimal.
function writeNotebook(p: string, nb: Notebook): void {
  fs.writeFileSync(p, JSON.stringify(nb, null, 1) + '\n', 'utf8')
}

// Exposed for tests / callers that want the text of a cell's source.
export { sourceToText }
