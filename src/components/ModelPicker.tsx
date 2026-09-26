import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdin } from 'ink'
import { useTheme } from '../theme'
import { fetchModelCatalog, type ModelCatalog, type ModelGroup } from '../lib/models'
import { loadCredentials } from '../lib/credentials'
import { resolveNewapiBase } from '../lib/newapi'
import { resolveRelayToken } from '../lib/oauth'
import { displayWidth } from '../lib/text'
import { useT } from '../lib/i18n'

// Interactive /model overlay: a search box + a scrollable selector populated from
// the API (GET /v1/models via the relay key). When the instance exposes more than
// one selectable group, a windowed tab row appears at the top and ←/→ switch
// groups; the tab shows the group NAME and the active group's 说明信息 prints at
// the bottom. Mirrors ThemePicker/settings (owns the keyboard via its own
// useInput) and additionally supports the mouse: hover highlights a row, click
// selects it / switches a tab, and the wheel moves the cursor.

interface Props {
  current: string
  width: number
  rows: number
  onSelect: (name: string) => void
  onCancel: () => void
}

const WINDOW = 10 // max model rows shown at once (the list scrolls within this)
const PAD = 1 // ModelPicker's paddingX: content col c ↔ 1-based screen x = c + PAD + 1

// A tab token as laid out on the (windowed) tab strip: the rendered text, whether
// it's the active tab, its group index, and its content-column span for click
// hit-testing (0-based, inclusive). Marker cells (‹ ›) carry tabIndex = -1.
interface TabSeg { text: string; active: boolean; tabIndex: number; start: number; end: number }

// Lay the tab tokens out into a single line no wider than `avail`, always keeping
// the active tab visible; clipped ends get ‹ / › markers. Returns the pieces to
// render plus their column spans (for mouse hit-testing).
function windowTabs(groups: ModelGroup[], active: number, avail: number): TabSeg[] {
  const tok = groups.map((g, i) => {
    const text = i === active ? `[${g.label}]` : ` ${g.label} `
    return { text, w: displayWidth(text) }
  })
  const budget = Math.max(4, avail - 2) // reserve ~2 cols for ‹ › markers
  let lo = active, hi = active, used = tok[active]?.w ?? 0
  for (let grow = true; grow;) {
    grow = false
    if (hi + 1 < tok.length && used + tok[hi + 1].w <= budget) { hi++; used += tok[hi].w; grow = true }
    if (lo - 1 >= 0 && used + tok[lo - 1].w <= budget) { lo--; used += tok[lo].w; grow = true }
  }
  const segs: TabSeg[] = []
  let col = 0
  if (lo > 0) { segs.push({ text: '‹ ', active: false, tabIndex: -1, start: col, end: col + 1 }); col += 2 }
  for (let i = lo; i <= hi; i++) {
    segs.push({ text: tok[i].text, active: i === active, tabIndex: i, start: col, end: col + tok[i].w - 1 })
    col += tok[i].w
  }
  if (hi < groups.length - 1) segs.push({ text: ' ›', active: false, tabIndex: -1, start: col, end: col + 1 })
  return segs
}

export function ModelPicker({ current, width, rows, onSelect, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const { stdin } = useStdin()
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [tab, setTab] = useState(0) // active group tab (0 = "所有分组")
  const abortRef = useRef<AbortController | null>(null)
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect

  // Fetch the catalog once on mount; esc/unmount aborts the in-flight request.
  useEffect(() => {
    const base = loadCredentials()?.baseUrl || resolveNewapiBase()
    const ac = new AbortController(); abortRef.current = ac
    // resolveRelayToken yields the sk- key or a fresh OAuth at_ token (refreshing
    // if needed), so the picker works for both login kinds.
    void resolveRelayToken()
      .then((key) => fetchModelCatalog(base, key, ac.signal))
      .then((c) => { setCatalog(c); setLoading(false) })
      .catch(() => { setCatalog({ models: [], error: t('model.fetchError') }); setLoading(false) })
    return () => ac.abort()
  }, [])

  // Tabs: prepend an "所有分组" tab (all callable models) before per-group tabs,
  // so the full list is always reachable. Only shown when ≥2 groups are available.
  const groups: ModelGroup[] = useMemo(() => {
    if (!catalog?.groups || catalog.groups.length < 2) return []
    return [{ id: '__all__', label: t('model.allGroups') }, ...catalog.groups]
  }, [catalog, t])
  const hasTabs = groups.length > 0
  const activeGroup = hasTabs ? groups[tab] : undefined

  // The models available under the active tab (before the search filter).
  const scoped: string[] = useMemo(() => {
    if (!catalog) return []
    if (!hasTabs) return catalog.models
    const g = groups[tab]
    if (!g || g.id === '__all__') return catalog.models
    return catalog.byGroup?.[g.id] ?? []
  }, [catalog, groups, tab, hasTabs])

  // Apply the search box: case-insensitive substring match on the model id.
  const filtered: string[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? scoped.filter((m) => m.toLowerCase().includes(q)) : scoped
  }, [scoped, query])

  // Keep the cursor in range whenever the filtered list changes.
  useEffect(() => { setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1))) }, [filtered.length])
  // COMPONENT_BODY_2

  // Fit the list to the screen so the bottom-anchored overlay never clips the
  // list itself (which would break mouse row math). Chrome above the list:
  // title+subtitle+blank+search(+tabs)+blank; trailer below: blank(+desc)+footer.
  const chromeAbove = hasTabs ? 6 : 5
  const trailer = hasTabs ? 3 : 2
  const win = Math.max(3, Math.min(WINDOW, rows - chromeAbove - trailer))

  // Window the list so it never overflows: keep the cursor visible within `win`.
  const start = Math.min(Math.max(0, index - Math.floor(win / 2)), Math.max(0, filtered.length - win))
  const visible = filtered.slice(start, start + win)
  const listCount = visible.length
  const showList = !loading && !(catalog?.error && filtered.length === 0) && listCount > 0

  // The tab strip, windowed to the content width (never wraps → 1 screen row).
  const tabSegs = useMemo(() => (hasTabs ? windowTabs(groups, tab, width - PAD * 2) : []), [hasTabs, groups, tab, width])

  // Screen-row geometry for mouse hit-testing. The modal wrapper is a default
  // (row-direction) flex box, so its justifyContent doesn't move us vertically and
  // the stretched overlay renders from the TOP of the alt screen: title on screen
  // row 1, everything measured DOWN from there (independent of terminal height).
  // SGR y is 1-based; content col c ↔ screen x = c + PAD + 1.
  const listTop = chromeAbove + 1 // first list line (after title/subtitle/blank/search[/tabs]/blank)
  const layoutRef = useRef({ loading, hasTabs, tabsRow: 0, tabSegs, firstItemRow: 0, lastItemRow: 0, start, filtered, filteredLen: filtered.length, listCount })
  layoutRef.current = {
    loading, hasTabs,
    tabsRow: hasTabs ? chromeAbove - 1 : 0, // the tab strip sits just above the blank + list
    tabSegs,
    firstItemRow: listTop,
    lastItemRow: listTop + (showList ? listCount : 0) - 1,
    start, filtered, filteredLen: filtered.length,
    listCount: showList ? listCount : 0,
  }

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (loading) return
    if (key.return) {
      // Prefer the highlighted item; fall back to the raw query so a model not in
      // the pulled list (or an offline list) can still be set directly.
      const picked = filtered[index] ?? (query.trim() || null)
      if (picked) onSelect(picked)
      return
    }
    if (key.upArrow) { setIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0)); return }
    if (key.downArrow) { setIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0)); return }
    // ←/→ switch group tabs (only when tabs are shown).
    if (hasTabs && key.leftArrow) { setTab((t) => (t - 1 + groups.length) % groups.length); setIndex(0); return }
    if (hasTabs && key.rightArrow) { setTab((t) => (t + 1) % groups.length); setIndex(0); return }
    // Search box editing.
    if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); return }
    if (key.ctrl || key.meta || key.tab) return
    if (!input || /[\r\n]/.test(input)) return
    // Drop mouse reports that Ink may surface here as text (SGR / legacy forms),
    // so pointer movement never pollutes the search box (see the stdin listener).
    if (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input)) return
    setQuery((q) => q + input)
  })
  // Mouse: enable any-motion reporting (?1003h) so hover moves the highlight like
  // Claude Code's settings page; on unmount re-assert the app's base modes
  // (?1000h?1002h?1006h). A bare ?1003l can clear mouse tracking entirely on
  // single-mode terminals, leaving the wheel to emit ↑/↓ (history navigation).
  // App skips mouse while a modal is open, so the overlay owns it here.
  useEffect(() => {
    const out = process.stdout
    try { out.write('\x1b[?1003h') } catch { /* best-effort */ }
    const onData = (buf: Buffer): void => {
      const s = buf.toString('utf8')
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
      let m: RegExpExecArray | null
      const L = layoutRef.current
      while ((m = re.exec(s)) !== null) {
        if (L.loading) continue
        const b = Number(m[1]); const x = Number(m[2]); const y = Number(m[3]); const release = m[4] === 'm'
        // Wheel (buttons 64/65) → move the cursor one row (wraps).
        if (b === 64 || b === 65) {
          const d = b === 65 ? 1 : -1
          setIndex((i) => { const n = layoutRef.current.filteredLen; return n ? (i + d + n) % n : 0 })
          continue
        }
        const cc = x - (PAD + 1) // 1-based screen x → 0-based content column
        // Tab strip: a click switches to the tab under the pointer.
        if (L.hasTabs && y === L.tabsRow) {
          if (release) {
            const seg = L.tabSegs.find((t) => t.tabIndex >= 0 && cc >= t.start && cc <= t.end)
            if (seg) { setTab(seg.tabIndex); setIndex(0) }
          }
          continue
        }
        // List rows: hover/press moves the highlight, release (click) selects.
        if (L.listCount > 0 && y >= L.firstItemRow && y <= L.lastItemRow) {
          const real = L.start + (y - L.firstItemRow)
          if (real < 0 || real >= L.filteredLen) continue
          if (release) { const picked = L.filtered[real]; if (picked) onSelectRef.current(picked) }
          else setIndex((i) => (i === real ? i : real))
        }
      }
    }
    stdin?.on('data', onData)
    return () => { stdin?.off('data', onData); try { out.write('\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h') } catch { /* best-effort */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  const activeDesc = activeGroup?.description
  return (
    <Box flexDirection="column" width={width} paddingX={PAD}>
      <Text bold color={colors.accent}>{t('model.title')}</Text>
      <Text color={colors.dim}>{t('model.subtitle')}</Text>
      <Text> </Text>

      <Box>
        <Text color={colors.accent}>{t('model.searchLabel')}</Text>
        {query ? <Text color={colors.text} wrap="truncate">{query}<Text inverse> </Text></Text>
          : <Text color={colors.dim}>{t('model.searchPlaceholder')}<Text inverse> </Text></Text>}
      </Box>

      {hasTabs ? (
        <Text wrap="truncate">
          {tabSegs.map((seg, i) => (
            <Text key={i} color={seg.active ? colors.accentBright : colors.dim} bold={seg.active}>{seg.text}</Text>
          ))}
        </Text>
      ) : null}

      <Text> </Text>
      <Box flexDirection="column">
        {loading ? (
          <Text color={colors.warning}>{t('model.loading')}</Text>
        ) : catalog?.error && filtered.length === 0 ? (
          <Text color={colors.error}>✗ {catalog.error}</Text>
        ) : filtered.length === 0 ? (
          <Text color={colors.dim}>{t('model.noMatch')}{query ? t('model.noMatchHint') : ''}</Text>
        ) : (
          visible.map((mdl, i) => {
            const real = start + i
            const cursor = real === index
            const isCurrent = mdl === current
            return (
              <Text key={mdl} color={cursor ? colors.accentBright : colors.text} wrap="truncate">
                {cursor ? '❯ ' : '  '}{mdl}{isCurrent ? <Text color={colors.success}> ✔</Text> : ''}
              </Text>
            )
          })
        )}
      </Box>

      <Text> </Text>
      {hasTabs ? (
        <Text color={colors.dim} wrap="truncate">{activeDesc ? t('model.descPrefix', { desc: activeDesc }) : ' '}</Text>
      ) : null}
      <Text color={colors.dim} wrap="truncate">
        {filtered.length > 0 ? `${index + 1}/${filtered.length} · ` : ''}{t('model.hintSelect')}{hasTabs ? t('model.hintSwitchGroup') : ''}{t('model.hintConfirm')}
      </Text>
    </Box>
  )
}
