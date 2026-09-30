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
const MUTATING = new Set(['write_file', 'edit_file', 'notebook_edit', 'bash'])
// The file-editing tools specifically — `acceptEdits` auto-approves these but
// still prompts for `bash` (which can do anything).
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit'])

export function isMutating(tool: string): boolean {
  // MCP tools (mcp__<server>__<tool>) are external calls that may do anything
  // (write files, hit the network), so they gate like `bash`: prompt in default
  // and acceptEdits, deny in plan. Kept as an inline prefix test so this module
  // stays dependency-free.
  return MUTATING.has(tool) || tool.startsWith('mcp__')
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

// ── Persistent permission rules ──────────────────────────────────────────────
//
// A user-managed layer on top of the mode (Claude Code's allow/deny/ask lists).
// Rules are strings: a bare tool name (`bash`, `Edit`) matches every call to it,
// or `Tool(pattern)` matches when the call's target — the command for bash, the
// path for file tools, the url/domain for web_fetch, the pattern for grep/glob —
// glob-matches `pattern` (`*` = any run of chars). Tool names are matched loosely
// so Claude Code's capitalized aliases (`Bash`, `Edit`, `Read`, `WebFetch`) map to
// our snake_case tools; a rule tool token containing `*` globs the raw tool name
// (handy for `mcp__server__*`). web_fetch also accepts `domain:example.com`.

export interface PermissionRules {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

// Claude Code–style capitalized tool names → our tool ids (keyed by the name with
// underscores stripped and lowercased, so both `Edit` and `edit_file` resolve).
const TOOL_ALIASES: Record<string, string> = {
  bash: 'bash', shell: 'bash',
  edit: 'edit_file', editfile: 'edit_file', multiedit: 'edit_file',
  write: 'write_file', writefile: 'write_file',
  read: 'read_file', readfile: 'read_file',
  notebookedit: 'notebook_edit',
  webfetch: 'web_fetch', fetch: 'web_fetch',
  websearch: 'web_search', search: 'web_search',
  grep: 'grep', glob: 'glob', listdir: 'list_dir', ls: 'list_dir',
}

// Compile a glob (only `*` is special) to an anchored, case-sensitive RegExp.
function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${esc}$`)
}

// Does a rule's tool token refer to the tool actually being called?
function toolMatches(ruleTool: string, actual: string): boolean {
  const r = ruleTool.trim()
  if (!r) return false
  if (r === '*') return true
  if (r.includes('*')) return globToRe(r).test(actual)          // e.g. mcp__github__*
  const rl = r.toLowerCase()
  if (rl === actual.toLowerCase()) return true
  return TOOL_ALIASES[rl.replace(/_/g, '')] === actual
}

// The string a rule's pattern is matched against, per tool. Empty when the tool
// has no natural target (then only a bare, pattern-less rule can match it).
function ruleTarget(tool: string, input: Record<string, unknown>): string {
  const i = input ?? {}
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (tool) {
    case 'bash': return s(i.command)
    case 'read_file': case 'write_file': case 'edit_file': return s(i.path) || s(i.file_path)
    case 'notebook_edit': return s(i.notebook_path) || s(i.path)
    case 'web_fetch': return s(i.url)
    case 'web_search': return s(i.query)
    case 'grep': case 'glob': return s(i.pattern)
    case 'list_dir': return s(i.path)
    default: return tool.startsWith('mcp__') ? tool : ''
  }
}

// The host of a URL, for web_fetch `domain:` rules. '' when unparseable.
function urlHost(url: string): string {
  try { return new URL(url).host.toLowerCase() } catch { return '' }
}

// Does one rule string match this call?
function ruleMatches(rule: string, tool: string, input: Record<string, unknown>): boolean {
  const trimmed = rule.trim()
  if (!trimmed) return false
  // Split `Tool(pattern)` → tool token + inner pattern; a bare token has none.
  const m = /^([^()]+)\(([\s\S]*)\)\s*$/.exec(trimmed)
  const toolTok = (m ? m[1] : trimmed).trim()
  const pattern = m ? m[2].trim() : undefined
  if (!toolMatches(toolTok, tool)) return false
  if (pattern === undefined || pattern === '') return true      // bare tool rule
  const target = ruleTarget(tool, input)
  // web_fetch domain rule: match the URL host (exact or a parent domain).
  if (tool === 'web_fetch' && pattern.toLowerCase().startsWith('domain:')) {
    const want = pattern.slice('domain:'.length).trim().toLowerCase()
    const host = urlHost(target)
    return !!want && !!host && (host === want || host.endsWith(`.${want}`))
  }
  if (!target) return false
  return globToRe(pattern).test(target)
}

function anyRuleMatches(rules: string[] | undefined, tool: string, input: Record<string, unknown>): boolean {
  return Array.isArray(rules) && rules.some((r) => ruleMatches(r, tool, input))
}

/**
 * Evaluate the persistent rules for a call. Precedence: a matching `deny` wins,
 * then `ask`, then `allow` (so a user can force-prompt a subset of a broadly
 * allowed tool). Returns undefined when no rule matches, so the caller falls back
 * to the mode decision.
 */
export function matchPermissionRule(
  tool: string,
  input: Record<string, unknown>,
  rules: PermissionRules | undefined,
): 'allow' | 'deny' | 'ask' | undefined {
  if (!rules) return undefined
  if (anyRuleMatches(rules.deny, tool, input)) return 'deny'
  if (anyRuleMatches(rules.ask, tool, input)) return 'ask'
  if (anyRuleMatches(rules.allow, tool, input)) return 'allow'
  return undefined
}

export const DENY_RULE_REASON =
  '该工具调用被权限规则拒绝（deny）。请改用其它方式完成任务；如属误配，可让用户用 /permissions 调整规则。'
