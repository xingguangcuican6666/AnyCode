import type { CommandContext, SlashCommand } from '../types'
import { providerIds } from '../providers'
import { VERSION, NAME } from '../version'
import { themes, themeList, DEFAULT_THEME } from '../theme'
import { loadMemory, setGoal, addNote, removeNote, formatMemory, saveMemory } from '../lib/memory'
import { contextState, contextLevel, fmtTokens, bar, emptyUsage } from '../lib/usage'
import { loadSkills, expandArgs } from '../lib/skills'
import { loadUserCommands } from '../lib/userCommands'
import {
  SETTINGS, SETTINGS_BY_KEY, settingGroups, getSetting,
  formatSettingValue, coerceSetting, settingHint, EFFORT_LEVELS, isEffortLevel,
} from '../lib/settings'

const help: SlashCommand = {
  name: 'help',
  aliases: ['?'],
  description: 'Show available commands',
  run(ctx) {
    const lines = registry.map((c) => {
      const alias = c.aliases?.length ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : ''
      return `- \`/${c.name}\`${alias} — ${c.description}`
    })
    ctx.print(['**AnyCode commands**', '', ...lines].join('\n'), 'system')
  },
}

const clear: SlashCommand = {
  name: 'clear',
  aliases: ['reset'],
  description: 'Clear the conversation and screen',
  run(ctx) { ctx.clear() },
}

const model: SlashCommand = {
  name: 'model',
  description: 'Show or set the model — e.g. /model claude-opus-4-8',
  run(ctx) {
    const next = ctx.args.trim()
    if (!next) {
      ctx.print(`Current model: \`${ctx.config.model}\` · provider \`${ctx.config.provider}\``, 'system')
      return
    }
    ctx.setConfig({ model: next })
    ctx.print(`Model set to \`${next}\`.`, 'system')
  },
}

// --- /effort: reasoning-effort level, mirroring Claude Code's /effort. Stored
// as the `effort` setting and injected into every turn's system preamble (see
// hooks/useChat) so it actually steers how much the agent explores/verifies.
const effort: SlashCommand = {
  name: 'effort',
  description: `Show or set reasoning effort — e.g. /effort high (${EFFORT_LEVELS.join(' | ')})`,
  run(ctx) {
    const cur = String(getSetting(ctx.config.settings, 'effort'))
    const next = ctx.args.trim().toLowerCase()
    if (!next) {
      ctx.print(`Reasoning effort: \`${cur}\`. Set with \`/effort <level>\` — ${EFFORT_LEVELS.join(', ')}.`, 'system')
      return
    }
    if (!isEffortLevel(next)) {
      ctx.print(`Unknown effort \`${next}\`. Choose one of: ${EFFORT_LEVELS.join(', ')}.`, 'system', { error: true })
      return
    }
    ctx.setConfig({ settings: { ...ctx.config.settings, effort: next } })
    ctx.print(`Reasoning effort set to \`${next}\`.`, 'system')
  },
}

const provider: SlashCommand = {
  name: 'provider',
  description: 'Show or switch provider (mock | anthropic | default | custom)',
  run(ctx) {
    const next = ctx.args.trim()
    const names = providerIds(ctx.config)
    if (!next) {
      ctx.print(`Current provider: \`${ctx.config.provider}\`. Available: ${names.map((n) => '`' + n + '`').join(', ')}.`, 'system')
      return
    }
    if (!names.includes(next)) {
      ctx.print(`Unknown provider \`${next}\`. Available: ${names.join(', ')}.`, 'system', { error: true })
      return
    }
    ctx.setConfig({ provider: next })
    ctx.print(`Provider set to \`${next}\`.`, 'system')
  },
}

// --- /config: core fields (provider/model/theme/system) + the broad settings
// surface described in src/lib/settings.ts. Data-driven so new settings are a
// single line in that table. The apiKey is shown but never settable here — it
// comes from the environment and is never written to disk (see saveConfig).
function renderConfig(ctx: CommandContext): void {
  const c = ctx.config
  const lines: string[] = ['**Configuration**', '', '**Core**',
    `- \`provider\`: \`${c.provider}\``,
    `- \`model\`: \`${c.model}\``,
    `- \`theme\`: \`${c.theme ?? DEFAULT_THEME}\``,
    `- \`system\`: ${c.system ? '`custom`' : '`default`'}`,
    `- \`apiKey\`: ${c.apiKey ? '`set (from env)`' : '`not set`'} _(read-only)_`,
  ]
  for (const group of settingGroups()) {
    lines.push('', `**${group}**`)
    for (const s of SETTINGS.filter((x) => x.group === group)) {
      const v = formatSettingValue(s, getSetting(c.settings, s.key))
      lines.push(`- \`${s.key}\`: \`${v}\` — ${s.label}`)
    }
  }
  lines.push('', 'Set with `/config <key> <value>` · inspect one with `/config <key>`.')
  ctx.print(lines.join('\n'), 'system')
}

// Set a schema-backed setting, validating the raw value against its spec and
// merging it into the persisted settings bag.
function setSchemaSetting(ctx: CommandContext, spec: (typeof SETTINGS)[number], value: string): void {
  if (!value) {
    const cur = formatSettingValue(spec, getSetting(ctx.config.settings, spec.key))
    ctx.print(`\`${spec.key}\`: \`${cur}\` — ${spec.label}. Accepts: ${settingHint(spec)}.`, 'system')
    return
  }
  const res = coerceSetting(spec, value)
  if (!res.ok) { ctx.print(`Invalid value for \`${spec.key}\` — ${res.error}.`, 'system', { error: true }); return }
  ctx.setConfig({ settings: { ...ctx.config.settings, [spec.key]: res.value! } })
  ctx.print(`\`${spec.key}\` set to \`${formatSettingValue(spec, res.value!)}\`.`, 'system')
}

const config: SlashCommand = {
  name: 'config',
  description: 'Show or set configuration — /config, /config <key> [value]',
  run(ctx) {
    const c = ctx.config
    const arg = ctx.args.trim()
    // Interactive host: bare /config opens the tabbed overlay (Config tab), like
    // Claude Code. `/config <key> [value]` still works as a scriptable shortcut.
    if (!arg) {
      if (ctx.openPanel) { ctx.openPanel('config'); return }
      renderConfig(ctx); return
    }
    const [key, ...rest] = arg.split(/\s+/)
    const value = rest.join(' ').trim()
    const lower = key.toLowerCase()
    switch (lower) {
      case 'provider': {
        const names = providerIds(c)
        if (!value) { ctx.print(`provider: \`${c.provider}\`. Available: ${names.join(', ')}.`, 'system'); return }
        if (!names.includes(value)) { ctx.print(`Unknown provider \`${value}\`. Available: ${names.join(', ')}.`, 'system', { error: true }); return }
        ctx.setConfig({ provider: value })
        ctx.print(`provider set to \`${value}\`.`, 'system')
        return
      }
      case 'model':
        if (!value) { ctx.print(`model: \`${c.model}\`.`, 'system'); return }
        ctx.setConfig({ model: value })
        ctx.print(`model set to \`${value}\`.`, 'system')
        return
      case 'theme':
        if (!value) { ctx.print(`theme: \`${c.theme ?? DEFAULT_THEME}\`.`, 'system'); return }
        if (!(value in themes)) {
          ctx.print(`Unknown theme \`${value}\`. Available: ${themeList().map((t) => t.name).join(', ')}.`, 'system', { error: true })
          return
        }
        ctx.setConfig({ theme: value })
        ctx.print(`theme set to \`${value}\`.`, 'system')
        return
      case 'system':
        // Empty value clears the custom system prompt (back to default).
        ctx.setConfig({ system: value || undefined })
        ctx.print(value ? 'Custom system prompt set.' : 'Custom system prompt cleared.', 'system')
        return
      case 'apikey':
        ctx.print('`apiKey` is read from the `ANTHROPIC_API_KEY` environment variable and is never set or stored here.', 'system', { error: true })
        return
      default: {
        const spec = SETTINGS_BY_KEY[key] ?? SETTINGS.find((s) => s.key.toLowerCase() === lower)
        if (spec) { setSchemaSetting(ctx, spec, value); return }
        ctx.print(`Unknown config key \`${key}\`. Run \`/config\` to see all keys.`, 'system', { error: true })
      }
    }
  },
}

// --- /usage: session token accounting + context-window fill ---
const usage: SlashCommand = {
  name: 'usage',
  aliases: ['tokens'],
  description: 'Show session token usage and context-window fill',
  run(ctx) {
    if (ctx.openPanel) { ctx.openPanel('usage'); return }
    const u = ctx.usage ?? emptyUsage()
    const ctxState = contextState(ctx.messages, ctx.config.model)
    const pct = Math.round(ctxState.ratio * 100)
    ctx.print(
      ['**Session usage**', '',
        `- turns: \`${u.turns}\``,
        `- input tokens: \`${fmtTokens(u.inputTokens)}\``,
        `- output tokens: \`${fmtTokens(u.outputTokens)}\``,
        `- total tokens: \`${fmtTokens(u.inputTokens + u.outputTokens)}\``,
        `- tool calls: \`${u.toolCalls}\``,
        `- compactions: \`${u.compactions}\``,
        '',
        '**Context window**', '',
        `${bar(ctxState.ratio)} ${pct}%`,
        `- used: \`${fmtTokens(ctxState.used)}\` / \`${fmtTokens(ctxState.limit)}\` · remaining \`${fmtTokens(ctxState.remaining)}\``,
      ].join('\n'),
      'system',
    )
  },
}

// --- /status: a one-shot snapshot of the whole session ---
const status: SlashCommand = {
  name: 'status',
  description: 'Show a status panel (version, config, context, goal, notes)',
  run(ctx) {
    if (ctx.openPanel) { ctx.openPanel('status'); return }
    const c = ctx.config
    const u = ctx.usage ?? emptyUsage()
    const ctxState = contextState(ctx.messages, c.model)
    const pct = Math.round(ctxState.ratio * 100)
    const level = contextLevel(ctxState.ratio)
    const mem = loadMemory()
    const goalLine = ctx.goalStatus?.() ?? (mem.goal ? `${mem.goal} _(idle)_` : 'none')
    const loopLine = ctx.loopStatus?.() ?? 'none'
    const skills = loadSkills()
    const custom = loadUserCommands()
    ctx.print(
      [`**${NAME} v${VERSION}**`, '',
        `- cwd: \`${process.cwd()}\``,
        `- provider / model: \`${c.provider}\` / \`${c.model}\``,
        `- api key: ${c.apiKey ? '`set`' : '`not set`'} · theme: \`${c.theme ?? DEFAULT_THEME}\``,
        `- context: ${bar(ctxState.ratio, 12)} ${pct}% (${level})`,
        `- session: \`${u.turns}\` turns · \`${fmtTokens(u.inputTokens + u.outputTokens)}\` tokens · \`${u.toolCalls}\` tool calls · \`${u.compactions}\` compactions`,
        `- goal: ${goalLine}`,
        `- loop: ${loopLine}`,
        `- notes: \`${mem.notes.length}\` · skills: \`${skills.length}\` · custom commands: \`${custom.length}\``,
      ].join('\n'),
      'system',
    )
  },
}

// --- /stats: session statistics (turns, tokens, tool calls, ratios) ---
const stats: SlashCommand = {
  name: 'stats',
  description: 'Show session statistics (turns, tokens, tool calls, averages)',
  run(ctx) {
    if (ctx.openPanel) { ctx.openPanel('stats'); return }
    const u = ctx.usage ?? emptyUsage()
    const total = u.inputTokens + u.outputTokens
    const perTurn = u.turns > 0 ? Math.round(total / u.turns) : 0
    const perTool = u.turns > 0 ? (u.toolCalls / u.turns).toFixed(1) : '0'
    const ratio = u.outputTokens > 0 ? (u.inputTokens / u.outputTokens).toFixed(1) : '—'
    ctx.print(
      ['**Session stats**', '',
        `- turns: \`${u.turns}\``,
        `- tool calls: \`${u.toolCalls}\``,
        `- compactions: \`${u.compactions}\``,
        `- total tokens: \`${fmtTokens(total)}\``,
        `- avg tokens / turn: \`${fmtTokens(perTurn)}\``,
        `- avg tools / turn: \`${perTool}\``,
        `- input:output ratio: \`${ratio}\``,
      ].join('\n'),
      'system',
    )
  },
}

// --- /compact: fold older messages into a digest to reclaim context ---
const compact: SlashCommand = {
  name: 'compact',
  description: 'Summarize older messages to free up the context window',
  run(ctx) {
    if (!ctx.compact) { ctx.print('`/compact` is only available in the interactive TUI.', 'system', { error: true }); return }
    // When this folds anything the app remounts with the compacted transcript
    // (the digest message is shown there), so a print here would be discarded —
    // only report when there was nothing to do.
    const n = ctx.compact()
    if (n <= 0) ctx.print('Nothing to compact yet — the transcript is still short.', 'system')
  },
}

// --- /skill: list reusable prompt playbooks, or run one ---
const skill: SlashCommand = {
  name: 'skill',
  aliases: ['skills'],
  description: 'List skills or run one — /skill, /skill <name> [args]',
  run(ctx) {
    const skills = loadSkills()
    const arg = ctx.args.trim()
    if (!arg) {
      if (!skills.length) {
        ctx.print('No skills found. Add one at `~/.anycode/skills/<name>/SKILL.md` or `./.anycode/skills/<name>/SKILL.md`.', 'system')
        return
      }
      const lines = skills.map((s) => `- \`${s.name}\` — ${s.description}`)
      ctx.print(['**Skills**', '', ...lines, '', 'Run one with `/skill <name> [args]`.'].join('\n'), 'system')
      return
    }
    const [name, ...rest] = arg.split(/\s+/)
    const found = skills.find((s) => s.name === name.toLowerCase())
    if (!found) {
      ctx.print(`Unknown skill \`${name}\`. Type \`/skill\` to list.`, 'system', { error: true })
      return
    }
    const prompt = expandArgs(found.body, rest.join(' '))
    if (ctx.send) { ctx.send(prompt); ctx.print(`▸ Running skill \`${found.name}\`.`, 'system') }
    else ctx.print(prompt, 'user')
  },
}

const version: SlashCommand = {
  name: 'version',
  description: 'Show the AnyCode version',
  run(ctx) { ctx.print(`AnyCode v${VERSION}`, 'system') },
}

const exit: SlashCommand = {
  name: 'exit',
  aliases: ['quit', 'q'],
  description: 'Exit AnyCode',
  run(ctx) { ctx.exit() },
}

const theme: SlashCommand = {
  name: 'theme',
  description: 'Show or switch the color theme — e.g. /theme light',
  run(ctx) {
    const next = ctx.args.trim()
    const cur = ctx.config.theme ?? DEFAULT_THEME
    if (!next) {
      if (ctx.openThemePicker) { ctx.openThemePicker(); return }
      const lines = themeList().map((t) => {
        const mark = t.name === cur ? ' ← current' : ''
        return `- \`${t.name}\`${mark} — ${t.label}`
      })
      ctx.print(['**Themes**', '', ...lines, '', 'Switch with `/theme <name>`.'].join('\n'), 'system')
      return
    }
    if (!(next in themes)) {
      const names = themeList().map((t) => '`' + t.name + '`').join(', ')
      ctx.print(`Unknown theme \`${next}\`. Available: ${names}.`, 'system', { error: true })
      return
    }
    if (next === cur) {
      ctx.print(`Already using the \`${next}\` theme.`, 'system')
      return
    }
    ctx.setConfig({ theme: next })
    ctx.print(`Theme set to \`${next}\`.`, 'system')
  },
}

// --- /goal: an objective AnyCode autonomously works toward until satisfied ---
// Like Claude Code's /goal: setting one kicks off work immediately, shows a live
// "◎ /goal active (Ns)" indicator, keeps driving turns until the model signals
// completion (GOAL_COMPLETE, injected via the system preamble), and auto-clears.
const goal: SlashCommand = {
  name: 'goal',
  description: 'Set a goal AnyCode works toward until it is satisfied — /goal <text>, /goal clear',
  run(ctx) {
    const arg = ctx.args.trim()
    if (!arg) {
      const cur = loadMemory().goal
      const active = ctx.goalStatus?.()
      if (active) { ctx.print(active, 'system'); return }
      ctx.print(cur ? `**Goal:** ${cur} _(not active — set it again to resume working)_` : 'No goal set. Use `/goal <text>` to set one.', 'system')
      return
    }
    if (arg === 'clear' || arg === 'none' || arg === 'off') {
      setGoal('')
      ctx.stopGoal?.()
      ctx.print('Goal cleared.', 'system')
      return
    }
    setGoal(arg)
    if (ctx.startGoal) {
      ctx.startGoal(arg)
      ctx.print(`Goal set: ${arg}`, 'system')
    } else {
      // Non-interactive host (print mode): no autonomous driver, but the goal
      // still steers every turn via the system preamble.
      ctx.print(`Goal set: ${arg}`, 'system')
    }
  },
}

// /plan: ask AnyCode to produce an implementation plan BEFORE touching code.
// Mirrors Claude Code's plan mode: it runs a normal model turn but instructs the
// model to use its read-only `plan` tool (or otherwise investigate read-only) and
// return a concrete step-by-step plan without editing anything.
const plan: SlashCommand = {
  name: 'plan',
  description: 'Draft an implementation plan before coding — /plan <what to build>',
  run(ctx) {
    const arg = ctx.args.trim()
    if (!arg) {
      ctx.print('Usage: `/plan <what to build>` — I\'ll investigate read-only and return a step-by-step plan before changing anything.', 'system')
      return
    }
    const prompt =
      `Use the \`plan\` tool to produce a concrete implementation plan for the following task, then present that plan to me. ` +
      `Do NOT edit any files or run mutating commands yet — planning only.\n\nTask: ${arg}`
    if (ctx.send) {
      ctx.send(prompt)
      ctx.print(`▸ Planning: ${arg}`, 'system')
    } else {
      ctx.print(`Planning is only available in an interactive session. Task noted: ${arg}`, 'system')
    }
  },
}

// --- /loop: re-run a prompt or command on an interval, or self-paced ---
function parseInterval(tok: string): number | null {
  const m = /^(\d+)(s|m|h)?$/.exec(tok)
  if (!m) return null
  const unit = m[2] ?? 's'
  const mult = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000
  return Number(m[1]) * mult
}

const loop: SlashCommand = {
  name: 'loop',
  description: 'Run a prompt or slash command on a recurring interval — e.g. /loop 5m /foo (omit interval to self-pace); /loop stop to cancel',
  run(ctx) {
    const arg = ctx.args.trim()
    if (!ctx.startLoop || !ctx.stopLoop) {
      ctx.print('`/loop` is only available in the interactive TUI.', 'system', { error: true })
      return
    }
    if (!arg || arg === 'status') {
      const s = ctx.loopStatus?.()
      ctx.print(s ? s : 'No loop is active. Start one with `/loop [interval] <prompt or /command>`.', 'system')
      return
    }
    if (arg === 'stop' || arg === 'cancel' || arg === 'off') {
      if (ctx.loopStatus?.()) { ctx.stopLoop(); ctx.print('Loop cancelled.', 'system') }
      else ctx.print('No loop is active.', 'system')
      return
    }
    const tokens = arg.split(/\s+/)
    const intervalMs = parseInterval(tokens[0])
    const payload = (intervalMs !== null ? tokens.slice(1) : tokens).join(' ').trim()
    if (!payload) {
      ctx.print('Usage: `/loop [interval] <prompt or /command>` — e.g. `/loop 5m /foo`.', 'system', { error: true })
      return
    }
    if (/^\/loop\b/.test(payload)) {
      ctx.print("A loop can't run `/loop` itself.", 'system', { error: true })
      return
    }
    ctx.startLoop({ intervalMs, payload })
    const cadence = intervalMs !== null ? `every ${tokens[0]}` : 'self-paced (back-to-back)'
    ctx.print(`Looping \`${payload}\` ${cadence}. Send \`/loop stop\` to cancel.`, 'system')
  },
}

// --- /memory: free-form notes remembered across sessions (goal lives in /goal) ---
const memory: SlashCommand = {
  name: 'memory',
  description: 'Show or edit remembered notes across sessions — /memory add <text> · rm <n> · clear',
  run(ctx) {
    const arg = ctx.args.trim()
    if (!arg) { ctx.print(formatMemory(loadMemory()), 'system'); return }
    const [sub, ...rest] = arg.split(/\s+/)
    const body = rest.join(' ').trim()
    switch (sub) {
      case 'add':
        if (!body) { ctx.print('Usage: `/memory add <text>`', 'system', { error: true }); return }
        addNote(body)
        ctx.print('Note added to memory.', 'system')
        return
      case 'rm':
      case 'remove': {
        const n = Number(body)
        if (!Number.isInteger(n) || n < 1) { ctx.print('Usage: `/memory rm <n>` — 1-based note number.', 'system', { error: true }); return }
        removeNote(n)
        ctx.print(`Removed note ${n}.`, 'system')
        return
      }
      case 'clear': {
        const m = loadMemory()
        m.notes = []
        saveMemory(m)
        ctx.print('Notes cleared.', 'system')
        return
      }
      case 'goal':
        ctx.print('The goal has its own command now — set it with `/goal <text>`.', 'system')
        return
      default:
        ctx.print(`Unknown \`/memory\` action \`${sub}\`. Use \`add\`, \`rm\`, or \`clear\` (set the goal with \`/goal\`).`, 'system', { error: true })
    }
  },
}

const builtins: SlashCommand[] = [help, clear, model, provider, effort, theme, goal, plan, loop, memory, config, usage, status, stats, compact, skill, version, exit]

// Merge user-defined commands (from ~/.anycode/commands and ./.anycode/commands)
// into the registry, but never let them shadow a built-in name or alias. Loaded
// once at startup; new command files are picked up on the next launch.
function buildRegistry(): SlashCommand[] {
  const taken = new Set<string>()
  for (const c of builtins) { taken.add(c.name); for (const a of c.aliases ?? []) taken.add(a) }
  const custom: SlashCommand[] = []
  try {
    for (const c of loadUserCommands()) {
      if (taken.has(c.name)) continue
      taken.add(c.name)
      custom.push(c)
    }
  } catch {
    // best-effort — a bad commands dir shouldn't break startup
  }
  return [...builtins, ...custom]
}

export const registry: SlashCommand[] = buildRegistry()

export function isCommand(input: string): boolean {
  return input.trim().startsWith('/')
}

export function findCommand(name: string): SlashCommand | undefined {
  return registry.find((c) => c.name === name || c.aliases?.includes(name))
}

export async function runCommand(input: string, ctx: Omit<CommandContext, 'args'>): Promise<void> {
  const trimmed = input.trim().replace(/^\//, '')
  const [name, ...rest] = trimmed.split(/\s+/)
  const cmd = findCommand(name)
  if (!cmd) {
    ctx.print(`Unknown command \`/${name}\`. Type \`/help\` for a list.`, 'system', { error: true })
    return
  }
  await cmd.run({ ...ctx, args: rest.join(' ') })
}
