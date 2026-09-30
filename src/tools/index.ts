// Public surface of the agent toolset: the registry, the Anthropic-format tool
// schemas to hand the model, and a dispatcher that runs a tool by name.
import type { ToolContext, ToolDef, ToolResult } from './types'
import { TOOLS } from './impl'
import { subagentTypeNames } from './orchestration'
import { mcpToolDefs, findMcpTool, isMcpToolName } from '../lib/mcp'

export type { ToolContext, ToolDef, ToolResult, SpawnOpts, SpawnResult } from './types'
export { TOOLS } from './impl'
export { renderWorkflowReport } from './impl'

// Patch the dynamic `subagent_type` enum (built-in roles + custom .anycode/agents)
// into a cloned schema for the task/workflow tools, so the model sees the custom
// agents available in `cwd`. Other tools pass through unchanged.
function withDynamicEnums(name: string, schema: Record<string, unknown>, cwd: string): Record<string, unknown> {
  if (name !== 'task' && name !== 'workflow') return schema
  const names = subagentTypeNames(cwd)
  const clone = structuredClone(schema) as Record<string, unknown>
  const props = (clone.properties ?? {}) as Record<string, any>
  if (name === 'task' && props.subagent_type) props.subagent_type.enum = names
  if (name === 'workflow' && props.tasks?.items?.properties?.subagent_type) {
    props.tasks.items.properties.subagent_type.enum = names
  }
  return clone
}

// The Anthropic-format tool list handed to the model. Orchestration tools
// (`task`, `workflow`) drive sub-agents; they're offered to the top-level agent
// only and withheld from sub-agents (pass includeOrchestration=false) so a
// sub-agent can't recurse into more sub-agents. `allowWorkflow=false` (the
// `dynamicWorkflows` setting turned off) additionally drops the `workflow` tool
// so the agent can still delegate one-off `task`s but not orchestrate multi-step
// workflows. `cwd` (when given) drives the dynamic `subagent_type` enum.
// `planMode` (top-level + `plan` permission mode) surfaces the `exit_plan_mode`
// approval tool, which is otherwise withheld — it only makes sense while planning.
export function toolSchemas(includeOrchestration = true, allowWorkflow = true, cwd?: string, planMode = false): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  const builtin = TOOLS.filter((t) => (includeOrchestration || !t.orchestration) && (allowWorkflow || t.name !== 'workflow') && (planMode || t.name !== 'exit_plan_mode')).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: cwd ? withDynamicEnums(t.name, t.input_schema, cwd) : t.input_schema,
  }))
  // Append discovered MCP tools (mcp__<server>__<tool>). Empty until servers
  // finish their handshake, so they surface on the next turn after startup.
  const mcp = mcpToolDefs().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  return mcp.length ? [...builtin, ...mcp] : builtin
}

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name) ?? (isMcpToolName(name) ? findMcpTool(name) : undefined)
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = findTool(name)
  if (!tool) return { content: `unknown tool: ${name}`, isError: true }
  try {
    return await tool.run(input ?? {}, ctx)
  } catch (e) {
    if (ctx.signal?.aborted) return { content: '(aborted)', isError: true }
    return { content: `tool ${name} threw: ${(e as Error).message}`, isError: true }
  }
}

/** A one-line, human-readable summary of a tool call for the transcript. */
export function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  const i = input ?? {}
  switch (name) {
    case 'bash': return `bash · ${String(i.command ?? '').split('\n')[0].slice(0, 80)}`
    case 'bash_output': return `bash_output · ${String(i.action ?? 'read')}${i.bash_id ? ` ${i.bash_id}` : ''}`
    case 'read_file': return `read_file · ${i.path ?? ''}`
    case 'write_file': return `write_file · ${i.path ?? ''}`
    case 'edit_file': return `edit_file · ${i.path ?? ''}`
    case 'grep': return `grep · ${i.pattern ?? ''}${i.glob ? ` (${i.glob})` : ''}`
    case 'glob': return `glob · ${i.pattern ?? ''}`
    case 'list_dir': return `list_dir · ${i.path ?? '.'}`
    case 'memory': return `memory · ${String(i.action ?? '')}${i.name ? ` ${i.name}` : ''}`
    case 'web_fetch': return `web_fetch · ${i.url ?? ''}`
    case 'web_search': return `web_search · ${i.query ?? ''}`
    case 'todo_write': return `todo_write · ${Array.isArray(i.todos) ? i.todos.length : 0} item${Array.isArray(i.todos) && i.todos.length === 1 ? '' : 's'}`
    case 'message': return `message · ${String(i.action ?? '')}${i.to ? ` → ${i.to}` : ''}`
    case 'ask_user': {
      const n = Array.isArray(i.questions) ? i.questions.length : 0
      return `ask_user · ${n} question${n === 1 ? '' : 's'}`
    }
    case 'schedule': return `schedule · ${String(i.action ?? '')}${i.id ? ` ${i.id}` : ''}`
    case 'monitor': return `monitor · ${String(i.action ?? '')}${i.id ? ` ${i.id}` : ''}`
    case 'skill': return `skill · ${i.name ?? '(list)'}`
    case 'exit_plan_mode': return 'exit_plan_mode · 请求批准计划'
    case 'notebook_edit': return `notebook_edit · ${String(i.edit_mode ?? 'replace')}${i.cell_id ? ` ${i.cell_id}` : ''}`
    case 'task': return `task · ${i.description || String(i.subagent_type ?? 'general')}`
    case 'plan': return `plan · ${i.description || 'plan'}`
    case 'agent_status': return 'agent_status'
    case 'agent_wait': return `agent_wait${Array.isArray(i.ids) && i.ids.length ? ` · ${i.ids.length} handle(s)` : ' · all'}`
    case 'workflow': {
      const n = Array.isArray(i.tasks) ? i.tasks.length : 0
      return `workflow · ${n} sub-task${n === 1 ? '' : 's'}`
    }
    default:
      if (isMcpToolName(name)) return `mcp · ${name.slice('mcp__'.length).replace('__', '/')}`
      return `${name} · ${JSON.stringify(i).slice(0, 80)}`
  }
}
