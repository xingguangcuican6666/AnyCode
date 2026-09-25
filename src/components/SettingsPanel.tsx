import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { AppConfig, Message, PanelTab, SessionUsage } from '../types'
import { useTheme } from '../theme'
import { themeList, AUTO_THEME } from '../theme'
import { providerIds } from '../providers'
import { DEFAULT_THEME } from '../theme'
import { VERSION, NAME } from '../version'
import {
  SETTINGS, type SettingSpec, getSetting, coerceSetting, settingHint,
} from '../lib/settings'
import { contextState, contextLevel, fmtTokens, fmtDuration, bar } from '../lib/usage'
import { fmtUsd } from '../lib/pricing'
import { loadMemory } from '../lib/memory'
import { loadSkills } from '../lib/skills'
import { loadUserCommands } from '../lib/userCommands'
import { StatsView, type StatsSub } from './StatsView'
import type { Range } from '../lib/stats'

// The interactive settings overlay — a tabbed page (Settings / Status / Config /
// Usage / Stats) modeled on Claude Code's. Config and Settings are editable
// lists (↑↓ to move, Enter/Space to change, / to search); Status/Usage/Stats are
// read-only panels. Rendered by App in place of the input cluster, exactly like
// ThemePicker, so the transcript stays visible above it.

// "Settings" is the panel's title (rendered as a heading above the tab row), not
// a selectable tab. The core config fields that used to live under a "Settings"
// tab now lead the Config tab (see rowsForTab).
const TABS: { id: PanelTab; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'config', label: 'Config' },
  { id: 'usage', label: 'Usage' },
  { id: 'stats', label: 'Stats' },
]

// A row on an editable tab: a schema-backed setting, a core AppConfig field, or
// a read-only line (the API key).
type Row =
  | { kind: 'setting'; key: string; label: string; spec: SettingSpec }
  | { kind: 'core'; key: 'provider' | 'model' | 'theme' | 'system'; label: string; ctl: 'enum' | 'text'; values?: string[] }
  | { kind: 'readonly'; key: string; label: string }

interface Props {
  tab: PanelTab
  width: number
  rows: number
  config: AppConfig
  usage: SessionUsage
  messages: Message[]
  goalStatus?: () => string | null
  loopStatus?: () => string | null
  setConfig: (patch: Partial<AppConfig>) => void
  onChangeTab: (tab: PanelTab) => void
  onClose: () => void
}

// Core AppConfig fields shown on the Settings tab. provider/theme cycle through
// their known values (provider ids include any custom Anthropic-protocol
// providers, see providers/index.ts); model/system are free text.
function coreRows(config: AppConfig): Row[] {
  return [
    { kind: 'core', key: 'provider', label: 'Provider', ctl: 'enum', values: providerIds(config) },
    { kind: 'core', key: 'model', label: 'Model', ctl: 'text' },
    { kind: 'core', key: 'theme', label: 'Theme', ctl: 'enum', values: [AUTO_THEME, ...themeList().map((t) => t.name)] },
    { kind: 'core', key: 'system', label: 'System prompt', ctl: 'text' },
    { kind: 'readonly', key: 'apiKey', label: 'API key' },
  ]
}

// All rows for an editable tab. Config now leads with the core AppConfig fields
// (provider/model/theme/system/apiKey) and then the schema-backed settings, so
// everything editable lives on one tab under the "Settings" title.
function rowsForTab(tab: PanelTab, config: AppConfig): Row[] {
  if (tab === 'config' || tab === 'settings') {
    return [...coreRows(config), ...SETTINGS.map((s) => ({ kind: 'setting' as const, key: s.key, label: s.label, spec: s }))]
  }
  return []
}

// The current value of a row, formatted for the value column.
function rowValue(row: Row, config: AppConfig): string {
  if (row.kind === 'readonly') return config.apiKey ? 'set (from env)' : 'not set'
  if (row.kind === 'core') {
    if (row.key === 'system') return config.system ? 'custom' : 'default'
    if (row.key === 'theme') return config.theme ?? DEFAULT_THEME
    return String(config[row.key] ?? '')
  }
  const spec = row.spec
  const v = getSetting(config.settings, spec.key)
  if (spec.type === 'boolean') return v ? 'true' : 'false'
  const base = spec.type === 'number' ? `${v}${spec.unit ?? ''}` : String(v)
  // Mark the default like Claude Code ("medium (default)") — but not for booleans.
  return v === spec.default ? `${base} (default)` : base
}

// A one-line hint describing the focused row (its schema description or how to
// edit it), shown just above the footer.
function rowHint(row: Row | undefined): string {
  if (!row) return ''
  if (row.kind === 'setting') return `${row.spec.description}. Accepts: ${settingHint(row.spec)}.`
  if (row.kind === 'readonly') return 'Read from ANTHROPIC_API_KEY — never set or stored here.'
  if (row.ctl === 'enum') return `Cycle with Enter/Space. Options: ${(row.values ?? []).join(', ')}.`
  return 'Press Enter to edit. Empty value clears it.'
}

// Whether a row is edited inline (number/string) vs toggled/cycled in place.
function isTextRow(row: Row): boolean {
  if (row.kind === 'setting') return row.spec.type === 'number' || row.spec.type === 'string'
  if (row.kind === 'core') return row.ctl === 'text'
  return false
}

// The raw string an inline edit starts from.
function editSeed(row: Row, config: AppConfig): string {
  if (row.kind === 'core') return row.key === 'system' ? (config.system ?? '') : String(config[row.key] ?? '')
  if (row.kind === 'setting') return String(getSetting(config.settings, row.spec.key))
  return ''
}

// Read-only tab bodies. Each returns markdown-free lines the panel renders as a
// simple column — mirroring what the /status, /usage, /stats text commands show.
function statusLines(config: AppConfig, usage: SessionUsage, messages: Message[], goal: string, loop: string): string[] {
  const ctx = contextState(messages, config.model)
  const pct = Math.round(ctx.ratio * 100)
  const mem = loadMemory()
  const skills = loadSkills()
  const custom = loadUserCommands()
  return [
    `${NAME} v${VERSION}`,
    '',
    `cwd            ${process.cwd()}`,
    `provider/model ${config.provider} / ${config.model}`,
    `api key        ${config.apiKey ? 'set' : 'not set'}   ·   theme  ${config.theme ?? DEFAULT_THEME}`,
    `context        ${bar(ctx.ratio, 16)} ${pct}% (${contextLevel(ctx.ratio)})`,
    `session        ${usage.turns} turns · ${fmtTokens(usage.inputTokens + usage.outputTokens)} tokens · ${usage.toolCalls} tool calls · ${usage.compactions} compactions`,
    `goal           ${goal}`,
    `loop           ${loop}`,
    `notes ${mem.notes.length} · skills ${skills.length} · custom commands ${custom.length}`,
  ]
}

// The Usage tab: a Claude Code–style cost view. Cost is computed at official
// rates (lib/pricing) regardless of provider; tokens/cache are the provider's
// real counts when reported (0 for mock). Sections are laid out so each heading
// is the only line followed by a blank (see the heading heuristic in render).
function usageLines(config: AppConfig, usage: SessionUsage, messages: Message[]): string[] {
  const ctx = contextState(messages, config.model)
  const pct = Math.round(ctx.ratio * 100)
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  const wallMs = Math.max(0, Date.now() - usage.startedAt)
  return [
    'Session', '',
    `Total cost              ${fmtUsd(usage.costUsd)}`,
    `Total duration (API)    ${fmtDuration(usage.apiMs)}`,
    `Total duration (wall)   ${fmtDuration(wallMs)}`,
    `Total code changes      ${usage.linesAdded} added · ${usage.linesRemoved} removed`,
    `Turns · tool calls      ${usage.turns} · ${usage.toolCalls}`,
    'Usage', '',
    `Input                   ${fmtTokens(usage.inputTokens)}`,
    `Output                  ${fmtTokens(usage.outputTokens)}`,
    `Cache read              ${fmtTokens(usage.cacheReadTokens)}`,
    `Cache write             ${fmtTokens(usage.cacheCreationTokens)}`,
    `Total tokens            ${fmtTokens(totalTokens)}`,
    'Context window', '',
    `${bar(ctx.ratio, 20)} ${pct}%`,
    `used ${fmtTokens(ctx.used)} / ${fmtTokens(ctx.limit)}  ·  remaining ${fmtTokens(ctx.remaining)}`,
  ]
}

export function SettingsPanel(props: Props): React.ReactElement {
  const { tab, width, rows, config, usage, messages, goalStatus, loopStatus, setConfig, onChangeTab, onClose } = props
  const colors = useTheme()
  const [cursor, setCursor] = useState(0)
  const [search, setSearch] = useState('')
  // Editable tabs are search-first: the tab opens focused on the search box, and
  // ↓/↵ moves into the list. Stats has its own sub-view + range selection.
  const [focus, setFocus] = useState<'search' | 'list'>('search')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [statsSub, setStatsSub] = useState<StatsSub>('overview')
  const [statsRange, setStatsRange] = useState<Range>('all')
  // On the Stats tab ↑↓ moves a focus cursor between its selector rows (0 = the
  // Overview/Models view, 1 = the Range filter) and ↵/space cycles the focused
  // one — the same move/change model as the editable tabs, so Range is reachable.
  const [statsCursor, setStatsCursor] = useState(0)

  // Every tab switch resets navigation/search/edit/stats state so each tab opens clean.
  useEffect(() => {
    setCursor(0); setSearch(''); setFocus('search'); setEditing(false); setEditError(null)
    setStatsSub('overview'); setStatsRange('all'); setStatsCursor(0)
  }, [tab])

  const editable = tab === 'config' || tab === 'settings'
  const allRows = useMemo(() => rowsForTab(tab, config), [tab, config])
  const q = search.trim().toLowerCase()
  const filtered = q ? allRows.filter((r) => r.label.toLowerCase().includes(q)) : allRows
  const cur = Math.min(cursor, Math.max(0, filtered.length - 1))
  const focused: Row | undefined = filtered[cur]
  const labelW = Math.min(38, Math.max(8, ...allRows.map((r) => r.label.length)))

  const switchTab = (delta: number): void => {
    const i = TABS.findIndex((t) => t.id === tab)
    onChangeTab(TABS[(i + delta + TABS.length) % TABS.length].id)
  }

  // Toggle/cycle a row in place, or drop into inline edit for text/number rows.
  const activate = (row: Row): void => {
    if (row.kind === 'readonly') return
    if (isTextRow(row)) { setDraft(editSeed(row, config)); setEditError(null); setEditing(true); return }
    if (row.kind === 'setting' && row.spec.type === 'boolean') {
      setConfig({ settings: { ...config.settings, [row.spec.key]: !getSetting(config.settings, row.spec.key) } })
      return
    }
    if (row.kind === 'setting' && row.spec.type === 'enum') {
      const opts = row.spec.values ?? []
      const idx = opts.indexOf(String(getSetting(config.settings, row.spec.key)))
      const next = opts[(idx + 1) % opts.length]
      setConfig({ settings: { ...config.settings, [row.spec.key]: next } })
      return
    }
    if (row.kind === 'core' && row.ctl === 'enum') {
      const opts = row.values ?? []
      const curVal = row.key === 'theme' ? (config.theme ?? DEFAULT_THEME) : String(config[row.key] ?? '')
      const next = opts[(opts.indexOf(curVal) + 1) % opts.length]
      setConfig(row.key === 'provider' ? { provider: next } : { theme: next })
    }
  }

  // Commit an inline edit: validate schema settings, apply core fields directly.
  const commit = (): void => {
    const row = focused
    if (!row) { setEditing(false); return }
    const v = draft.trim()
    if (row.kind === 'core') {
      if (row.key === 'model') { if (v) setConfig({ model: v }) }
      else if (row.key === 'system') setConfig({ system: v || undefined })
      setEditing(false); setEditError(null); return
    }
    if (row.kind === 'setting') {
      const res = coerceSetting(row.spec, v)
      if (!res.ok) { setEditError(res.error ?? 'invalid'); return }
      setConfig({ settings: { ...config.settings, [row.spec.key]: res.value! } })
      setEditing(false); setEditError(null)
    }
  }

  useInput((input, key) => {
    if (editing) {
      if (key.return) { commit(); return }
      if (key.escape) { setEditing(false); setEditError(null); return }
      if (key.backspace || key.delete) { setDraft((d) => d.slice(0, -1)); setEditError(null); return }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return
      // Only append printable characters — never control bytes (e.g. a burst of
      // backspaces arriving as one chunk), which would corrupt a validated value.
      const printable = input ? input.replace(/[\x00-\x1f\x7f]/g, '') : ''
      if (printable) { setDraft((d) => d + printable); setEditError(null) }
      return
    }
    // Tab switching works from any tab/focus.
    if (key.leftArrow) { switchTab(-1); return }
    if (key.rightArrow) { switchTab(1); return }
    if (key.tab) { switchTab(key.shift ? -1 : 1); return }

    // Stats tab: ↑↓ move the focus cursor between the selector rows, ↵/space cycle
    // the focused one (r stays as a shortcut for the range). Range only exists on
    // the Overview sub-view, so the cursor is capped at that row's count.
    if (tab === 'stats') {
      if (key.escape) { onClose(); return }
      const cycleRange = (): void => setStatsRange((r) => (r === 'all' ? '30d' : r === '30d' ? '7d' : 'all'))
      const maxRow = statsSub === 'overview' ? 1 : 0
      const row = Math.min(statsCursor, maxRow)
      if (key.upArrow) { setStatsCursor(Math.max(0, row - 1)); return }
      if (key.downArrow) { setStatsCursor(Math.min(maxRow, row + 1)); return }
      if (key.return || input === ' ') {
        if (row === 0) { setStatsSub((s) => (s === 'overview' ? 'models' : 'overview')); setStatsCursor(0) }
        else cycleRange()
        return
      }
      if (input === 'r' || input === 'R') { cycleRange(); return }
      return
    }
    // Other read-only tabs (Status/Usage): esc closes, tabs already handled.
    if (!editable) { if (key.escape) onClose(); return }

    // Editable tabs (Settings/Config): search-first, then list navigation.
    if (focus === 'search') {
      if (key.escape) { if (search) { setSearch(''); setCursor(0) } else onClose(); return }
      if (key.return || key.downArrow) { if (filtered.length > 0) { setFocus('list'); setCursor(0) } return }
      if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); setCursor(0); return }
      if (key.ctrl || key.meta) return
      const printable = input ? input.replace(/[\x00-\x1f\x7f]/g, '') : ''
      if (printable) { setSearch((s) => s + printable); setCursor(0) }
      return
    }
    // focus === 'list'
    if (key.escape) { onClose(); return }
    if (input === '/') { setFocus('search'); return }
    if (filtered.length > 0) {
      if (key.upArrow) {
        if (cur <= 0) { setFocus('search'); return } // past the top → back to the search box
        setCursor(() => Math.max(0, cur - 1)); return
      }
      if (key.downArrow) { setCursor(() => Math.min(filtered.length - 1, cur + 1)); return }
      if (key.return || input === ' ') { if (focused) activate(focused); return }
    }
  })

  // ---- render / height budgeting ----
  // The whole frame (border to border) MUST stay a couple of rows shorter than the
  // viewport. If it ever reaches full height, the terminal scrolls the frame's top
  // into scrollback and Ink's log-update erase (cursor-up by logical line count)
  // can no longer reach it — which is exactly what left the ghost/stacked frames
  // on tab-switch and close. So every tab's body is windowed to a strict budget.
  const RESERVE = 2                                     // headroom below the frame
  const maxH = Math.max(10, rows - RESERVE)
  const CHROME = 8                                      // border2 + title + tabs + 2 spacers + hint + footer
  const bodyBudget = Math.max(3, maxH - CHROME)
  // Editable tabs spend two body lines on the search box + its spacer.
  const listAvail = Math.max(1, bodyBudget - 2)
  // When the list overflows, reserve two lines for the ↑/↓ scroll indicators so the
  // windowed slice plus markers still fit exactly within the budget.
  const scrolling = filtered.length > listAvail
  const listRows = scrolling ? Math.max(1, listAvail - 2) : listAvail
  const start = Math.min(Math.max(0, cur - Math.floor(listRows / 2)), Math.max(0, filtered.length - listRows))
  const windowed = filtered.slice(start, start + listRows)
  const above = start
  const below = Math.max(0, filtered.length - (start + listRows))

  const goal = goalStatus?.() ?? 'none'
  const loop = loopStatus?.() ?? 'none'
  const roAll =
    tab === 'status' ? statusLines(config, usage, messages, goal, loop)
    : tab === 'usage' ? usageLines(config, usage, messages)
    : []
  // Read-only tabs have no scroll keys, so clamp to the budget: on a terminal too
  // short to show everything, drop the overflow and note it rather than letting the
  // frame spill past the viewport (which is what desynced Ink's repaint).
  const roLines = roAll.length > bodyBudget
    ? [...roAll.slice(0, Math.max(1, bodyBudget - 1)), `… +${roAll.length - Math.max(1, bodyBudget - 1)} more — resize terminal`]
    : roAll

  const footer =
    editing ? 'type · ↵ save · esc cancel'
    : tab === 'stats' ? '↑↓ move · ↵/space change · ←→ tabs · esc close'
    : !editable ? '←→ tabs · esc close'
    : focus === 'search' ? `type to filter · ↓/↵ list · esc ${search ? 'clear' : 'close'} · ←→ tabs`
    : '↑↓ move · ↵/space change · / search · ←→ tabs · esc close'

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={colors.accentDim} paddingX={1}>
      <Text bold color={colors.accentBright}>Settings</Text>
      <Box>
        {TABS.map((t) => {
          const active = t.id === tab
          return (
            <Text key={t.id} inverse={active} bold={active} color={active ? undefined : colors.dim}>
              {` ${t.label} `}
            </Text>
          )
        })}
      </Box>
      <Text> </Text>
      {editable ? (
        <Box flexDirection="column">
          <Text color={focus === 'search' ? colors.accentBright : colors.dim} wrap="truncate">
            {'🔍 '}
            {search
              ? <Text color={colors.text}>{search}</Text>
              : <Text color={colors.dim}>{tab === 'config' ? 'Search settings…' : 'Search options…'}</Text>}
            {focus === 'search' ? '▏' : ''}
          </Text>
          <Text> </Text>
          {above > 0 ? <Text color={colors.dim}>{`  ↑ ${above} more above`}</Text> : null}
          {filtered.length === 0 ? <Text color={colors.dim}>  no matching settings</Text> : null}
          {windowed.map((row) => {
            const isCur = focus === 'list' && row === focused
            const editingThis = editing && isCur
            return (
              <Text key={`${row.kind}:${row.key}`} color={isCur ? colors.accentBright : colors.text} wrap="truncate">
                {isCur ? '❯ ' : '  '}{row.label.padEnd(labelW).slice(0, labelW)}  {editingThis
                  ? <Text color={colors.accent}>{draft}▏</Text>
                  : <Text color={colors.dim}>{rowValue(row, config)}</Text>}
              </Text>
            )
          })}
          {below > 0 ? <Text color={colors.dim}>{`  ↓ ${below} more below`}</Text> : null}
        </Box>
      ) : tab === 'stats' ? (
        <StatsView width={width - 6} rows={bodyBudget} sub={statsSub} range={statsRange} focusRow={statsSub === 'overview' ? Math.min(statsCursor, 1) : 0} />
      ) : (
        <Box flexDirection="column">
          {roLines.map((line, i) => {
            const heading = line !== '' && roLines[i + 1] === ''
            return (
              <Text key={i} bold={heading} color={heading ? colors.accent : colors.text} wrap="truncate">{line === '' ? ' ' : line}</Text>
            )
          })}
        </Box>
      )}
      <Text> </Text>
      {editError
        ? <Text color={colors.error} wrap="truncate">{`⚠ ${editError}`}</Text>
        : (editable && focused && focus === 'list' ? <Text color={colors.dim} wrap="truncate">{rowHint(focused)}</Text> : null)}
      <Text color={colors.dim}>{footer}</Text>
    </Box>
  )
}
