// Settings schema for /config. AnyCode mirrors Claude Code's Config tab: a broad
// surface of toggles, enums, and values. Rather than a field-per-setting on
// AppConfig plus a giant switch, we describe every setting once here — its type,
// default, allowed values, and label — and drive the whole /config command
// (listing, validation, coercion, display) from this table. New settings are one
// line each. The live values live in AppConfig.settings (a keyed bag), so they
// persist through saveConfig for free; core fields (provider/model/theme/system)
// keep their own typed slots and are handled directly by /config.
import { t } from './i18n'

export type SettingValue = boolean | string | number

export type SettingType = 'boolean' | 'enum' | 'number' | 'string'

export interface SettingSpec {
  key: string
  label: string
  group: string
  type: SettingType
  default: SettingValue
  values?: string[]  // enum options
  min?: number       // number bounds
  max?: number
  unit?: string      // display suffix for numbers, e.g. 's'
  description: string
}

// Ordered so /config groups read top-to-bottom like the real Config tab.
export const SETTINGS: SettingSpec[] = [
  // Context & model
  { key: 'autoCompact', label: 'Auto-compact', group: 'Context & model', type: 'boolean', default: true, description: 'Summarize older messages when the context window fills' },
  { key: 'autoCompactWindow', label: 'Auto-compact window', group: 'Context & model', type: 'number', min: 0, max: 10_000_000, unit: ' tok', default: 0, description: 'Trigger auto-compact once the context reaches this many tokens (0 = auto, use the model’s window). Set with /autocompact' },
  { key: 'continueAtUsageLimit', label: 'Continue automatically at usage limit', group: 'Context & model', type: 'boolean', default: false, description: 'Keep going when a usage limit is hit instead of stopping' },
  { key: 'switchModelOnFlag', label: 'Switch models when a message is flagged', group: 'Context & model', type: 'boolean', default: false, description: 'Fall back to another model if a message is flagged' },
  { key: 'fallbackModel', label: 'Fallback model', group: 'Context & model', type: 'string', default: '', description: 'Model id to switch to when a message is flagged (requires the setting above)' },
  { key: 'thinkingMode', label: 'Thinking mode', group: 'Context & model', type: 'enum', values: ['auto', 'off', 'on'], default: 'auto', description: 'Extended thinking before responding' },
  { key: 'effort', label: 'Reasoning effort', group: 'Context & model', type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium', description: 'How much reasoning/verification the agent applies (set with /effort)' },
  { key: 'contextWindow', label: 'Context window override', group: 'Context & model', type: 'number', min: 0, max: 10_000_000, unit: ' tok', default: 0, description: 'Force the context-window size in tokens (0 = auto-detect from the model)' },
  // Interface
  { key: 'showTips', label: 'Show tips', group: 'Interface', type: 'boolean', default: true, description: 'Occasional usage tips in the footer' },
  { key: 'draftedFeedback', label: 'Claude-drafted feedback', group: 'Interface', type: 'boolean', default: true, description: 'Offer a drafted message when reporting feedback' },
  { key: 'reduceMotion', label: 'Reduce motion', group: 'Interface', type: 'boolean', default: false, description: 'Minimize spinners and animations' },
  { key: 'promptSuggestions', label: 'Prompt suggestions', group: 'Interface', type: 'boolean', default: true, description: 'Suggest follow-up prompts' },
  { key: 'sessionRecap', label: 'Session recap', group: 'Interface', type: 'boolean', default: true, description: 'Recap what happened when resuming a session' },
  { key: 'verbose', label: 'Verbose output', group: 'Interface', type: 'boolean', default: false, description: 'Show full, untruncated tool output' },
  { key: 'progressBar', label: 'Terminal progress bar', group: 'Interface', type: 'boolean', default: true, description: 'Draw a progress bar in the terminal title' },
  { key: 'showTurnDuration', label: 'Show turn duration', group: 'Interface', type: 'boolean', default: true, description: 'Display how long each turn took' },
  { key: 'timeFormat', label: 'Time format', group: 'Interface', type: 'enum', values: ['24h', '12h'], default: '24h', description: 'Clock format for timestamps' },
  { key: 'autoScroll', label: 'Auto-scroll', group: 'Interface', type: 'boolean', default: true, description: 'Follow output as it streams' },
  { key: 'outputStyle', label: 'Output style', group: 'Interface', type: 'enum', values: ['default', 'concise', 'explanatory'], default: 'default', description: 'How much explanation responses include' },
  { key: 'language', label: 'Language', group: 'Interface', type: 'enum', values: ['auto', 'zh', 'en'], default: 'auto', description: 'UI language (auto = match your shell locale)' },
  { key: 'prStatusFooter', label: 'Show PR status footer', group: 'Interface', type: 'boolean', default: true, description: 'Footer line with the current PR status' },
  { key: 'statusLine', label: 'Custom status line', group: 'Interface', type: 'string', default: '', description: 'Shell command whose first stdout line renders as a footer; receives a JSON context (model, provider, cwd, version, tokens, turns) on stdin. Set with /statusline' },
  { key: 'openAgentsView', label: 'Open agents view by default', group: 'Interface', type: 'boolean', default: false, description: 'Start with the agents panel open' },
  // Workflow
  { key: 'rewindCode', label: 'Rewind code (checkpoints)', group: 'Workflow', type: 'boolean', default: true, description: 'Keep checkpoints so edits can be rewound' },
  { key: 'dynamicWorkflows', label: 'Dynamic workflows', group: 'Workflow', type: 'boolean', default: true, description: 'Let the agent orchestrate multi-step workflows' },
  { key: 'ultracodeTrigger', label: 'Ultracode keyword trigger', group: 'Workflow', type: 'boolean', default: false, description: 'Enable the "ultracode" keyword for large fan-out' },
  { key: 'dynamicWorkflowSize', label: 'Dynamic workflow size', group: 'Workflow', type: 'enum', values: ['small', 'medium', 'large'], default: 'medium', description: 'Guideline for how many agents a workflow may spawn' },
  { key: 'artifacts', label: 'Artifacts', group: 'Workflow', type: 'boolean', default: true, description: 'Allow rendering standalone artifacts' },
  { key: 'permissionMode', label: 'Default permission mode', group: 'Workflow', type: 'enum', values: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], default: 'default', description: 'Permission mode new sessions start in' },
  { key: 'worktreeBaseRef', label: 'Worktree base ref', group: 'Workflow', type: 'enum', values: ['fresh', 'head'], default: 'fresh', description: 'Base a new worktree on origin default (fresh) or local HEAD' },
  { key: 'autoModeInPlan', label: 'Use auto mode during plan', group: 'Workflow', type: 'boolean', default: false, description: 'Run read-only tools automatically while planning' },
  { key: 'questionTimeout', label: 'Question auto-continue timeout', group: 'Workflow', type: 'number', min: 0, max: 600, unit: 's', default: 30, description: 'Seconds before an unanswered question auto-continues (0 = never)' },
  // Editor & input
  { key: 'editorMode', label: 'Editor mode', group: 'Editor & input', type: 'enum', values: ['normal', 'vim', 'emacs'], default: 'normal', description: 'Key bindings for the prompt input' },
  { key: 'respectGitignore', label: 'Respect .gitignore in file picker', group: 'Editor & input', type: 'boolean', default: true, description: 'Hide ignored files from the picker' },
  { key: 'skipCopyPicker', label: 'Skip the /copy picker', group: 'Editor & input', type: 'boolean', default: false, description: 'Copy immediately without the picker step' },
  { key: 'copyOnSelect', label: 'Copy on select', group: 'Editor & input', type: 'boolean', default: false, description: 'Copy selected text to the clipboard automatically' },
  { key: 'leftArrowOpensAgents', label: '← opens agents', group: 'Editor & input', type: 'boolean', default: true, description: 'Left arrow at column 0 opens the agents view when sub-agents exist' },
  { key: 'lastResponseInEditor', label: 'Show last response in external editor', group: 'Editor & input', type: 'boolean', default: false, description: 'Open the last response in $EDITOR' },
  // Notifications & sessions
  { key: 'localNotifications', label: 'Local notifications', group: 'Notifications & sessions', type: 'boolean', default: true, description: 'Desktop notifications when the terminal is unfocused' },
  { key: 'otherSessionMessages', label: 'Messages from your other sessions', group: 'Notifications & sessions', type: 'enum', values: ['off', 'notify', 'deliver'], default: 'notify', description: 'How to surface messages from your other sessions' },
  { key: 'dialogExpiry', label: 'Dialog expiry', group: 'Notifications & sessions', type: 'number', min: 0, max: 86400, unit: 's', default: 300, description: 'Seconds before an idle dialog expires (0 = never)' },
  // Advanced
  { key: 'autoUpdateChannel', label: 'Auto-update channel', group: 'Advanced', type: 'enum', values: ['stable', 'latest'], default: 'stable', description: 'Which release channel to auto-update from' },
  { key: 'retryStatusCodes', label: 'Retry status codes', group: 'Advanced', type: 'string', default: '408,409,429,500-599', description: 'HTTP statuses to retry — codes and ranges, e.g. 408,409,429,500-599' },
  { key: 'retryMaxAttempts', label: 'Retry max attempts', group: 'Advanced', type: 'number', min: 1, max: 50, default: 10, description: 'Total tries per API request before giving up' },
  { key: 'autoConnectIde', label: 'Auto-connect to IDE (external terminal)', group: 'Advanced', type: 'boolean', default: false, description: 'Connect to a running IDE from an external terminal' },
  { key: 'chromeEnabled', label: 'Claude in Chrome enabled by default', group: 'Advanced', type: 'boolean', default: false, description: 'Enable the Chrome integration for new sessions' },
]

export const SETTINGS_BY_KEY: Record<string, SettingSpec> = Object.fromEntries(
  SETTINGS.map((s) => [s.key, s]),
)

// Groups in first-seen order, for a stable /config layout.
export function settingGroups(): string[] {
  const seen: string[] = []
  for (const s of SETTINGS) if (!seen.includes(s.group)) seen.push(s.group)
  return seen
}

// The default value bag stored on AppConfig.settings.
export function settingsDefaults(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const s of SETTINGS) out[s.key] = s.default
  return out
}

// Read a setting's live value, falling back to its default when unset. Tolerant
// of a settings bag written by an older build that predates a given key.
export function getSetting(bag: Record<string, SettingValue> | undefined, key: string): SettingValue {
  const spec = SETTINGS_BY_KEY[key]
  const v = bag?.[key]
  if (v === undefined || v === null) return spec ? spec.default : ''
  return v
}

// Human-readable value for listing: booleans as on/off, numbers with their unit.
export function formatSettingValue(spec: SettingSpec, value: SettingValue): string {
  if (spec.type === 'boolean') return value ? 'on' : 'off'
  if (spec.type === 'number') return `${value}${spec.unit ?? ''}`
  return String(value)
}

const TRUEY = new Set(['on', 'true', 'yes', '1', 'enable', 'enabled'])
const FALSEY = new Set(['off', 'false', 'no', '0', 'disable', 'disabled'])

export interface CoerceResult {
  ok: boolean
  value?: SettingValue
  error?: string
}

// Parse and validate a raw string against a setting's type, so /config can reject
// bad input with a helpful message instead of storing garbage.
export function coerceSetting(spec: SettingSpec, raw: string): CoerceResult {
  const v = raw.trim()
  switch (spec.type) {
    case 'boolean': {
      const low = v.toLowerCase()
      if (TRUEY.has(low)) return { ok: true, value: true }
      if (FALSEY.has(low)) return { ok: true, value: false }
      return { ok: false, error: t('set.errOnOff', { v }) }
    }
    case 'enum': {
      const low = v.toLowerCase()
      const match = (spec.values ?? []).find((o) => o.toLowerCase() === low)
      if (!match) return { ok: false, error: t('set.errOneOf', { values: (spec.values ?? []).join(', ') }) }
      return { ok: true, value: match }
    }
    case 'number': {
      const n = Number(v)
      if (!Number.isFinite(n)) return { ok: false, error: t('set.errNumber', { v }) }
      if (spec.min !== undefined && n < spec.min) return { ok: false, error: t('set.errMin', { min: spec.min }) }
      if (spec.max !== undefined && n > spec.max) return { ok: false, error: t('set.errMax', { max: spec.max }) }
      return { ok: true, value: n }
    }
    default:
      return { ok: true, value: v }
  }
}

// A short hint of the accepted input for a setting, shown when it's queried alone.
export function settingHint(spec: SettingSpec): string {
  if (spec.type === 'boolean') return t('set.hintOnOff')
  if (spec.type === 'enum') return (spec.values ?? []).join(' | ')
  if (spec.type === 'number') {
    const lo = spec.min ?? 0
    const hi = spec.max !== undefined ? spec.max : '∞'
    return t('set.hintNumber', { lo, hi, unit: spec.unit ? ` (${spec.unit})` : '' })
  }
  return t('set.hintText')
}

// Reasoning-effort levels, ordered low→high, and the one-line behavioral
// directive each injects into the system preamble (see hooks/useChat). Effort is
// stored as the `effort` setting and driven by the /effort command; it steers how
// much the agent explores and verifies rather than any API-level thinking budget.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

const EFFORT_DIRECTIVE: Record<EffortLevel, string> = {
  low: 'Favor speed and brevity: do the minimum needed to answer correctly and skip exhaustive exploration.',
  medium: 'Balance thoroughness with efficiency: explore what the task needs, then act.',
  high: 'Think carefully: investigate the relevant code before acting and check your work as you go.',
  xhigh: 'Be rigorous and exhaustive: investigate deeply, consider edge cases, and verify with a build or tests before finishing.',
  max: 'Maximum rigor: exhaustively investigate, cross-check assumptions, and leave nothing unverified before you finish.',
}

export function isEffortLevel(v: string): v is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(v)
}

// The system-preamble line for a given effort level (undefined for an unknown
// level so callers can drop it cleanly).
export function effortDirective(level: string | undefined): string | undefined {
  if (!level || !isEffortLevel(level)) return undefined
  return `Reasoning effort: ${level}. ${EFFORT_DIRECTIVE[level]}`
}

// Extended-thinking token budget per effort level (0 = thinking off). Passed to
// the API as `thinking.budget_tokens` (see providers/anthropic); higher effort
// buys the model more room to reason before answering. Low/medium stay off so
// the default flow keeps its cost/latency and never trips a model that lacks
// extended-thinking support — /effort high+ opts in.
const THINKING_BUDGET: Record<EffortLevel, number> = {
  low: 0, medium: 0, high: 4096, xhigh: 8192, max: 12288,
}

export function thinkingBudgetFor(level: string | undefined): number {
  if (!level || !isEffortLevel(level)) return 0
  return THINKING_BUDGET[level]
}

// Combine the `thinkingMode` setting (auto/off/on) with the effort-derived
// budget. `off` disables extended thinking regardless of effort; `on` forces it
// on even when the effort tier's budget is 0 (using a modest floor so a model
// that supports thinking actually engages it); `auto` (the default) keeps the
// effort-driven behavior. Providers that don't support thinking ignore this.
const THINKING_ON_FLOOR = 4096
export function resolveThinkingBudget(level: string | undefined, mode: string | undefined): number {
  const base = thinkingBudgetFor(level)
  if (mode === 'off') return 0
  if (mode === 'on') return Math.max(base, THINKING_ON_FLOOR)
  return base
}

// The system-preamble line for the `outputStyle` setting. `default` adds nothing
// (returns undefined so the caller drops it cleanly); the others steer how much
// explanation the model wraps around its answers — mirroring effortDirective.
const OUTPUT_STYLE_DIRECTIVE: Record<string, string> = {
  concise: 'Output style: concise. Keep prose to the minimum that answers well — lead with the result, skip preamble and restatement, and prefer short paragraphs or tight lists.',
  explanatory: 'Output style: explanatory. Teach as you go — explain the reasoning behind non-obvious choices, note relevant trade-offs, and give enough context that the reader learns why, not just what.',
}
export function outputStyleDirective(style: string | undefined): string | undefined {
  if (!style || style === 'default') return undefined
  return OUTPUT_STYLE_DIRECTIVE[style]
}

// The system-preamble line for the `dynamicWorkflowSize` setting — a guideline
// (not a hard cap) on how many sub-agents a single workflow should spawn, mirroring
// how Claude Code nudges the fleet size. Only injected when `dynamicWorkflows` is
// on (no point sizing workflows the agent can't spawn). Unknown size → undefined.
const WORKFLOW_SIZE_DIRECTIVE: Record<string, string> = {
  small: 'Workflow size guideline: small — keep any multi-agent workflow under 5 sub-agents; prefer solving directly or with one or two agents unless the task clearly needs more.',
  medium: 'Workflow size guideline: medium — keep any multi-agent workflow under 10 sub-agents unless the task clearly calls for wider fan-out.',
  large: 'Workflow size guideline: large — you may spawn many sub-agents (dozens) when the task genuinely benefits from broad parallelism.',
}
export function workflowSizeDirective(size: string | undefined): string | undefined {
  if (!size) return undefined
  return WORKFLOW_SIZE_DIRECTIVE[size]
}
