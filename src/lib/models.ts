// Model catalog fetcher for the interactive /model picker. Pulls the list of
// models the current relay token can actually call from new-api's OpenAI-compatible
// GET /v1/models (TokenAuth → an sk- relay key, or an OAuth at_ token with the
// models.invoke scope, authorizes it), and — best-effort
// — derives selectable groups from GET /api/pricing so the picker can show group
// tabs when more than one group is available.
//
// Every call is best-effort and returns data (never throws), so the picker can
// render a clean message. Treat any server response as untrusted data.
import { normalizeBase } from './newapi'

export interface ModelGroup {
  id: string
  // The group NAME shown on the tab (new-api's usable_group KEY, e.g. "default",
  // "common", "bot") — NOT the 说明信息/description, which is `description`.
  label: string
  // The group's 说明信息 (usable_group VALUE, e.g. "默认分组") shown at the bottom
  // when this tab is active. Absent when the group has no description set.
  description?: string
}

export interface ModelCatalog {
  // Authoritative list of callable model ids (from /v1/models), deduped + sorted.
  models: string[]
  // Selectable groups (≥2 → the picker shows tabs). Absent/short → single list.
  groups?: ModelGroup[]
  // group id → the models in that group (intersected with `models`, so every
  // entry is actually callable by this key).
  byGroup?: Record<string, string[]>
  error?: string
}

// Bearer header for the relay token. Both new-api relay keys (`sk-…`) and OAuth
// access tokens (`at_…`) are sent verbatim; only a bare relay key that's missing
// its `sk-` prefix gets one added. /v1/models and /api/pricing accept the header.
function authHeader(token?: string): Record<string, string> {
  if (!token) return {}
  const bearer = token.startsWith('sk-') || token.startsWith('at_') ? token : `sk-${token}`
  return { authorization: `Bearer ${bearer}` }
}

// GET /v1/models → the flat union of models usable by the token's groups. OpenAI
// envelope: { data: [{ id }], object: "list" }. Returns [] on any failure.
async function fetchModelIds(base: string, key: string | undefined, signal?: AbortSignal): Promise<{ ids: string[]; error?: string }> {
  let res: Response
  try {
    res = await fetch(`${base}/v1/models`, { headers: authHeader(key), signal })
  } catch (e) { return { ids: [], error: `无法连接 ${base} — ${(e as Error).message}` } }
  if (!res.ok) return { ids: [], error: res.status === 401 ? 'relay 令牌无效或未登录（HTTP 401）' : `拉取模型列表失败（HTTP ${res.status}）` }
  let json: { data?: Array<{ id?: unknown }> }
  try { json = (await res.json()) as typeof json } catch { return { ids: [], error: '模型列表响应解析失败' } }
  const ids = (json.data ?? []).map((m) => String(m?.id ?? '')).filter(Boolean)
  return { ids }
}

// Shape of GET /api/pricing we care about (tolerant across new-api versions):
//   { data: [{ model_name, enable_groups: [] }],
//     usable_group: { <group name>: <说明信息/description> } }
// The usable_group KEY is the group name (what we show on the tab); the VALUE is
// its 说明信息 description (shown at the bottom when the tab is active).
interface PricingResp {
  data?: Array<{ model_name?: unknown; enable_groups?: unknown }>
  usable_group?: Record<string, unknown>
}

// Best-effort GET /api/pricing → (groups, byGroup). Needs the "pricing" nav module
// to allow this key; on any failure we return null and the picker falls back to a
// single untabbed list. byGroup is intersected with `models` so tabs only ever
// list callable models.
async function fetchGroups(base: string, key: string | undefined, models: string[], signal?: AbortSignal): Promise<{ groups: ModelGroup[]; byGroup: Record<string, string[]> } | null> {
  let res: Response
  try {
    res = await fetch(`${base}/api/pricing`, { headers: authHeader(key), signal })
  } catch { return null }
  if (!res.ok) return null
  let body: { data?: PricingResp } | PricingResp
  try { body = (await res.json()) as typeof body } catch { return null }
  // /api/pricing wraps as { success, data } on some builds, flat on others.
  const p: PricingResp = (body as { data?: PricingResp }).data && !Array.isArray((body as { data?: PricingResp }).data)
    ? (body as { data: PricingResp }).data
    : (body as PricingResp)
  const usable = p.usable_group ?? {}
  const groupIds = Object.keys(usable)
  if (groupIds.length < 2) return null

  const modelSet = new Set(models)
  const byGroup: Record<string, string[]> = {}
  for (const id of groupIds) byGroup[id] = []
  for (const row of p.data ?? []) {
    const name = String(row?.model_name ?? '')
    if (!name || !modelSet.has(name)) continue
    const eg = Array.isArray(row?.enable_groups) ? (row.enable_groups as unknown[]).map(String) : []
    for (const g of eg) if (g in byGroup) byGroup[g].push(name)
  }
  // Drop groups that ended up with no callable models — they'd be empty tabs.
  // Tab label = the group NAME (the usable_group key); description = its 说明信息
  // (the value), shown at the bottom when the tab is active.
  const groups: ModelGroup[] = groupIds
    .filter((id) => byGroup[id].length > 0)
    .map((id) => {
      const desc = String(usable[id] ?? '').trim()
      return { id, label: id, description: desc && desc !== id ? desc : undefined }
    })
  if (groups.length < 2) return null
  return { groups, byGroup }
}

// Fetch the full catalog for the /model picker: the callable model list plus, when
// available, group tabs. `key` is the sk- relay key; `baseUrl` the instance base.
export async function fetchModelCatalog(baseUrl: string, key: string | undefined, signal?: AbortSignal): Promise<ModelCatalog> {
  const base = normalizeBase(baseUrl)
  const { ids, error } = await fetchModelIds(base, key, signal)
  const models = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
  if (error) return { models, error }
  const grouped = await fetchGroups(base, key, models, signal)
  if (!grouped) return { models }
  return { models, groups: grouped.groups, byGroup: grouped.byGroup }
}
