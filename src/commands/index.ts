import type { CommandContext, SlashCommand } from '../types'
import { providerIds } from '../providers'
import { VERSION, NAME } from '../version'
import { themes, themeList, DEFAULT_THEME } from '../theme'
import { loadMemory, setGoal, listMemories, getMemory, saveMemoryEntry, deleteMemory, formatMemoryList, MEMORY_TYPES, type MemoryType } from '../lib/memory'
import { contextState, contextLevel, contextLimit, fmtTokens, bar, emptyUsage } from '../lib/usage'
import { refreshModelDb } from '../lib/modelDb'
import { loadSkills, expandArgs } from '../lib/skills'
import { collectProjectInstructions } from '../lib/projectInstructions'
import { loadHooks, HOOK_EVENTS } from '../lib/hooks'
import { listMcpServers } from '../lib/mcp'
import { loadUserCommands } from '../lib/userCommands'
import { loadCredentials, clearCredentials } from '../lib/credentials'
import { logout as newapiLogout } from '../lib/newapi'
import { revokeOAuth } from '../lib/oauth'
import { copyToClipboard } from '../lib/clipboard'
import { createWorktree, type WorktreeBaseRef } from '../lib/worktree'
import { saveFeedback, feedbackCount } from '../lib/feedback'
import { listCheckpoints, restoreCheckpoint, clearCheckpoints } from '../lib/checkpoints'
import { getIdentity, livePeers, sendMail } from '../lib/mailbox'
import { sendMessageFrame, subscribeTo, unsubscribeFrom, isSubscribed, isReachable } from '../lib/sessionSocket'
import { detectIde } from '../lib/ide'
import { detectChrome } from '../lib/chrome'
import { t } from '../lib/i18n'
import { loadAgents } from '../lib/agents'
import { availableUpdate, type UpdateChannel } from '../lib/update'
import { CONFIG_FILE } from '../config'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
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

// --- /new: start a fresh session. ctx.clear() rotates to a brand-new session
// file (see cli.tsx onClear), so the current transcript is dropped from view but
// stays saved on disk and remains reopenable via /resume — this is exactly the
// "start a new session" affordance users expected but couldn't find.
const newSession: SlashCommand = {
  name: 'new',
  get description() { return t('cmd.newDesc') },
  run(ctx) { ctx.clear() },
}

const model: SlashCommand = {
  name: 'model',
  get description() { return t('cmd.modelDesc') },
  async run(ctx) {
    const next = ctx.args.trim()
    // `/model refresh` force-updates the online context-window database (models.dev)
    // so the context bar tracks upstream without waiting for the daily refresh.
    if (next.toLowerCase() === 'refresh') {
      const ok = await refreshModelDb()
      ctx.print(ok ? t('cmd.modelDbRefreshed') : t('cmd.modelDbRefreshFailed'), 'system', ok ? undefined : { error: true })
      return
    }
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
      // Interactive session: open the Faster↔Smarter slider. Non-interactive
      // (no overlay host): fall back to printing the current level.
      if (ctx.openEffortPicker) { ctx.openEffortPicker(); return }
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
        t('cmd.statusNotes', { notes: listMemories().length, skills: skills.length, custom: custom.length }),
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
  async run(ctx) {
    if (!ctx.compact) { ctx.print(t('cmd.tuiOnly', { cmd: '/compact' }), 'system', { error: true }); return }
    // When this folds anything the app remounts with the compacted transcript
    // (the digest message is shown there), so a print here would be discarded —
    // only report when there was nothing to do. `compact` may summarize via a
    // model call, so it can be async; await either way.
    const n = await ctx.compact()
    if (n <= 0) ctx.print(t('cmd.compactNothing'), 'system')
  },
}

// Parse a token count for /autocompact: bare digits, or a k/m suffix
// ("128000", "128k", "1m"). Returns null when it isn't a positive number.
function parseTokens(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(s.trim())
  if (!m) return null
  const mult = m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1_000 : 1
  const n = Math.round(Number(m[1]) * mult)
  return n > 0 ? n : null
}

// --- /autocompact: configure WHEN auto-compaction fires ---
// Bare `/autocompact` opens the window picker; `/autocompact auto|off|<tokens>`
// sets it directly. "auto" tracks the model's own context window; "off" disables
// auto-compaction (manual /compact still works); a token count caps the trigger
// at min(window, model context). Stored in the settings bag (autoCompact +
// autoCompactWindow) so it persists.
const autocompact: SlashCommand = {
  name: 'autocompact',
  aliases: ['auto-compact'],
  get description() { return t('cmd.autocompactDesc') },
  run(ctx) {
    const arg = ctx.args.trim().toLowerCase()
    if (!arg && ctx.openAutoCompact) { ctx.openAutoCompact(); return }
    const s = { ...ctx.config.settings }
    if (!arg) {
      const on = getSetting(ctx.config.settings, 'autoCompact') !== false
      const w = Number(getSetting(ctx.config.settings, 'autoCompactWindow')) || 0
      const value = !on ? t('autocompact.off') : w > 0 ? t('autocompact.tokens', { n: fmtTokens(w) }) : t('autocompact.auto')
      ctx.print(t('cmd.settingInfo', { key: 'autoCompactWindow', value, label: t('autocompact.title'), hint: 'auto | off | <tokens>' }), 'system')
      return
    }
    if (arg === 'off' || arg === 'none' || arg === 'disable') {
      ctx.setConfig({ settings: { ...s, autoCompact: false } })
      ctx.print(t('cmd.autocompactOff'), 'system')
      return
    }
    if (arg === 'auto' || arg === '0' || arg === 'default') {
      ctx.setConfig({ settings: { ...s, autoCompact: true, autoCompactWindow: 0 } })
      ctx.print(t('cmd.autocompactAuto', { limit: fmtTokens(contextLimit(ctx.config.model)) }), 'system')
      return
    }
    const n = parseTokens(arg)
    if (n === null) { ctx.print(t('cmd.autocompactInvalid', { value: arg }), 'system', { error: true }); return }
    ctx.setConfig({ settings: { ...s, autoCompact: true, autoCompactWindow: n } })
    ctx.print(t('cmd.autocompactSet', { value: fmtTokens(n) }), 'system')
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

// --- /init: generate (or refresh) a project MEOWCODE.md, like Claude Code's
// /init. It runs as a model turn: the agent explores the repo with its own tools
// and writes MEOWCODE.md at the project root, which auto-loads into every future
// session's system prompt (see lib/projectInstructions). If instruction files
// already exist, it refreshes rather than starts from scratch.
const INIT_PROMPT =
  'Create a `MEOWCODE.md` file in the current project root that captures the essential, non-obvious knowledge a coding agent needs to work effectively in this repository. ' +
  'First explore the codebase yourself — read the package/build manifests, the README, the directory layout, and a sample of the source — to ground everything you write in what is actually here; do not invent conventions. ' +
  'Then write `MEOWCODE.md` with the write_file tool, covering: the build / test / lint / run commands (the exact invocations), the high-level architecture and where the main pieces live, the code conventions and libraries this project already uses, and any constraints or gotchas a newcomer would trip on. ' +
  'Keep it concise and high-signal — omit anything obvious from a glance at the tree. If a MEOWCODE.md (or CLAUDE.md / AGENTS.md) already exists, read it first and improve it in place rather than discarding what is there. When done, briefly confirm what you wrote.'

const init: SlashCommand = {
  name: 'init',
  get description() { return t('cmd.initDesc') },
  run(ctx) {
    if (!ctx.send) { ctx.print(t('cmd.initNonInteractive'), 'system', { error: true }); return }
    const cwd = process.cwd()
    const existing = collectProjectInstructions(cwd).filter((f) => path.dirname(f.path) === cwd)
    ctx.send(INIT_PROMPT)
    if (existing.length) {
      ctx.print(t('cmd.initRefreshing', { files: existing.map((f) => f.rel).join(', ') }), 'system')
    } else {
      ctx.print(t('cmd.initRunning'), 'system')
    }
  },
}

// --- /hooks: show configured lifecycle hooks (read-only viewer) ---
const hooks: SlashCommand = {
  name: 'hooks',
  get description() { return t('cmd.hooksDesc') },
  run(ctx) {
    const cfg = loadHooks(process.cwd())
    const lines: string[] = []
    for (const ev of HOOK_EVENTS) {
      const matchers = cfg[ev] ?? []
      if (!matchers.length) continue
      lines.push(`• ${ev}`)
      for (const m of matchers) {
        const scope = m.matcher ? ` [${m.matcher}]` : ''
        for (const h of m.hooks ?? []) lines.push(`    ${scope ? scope + ' ' : ''}$ ${h.command}`)
      }
    }
    if (!lines.length) { ctx.print(t('cmd.hooksNone'), 'system'); return }
    ctx.print(`${t('cmd.hooksHeader')}\n${lines.join('\n')}`, 'system')
  },
}

// --- /mcp: show configured MCP servers, their status and discovered tools ---
const mcp: SlashCommand = {
  name: 'mcp',
  get description() { return t('cmd.mcpDesc') },
  run(ctx) {
    const list = listMcpServers()
    if (!list.length) { ctx.print(t('cmd.mcpNone'), 'system'); return }
    const glyph: Record<string, string> = { ready: '✓', starting: '…', failed: '✗', stopped: '·' }
    const label = {
      ready: 'cmd.mcpReady', starting: 'cmd.mcpStarting',
      failed: 'cmd.mcpFailed', stopped: 'cmd.mcpStopped',
    } as const
    const lines: string[] = []
    for (const s of list) {
      const g = glyph[s.status] ?? '?'
      lines.push(`${g} ${s.name} — ${t(label[s.status])}${s.error ? ` (${s.error})` : ''}`)
      lines.push(`    $ ${s.command}`)
      if (s.tools.length) lines.push(`    ${t('cmd.mcpTools', { n: s.tools.length })}: ${s.tools.join(', ')}`)
    }
    ctx.print(`${t('cmd.mcpHeader')}\n${lines.join('\n')}`, 'system')
  },
}

// --- /doctor: environment & configuration health check (read-only) ---
const doctor: SlashCommand = {
  name: 'doctor',
  get description() { return t('cmd.doctorDesc') },
  run(ctx) {
    const c = ctx.config
    const cwd = process.cwd()
    const ok = (b: boolean) => (b ? '✓' : '✗')
    const lines: string[] = []
    lines.push(`${NAME} v${VERSION}`)
    const runtime = (process as any).versions?.bun ? `bun ${(process as any).versions.bun}` : `node ${process.versions.node}`
    lines.push(t('cmd.doctorRuntime', { runtime, platform: `${process.platform}-${process.arch}` }))
    let branch = ''
    try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch {}
    lines.push(t('cmd.doctorCwd', { cwd, git: branch ? `git:${branch}` : t('cmd.doctorNoGit') }))
    lines.push(t('cmd.doctorProvider', { provider: c.provider, model: c.model }))
    const creds = loadCredentials()
    const how = c.apiKey ? 'apiKey' : creds ? (creds.oauth ? 'oauth' : creds.key ? 'key' : 'session') : t('cmd.doctorNone')
    lines.push(`${ok(!!(c.apiKey || creds))} ${t('cmd.doctorAuth', { how })}`)
    lines.push(`${ok(fs.existsSync(CONFIG_FILE))} ${t('cmd.doctorConfig', { path: CONFIG_FILE })}`)
    const channel = (String(getSetting(c.settings, 'autoUpdateChannel')) === 'latest' ? 'latest' : 'stable') as UpdateChannel
    const upd = availableUpdate(channel)
    lines.push(upd ? `⬆ ${t('cmd.doctorUpdate', { ver: upd })}` : `✓ ${t('cmd.doctorUpToDate')}`)
    const mcpList = listMcpServers()
    lines.push(t('cmd.doctorMcp', { total: mcpList.length, ready: mcpList.filter((s) => s.status === 'ready').length }))
    const hk = loadHooks(cwd)
    lines.push(t('cmd.doctorHooks', { n: HOOK_EVENTS.reduce((n, e) => n + (hk[e]?.length ?? 0), 0) }))
    lines.push(t('cmd.doctorExt', { skills: loadSkills().length, commands: loadUserCommands().length, agents: loadAgents(cwd).length }))
    const ide = detectIde()
    lines.push(t('cmd.doctorIde', { ide: ide.ideName || (ide.integrated ? 'integrated' : t('cmd.doctorNone')) }))
    ctx.print(`${t('cmd.doctorHeader')}\n${lines.join('\n')}`, 'system')
  },
}

// --- /export: write the current conversation transcript to a Markdown file ---
const ROLE_LABEL: Record<string, string> = { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool' }
const exportCmd: SlashCommand = {
  name: 'export',
  get description() { return t('cmd.exportDesc') },
  run(ctx) {
    const msgs = ctx.messages.filter((m) => m.content && m.content.trim() && !m.meta?.turnDone && !m.meta?.folded)
    if (!msgs.length) { ctx.print(t('cmd.exportEmpty'), 'system'); return }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const arg = ctx.args.trim()
    const dest = arg
      ? (path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg))
      : path.join(process.cwd(), `meowcode-export-${stamp}.md`)
    const body = msgs.map((m) => `## ${ROLE_LABEL[m.role] ?? m.role}\n\n${m.content.trim()}`).join('\n\n')
    const md = `# ${NAME} — ${new Date().toLocaleString()}\n\n${body}\n`
    try {
      fs.writeFileSync(dest, md, 'utf8')
      ctx.print(t('cmd.exportDone', { path: dest, n: msgs.length }), 'system')
    } catch (e) {
      ctx.print(t('cmd.exportFailed', { err: e instanceof Error ? e.message : String(e) }), 'system', { error: true })
    }
  },
}

// --- /review: kick off an AI code review of the current git changes (model turn) ---
const REVIEW_PROMPT =
  'Review the current uncommitted changes in this repository as a senior engineer would. ' +
  'First run `git status` and `git diff` (both staged and unstaged) with the bash tool to see exactly what changed — if there are no uncommitted changes, review the most recent commit with `git show HEAD` instead. ' +
  'Read enough of the surrounding code to judge each change in context. ' +
  'Then give focused, actionable feedback grouped by severity, covering: correctness and edge-case bugs, security issues, error handling, missing tests, and any deviation from the conventions already used in this codebase. ' +
  'Cite specific files and line ranges. Be concise; skip praise and trivia. If the changes look solid, say so briefly.'
const review: SlashCommand = {
  name: 'review',
  get description() { return t('cmd.reviewDesc') },
  run(ctx) {
    if (!ctx.send) { ctx.print(t('cmd.reviewNonInteractive'), 'system', { error: true }); return }
    const extra = ctx.args.trim()
    ctx.send(extra ? `${REVIEW_PROMPT}\n\nAdditional focus from the user: ${extra}` : REVIEW_PROMPT)
    ctx.print(t('cmd.reviewRunning'), 'system')
  },
}

// --- /terminal-setup: detect the terminal and advise on multiline keybindings ---
const terminalSetup: SlashCommand = {
  name: 'terminal-setup',
  get description() { return t('cmd.termSetupDesc') },
  run(ctx) {
    const prog = process.env.TERM_PROGRAM || process.env.TERM || 'unknown'
    const p = prog.toLowerCase()
    const tip = p.includes('iterm') ? 'cmd.termSetupIterm'
      : p.includes('vscode') ? 'cmd.termSetupVscode'
      : p.includes('apple') ? 'cmd.termSetupAppleTerminal'
      : 'cmd.termSetupGeneric'
    const lines = [t('cmd.termSetupDetected', { term: prog }), t(tip), t('cmd.termSetupSupported')]
    ctx.print(`${t('cmd.termSetupHeader')}\n${lines.join('\n')}`, 'system')
  },
}

// --- /statusline: set or clear the custom status-line shell command ---
const statusline: SlashCommand = {
  name: 'statusline',
  get description() { return t('cmd.statuslineDesc') },
  run(ctx) {
    const arg = ctx.args.trim()
    const s = ctx.config.settings ?? {}
    const cur = String(getSetting(s, 'statusLine') || '')
    if (!arg) {
      ctx.print(cur ? t('cmd.statuslineCurrent', { cmd: cur }) : t('cmd.statuslineNone'), 'system')
      return
    }
    if (['off', 'clear', 'none', 'disable'].includes(arg.toLowerCase())) {
      ctx.setConfig({ settings: { ...s, statusLine: '' } })
      ctx.print(t('cmd.statuslineCleared'), 'system')
      return
    }
    ctx.setConfig({ settings: { ...s, statusLine: arg } })
    ctx.print(t('cmd.statuslineSet', { cmd: arg }), 'system')
  },
}

const exit: SlashCommand = {
  name: 'exit',
  aliases: ['quit', 'q'],
  get description() { return t('cmd.exitDesc') },
  run(ctx) { ctx.exit() },
}

// --- /permissions: view and edit the persistent allow/deny/ask rule lists ---
// These layer on top of the permission MODE (see tools/permission): a matching
// `deny` always blocks, an `allow` skips a prompt the mode would raise, and an
// `ask` forces one the mode would auto-allow. Rules are `Tool` or `Tool(pattern)`
// strings, e.g. `bash(git *)`, `Edit(src/**)`, `web_fetch(domain:example.com)`.
const permissions: SlashCommand = {
  name: 'permissions',
  aliases: ['perms'],
  get description() { return t('cmd.permsDesc') },
  run(ctx) {
    const raw = ctx.args.trim()
    const cur = ctx.config.permissions ?? {}
    const lists = { allow: [...(cur.allow ?? [])], deny: [...(cur.deny ?? [])], ask: [...(cur.ask ?? [])] }
    const subRaw = raw.split(/\s+/)[0] ?? ''
    const sub = subRaw.toLowerCase()
    const rule = raw.slice(subRaw.length).trim()
    const keys = ['allow', 'deny', 'ask'] as const

    // Bare /permissions → list the current mode and every rule.
    if (!raw) {
      const mode = String(getSetting(ctx.config.settings, 'permissionMode') || 'default')
      const section = (label: string, arr: string[]): string =>
        arr.length ? `${label}\n${arr.map((r) => `    ${r}`).join('\n')}` : `${label} ${t('cmd.permsEmpty')}`
      const body = [
        t('cmd.permsMode', { mode }),
        section(t('cmd.permsAllow'), lists.allow),
        section(t('cmd.permsDeny'), lists.deny),
        section(t('cmd.permsAsk'), lists.ask),
        '',
        t('cmd.permsHint'),
      ].join('\n')
      ctx.print(`${t('cmd.permsHeader')}\n${body}`, 'system')
      return
    }

    if (sub === 'clear' || sub === 'reset') {
      ctx.setConfig({ permissions: { allow: [], deny: [], ask: [] } })
      ctx.print(t('cmd.permsCleared'), 'system')
      return
    }

    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      if (!rule) { ctx.print(t('cmd.permsNeedRule'), 'system', { error: true }); return }
      let removed = false
      for (const k of keys) {
        const before = lists[k].length
        lists[k] = lists[k].filter((r) => r !== rule)
        if (lists[k].length !== before) removed = true
      }
      if (!removed) { ctx.print(t('cmd.permsNotFound', { rule }), 'system', { error: true }); return }
      ctx.setConfig({ permissions: lists })
      ctx.print(t('cmd.permsRemoved', { rule }), 'system')
      return
    }

    if (sub === 'allow' || sub === 'deny' || sub === 'ask') {
      if (!rule) { ctx.print(t('cmd.permsNeedRule'), 'system', { error: true }); return }
      // A rule lives in exactly one list: add here, drop from the others.
      for (const k of keys) lists[k] = lists[k].filter((r) => r !== rule)
      lists[sub].push(rule)
      ctx.setConfig({ permissions: lists })
      ctx.print(t('cmd.permsAdded', { list: sub, rule }), 'system')
      return
    }

    ctx.print(t('cmd.permsUsage'), 'system', { error: true })
  },
}

// --- /resume: reopen a previously saved session (its whole transcript) ---
// Sessions autosave to ~/.anycode/sessions/ as you work; /resume opens a picker of
// the newest first. Selecting one remounts the app seeded with that transcript
// (see app.tsx onResume). `meowcode --continue` reopens the latest without the UI.
const resume: SlashCommand = {
  name: 'resume',
  get description() { return t('cmd.resumeDesc') },
  run(ctx) {
    if (ctx.openResume) { ctx.openResume(); return }
    ctx.print(t('cmd.resumeNonInteractive'), 'system')
  },
}

// --- /fork: branch the current conversation into a new session ---
// Freezes the current session file as it stands and rotates continued autosaves
// to a fresh id (see app.tsx forkCurrent → cli.tsx onFork). The original stays on
// disk, reopenable via /resume, so the live conversation branches without losing
// where it came from. `meowcode --fork-session [id]` does the same at launch.
const fork: SlashCommand = {
  name: 'fork',
  get description() { return t('cmd.forkDesc') },
  run(ctx) {
    if (!ctx.forkCurrent) { ctx.print(t('cmd.forkNonInteractive'), 'system'); return }
    const id = ctx.forkCurrent()
    if (!id) { ctx.print(t('cmd.forkEmpty'), 'system', { error: true }); return }
    ctx.print(t('cmd.forkDone', { id }), 'system')
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

// /plan: enter Claude Code–style plan mode and (optionally) kick off planning.
// This does two things that must go together: (1) flip `permissionMode` to
// 'plan' so the REAL enforcement engine (decidePermission) denies every mutating
// tool for the rest of the session until the user leaves plan mode — the prompt
// text alone is just a request the model could ignore; (2) instruct the model to
// use its read-only `plan` tool and return a step-by-step plan.
//
// Remembers the mode we came from so `/plan off` restores it (e.g. back to
// 'acceptEdits'), rather than blindly resetting to 'default'.
let planPrevMode: string | null = null

const plan: SlashCommand = {
  name: 'plan',
  get description() { return t('cmd.planDesc') },
  run(ctx) {
    const arg = ctx.args.trim()
    const low = arg.toLowerCase()
    const s = { ...ctx.config.settings }
    const cur = String(getSetting(ctx.config.settings, 'permissionMode') || 'default')

    // /plan off|exit|done|end — leave plan mode, restoring the prior mode.
    if (low === 'off' || low === 'exit' || low === 'done' || low === 'end' || low === 'stop' || low === 'none') {
      const restore = planPrevMode ?? 'default'
      planPrevMode = null
      if (cur !== 'plan') { ctx.print(t('cmd.planNotActive'), 'system'); return }
      ctx.setConfig({ settings: { ...s, permissionMode: restore } })
      ctx.print(t('cmd.planExited', { mode: restore }), 'system')
      return
    }

    // Entering plan mode: remember where we came from, then flip the real switch
    // so decidePermission starts denying mutations on the next turn onward.
    if (cur !== 'plan') planPrevMode = cur
    ctx.setConfig({ settings: { ...s, permissionMode: 'plan' } })

    // Bare /plan: just switch into plan mode and explain how to use / exit it.
    if (!arg) {
      ctx.print(t('cmd.planEntered'), 'system')
      return
    }

    // /plan <task>: switch to plan mode AND launch the planning turn.
    const prompt =
      `Use the \`plan\` tool to produce a concrete implementation plan for the following task, then present that plan to me. ` +
      `Do NOT edit any files or run mutating commands yet — planning only. ` +
      `When the plan is ready and you want to start implementing, call the \`exit_plan_mode\` tool with the plan to ask for my approval.\n\nTask: ${arg}`
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

// --- /memory: the structured, cross-session memory store (goal lives in /goal) ---
const memory: SlashCommand = {
  name: 'memory',
  get description() { return t('cmd.memoryDesc') },
  run(ctx) {
    const arg = ctx.args.trim()
    if (!arg || arg === 'list' || arg === 'ls') { ctx.print(formatMemoryList(), 'system'); return }
    const [sub, ...rest] = arg.split(/\s+/)
    const body = rest.join(' ').trim()
    switch (sub) {
      case 'save':
      case 'add': {
        // /memory save [type] <description> :: <body>  — or just <text> (reference).
        if (!body) { ctx.print(t('cmd.memoryAddUsage'), 'system', { error: true }); return }
        let rest2 = body
        let type: MemoryType = 'reference'
        const maybeType = rest2.split(/\s+/)[0]
        if ((MEMORY_TYPES as readonly string[]).includes(maybeType)) { type = maybeType as MemoryType; rest2 = rest2.slice(maybeType.length).trim() }
        const [desc, fact] = rest2.includes('::') ? rest2.split('::', 2).map((s) => s.trim()) : [rest2, rest2]
        if (!desc) { ctx.print(t('cmd.memoryAddUsage'), 'system', { error: true }); return }
        const saved = saveMemoryEntry({ description: desc, type, body: fact })
        if (!saved) { ctx.print(t('cmd.memorySaveFailed'), 'system', { error: true }); return }
        ctx.print(t('cmd.memorySaved', { name: saved.name, type: saved.type }), 'system')
        return
      }
      case 'show':
      case 'read':
      case 'cat': {
        if (!body) { ctx.print(t('cmd.memoryShowUsage'), 'system', { error: true }); return }
        const e = getMemory(body)
        if (!e) { ctx.print(t('cmd.memoryNotFound', { name: body }), 'system', { error: true }); return }
        ctx.print(`**${e.name}** _(${e.type})_ — ${e.description}\n\n${e.body}`, 'system')
        return
      }
      case 'rm':
      case 'remove':
      case 'delete': {
        if (!body) { ctx.print(t('cmd.memoryRmUsage'), 'system', { error: true }); return }
        const ok = deleteMemory(body)
        ctx.print(ok ? t('cmd.memoryRemoved', { name: body }) : t('cmd.memoryNotFound', { name: body }), 'system', ok ? undefined : { error: true })
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

// --- /copy: copy an assistant response to the clipboard (the `skipCopyPicker`
// setting). With skipCopyPicker on — or when given an index — it copies straight
// away; otherwise it prints a short picker of recent responses to choose from
// (`/copy <n>`, 1 = most recent). Uses the OSC 52 + native clipboard bridge.
const copy: SlashCommand = {
  name: 'copy',
  aliases: ['cp'],
  get description() { return t('cmd.copyDesc') },
  run(ctx) {
    const assistants = ctx.messages.filter((m) => m.role === 'assistant' && m.content.trim())
    if (!assistants.length) { ctx.print(t('cmd.copyNone'), 'system'); return }
    const skip = getSetting(ctx.config.settings, 'skipCopyPicker') === true
    const arg = ctx.args.trim()
    if (arg || skip) {
      let idx = assistants.length - 1
      if (arg) {
        const n = Number(arg)
        if (!Number.isInteger(n) || n < 1 || n > assistants.length) {
          ctx.print(t('cmd.copyBadIndex', { n: arg, max: assistants.length }), 'system', { error: true }); return
        }
        idx = assistants.length - n // 1 = most recent
      }
      const text = assistants[idx].content
      copyToClipboard(text, process.stdout)
      ctx.print(t('cmd.copyDone', { chars: text.length }), 'system')
      return
    }
    const recent = assistants.slice(-9).reverse()
    const lines = recent.map((m, i) => {
      const preview = m.content.replace(/\s+/g, ' ').trim().slice(0, 60)
      return `- \`/copy ${i + 1}\` — ${preview}${m.content.length > 60 ? '…' : ''}`
    })
    ctx.print([t('cmd.copyPickTitle'), '', ...lines, '', t('cmd.copyPickHint')].join('\n'), 'system')
  },
}

// --- /worktree: create a git worktree (the `worktreeBaseRef` setting). `fresh`
// branches from the origin default branch, `head` from the current local HEAD.
// The worktree lands under `<repo>/.worktrees/<name>` on a new branch.
const worktree: SlashCommand = {
  name: 'worktree',
  aliases: ['wt'],
  get description() { return t('cmd.worktreeDesc') },
  async run(ctx) {
    const name = ctx.args.trim()
    if (!name) { ctx.print(t('cmd.worktreeUsage'), 'system'); return }
    const baseRef: WorktreeBaseRef = String(getSetting(ctx.config.settings, 'worktreeBaseRef')) === 'head' ? 'head' : 'fresh'
    ctx.print(t('cmd.worktreeCreating', { name, base: baseRef }), 'system')
    const r = await createWorktree(process.cwd(), name, baseRef)
    if (!r.ok) { ctx.print(t('cmd.worktreeFailed', { error: r.error ?? '' }), 'system', { error: true }); return }
    ctx.print(t('cmd.worktreeDone', { path: r.path!.replace(os.homedir(), '~'), branch: r.branch!, base: r.base! }), 'system')
  },
}

// --- /editor: open the last assistant response in $EDITOR (the
// `lastResponseInEditor` setting gates it; off → a note on how to enable). The
// app suspends Ink's raw mode while the editor owns the terminal (see app.tsx).
const editor: SlashCommand = {
  name: 'editor',
  get description() { return t('cmd.editorDesc') },
  run(ctx) {
    if (getSetting(ctx.config.settings, 'lastResponseInEditor') !== true) { ctx.print(t('cmd.editorDisabled'), 'system'); return }
    const last = [...ctx.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())
    if (!last) { ctx.print(t('cmd.editorNone'), 'system'); return }
    if (!ctx.openEditor) { ctx.print(t('cmd.tuiOnly', { cmd: '/editor' }), 'system', { error: true }); return }
    ctx.openEditor(last.content)
  },
}

// --- /feedback: capture a feedback report to ~/.anycode/feedback/ (the
// `draftedFeedback` setting). Bare `/feedback` with drafting on asks the model to
// draft one for you to review; otherwise it prints usage. `/feedback <text>`
// saves the report immediately.
const feedback: SlashCommand = {
  name: 'feedback',
  get description() { return t('cmd.feedbackDesc') },
  run(ctx) {
    const body = ctx.args.trim()
    const drafted = getSetting(ctx.config.settings, 'draftedFeedback') !== false
    if (!body) {
      if (drafted && ctx.send) {
        ctx.send('请根据本次会话，帮我起草一条简洁的反馈报告（包含：遇到的问题、期望的行为、可复现步骤）。起草后展示给我确认，我再用 /feedback <内容> 保存。')
        ctx.print(t('cmd.feedbackDrafting'), 'system')
        return
      }
      ctx.print(t('cmd.feedbackUsage'), 'system')
      return
    }
    const saved = saveFeedback(body, new Date().toISOString())
    ctx.print(t('cmd.feedbackSaved', { file: saved.file.replace(os.homedir(), '~'), count: feedbackCount() }), 'system')
  },
}

// --- /rewind: restore a file to its pre-edit state (the `rewindCode` setting).
// Bare `/rewind` lists this session's checkpoints newest-first; `/rewind <n>`
// restores one (writing the old contents back, or deleting a file that hadn't
// existed); `/rewind clear` forgets them. Snapshots are captured automatically
// before write_file/edit_file while rewindCode is on (see lib/checkpoints).
const rewind: SlashCommand = {
  name: 'rewind',
  aliases: ['undo'],
  get description() { return t('cmd.rewindDesc') },
  run(ctx) {
    if (getSetting(ctx.config.settings, 'rewindCode') === false) { ctx.print(t('cmd.rewindDisabled'), 'system'); return }
    const arg = ctx.args.trim()
    if (arg.toLowerCase() === 'clear') { clearCheckpoints(); ctx.print(t('cmd.rewindCleared'), 'system'); return }
    const cps = listCheckpoints().reverse() // newest first
    const rel = (p: string): string => p.replace(process.cwd() + '/', '').replace(os.homedir(), '~')
    if (!arg) {
      if (!cps.length) { ctx.print(t('cmd.rewindNone'), 'system'); return }
      const lines = cps.slice(0, 20).map((c, i) => {
        const kind = c.before === null ? t('cmd.rewindWasNew') : t('cmd.rewindWasEdit')
        return `- \`/rewind ${i + 1}\` — ${rel(c.path)} (${kind})`
      })
      ctx.print([t('cmd.rewindTitle'), '', ...lines, '', t('cmd.rewindHint')].join('\n'), 'system')
      return
    }
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1 || n > cps.length) { ctx.print(t('cmd.rewindBadIndex', { n: arg, max: cps.length }), 'system', { error: true }); return }
    const cp = cps[n - 1]
    const r = restoreCheckpoint(cp.id)
    if (!r.ok) { ctx.print(t('cmd.rewindFailed', { error: r.error ?? '' }), 'system', { error: true }); return }
    ctx.print(t(r.action === 'deleted' ? 'cmd.rewindDeleted' : 'cmd.rewindRestored', { path: rel(r.path ?? cp.path) }), 'system')
  },
}

// /dm — message your other running MeowCode sessions via the file mailbox (the
// `otherSessionMessages` setting). Bare = list online peers; `/dm <n> <text>`
// sends to peer #n; `/dm all <text>` broadcasts. Identity is set by the app's
// mailbox effect, so this only works when the setting isn't 'off'.
const dm: SlashCommand = {
  name: 'dm',
  aliases: ['msg'],
  get description() { return t('cmd.dmDesc') },
  run(ctx) {
    if (!getIdentity()) { ctx.print(t('cmd.dmDisabled'), 'system'); return }
    const now = Date.now()
    const peers = livePeers(now)
    const arg = ctx.args.trim()
    if (!arg) {
      if (!peers.length) { ctx.print(t('cmd.dmNoPeers'), 'system'); return }
      const lines = peers.map((p, i) => `- \`/dm ${i + 1}\` — ${p.title}  ·  ${p.cwd}`)
      ctx.print([t('cmd.dmPeersTitle'), '', ...lines, '', t('cmd.dmUsage')].join('\n'), 'system')
      return
    }
    const sp = arg.indexOf(' ')
    const target = (sp === -1 ? arg : arg.slice(0, sp)).toLowerCase()
    const text = sp === -1 ? '' : arg.slice(sp + 1).trim()
    if (!text) { ctx.print(t('cmd.dmUsage'), 'system'); return }
    const rand = Math.random().toString(36).slice(2, 8)
    const id = `${now}-${rand}`
    if (target === 'all' || target === '*') {
      if (!peers.length) { ctx.print(t('cmd.dmNoPeers'), 'system'); return }
      // Real-time to every live peer, plus one durable broadcast mail (shared id
      // → each receiver dedups its socket copy against the file copy).
      for (const p of peers) sendMessageFrame(p.id, id, text, now)
      const ok = sendMail('*', text, now, rand)
      ctx.print(ok ? t('cmd.dmSent', { to: t('cmd.dmBroadcast') }) : t('cmd.dmFailed'), 'system', ok ? undefined : { error: true })
      return
    }
    const n = Number(target)
    if (!Number.isInteger(n) || n < 1 || n > peers.length) { ctx.print(t('cmd.dmBadIndex', { n: target, max: peers.length }), 'system', { error: true }); return }
    const peer = peers[n - 1]
    sendMessageFrame(peer.id, id, text, now) // instant if the peer's socket is up
    const ok = sendMail(peer.id, text, now, rand) // durable fallback (same id)
    ctx.print(ok ? t('cmd.dmSent', { to: peer.title }) : t('cmd.dmFailed'), 'system', ok ? undefined : { error: true })
  },
}

// /sessions (alias /sess) — list live peer sessions and manage idle-notice
// subscriptions over the socket hub. Bare lists them (● = socket reachable now,
// ✓ = subscribed); `sub <n|all>` / `unsub <n|all>` toggle subscriptions. Messaging
// stays on /dm; this is the "list + subscribe" surface.
const sessions: SlashCommand = {
  name: 'sessions',
  aliases: ['sess'],
  get description() { return t('cmd.sessionsDesc') },
  run(ctx) {
    if (!getIdentity()) { ctx.print(t('cmd.dmDisabled'), 'system'); return }
    const now = Date.now()
    const peers = livePeers(now)
    const arg = ctx.args.trim()
    const sp = arg.indexOf(' ')
    const verb = (sp === -1 ? arg : arg.slice(0, sp)).toLowerCase()
    const rest = (sp === -1 ? '' : arg.slice(sp + 1).trim()).toLowerCase()
    if (verb === 'sub' || verb === 'unsub') {
      if (!peers.length) { ctx.print(t('cmd.dmNoPeers'), 'system'); return }
      let targets = peers
      if (rest !== 'all' && rest !== '*') {
        const n = Number(rest)
        if (!Number.isInteger(n) || n < 1 || n > peers.length) { ctx.print(t('cmd.dmBadIndex', { n: rest || '?', max: peers.length }), 'system', { error: true }); return }
        targets = [peers[n - 1]]
      }
      for (const p of targets) { if (verb === 'sub') subscribeTo(p.id, now); else unsubscribeFrom(p.id, now) }
      const names = targets.map((p) => p.title).join('、')
      ctx.print(t(verb === 'sub' ? 'cmd.sessionsSubbed' : 'cmd.sessionsUnsubbed', { names }), 'system')
      return
    }
    if (!peers.length) { ctx.print(t('cmd.sessionsNone'), 'system'); return }
    const lines = peers.map((p, i) => {
      const marks = [isReachable(p.id) ? t('cmd.sessionsLiveMark') : '', isSubscribed(p.id) ? t('cmd.sessionsSubMark') : ''].filter(Boolean).join(' ')
      return `- \`${i + 1}\` — ${p.title}  ·  ${p.cwd}${marks ? '  ' + marks : ''}`
    })
    ctx.print([t('cmd.sessionsTitle'), '', ...lines, '', t('cmd.sessionsUsage')].join('\n'), 'system')
  },
}

// /ide — report the editor-integration status the `autoConnectIde` setting acts
// on. Detection only: a live editor connection needs the (unbuilt) MeowCode IDE
// extension, so this never claims a handshake it didn't make.
const ide: SlashCommand = {
  name: 'ide',
  get description() { return t('cmd.ideDesc') },
  run(ctx) {
    const auto = getSetting(ctx.config.settings, 'autoConnectIde') === true
    const s = detectIde()
    const rel = (p?: string): string => (p ? p.replace(os.homedir(), '~') : '?')
    if (s.integrated) { ctx.print(t('cmd.ideIntegrated', { name: s.ideName ?? 'IDE' }), 'system'); return }
    if (s.external.length) {
      const lines = s.external.map((l) => `- ${l.ideName ?? 'IDE'} · ${t('cmd.idePort', { port: l.port })}${l.workspace ? ` · ${rel(l.workspace)}` : ''}`)
      ctx.print([t('cmd.ideFound'), '', ...lines, '', t('cmd.ideNeedsExt')].join('\n'), 'system')
      return
    }
    ctx.print(auto ? t('cmd.ideNone') : t('cmd.ideNoneOff'), 'system')
  },
}

// /chrome — report the "Claude in Chrome" integration status (`chromeEnabled`).
// Locates a Chrome binary so we can say whether it COULD run; the actual browser
// control needs a companion extension, which this honestly notes.
const chrome: SlashCommand = {
  name: 'chrome',
  get description() { return t('cmd.chromeDesc') },
  run(ctx) {
    const on = getSetting(ctx.config.settings, 'chromeEnabled') === true
    const c = detectChrome()
    if (!on) { ctx.print(t('cmd.chromeOff'), 'system'); return }
    const found = c.available ? t('cmd.chromeFound', { path: c.path ?? '' }) : t('cmd.chromeMissing')
    ctx.print([t('cmd.chromeOn'), found, t('cmd.chromeNeedsExt')].join('\n'), 'system')
  },
}

const builtins: SlashCommand[] = [help, clear, newSession, model, provider, login, logout, effort, theme, goal, plan, loop, memory, config, usage, status, stats, compact, autocompact, skill, init, hooks, mcp, doctor, exportCmd, review, terminalSetup, statusline, permissions, copy, worktree, editor, feedback, rewind, dm, sessions, ide, chrome, resume, fork, version, exit]

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
