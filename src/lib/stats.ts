// Lifetime usage stats, persisted to ~/.anycode/stats.json. This is what the
// Stats tab's heatmap + "all-time" numbers read from: per-day token/cost/turn
// totals, per-model totals, session count, and the longest single session. Kept
// dependency-free and fully defensive — a missing or corrupt file just yields an
// empty store, and every write is best-effort (stats are never load-bearing).
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const STATS_DIR = path.join(os.homedir(), '.anycode')
export const STATS_FILE = path.join(STATS_DIR, 'stats.json')

export interface DayStat {
  tokens: number   // input + output + cache, the number the heatmap buckets on
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turns: number
}

export interface StatsStore {
  version: 1
  firstDay: string            // 'YYYY-MM-DD' of the earliest recorded activity
  sessions: number
  longestSessionMs: number
  days: Record<string, DayStat>
  models: Record<string, number>  // model id → cumulative tokens
  updatedAt: string
}

export function emptyStore(): StatsStore {
  return { version: 1, firstDay: '', sessions: 0, longestSessionMs: 0, days: {}, models: {}, updatedAt: '' }
}

function emptyDay(): DayStat {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
}

/** Local 'YYYY-MM-DD' for a date (defaults to now). */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a 'YYYY-MM-DD' key into a local Date at midnight. */
function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

/** A day key shifted by n days (n may be negative). */
function shiftDay(key: string, n: number): string {
  const d = parseDay(key)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}

export function loadStats(): StatsStore {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) as Partial<StatsStore>
    const s = { ...emptyStore(), ...raw }
    s.days = raw.days ?? {}
    s.models = raw.models ?? {}
    return s
  } catch {
    return emptyStore()
  }
}

export function saveStats(s: StatsStore): void {
  try {
    fs.mkdirSync(STATS_DIR, { recursive: true })
    fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2))
  } catch {
    // best-effort; lifetime stats are never load-bearing
  }
}

// One session bump per process, however many times App remounts (resize/compact
// remount useChat, which must NOT re-count the session).
let sessionRecorded = false
export function recordSession(): void {
  if (sessionRecorded) return
  sessionRecorded = true
  const s = loadStats()
  s.sessions += 1
  s.updatedAt = new Date().toISOString()
  saveStats(s)
}

/** One turn's real usage, folded into the lifetime store. */
export interface TurnStat {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  wallMs?: number   // running session wall-time, to track the longest session
}

export function recordTurn(t: TurnStat, now: Date = new Date()): void {
  const s = loadStats()
  const key = dayKey(now)
  const day = s.days[key] ?? emptyDay()
  const total = t.input + t.output + t.cacheRead + t.cacheWrite
  day.input += t.input
  day.output += t.output
  day.cacheRead += t.cacheRead
  day.cacheWrite += t.cacheWrite
  day.cost += t.cost
  day.turns += 1
  day.tokens += total
  s.days[key] = day
  if (t.model) s.models[t.model] = (s.models[t.model] ?? 0) + total
  if (!s.firstDay || key < s.firstDay) s.firstDay = key
  if (t.wallMs && t.wallMs > s.longestSessionMs) s.longestSessionMs = t.wallMs
  s.updatedAt = now.toISOString()
  saveStats(s)
}

// ---- aggregates for the Stats tab ----

export type Range = 'all' | '30d' | '7d'

export interface RangeTotals {
  tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number
  cost: number; turns: number; activeDays: number
}

/** Sum the day stats that fall within a range (ending today). */
export function rangeTotals(s: StatsStore, range: Range, now: Date = new Date()): RangeTotals {
  const acc: RangeTotals = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, activeDays: 0 }
  const cutoff = range === 'all' ? '' : shiftDay(dayKey(now), range === '7d' ? -6 : -29)
  for (const [key, d] of Object.entries(s.days)) {
    if (cutoff && key < cutoff) continue
    acc.tokens += d.tokens; acc.input += d.input; acc.output += d.output
    acc.cacheRead += d.cacheRead; acc.cacheWrite += d.cacheWrite
    acc.cost += d.cost; acc.turns += d.turns
    if (d.tokens > 0) acc.activeDays += 1
  }
  return acc
}

/** Current streak (consecutive active days ending today) and longest ever. */
export function streaks(s: StatsStore, now: Date = new Date()): { current: number; longest: number } {
  const active = new Set(Object.entries(s.days).filter(([, d]) => d.tokens > 0).map(([k]) => k))
  if (active.size === 0) return { current: 0, longest: 0 }
  let current = 0
  for (let k = dayKey(now); active.has(k); k = shiftDay(k, -1)) current++
  const sorted = [...active].sort()
  let longest = 1, run = 1
  for (let i = 1; i < sorted.length; i++) {
    run = shiftDay(sorted[i - 1], 1) === sorted[i] ? run + 1 : 1
    if (run > longest) longest = run
  }
  return { current, longest }
}

export interface Overview {
  totalTokens: number; totalCost: number; sessions: number; activeDays: number
  firstDay: string; longestSessionMs: number
  mostActiveDay: { day: string; tokens: number } | null
  favoriteModel: { model: string; tokens: number } | null
  currentStreak: number; longestStreak: number
}

export function overview(s: StatsStore, now: Date = new Date()): Overview {
  const all = rangeTotals(s, 'all', now)
  let mostActiveDay: Overview['mostActiveDay'] = null
  for (const [day, d] of Object.entries(s.days)) {
    if (!mostActiveDay || d.tokens > mostActiveDay.tokens) mostActiveDay = { day, tokens: d.tokens }
  }
  let favoriteModel: Overview['favoriteModel'] = null
  for (const [model, tokens] of Object.entries(s.models)) {
    if (!favoriteModel || tokens > favoriteModel.tokens) favoriteModel = { model, tokens }
  }
  const st = streaks(s, now)
  return {
    totalTokens: all.tokens, totalCost: all.cost, sessions: s.sessions, activeDays: all.activeDays,
    firstDay: s.firstDay, longestSessionMs: s.longestSessionMs,
    mostActiveDay: mostActiveDay && mostActiveDay.tokens > 0 ? mostActiveDay : null,
    favoriteModel,
    currentStreak: st.current, longestStreak: st.longest,
  }
}

/** Per-model totals, most-used first, with a share of the grand total. */
export function modelBreakdown(s: StatsStore): Array<{ model: string; tokens: number; pct: number }> {
  const entries = Object.entries(s.models).map(([model, tokens]) => ({ model, tokens }))
  const grand = entries.reduce((n, e) => n + e.tokens, 0) || 1
  return entries.sort((a, b) => b.tokens - a.tokens).map((e) => ({ ...e, pct: e.tokens / grand }))
}

export interface Heatmap {
  cells: number[][]        // [7 weekday rows][weeks] → bucket 0..4, or -1 for a future day
  weeks: number
  monthLabels: string[]    // length = weeks; a 3-letter month at each column where the month starts, else ''
  max: number              // peak daily tokens in the visible window (drives buckets)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** GitHub-style contribution grid: `weeks` columns (oldest→newest), 7 weekday
 *  rows (Sun→Sat), each cell bucketed 0..4 by that day's token total. */
export function heatmap(s: StatsStore, weeks = 52, now: Date = new Date()): Heatmap {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sundayOfThisWeek = new Date(today)
  sundayOfThisWeek.setDate(today.getDate() - today.getDay()) // back to Sunday
  const cells: number[][] = Array.from({ length: 7 }, () => new Array<number>(weeks).fill(-1))
  const monthLabels = new Array<string>(weeks).fill('')
  let max = 1
  const tokAt = (d: Date): number => s.days[dayKey(d)]?.tokens ?? 0
  // First pass: find the peak so buckets scale to the visible window.
  for (let c = 0; c < weeks; c++) {
    for (let r = 0; r < 7; r++) {
      const cell = new Date(sundayOfThisWeek)
      cell.setDate(sundayOfThisWeek.getDate() - (weeks - 1 - c) * 7 + r)
      if (cell > today) continue
      const t = tokAt(cell)
      if (t > max) max = t
    }
  }
  let prevMonth = -1
  for (let c = 0; c < weeks; c++) {
    const colSunday = new Date(sundayOfThisWeek)
    colSunday.setDate(sundayOfThisWeek.getDate() - (weeks - 1 - c) * 7)
    if (colSunday.getMonth() !== prevMonth) { monthLabels[c] = MONTHS[colSunday.getMonth()]; prevMonth = colSunday.getMonth() }
    for (let r = 0; r < 7; r++) {
      const cell = new Date(colSunday)
      cell.setDate(colSunday.getDate() + r)
      if (cell > today) { cells[r][c] = -1; continue }
      const t = tokAt(cell)
      cells[r][c] = t === 0 ? 0 : t < max * 0.25 ? 1 : t < max * 0.5 ? 2 : t < max * 0.75 ? 3 : 4
    }
  }
  return { cells, weeks, monthLabels, max }
}

// Wordcount fun-fact: Les Misérables is ~530k words ≈ ~700k tokens. Purely for
// the "you've written N novels' worth" flourish on the Stats tab.
export const LES_MIS_TOKENS = 700_000
export function funFact(totalTokens: number): string {
  const n = totalTokens / LES_MIS_TOKENS
  if (n < 0.01) return ''
  return `≈ ${n < 1 ? n.toFixed(2) : n.toFixed(1)}× the tokens in Les Misérables`
}
