// The agent tool registry. The concrete implementations live in two modules —
// the basic file/shell/search tools in ./fs-tools, and the sub-agent
// orchestration tools (task/plan/workflow + background check/collect) in
// ./orchestration — with small shared helpers in ./util. This module just
// assembles them into the ordered TOOLS list the loop consumes, and re-exports
// renderWorkflowReport for the providers (see providers/mock).
import type { ToolDef } from './types'
import { bash, readFile, writeFile, editFile, grep, globTool, listDir } from './fs-tools'
import { task, plan, workflow, agentStatus, agentWait } from './orchestration'
import { memoryTool } from './memory-tool'
import { webFetch, webSearch } from './web'
import { todoWrite } from './todo'
import { messageTool } from './message-tool'
import { askUser } from './ask'
import { scheduleTool } from './schedule-tool'
import { monitorTool } from './monitor-tool'
import { skillTool } from './skill-tool'
import { notebookEdit } from './notebook-tool'
import { bashOutput } from './bash-output-tool'
import { exitPlanModeTool } from './plan-tool'

export { renderWorkflowReport } from './orchestration'

export const TOOLS: ToolDef[] = [bash, bashOutput, readFile, writeFile, editFile, grep, globTool, listDir, webFetch, webSearch, todoWrite, memoryTool, messageTool, askUser, scheduleTool, monitorTool, skillTool, notebookEdit, exitPlanModeTool, task, plan, workflow, agentStatus, agentWait]
