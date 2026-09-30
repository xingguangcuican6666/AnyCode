export type Role = 'user' | 'assistant' | 'system' | 'tool'

// One row of a unified diff for the write/edit diff view. `context` is an
// unchanged line (dimmed), `add`/`del` the +/- lines (green/red), `hunk` a
// "⋯ N unchanged lines" separator between kept regions. Line numbers are 1-based
// (old file for del, new file for add, both for context).
export interface DiffLine {
  tag: 'context' | 'add' | 'del' | 'hunk'
  text: string
  oldNo?: number
  newNo?: number
}

// A structured content block a tool can return IN PLACE of plain text, so the
// model receives it inside the tool_result — used by read_file to hand back
// images and PDFs (multimodal read). `text` blocks caption the media; `image`
// and `document` carry base64 data with an Anthropic media_type. When a
// ToolResult sets `blocks`, the API request uses them; the transcript still
// shows the ToolResult's plain `content`/`display`.
export type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }

// A base64 image attached to a USER prompt (pasted from the clipboard or a
// dropped/typed image-file path — see lib/images). Rides on the Message's meta;
// wire.toApiMessages emits it as an Anthropic `image` content block.
export interface ImageAttachment {
  media_type: string
  data: string
}

export interface MessageMeta {
  interrupted?: boolean
  error?: boolean
  command?: string
  // A reasoning ("thinking") block: rendered as a dim, collapsed summary
  // ("✻ Thought for Ns") above the answer. `thinkingSeconds` is how long the
  // model spent thinking before it started answering.
  thinking?: boolean
  thinkingSeconds?: number
  // A transient retry notice (rendered in the warning color, not as an error).
  retry?: boolean
  // A compaction digest (see lib/compact). Rendered as a dim system line, but —
  // unlike other system messages — it MUST reach the model, so toApiMessages
  // carries it into the request as a user turn. Without this flag the summary
  // would be dropped and the model would "forget" everything that was folded.
  compacted?: boolean
  // Set on messages FOLDED by an in-place compaction. They stay VISIBLE in the
  // transcript (compaction no longer clears the screen — see app.tsx foldContext)
  // but are dropped from the model context: toApiMessages and contextTokens both
  // skip `folded` messages. The digest that stands in for them carries `compacted`
  // (above) plus `foldedCount` — how many messages it replaces, shown on its
  // collapsed one-line row (see lib/transcript).
  folded?: boolean
  foldedCount?: number
  // A write_file/edit_file result's unified diff, rendered as a line-numbered
  // green/red diff view (collapsible on click). Absent for non-mutating tools.
  diff?: DiffLine[]
  // A per-turn completion footer ("✻ <word> for <elapsed> · done <clock>"),
  // appended after the agent finishes a turn (see useChat). UI-only — role
  // 'system' keeps it out of the API history (toApiMessages drops it).
  turnDone?: boolean
  // Images attached to a USER message (pasted from the clipboard or a
  // dropped/typed image-file path — see lib/images, wire.toApiMessages). The
  // visible `content` carries "[Image #N]" placeholders; these hold the actual
  // base64 the model receives.
  attachments?: ImageAttachment[]
  // Contents injected for the `@path` mentions in a USER message (see
  // lib/mentions, wire.toApiMessages). The visible `content` keeps the clean
  // `@path` tokens; this block is appended to the text the model receives so it
  // sees the referenced files without a read_file round-trip.
  injectedContext?: string
}

export interface Message {
  id: string
  role: Role
  content: string
  meta?: MessageMeta
}

export interface StreamOpts {
  model: string
  system?: string
  signal?: AbortSignal
  // When > 0, request extended thinking with this token budget (see /effort →
  // thinkingBudgetFor). Providers that don't support it ignore the field.
  thinkingBudget?: number
  // Which HTTP status codes count as transient (retryable). A comma-separated
  // list of codes and inclusive ranges, e.g. '408,409,429,500-599'. Parsed by
  // the provider (see parseRetryCodes); absent = the provider's built-in default.
  retryStatusCodes?: string
  // Total tries per request before giving up. Absent = the provider default.
  retryMaxAttempts?: number
  // When true, a usage/rate limit (HTTP 429) no longer ends the turn at the
  // normal attempt cap: the provider keeps waiting (honoring Retry-After, up to a
  // bounded number of waits) and continues instead of surfacing the limit as an
  // error. Maps to the `continueAtUsageLimit` setting.
  continueAtUsageLimit?: boolean
  // When true, a `refusal` stop reason (the message was flagged) makes the
  // provider retry the turn once with `fallbackModel` instead of surfacing the
  // refusal. Maps to the `switchModelOnFlag` setting; no-op without fallbackModel.
  switchModelOnFlag?: boolean
  // The model to fall back to for switchModelOnFlag. Absent = no switch possible.
  fallbackModel?: string
  // Live progress callback for the `workflow` tool: called as its sub-agents move
  // queued→running→done so the UI can render a live tree. Threaded into the tool
  // context by the provider (see providers/anthropic). Optional; absent = no live
  // reporting (the workflow still runs and returns its final report).
  onWorkflow?: (snap: WorkflowSnapshot) => void
  // Live callback for `task`/`plan` sub-agents: called as a switchable sub-agent
  // streams its own events, so the UI can list it in the bottom agent switcher and
  // swap the viewport to its transcript. Distinct from onWorkflow (a progress
  // tree). Threaded by the provider; absent = no switchable view.
  onAgent?: (snap: AgentSnapshot) => void
  // Mid-turn interjection drain: called by the top-level agent loop right after a
  // tool batch, it returns any user lines typed WHILE the turn was streaming
  // (type-ahead) so they can be merged into the very next model request instead of
  // waiting for the turn to end. Returns [] when nothing is queued. Only the
  // top-level agent gets this (sub-agents never drain interjections). See app.tsx's
  // `queued` state and useChat's opts wiring.
  takePending?: () => string[]
  // When false (the `dynamicWorkflows` setting turned off), the `workflow` tool is
  // withheld from the top-level agent so it can still run one-off `task` sub-agents
  // but not orchestrate multi-step workflows. Absent/true = workflows allowed.
  dynamicWorkflows?: boolean
  // When false (the `artifacts` setting turned off), saving a workflow run as a
  // standalone Markdown report (the expanded workflow view's `s` control) is
  // refused. Absent/true = artifacts allowed. Threaded into the tool context.
  artifacts?: boolean
  // When false (the `rewindCode` setting turned off), file tools skip snapshotting
  // pre-edit state, so /rewind has nothing to restore. Absent/true = checkpoints
  // kept. Threaded into the tool context.
  rewind?: boolean
  // Permission gating (the `permissionMode` + `autoModeInPlan` settings). The
  // provider consults these before each TOP-LEVEL tool call (see tools/permission
  // decidePermission): allow / deny (reason fed back to the model) / ask the user
  // via `requestPermission`. Sub-agents inherit only the deterministic part (plan
  // mode denies mutations) and never prompt. Absent permissionMode = 'default'.
  permissionMode?: string
  autoModeInPlan?: boolean
  // Interactive permission prompt: called by the top-level agent loop when a tool
  // needs the user's OK ('ask'). Resolves 'allow' to run it or 'deny' to skip it
  // (the denial is fed back as an error tool_result so the model can adapt).
  // Absent = no interactive gating (an 'ask' decision falls through to allow).
  requestPermission?: (req: PermissionRequest) => Promise<'allow' | 'deny'>
  // Interactive structured-question prompt (the `ask_user` tool): called when the
  // model needs a decision that is genuinely the user's to make and wants to offer
  // a few concrete options. Resolves with the user's selections (see
  // UserInputResponse). Absent (headless / sub-agent) = the tool reports that no
  // interactive user is available and the model proceeds on its own judgment.
  requestUserInput?: (req: UserInputRequest) => Promise<UserInputResponse>
  // Plan-mode exit: called by the top-level agent loop when the `exit_plan_mode`
  // tool is approved, so the host can flip the persistent `permissionMode` setting
  // (plan → acceptEdits or default) and reflect it in the UI. The provider also
  // updates its in-turn mode so edits are allowed immediately. Absent = the
  // provider still relaxes the current turn but the change isn't persisted.
  onPermissionModeChange?: (mode: string) => void
  // Persistent permission rules (the `permissions` config), layered on top of the
  // mode by the provider before each tool call. See AppConfig.permissions and
  // tools/permission matchPermissionRule. Threaded to sub-agents too (a deny rule
  // must bind them), but sub-agents can't prompt so an 'ask' collapses to allow.
  permissionRules?: { allow?: string[]; deny?: string[]; ask?: string[] }
}

// One pending permission prompt handed to the UI: which tool wants to run, its
// raw input, and a short human-readable summary line (see summarizeToolCall).
export interface PermissionRequest {
  tool: string
  input: Record<string, unknown>
  summary: string
}

// One structured question the `ask_user` tool poses, mirroring Claude Code's
// AskUserQuestion. `header` is a short chip label; `options` are the selectable
// answers. The UI ALWAYS also offers a free-form "Other" entry, so the model
// never needs to add one. `multiSelect` lets the user pick more than one option.
export interface UserQuestion {
  question: string
  header: string
  multiSelect?: boolean
  options: Array<{ label: string; description?: string }>
}

// A pending `ask_user` prompt handed to the UI (one or more questions), and the
// answer that comes back — one entry per question, in the same order, holding the
// chosen option labels (free-form "Other" text included verbatim). An empty inner
// array = that question was skipped; `cancelled` = the whole prompt was dismissed
// (esc), so the tool tells the model no answer was given.
export interface UserInputRequest {
  questions: UserQuestion[]
}
export interface UserInputResponse {
  answers: string[][]
  cancelled?: boolean
}

// One sub-agent inside a live `workflow` run, with its current state and timing
// so the progress panel can show "queued / running (Ns) / done".
export interface WorkflowAgent {
  label: string
  state: 'queued' | 'running' | 'done' | 'error'
  steps: number         // tool calls made so far (final count when done)
  startedAt?: number    // epoch ms when it began running (for a live elapsed timer)
  elapsedMs?: number    // wall time once done/errored
  error?: string
}

// Live controls the expanded workflow view drives (p pause/resume · s save). The
// functions close over the running tool's own state (a pause flag + its results),
// so calling them steers the in-flight workflow directly — no separate channel.
// Attached to each snapshot by the tool; absent when a provider can't drive them.
export interface WorkflowControls {
  pause: () => void
  resume: () => void
  save: () => Promise<string>   // write a report to disk, resolve with the path
}

// A snapshot of a running `workflow` tool call, emitted repeatedly as its agents
// progress. `done` flips true on the final snapshot. `paused` reflects whether
// new sub-agents are currently held (see WorkflowControls.pause).
export interface WorkflowSnapshot {
  id: string
  title: string         // e.g. "workflow · 3 sub-agents"
  agents: WorkflowAgent[]
  done: boolean
  paused?: boolean
  controls?: WorkflowControls
}

// A live sub-agent spawned by the `task`/`plan` tools, surfaced as a SWITCHABLE
// transcript view — conceptually different from a `workflow` (which is a
// collapsed line + an expandable progress TREE). Here the user selects the agent
// in the bottom switcher (○ main / ● <type> <activity>) and the main viewport
// swaps to render THAT agent's own chat. Its transcript is carried as the raw
// event stream (`events`) so the UI flattens it exactly like the main one.
// Emitted repeatedly through StreamOpts.onAgent as the sub-agent works; `done`
// flips true on the final snapshot.
export interface AgentSnapshot {
  id: string
  type: string          // sub-agent role, e.g. 'general' | 'explore' | 'plan'
  label: string         // short human label ("review src/app.tsx")
  activity: string      // current one-word activity ("starting"/"read_file"/"done")
  state: 'running' | 'done' | 'error'
  events: AgentEvent[]  // the sub-agent's own event stream → its transcript
  steps: number         // tool calls made so far
  startedAt?: number
  elapsedMs?: number
  error?: string
  done: boolean
}

/**
 * Events emitted while an agentic turn runs. `text` is streamed model prose;
 * `thinking` is streamed reasoning from an extended-thinking block (shown
 * separately from the answer); `tool_use` announces a tool call the model
 * requested (shown before it runs); `tool_result` carries what the tool
 * returned (with any line-change counts); `usage` reports real token counts
 * from the provider (input/output/cache) so billing and the Usage tab don't
 * rely on estimates; `retry` is a transient, self-healing transport failure the
 * provider is retrying (not fatal); `error` is a terminal transport/API
 * failure. The turn ends when the generator returns.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string; display?: string; isError?: boolean; linesAdded?: number; linesRemoved?: number; diff?: DiffLine[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { type: 'retry'; attempt: number; max: number; delayMs: number; reason: string }
  | { type: 'error'; message: string }

/**
 * A model/agent backend.
 * - `stream` yields plain text chunks (chat only).
 * - `agent` runs a full tool-use loop: it calls the model, executes any tools
 *   the model requests, feeds the results back, and repeats until the model
 *   stops asking for tools — yielding AgentEvents throughout.
 * - `complete` is a one-shot, non-streaming call used by out-of-session helpers
 *   (e.g. the goal stop-hook judge).
 */
export interface Provider {
  id: string
  label: string
  stream(messages: Message[], opts: StreamOpts): AsyncGenerator<string, void, unknown>
  agent?(messages: Message[], opts: StreamOpts): AsyncGenerator<AgentEvent, void, unknown>
  complete?(messages: Message[], opts: StreamOpts): Promise<string>
}

/** A recurring/self-paced job started by /loop. */
export interface LoopSpec {
  intervalMs: number | null   // ms between runs; null = self-paced (run back-to-back)
  payload: string             // the prompt or slash command to re-run each tick
}

/** Tabs of the interactive settings overlay (see components/SettingsPanel). */
export type PanelTab = 'settings' | 'status' | 'config' | 'usage' | 'stats'

/**
 * A user-defined provider speaking the Anthropic Messages protocol (A协议). The
 * default AnyCode vendor is stubbed for now (see providers/index.ts); until it's
 * wired, these custom Anthropic-compatible endpoints are the only way to add a
 * provider. Costs are always computed at the OFFICIAL rate table (see
 * lib/pricing) regardless of the actual vendor.
 */
export interface CustomProvider {
  id: string            // selectable name, e.g. 'my-gateway'
  label: string         // human label shown in listings
  baseUrl: string       // host base; "/v1/messages" is appended if absent
  apiKeyEnv?: string    // env var holding the key — never a literal key (never persisted)
  model?: string        // optional default model id hint for this provider
}

export interface AppConfig {
  provider: string   // 'mock' | 'anthropic' | 'default' | a custom provider id
  model: string
  apiKey?: string
  theme?: string     // active color-theme name (see src/theme.ts)
  system?: string
  // The broad Config-tab surface (toggles/enums/values). Described once in
  // src/lib/settings.ts and stored here as a keyed bag so it persists via
  // saveConfig without a field-per-setting. Missing keys fall back to defaults.
  settings?: Record<string, boolean | string | number>
  // User-defined Anthropic-protocol providers (persisted; keys live in env).
  customProviders?: CustomProvider[]
  // Lifecycle shell hooks (PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/…);
  // see lib/hooks. Persisted as-is via saveConfig; shape is HooksConfig but kept
  // loose here so types.ts stays dependency-free.
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type?: string; command: string; timeout?: number }> }>>
  // Local MCP (Model Context Protocol) servers to spawn on startup; their tools
  // become callable as mcp__<server>__<tool>. See lib/mcp. Kept loose here (shape
  // is McpServers) so types.ts stays dependency-free.
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean; cwd?: string }>
  // Persistent permission rules layered on top of the permission MODE: lists of
  // `Tool` or `Tool(pattern)` strings. A matching `deny` always blocks (wins over
  // everything), an `allow` skips the prompt an 'ask' would raise, and an `ask`
  // forces a prompt a mode would otherwise auto-allow. Evaluated by the provider
  // before each tool call (see tools/permission matchPermissionRule) and managed
  // by /permissions. Kept loose here (shape is PermissionRules) so types.ts stays
  // dependency-free.
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] }
}

/** Cumulative token/turn accounting for a session (see lib/usage). */
export interface SessionUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  compactions: number
  // Real cache token counts (from the provider's usage report; 0 for mock).
  cacheReadTokens: number
  cacheCreationTokens: number
  // Time spent inside provider/API calls (ms), and when the session started
  // (epoch ms) — together these drive the Usage tab's API vs wall durations.
  apiMs: number
  startedAt: number
  // Cumulative code changes from file-mutating tools this session.
  linesAdded: number
  linesRemoved: number
  // Running USD cost, computed per turn at official rates (see lib/pricing).
  costUsd: number
}

/** Context handed to a slash command when it runs. */
export interface CommandContext {
  args: string
  config: AppConfig
  setConfig: (patch: Partial<AppConfig>) => void
  messages: Message[]
  clear: () => void
  exit: () => void
  print: (content: string, role?: Role, meta?: MessageMeta) => void
  /** Open the interactive theme picker overlay (interactive sessions only). */
  openThemePicker?: () => void
  /** Open the interactive model picker overlay (interactive sessions only). */
  openModelPicker?: () => void
  /** Start a recurring/self-paced loop (interactive sessions only). */
  startLoop?: (spec: LoopSpec) => void
  /** Cancel the active loop, if any. */
  stopLoop?: () => void
  /** A one-line description of the active loop, or null if none. */
  loopStatus?: () => string | null
  /** Start (or replace) the active goal AnyCode autonomously works toward (interactive sessions only). */
  startGoal?: (text: string) => void
  /** Stop the active goal run, if any. */
  stopGoal?: () => void
  /** A one-line description of the active goal, or null if none. */
  goalStatus?: () => string | null
  /** Cumulative session token/turn usage (drives /usage and /status). */
  usage?: SessionUsage
  /** Run text as a model turn, as if the user had typed it (custom commands, /skill). */
  send?: (text: string) => void
  /** Compact the transcript into a summary to reclaim context; returns messages folded (/compact). May summarize via a model call, so it can be async. */
  compact?: () => number | Promise<number>
  /** Open the interactive settings overlay on a given tab (interactive sessions only). */
  openPanel?: (tab: PanelTab) => void
  /** Open the interactive new-api login overlay (interactive sessions only). */
  openLogin?: () => void
  /** Open the interactive /resume session picker (interactive sessions only). */
  openResume?: () => void
  /** Fork the current session into a fresh one and continue there, freezing the original on disk (/fork; interactive sessions only). Returns the new session id, or null if there's nothing saved yet. */
  forkCurrent?: () => string | null
  /** Open the interactive /autocompact window picker (interactive sessions only). */
  openAutoCompact?: () => void
  /** Open the interactive /effort slider picker (interactive sessions only). */
  openEffortPicker?: () => void
  /** Open the last assistant response in $EDITOR (the `lastResponseInEditor` setting; interactive sessions only). */
  openEditor?: (text: string) => void
}

export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  run: (ctx: CommandContext) => void | Promise<void>
}

/** The subset of a command the input's autocomplete menu needs to render. */
export type CommandSpec = Pick<SlashCommand, 'name' | 'description' | 'aliases'>
