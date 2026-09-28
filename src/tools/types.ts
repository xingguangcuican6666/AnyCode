// Agent tools — modeled on the standard coding-agent toolset (read/write/edit a
// file, run a shell command, search by content or by name). A ToolDef couples
// the model-facing schema (name/description/JSON schema, in Anthropic's tool
// format) with a `run` that actually performs the action and returns text.
import type { AgentSnapshot, DiffLine, WorkflowSnapshot } from '../types'

export interface ToolResult {
  content: string
  // Optional SHORT text shown in the terminal transcript in place of `content`.
  // `content` still goes to the model verbatim (so internal guidance/handles stay
  // in context); `display` is only what the user sees, keeping the frontend clean.
  // Absent → the UI falls back to `content`.
  display?: string
  isError?: boolean
  // Code-change accounting for the Usage tab's "Total code changes". Set by the
  // file-mutating tools (write_file/edit_file); absent for read-only tools.
  linesAdded?: number
  linesRemoved?: number
  // A unified diff of the change (line numbers + context/+/- rows), set by
  // write_file/edit_file so the UI can render a collapsible diff view. Absent
  // for read-only tools, or when the file is too large to diff.
  diff?: DiffLine[]
}

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
  // Run a nested sub-agent and return its final report. Supplied by the agent
  // loop (see providers/anthropic) so the orchestration tools (`task`,
  // `workflow`) can delegate without tools/impl importing a provider — which
  // would form an import cycle. Absent inside a sub-agent, so nesting is capped
  // at one level (a sub-agent cannot spawn further sub-agents).
  spawnAgent?: (opts: SpawnOpts) => Promise<SpawnResult>
  // Live progress sink for the `workflow` tool: called with a fresh snapshot each
  // time a sub-agent changes state (queued→running→done/error), so the UI can
  // render a live tree. Threaded from StreamOpts.onWorkflow by the agent loop.
  // Absent = no live reporting (the workflow still runs and returns its report).
  onWorkflow?: (snap: WorkflowSnapshot) => void
  // Live sink for `task`/`plan` sub-agents surfaced as switchable transcripts:
  // called with a fresh snapshot each time the sub-agent emits an event. Threaded
  // from StreamOpts.onAgent by the agent loop. Absent = no switchable view.
  onAgent?: (snap: AgentSnapshot) => void
  // True only at the top level: whether `task`/`workflow` may run in the
  // BACKGROUND (return a handle immediately and keep running past the turn, see
  // lib/background). Withheld from sub-agents so background orchestration — like
  // ordinary orchestration — never nests.
  allowBackground?: boolean
}

export interface SpawnOpts {
  prompt: string
  // Optional role/system override for the sub-agent (e.g. an explorer vs a coder).
  system?: string
  // Short human label for the sub-task (shown in the returned report).
  label?: string
  // Called with each event the sub-agent emits (text/tool_use/tool_result/…), so
  // the orchestrating tool can accumulate the sub-agent's live transcript and
  // surface it through ctx.onAgent. Absent = the caller only wants the final result.
  onEvent?: (ev: import('../types').AgentEvent) => void
  // Optional per-spawn abort signal. When set, it (not the turn's signal) governs
  // this sub-agent, so a BACKGROUND run can be cancelled independently of the main
  // turn (see lib/background + useChat.interrupt). Absent = use the turn's signal.
  signal?: AbortSignal
}

export interface SpawnResult {
  text: string    // the sub-agent's final prose
  steps: number   // how many tool calls it made
  error?: string  // set if the sub-agent hit a transport/API error
}

export interface ToolDef {
  name: string
  description: string
  // JSON Schema for the tool input (Anthropic `input_schema` shape).
  input_schema: Record<string, unknown>
  // Orchestration tools (`task`, `workflow`) drive sub-agents; they are offered
  // to the top-level agent only and withheld from sub-agents (see toolSchemas).
  orchestration?: boolean
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
