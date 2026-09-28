// The agent tool registry. The concrete implementations live in two modules —
// the basic file/shell/search tools in ./fs-tools, and the sub-agent
// orchestration tools (task/plan/workflow + background check/collect) in
// ./orchestration — with small shared helpers in ./util. This module just
// assembles them into the ordered TOOLS list the loop consumes, and re-exports
// renderWorkflowReport for the providers (see providers/mock).
import type { ToolDef } from './types'
import { bash, readFile, writeFile, editFile, grep, globTool, listDir } from './fs-tools'
import { task, plan, workflow, agentStatus, agentWait } from './orchestration'

export { renderWorkflowReport } from './orchestration'

export const TOOLS: ToolDef[] = [bash, readFile, writeFile, editFile, grep, globTool, listDir, task, plan, workflow, agentStatus, agentWait]
