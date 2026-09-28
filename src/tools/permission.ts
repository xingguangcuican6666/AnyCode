// Permission engine for the `permissionMode` + `autoModeInPlan` settings.
//
// Claude Code gates tool calls behind a permission mode: some modes run tools
// freely, some prompt before anything that changes the workspace, and "plan"
// mode forbids edits entirely so the agent researches then proposes a plan. We
// mirror that here. The provider consults `decidePermission` before each
// top-level tool call and either runs it, denies it (feeding the reason back to
// the model), or asks the user via an interactive dialog.
//
// The decision is intentionally pure and synchronous — the only async part
// (showing a dialog) lives in the provider/UI. Sub-agents can't show a dialog,
// so they only ever get the deterministic part of the policy (plan mode denies
// mutations); everything else a sub-agent may do runs.

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

export function isPermissionMode(v: string | undefined): v is PermissionMode {
  return !!v && (PERMISSION_MODES as readonly string[]).includes(v)
}

/**
 * The next mode when the user presses shift+tab, cycling in PERMISSION_MODES
 * order and wrapping around (default → acceptEdits → plan → bypassPermissions →
 * default). Mirrors Claude Code's shift+tab mode cycling.
 */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(mode)
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]
}

// Tools that change the workspace (write files or run arbitrary shell). Everything
// else in the toolset is read-only (read_file/grep/glob/list_dir) or an
// orchestration wrapper (task/plan/workflow/agent_*) that itself spawns sub-agents
// rather than mutating directly.
const MUTATING = new Set(['write_file', 'edit_file', 'bash'])
// The file-editing tools specifically — `acceptEdits` auto-approves these but
// still prompts for `bash` (which can do anything).
const EDIT_TOOLS = new Set(['write_file', 'edit_file'])

export function isMutating(tool: string): boolean {
  return MUTATING.has(tool)
}

export type PermissionAction =
  | { action: 'allow' }
  | { action: 'ask' }
  | { action: 'deny'; reason: string }

const PLAN_DENY_REASON =
  '当前处于 plan（规划）权限模式：只读研究可用，但不能修改工作区。请先给出计划，待用户确认后再执行改动。'

/**
 * Decide how a tool call should be handled under the given permission mode.
 * `autoModeInPlan` lets read-only tools run without a prompt while planning.
 * `sub` marks a sub-agent call — sub-agents can't show a dialog, so an 'ask'
 * collapses to 'allow' (the deterministic plan-mode denial still applies).
 */
export function decidePermission(
  mode: PermissionMode,
  tool: string,
  opts: { autoModeInPlan?: boolean; sub?: boolean } = {},
): PermissionAction {
  const { autoModeInPlan = false, sub = false } = opts

  if (mode === 'bypassPermissions') return { action: 'allow' }

  const mutating = isMutating(tool)

  if (mode === 'plan') {
    // Plan mode is read-only: never edit, even via a sub-agent.
    if (mutating) return { action: 'deny', reason: PLAN_DENY_REASON }
    // Read-only tools: auto-run when autoModeInPlan is on, else prompt (top level)
    // — sub-agents always proceed since they have no dialog.
    if (autoModeInPlan || sub) return { action: 'allow' }
    return { action: 'ask' }
  }

  // Sub-agents run autonomously in the remaining modes.
  if (sub) return { action: 'allow' }

  if (!mutating) return { action: 'allow' }

  if (mode === 'acceptEdits') {
    // Auto-accept file edits; still confirm arbitrary shell.
    if (EDIT_TOOLS.has(tool)) return { action: 'allow' }
    return { action: 'ask' }
  }

  // default mode: confirm every mutating call.
  return { action: 'ask' }
}
