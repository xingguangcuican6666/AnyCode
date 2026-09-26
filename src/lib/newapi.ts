// Dependency-free HTTP client for new-api panel auth (see docs: authentication.md
// and openapi/api.json). Used by /login and /logout. Every call is best-effort
// and returns a typed result rather than throwing, so the login overlay can show
// a clean message. Model calls do NOT go through here — they use the relay key
// against /v1/messages via the `newapi` provider (see providers/index.ts).
import type { PanelSession } from './credentials'

// The user's fixed new-api instance. Used as the default base for /login and as
// the `newapi` provider's endpoint when no per-login baseUrl is stored, so the
// user never has to type it. A stored credential's baseUrl still wins.
export const NEWAPI_BASE_URL = 'https://api.xingguangcuican.icu'

// Standard env override: NEWAPI_BASE_URL wins over the built-in default, so the
// instance can be pointed elsewhere without editing settings. A stored
// credential's baseUrl still wins over both (resolved by the caller).
export function resolveNewapiBase(): string {
  return normalizeBase(process.env.NEWAPI_BASE_URL || NEWAPI_BASE_URL)
}

// Trim trailing slashes so `${base}/api/...` never double-slashes.
export function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

// new-api wraps every panel response as { success, message, data }.
interface Envelope<T> { success?: boolean; message?: string; data?: T }

export interface LoginResult {
  ok: boolean
  // A completed login: a panel session (for logout) plus the raw session cookies.
  session?: PanelSession
  // A 2FA challenge: the flow token to pass to submit2FA.
  needs2FA?: boolean
  flowToken?: string
  error?: string
}

// Rebuild a Cookie header from a response's Set-Cookie list, so the refresh
// cookie (HttpOnly, holds the refresh token) can be replayed on logout.
function cookieFromResponse(res: Response): string | undefined {
  // getSetCookie is available on undici/Node 18.14+ and Bun; fall back to the
  // single combined header otherwise.
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] }
  const list = anyHeaders.getSetCookie?.() ?? []
  const raw = list.length ? list : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : [])
  const pairs = raw.map((c) => c.split(';')[0].trim()).filter(Boolean)
  return pairs.length ? pairs.join('; ') : undefined
}

// Pull the useful bits out of an AuthBundle (docs: 浏览器接口). Tolerant of the
// exact envelope so it works across new-api versions.
function sessionFromBundle(data: Record<string, unknown>, cookie: string | undefined, username: string): PanelSession {
  const sess = (data.session ?? {}) as Record<string, unknown>
  return {
    accessToken: String(data.access_token ?? ''),
    sid: sess.sid != null ? String(sess.sid) : undefined,
    cookie,
    username: username || undefined,
    expiresAt: typeof data.access_expires_at === 'number' ? data.access_expires_at : undefined,
  }
}

// POST /api/user/login {username,password}. On success returns a session; if the
// account has 2FA it returns needs2FA + a flowToken to pass to submit2FA.
export async function login(baseUrl: string, username: string, password: string, signal?: AbortSignal): Promise<LoginResult> {
  const base = normalizeBase(baseUrl)
  let res: Response
  try {
    res = await fetch(`${base}/api/user/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal,
    })
  } catch (e) {
    return { ok: false, error: `无法连接 ${base} — ${(e as Error).message}` }
  }
  let body: Envelope<Record<string, unknown>>
  try { body = (await res.json()) as Envelope<Record<string, unknown>> } catch { body = {} }
  if (!res.ok || body.success === false) {
    return { ok: false, error: body.message || `HTTP ${res.status}` }
  }
  const data = body.data ?? {}
  const cookie = cookieFromResponse(res)
  // A 2FA challenge: no access token yet, but a one-time flow token to continue.
  const flowToken = (data.flow_token ?? data.two_fa_token) as string | undefined
  if (!data.access_token && flowToken) {
    return { ok: true, needs2FA: true, flowToken }
  }
  if (!data.access_token) return { ok: false, error: body.message || '登录响应缺少 access_token' }
  return { ok: true, session: sessionFromBundle(data, cookie, username) }
}

// POST /api/user/login/2fa {code, flow_token} to complete a 2FA login.
export async function submit2FA(baseUrl: string, code: string, flowToken: string, username: string, signal?: AbortSignal): Promise<LoginResult> {
  const base = normalizeBase(baseUrl)
  let res: Response
  try {
    res = await fetch(`${base}/api/user/login/2fa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, flow_token: flowToken }),
      signal,
    })
  } catch (e) {
    return { ok: false, error: `无法连接 ${base} — ${(e as Error).message}` }
  }
  let body: Envelope<Record<string, unknown>>
  try { body = (await res.json()) as Envelope<Record<string, unknown>> } catch { body = {} }
  if (!res.ok || body.success === false) return { ok: false, error: body.message || `HTTP ${res.status}` }
  const data = body.data ?? {}
  if (!data.access_token) return { ok: false, error: body.message || '2FA 响应缺少 access_token' }
  return { ok: true, session: sessionFromBundle(data, cookieFromResponse(res), username) }
}

// GET /api/token/ with the panel access token → the first usable relay key.
// new-api relay keys are used as `sk-<key>`; the API returns the bare key, so we
// add the prefix unless it is already present. Returns null when the account has
// no enabled token (the caller then asks the user to paste or create one).
export async function fetchRelayKey(baseUrl: string, accessToken: string, signal?: AbortSignal): Promise<string | null> {
  const base = normalizeBase(baseUrl)
  let res: Response
  try {
    res = await fetch(`${base}/api/token/?p=0&size=100`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    })
  } catch { return null }
  if (!res.ok) return null
  let body: Envelope<unknown>
  try { body = (await res.json()) as Envelope<unknown> } catch { return null }
  // data may be an array, or a paged { items } / { records } object.
  const d = body.data as unknown
  const list: Array<Record<string, unknown>> = Array.isArray(d)
    ? (d as Array<Record<string, unknown>>)
    : (((d as Record<string, unknown>)?.items ?? (d as Record<string, unknown>)?.records ?? []) as Array<Record<string, unknown>>)
  // Prefer an enabled token (status === 1); fall back to the first with a key.
  const enabled = list.find((t) => t.status === 1 && t.key) ?? list.find((t) => t.key)
  if (!enabled?.key) return null
  const key = String(enabled.key)
  return key.startsWith('sk-') ? key : `sk-${key}`
}

// POST /api/user/auth/logout — revoke the current panel login session. Replays
// the refresh cookie and X-Auth-Session (docs: 客户端内存中已有会话时…). Best-effort:
// resolves ok:false with a reason but never throws (the caller clears the local
// credential regardless, so a dead server never traps the user logged in).
export async function logout(baseUrl: string, session: PanelSession, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const base = normalizeBase(baseUrl)
  const headers: Record<string, string> = {}
  if (session.cookie) headers.cookie = session.cookie
  if (session.sid) headers['x-auth-session'] = session.sid
  if (session.accessToken) headers.authorization = `Bearer ${session.accessToken}`
  try {
    const res = await fetch(`${base}/api/user/auth/logout`, { method: 'POST', headers, signal })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
