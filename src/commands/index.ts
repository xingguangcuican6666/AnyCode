import type { CommandContext, SlashCommand } from '../types'
import { providerIds } from '../providers'
import { VERSION, NAME } from '../version'
import { themes, themeList, DEFAULT_THEME } from '../theme'
import { loadMemory, setGoal, addNote, removeNote, formatMemory, saveMemory } from '../lib/memory'
import { contextState, contextLevel, fmtTokens, bar, emptyUsage } from '../lib/usage'
import { loadSkills, expandArgs } from '../lib/skills'
import { loadUserCommands } from '../lib/userCommands'
import { loadCredentials, clearCredentials } from '../lib/credentials'
import { logout as newapiLogout } from '../lib/newapi'
import { revokeOAuth } from '../lib/oauth'
import { t } from '../lib/i18n'
import {
  SETTINGS, SETTINGS_BY_KEY, settingGroups, getSetting,
  formatSettingValue, coerceSetting, settingHint, EFFORT_LEVELS, isEffortLevel,
} from '../lib/settings'

const help: SlashCommand = {
  name: 'help',
  aliases: ['?'],
  get description() { return t('cmd.helpDesc') },
  run(ctx) {
    const lines = registry.map((c) => {
      const alias = c.aliases?.length ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : ''
      return `- \`/${c.name}\`${alias} — ${c.description}`
    })
    ctx.print([t('cmd.helpTitle'), '', ...lines].join('\n'), 'system')
  },
}

const clear: SlashCommand = {
  name: 'clear',
  aliases: ['reset'],
  get description() { return t('cmd.clearDesc') },
  run(ctx) { ctx.clear() },
}

const model: SlashCommand = {
  name: 'model',
  get description() { return t('cmd.modelDesc') },
  run(ctx) {
    const next = ctx.args.trim()
    if (!next) {
      // Interactive session: open the search + selector overlay. Non-interactive
      // (no overlay host): fall back to printing the current model.
      if (ctx.openModelPicker) { ctx.openModelPicker(); return }
      ctx.print(t('cmd.modelCurrent', { model: ctx.config.model, provider: ctx.config.provider }), 'system')
      return
    }
    ctx.setConfig({ model: next })
    ctx.print(t('cmd.modelSet', { model: next }), 'system')
  },
}

// --- /effort: reasoning-effort level, mirroring Claude Code's /effort. Stored
// as the `effort` setting and injected into every turn's system preamble (see
// hooks/useChat) so it actually steers how much the agent explores/verifies.
const effort: SlashCommand = {
  name: 'effort',
  get description() { return t('cmd.effortDesc', { levels: EFFORT_LEVELS.join(' | ') }) },
  run(ctx) {
    const cur = String(getSetting(ctx.config.settings, 'effort'))
    const next = ctx.args.trim().toLowerCase()
    if (!next) {
      ctx.print(t('cmd.effortCurrent', { cur, levels: EFFORT_LEVELS.join(', ') }), 'system')
      return
    }
    if (!isEffortLevel(next)) {
      ctx.print(t('cmd.effortUnknown', { effort: next, levels: EFFORT_LEVELS.join(', ') }), 'system', { error: true })
      return
    }
    ctx.setConfig({ settings: { ...ctx.config.settings, effort: next } })
    ctx.print(t('cmd.effortSet', { effort: next }), 'system')
  },
}

const provider: SlashCommand = {
  name: 'provider',
  get description() { return t('cmd.providerDesc') },
  run(ctx) {
    const next = ctx.args.trim()
    const names = providerIds(ctx.config)
    if (!next) {
      ctx.print(t('cmd.providerCurrent', { provider: ctx.config.provider, names: names.map((n) => '`' + n + '`').join(', ') }), 'system')
      return
    }
    if (!names.includes(next)) {
      ctx.print(t('cmd.providerUnknown', { provider: next, names: names.join(', ') }), 'system', { error: true })
      return
    }
    ctx.setConfig({ provider: next })
    ctx.print(t('cmd.providerSet', { provider: next }), 'system')
  },
}

// --- /config: core fields (provider/model/theme/system) + the broad settings
// surface described in src/lib/settings.ts. Data-driven so new settings are a
// single line in that table. The apiKey is shown but never settable here — it
// comes from the environment and is never written to disk (see saveConfig).
function renderConfig(ctx: CommandContext): void {
  const c = ctx.config
  const lines: string[] = [t('cmd.configTitle'), '', t('cmd.configCore'),
    `- \`provider\`: \`${c.provider}\``,
    `- \`model\`: \`${c.model}\``,
    `- \`theme\`: \`${c.theme ?? DEFAULT_THEME}\``,
    `- \`system\`: ${c.system ? t('cmd.configSystemCustom') : t('cmd.configSystemDefault')}`,
    `- \`apiKey\`: ${c.apiKey ? t('cmd.configApiKeySet') : t('cmd.configApiKeyUnset')} ${t('cmd.configReadonly')}`,
  ]
  for (const group of settingGroups()) {
    lines.push('', `**${group}**`)
    for (const s of SETTINGS.filter((x) => x.group === group)) {
      const v = formatSettingValue(s, getSetting(c.settings, s.key))
      lines.push(`- \`${s.key}\`: \`${v}\` — ${s.label}`)
    }
  }
  lines.push('', t('cmd.configFooter'))
  ctx.print(lines.join('\n'), 'system')
}

// Set a schema-backed setting, validating the raw value against its spec and
// merging it into the persisted settings bag.
function setSchemaSetting(ctx: CommandContext, spec: (typeof SETTINGS)[number], value: string): void {
  if (!value) {
    const cur = formatSettingValue(spec, getSetting(ctx.config.settings, spec.key))
    ctx.print(t('cmd.settingInfo', { key: spec.key, value: cur, label: spec.label, hint: settingHint(spec) }), 'system')
    return
  }
  const res = coerceSetting(spec, value)
  if (!res.ok) { ctx.print(t('cmd.settingInvalid', { key: spec.key, error: res.error! }), 'system', { error: true }); return }
  ctx.setConfig({ settings: { ...ctx.config.settings, [spec.key]: res.value! } })
  ctx.print(t('cmd.settingSet', { key: spec.key, value: formatSettingValue(spec, res.value!) }), 'system')
}

const config: SlashCommand = {
  name: 'config',
  get description() { return t('cmd.configDesc') },
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
        if (!value) { ctx.print(t('cmd.configProviderInfo', { provider: c.provider, names: names.join(', ') }), 'system'); return }
        if (!names.includes(value)) { ctx.print(t('cmd.providerUnknown', { provider: value, names: names.join(', ') }), 'system', { error: true }); return }
        ctx.setConfig({ provider: value })
        ctx.print(t('cmd.configProviderSet', { provider: value }), 'system')
        return
      }
      case 'model':
        if (!value) { ctx.print(t('cmd.configModelInfo', { model: c.model }), 'system'); return }
        ctx.setConfig({ model: value })
        ctx.print(t('cmd.configModelSet', { model: value }), 'system')
        return
      case 'theme':
        if (!value) { ctx.print(t('cmd.configThemeInfo', { theme: c.theme ?? DEFAULT_THEME }), 'system'); return }
        if (!(value in themes)) {
          ctx.print(t('cmd.themeUnknown', { theme: value, names: themeList().map((t) => t.name).join(', ') }), 'system', { error: true })
          return
        }
        ctx.setConfig({ theme: value })
        ctx.print(t('cmd.configThemeSet', { theme: value }), 'system')
        return
      case 'system':
        // Empty value clears the custom system prompt (back to default).
        ctx.setConfig({ system: value || undefined })
        ctx.print(value ? t('cmd.configSystemSet') : t('cmd.configSystemCleared'), 'system')
        return
      case 'apikey':
        ctx.print(t('cmd.configApiKeyReadonly'), 'system', { error: true })
        return
      default: {
        const spec = SETTINGS_BY_KEY[key] ?? SETTINGS.find((s) => s.key.toLowerCase() === lower)
        if (spec) { setSchemaSetting(ctx, spec, value); return }
        ctx.print(t('cmd.configUnknownKey', { key }), 'system', { error: true })
      }
    }
  },
}

// --- /usage: session token accounting + context-window fill ---
const usage: SlashCommand = {
  name: 'usage',
  aliases: ['tokens'],
  get description() { return t('cmd.usageDesc') },
  run(ctx) {
    if (ctx.openPanel) { ctx.openPanel('usage'); return }
    const u = ctx.usage ?? emptyUsage()
    const ctxState = contextState(ctx.messages, ctx.config.model)
    const pct = Math.round(ctxState.ratio * 100)
    ctx.print(
      [t('cmd.usageTitle'), '',
        t('cmd.usageTurns', { n: u.turns }),
        t('cmd.usageInput', { n: fmtTokens(u.inputTokens) }),
        t('cmd.usageOutput', { n: fmtTokens(u.outputTokens) }),
        t('cmd.usageTotal', { n: fmtTokens(u.inputTokens + u.outputTokens) }),
        t('cmd.usageToolCalls', { n: u.toolCalls }),
        t('cmd.usageCompactions', { n: u.compactions }),
        '',
        t('cmd.usageContextWindow'), '',
        `${bar(ctxState.ratio)} ${pct}%`,
        t('cmd.usageUsed', { used: fmtTokens(ctxState.used), limit: fmtTokens(ctxState.limit), remaining: fmtTokens(ctxState.remaining) }),
      ].join('\n'),
      'system',
    )
  },
}

// --- /status: a one-shot snapshot of the whole session ---
const status: SlashCommand = {
  name: 'status',
  get description() { return t('cmd.statusDesc') },
  run(ctx) {
    if (ctx.openPanel) { ctx.openPanel('status'); return }
    const c = ctx.config
    const u = ctx.usage ?? emptyUsage()
    const ctxState = contextState(ctx.messages, c.model)
    const pct = Math.round(ctxState.ratio * 100)
    const level = contextLevel(ctxState.ratio)
    const mem = loadMemory()
    const goalLine = ctx.goalStatus?.() ?? (mem.goal ? t('cmd.statusGoalIdle', { goal: mem.goal }) : t('cmd.statusNone'))
    const loopLine = ctx.loopStatus?.() ?? t('cmd.statusNone')
    const skills = loadSkills()
    const custom = loadUserCommands()
    ctx.print(
      [`**${NAME} v${VERSION}**`, '',
        t('cmd.statusCwd', { cwd: process.cwd() }),
        t('cmd.statusProviderModel', { provider: c.provider, model: c.model }),
        t('cmd.statusApiTheme', { apiKey: c.apiKey ? t('cmd.statusSet') : t('cmd.statusNotSet'), theme: c.theme ?? DEFAULT_THEME }),
        t('cmd.statusContext', { bar: bar(ctxState.ratio, 12), pct, level }),
        t('cmd.statusSession', { turns: u.turns, tokens: fmtTokens(u.inputTokens + u.outputTokens), toolCalls: u.toolCalls, compactions: u.compactions }),
        t('cmd.statusGoal', { goal: goalLine }),
        t('cmd.statusLoop', { loop: loopLine }),
        t('cmd.statusNotes', { notes: mem.notes.length, skills: skills.length, custom: custom.length }),
      ].join('\n'),
      'system',
    )
  },
}

// --- /stats: session statistics (turns, tokens, tool calls, ratios) ---
const stats: SlashCommand = {
  name: 'stats',
  get description() { return t('cmd.statsDesc') },
  run(ctx) {
    if (ctx.openPanel) { ctx.openPanel('stats'); return }
    const u = ctx.usage ?? emptyUsage()
    const total = u.inputTokens + u.outputTokens
    const perTurn = u.turns > 0 ? Math.round(total / u.turns) : 0
    const perTool = u.turns > 0 ? (u.toolCalls / u.turns).toFixed(1) : '0'
    const ratio = u.outputTokens > 0 ? (u.inputTokens / u.outputTokens).toFixed(1) : '—'
    ctx.print(
      [t('cmd.statsTitle'), '',
        t('cmd.statsTurns', { n: u.turns }),
        t('cmd.statsToolCalls', { n: u.toolCalls }),
        t('cmd.statsCompactions', { n: u.compactions }),
        t('cmd.statsTotalTokens', { n: fmtTokens(total) }),
        t('cmd.statsAvgTokens', { n: fmtTokens(perTurn) }),
        t('cmd.statsAvgTools', { n: perTool }),
        t('cmd.statsRatio', { n: ratio }),
      ].join('\n'),
      'system',
    )
  },
}

// --- /compact: fold older messages into a digest to reclaim context ---
const compact: SlashCommand = {
  name: 'compact',
  get description() { return t('cmd.compactDesc') },
  run(ctx) {
    if (!ctx.compact) { ctx.print(t('cmd.tuiOnly', { cmd: '/compact' }), 'system', { error: true }); return }
    // When this folds anything the app remounts with the compacted transcript
    // (the digest message is shown there), so a print here would be discarded —
    // only report when there was nothing to do.
    const n = ctx.compact()
    if (n <= 0) ctx.print(t('cmd.compactNothing'), 'system')
  },
}

// --- /skill: list reusable prompt playbooks, or run one ---
const skill: SlashCommand = {
  name: 'skill',
  aliases: ['skills'],
  get description() { return t('cmd.skillDesc') },
  run(ctx) {
    const skills = loadSkills()
    const arg = ctx.args.trim()
    if (!arg) {
      if (!skills.length) {
        ctx.print(t('cmd.skillNone'), 'system')
        return
      }
      const lines = skills.map((s) => `- \`${s.name}\` — ${s.description}`)
      ctx.print([t('cmd.skillTitle'), '', ...lines, '', t('cmd.skillRunHint')].join('\n'), 'system')
      return
    }
    const [name, ...rest] = arg.split(/\s+/)
    const found = skills.find((s) => s.name === name.toLowerCase())
    if (!found) {
      ctx.print(t('cmd.skillUnknown', { name }), 'system', { error: true })
      return
    }
    const prompt = expandArgs(found.body, rest.join(' '))
    if (ctx.send) { ctx.send(prompt); ctx.print(t('cmd.skillRunning', { name: found.name }), 'system') }
    else ctx.print(prompt, 'user')
  },
}

const version: SlashCommand = {
  name: 'version',
  get description() { return t('cmd.versionDesc') },
  run(ctx) { ctx.print(`MeowCode v${VERSION}`, 'system') },
}

const exit: SlashCommand = {
  name: 'exit',
  aliases: ['quit', 'q'],
  get description() { return t('cmd.exitDesc') },
  run(ctx) { ctx.exit() },
}

// --- /resume: reopen a previously saved session (its whole transcript) ---
// Sessions autosave to ~/.anycode/sessions/ as you work; /resume opens a picker of
// the newest first. Selecting one remounts the app seeded with that transcript
// (see app.tsx onResume). `meowcode --continue` reopens the latest without the UI.
const resume: SlashCommand = {
  name: 'resume',
  aliases: ['sessions'],
  get description() { return t('cmd.resumeDesc') },
  run(ctx) {
    if (ctx.openResume) { ctx.openResume(); return }
    ctx.print(t('cmd.resumeNonInteractive'), 'system')
  },
}

const theme: SlashCommand = {
  name: 'theme',
  get description() { return t('cmd.themeDesc') },
  run(ctx) {
    const next = ctx.args.trim()
    const cur = ctx.config.theme ?? DEFAULT_THEME
    if (!next) {
      if (ctx.openThemePicker) { ctx.openThemePicker(); return }
      const lines = themeList().map((t2) => {
        const mark = t2.name === cur ? t('cmd.themeCurrentMark') : ''
        return `- \`${t2.name}\`${mark} — ${t2.label}`
      })
      ctx.print([t('cmd.themeTitle'), '', ...lines, '', t('cmd.themeSwitchHint')].join('\n'), 'system')
      return
    }
    if (!(next in themes)) {
      const names = themeList().map((t2) => '`' + t2.name + '`').join(', ')
      ctx.print(t('cmd.themeUnknown', { theme: next, names }), 'system', { error: true })
      return
    }
    if (next === cur) {
      ctx.print(t('cmd.themeAlready', { theme: next }), 'system')
      return
    }
    ctx.setConfig({ theme: next })
    ctx.print(t('cmd.themeSet', { theme: next }), 'system')
  },
}

// --- /goal: an objective AnyCode autonomously works toward until satisfied ---
// Like Claude Code's /goal: setting one kicks off work immediately, shows a live
// "◎ /goal active (Ns)" indicator, keeps driving turns until the model signals
// completion (GOAL_COMPLETE, injected via the system preamble), and auto-clears.
const goal: SlashCommand = {
  name: 'goal',
  get description() { return t('cmd.goalDesc') },
  run(ctx) {
    const arg = ctx.args.trim()
    if (!arg) {
      const cur = loadMemory().goal
      const active = ctx.goalStatus?.()
      if (active) { ctx.print(active, 'system'); return }
      ctx.print(cur ? t('cmd.goalInactive', { goal: cur }) : t('cmd.goalNone'), 'system')
      return
    }
    if (arg === 'clear' || arg === 'none' || arg === 'off') {
      setGoal('')
      ctx.stopGoal?.()
      ctx.print(t('cmd.goalCleared'), 'system')
      return
    }
    setGoal(arg)
    if (ctx.startGoal) {
      ctx.startGoal(arg)
      ctx.print(t('cmd.goalSet', { goal: arg }), 'system')
    } else {
      // Non-interactive host (print mode): no autonomous driver, but the goal
      // still steers every turn via the system preamble.
      ctx.print(t('cmd.goalSet', { goal: arg }), 'system')
    }
  },
}

// /plan: ask AnyCode to produce an implementation plan BEFORE touching code.
// Mirrors Claude Code's plan mode: it runs a normal model turn but instructs the
// model to use its read-only `plan` tool (or otherwise investigate read-only) and
// return a concrete step-by-step plan without editing anything.
const plan: SlashCommand = {
  name: 'plan',
  get description() { return t('cmd.planDesc') },
  run(ctx) {
    const arg = ctx.args.trim()
    if (!arg) {
      ctx.print(t('cmd.planUsage'), 'system')
      return
    }
    const prompt =
      `Use the \`plan\` tool to produce a concrete implementation plan for the following task, then present that plan to me. ` +
      `Do NOT edit any files or run mutating commands yet — planning only.\n\nTask: ${arg}`
    if (ctx.send) {
      ctx.send(prompt)
      ctx.print(t('cmd.planPlanning', { task: arg }), 'system')
    } else {
      ctx.print(t('cmd.planNonInteractive', { task: arg }), 'system')
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
  get description() { return t('cmd.loopDesc') },
  run(ctx) {
    const arg = ctx.args.trim()
    if (!ctx.startLoop || !ctx.stopLoop) {
      ctx.print(t('cmd.tuiOnly', { cmd: '/loop' }), 'system', { error: true })
      return
    }
    if (!arg || arg === 'status') {
      const s = ctx.loopStatus?.()
      ctx.print(s ? s : t('cmd.loopNoneStatus'), 'system')
      return
    }
    if (arg === 'stop' || arg === 'cancel' || arg === 'off') {
      if (ctx.loopStatus?.()) { ctx.stopLoop(); ctx.print(t('cmd.loopCancelled'), 'system') }
      else ctx.print(t('cmd.loopNone'), 'system')
      return
    }
    const tokens = arg.split(/\s+/)
    const intervalMs = parseInterval(tokens[0])
    const payload = (intervalMs !== null ? tokens.slice(1) : tokens).join(' ').trim()
    if (!payload) {
      ctx.print(t('cmd.loopUsage'), 'system', { error: true })
      return
    }
    if (/^\/loop\b/.test(payload)) {
      ctx.print(t('cmd.loopNoSelf'), 'system', { error: true })
      return
    }
    ctx.startLoop({ intervalMs, payload })
    const cadence = intervalMs !== null ? t('cmd.loopCadenceEvery', { interval: tokens[0] }) : t('cmd.loopCadenceSelf')
    ctx.print(t('cmd.loopStarted', { payload, cadence }), 'system')
  },
}

// --- /memory: free-form notes remembered across sessions (goal lives in /goal) ---
const memory: SlashCommand = {
  name: 'memory',
  get description() { return t('cmd.memoryDesc') },
  run(ctx) {
    const arg = ctx.args.trim()
    if (!arg) { ctx.print(formatMemory(loadMemory()), 'system'); return }
    const [sub, ...rest] = arg.split(/\s+/)
    const body = rest.join(' ').trim()
    switch (sub) {
      case 'add':
        if (!body) { ctx.print(t('cmd.memoryAddUsage'), 'system', { error: true }); return }
        addNote(body)
        ctx.print(t('cmd.memoryAdded'), 'system')
        return
      case 'rm':
      case 'remove': {
        const n = Number(body)
        if (!Number.isInteger(n) || n < 1) { ctx.print(t('cmd.memoryRmUsage'), 'system', { error: true }); return }
        removeNote(n)
        ctx.print(t('cmd.memoryRemoved', { n }), 'system')
        return
      }
      case 'clear': {
        const m = loadMemory()
        m.notes = []
        saveMemory(m)
        ctx.print(t('cmd.memoryCleared'), 'system')
        return
      }
      case 'goal':
        ctx.print(t('cmd.memoryGoalMoved'), 'system')
        return
      default:
        ctx.print(t('cmd.memoryUnknown', { action: sub }), 'system', { error: true })
    }
  },
}

// --- /login, /logout: sign in to the user's new-api provider. The login itself
// happens in an interactive overlay (credentials never touch the transcript);
// model calls then run through the `newapi` provider against /v1/messages. See
// lib/newapi, lib/credentials, components/LoginPanel.
const login: SlashCommand = {
  name: 'login',
  get description() { return t('cmd.loginDesc') },
  run(ctx) {
    const cur = loadCredentials()
    if (ctx.openLogin) {
      if (cur) ctx.print(t('cmd.loginAlready', { url: cur.baseUrl, as: cur.session?.username ? t('cmd.loginAs', { username: cur.session.username }) : '' }), 'system')
      ctx.openLogin()
      return
    }
    ctx.print(t('cmd.tuiOnly', { cmd: '/login' }), 'system', { error: true })
  },
}

const logout: SlashCommand = {
  name: 'logout',
  get description() { return t('cmd.logoutDesc') },
  async run(ctx) {
    const cur = loadCredentials()
    if (!cur) { ctx.print(t('cmd.logoutNotLoggedIn'), 'system'); return }
    // Best-effort server-side revocation. A panel (password) login revokes its
    // session; an OAuth login revokes its token grant; a pasted key has neither.
    // Either way the local credential is cleared.
    if (cur.session?.accessToken) {
      const r = await newapiLogout(cur.baseUrl, cur.session)
      if (!r.ok) ctx.print(t('cmd.logoutServerFailed', { error: r.error ?? t('cmd.logoutUnknownError') }), 'system')
    }
    if (cur.oauth) {
      const r = await revokeOAuth(cur.oauth)
      if (!r.ok) ctx.print(t('cmd.logoutOauthFailed', { error: r.error ?? t('cmd.logoutUnknownError') }), 'system')
      ctx.print(t('cmd.logoutOauthNote'), 'system')
    }
    clearCredentials()
    // If the active provider was the logged-in one, fall back so the next turn
    // doesn't hit a now-keyless newapi provider.
    if (ctx.config.provider === 'newapi') {
      const fallback = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock'
      ctx.setConfig({ provider: fallback })
      ctx.print(t('cmd.logoutSwitched', { provider: fallback }), 'system')
    } else {
      ctx.print(t('cmd.logoutDone'), 'system')
    }
  },
}

const builtins: SlashCommand[] = [help, clear, model, provider, login, logout, effort, theme, goal, plan, loop, memory, config, usage, status, stats, compact, skill, resume, version, exit]

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
    ctx.print(t('cmd.unknownCommand', { name }), 'system', { error: true })
    return
  }
  await cmd.run({ ...ctx, args: rest.join(' ') })
}
