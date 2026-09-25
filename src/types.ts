export type Role = 'user' | 'assistant' | 'system' | 'tool'

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
  // Live progress callback for the `workflow` tool: called as its sub-agents move
  // queued→running→done so the UI can render a live tree. Threaded into the tool
  // context by the provider (see providers/anthropic). Optional; absent = no live
  // reporting (the workflow still runs and returns its final report).
  onWorkflow?: (snap: WorkflowSnapshot) => void
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
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean; linesAdded?: number; linesRemoved?: number }
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
  /** Compact the transcript into a summary to reclaim context; returns messages folded (/compact). */
  compact?: () => number
  /** Open the interactive settings overlay on a given tab (interactive sessions only). */
  openPanel?: (tab: PanelTab) => void
}

export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  run: (ctx: CommandContext) => void | Promise<void>
}

/** The subset of a command the input's autocomplete menu needs to render. */
export type CommandSpec = Pick<SlashCommand, 'name' | 'description' | 'aliases'>
