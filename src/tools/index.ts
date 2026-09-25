// Public surface of the agent toolset: the registry, the Anthropic-format tool
// schemas to hand the model, and a dispatcher that runs a tool by name.
import type { ToolContext, ToolDef, ToolResult } from './types'
import { TOOLS } from './impl'

export type { ToolContext, ToolDef, ToolResult, SpawnOpts, SpawnResult } from './types'
export { TOOLS } from './impl'
export { renderWorkflowReport } from './impl'

// The Anthropic-format tool list handed to the model. Orchestration tools
// (`task`, `workflow`) drive sub-agents; they're offered to the top-level agent
// only and withheld from sub-agents (pass includeOrchestration=false) so a
// sub-agent can't recurse into more sub-agents.
export function toolSchemas(includeOrchestration = true): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return TOOLS.filter((t) => includeOrchestration || !t.orchestration).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
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
    case 'read_file': return `read_file · ${i.path ?? ''}`
    case 'write_file': return `write_file · ${i.path ?? ''}`
    case 'edit_file': return `edit_file · ${i.path ?? ''}`
    case 'grep': return `grep · ${i.pattern ?? ''}${i.glob ? ` (${i.glob})` : ''}`
    case 'glob': return `glob · ${i.pattern ?? ''}`
    case 'list_dir': return `list_dir · ${i.path ?? '.'}`
    case 'task': return `task · ${i.description || String(i.subagent_type ?? 'general')}`
    case 'plan': return `plan · ${i.description || 'plan'}`
    case 'workflow': {
      const n = Array.isArray(i.tasks) ? i.tasks.length : 0
      return `workflow · ${n} sub-task${n === 1 ? '' : 's'}`
    }
    default: return `${name} · ${JSON.stringify(i).slice(0, 80)}`
  }
}
