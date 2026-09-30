// exit_plan_mode — the plan-mode approval control tool, mirroring Claude Code's
// ExitPlanMode. It is offered to the TOP-LEVEL agent only while it is in the
// `plan` permission mode (see toolSchemas' planMode gate). The real approval flow
// lives in the provider's tool loop (providers/anthropic → handleExitPlanMode):
// it presents the finalized plan, asks the user to approve leaving plan mode
// (auto-accept edits vs. confirm each change), and — on approval — flips the
// permission mode so edits are allowed immediately and persists the change via
// StreamOpts.onPermissionModeChange.
//
// This ToolDef exists so the tool has a schema, a registration, and a
// summarize/dispatch entry. Its run() is only a fallback for contexts that never
// reach the provider's special-casing — a sub-agent or a headless run, where no
// interactive approver exists; it simply reports that and returns the plan.
import type { ToolDef } from './types'
import { t } from '../lib/i18n'

export const exitPlanModeTool: ToolDef = {
  name: 'exit_plan_mode',
  description:
    'Present a completed implementation plan and ask the user to approve leaving plan mode before you make any changes. Call this ONLY when you are in plan mode and have finished researching and written a concrete, step-by-step plan for the work ahead. Pass the plan itself in `plan` (concise Markdown). If the user approves, plan mode ends and you may begin implementing; if they decline, refine the plan per their feedback and call it again. Do NOT call this for questions, research-only tasks, or when you are not in plan mode.',
  input_schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The finalized implementation plan to present for approval, as concise Markdown.',
      },
    },
    required: ['plan'],
  },
  async run(input) {
    const plan = String((input as { plan?: unknown })?.plan ?? '').trim()
    if (!plan) return { content: 'exit_plan_mode requires a non-empty `plan`.', isError: true }
    // Fallback path only (see file header): no interactive approver is present in
    // this context, so report that and hand the plan text back to the caller.
    return { content: t('exitPlan.noApprover'), isError: false }
  },
}
