// OAuth2 Authorization Code + PKCE client for new-api's built-in OAuth server.
// Used by /login's "浏览器登录 (OAuth)" method.
//
// Flow (public client, token_endpoint_auth_method=none — no client_secret):
//   1. spin up a loopback callback server on 127.0.0.1:<port>
//   2. open the browser to {issuer}/oauth2/authorize with a PKCE S256 challenge
//   3. user logs in + consents in new-api; browser redirects back with ?code&state
//   4. POST {issuer}/oauth2/token (code + code_verifier + client_id) → tokens
// The at_ access token returned in step 4 IS the bearer that authorizes model
// calls via /v1/messages (it needs the `models.invoke` scope); it expires (~1h)
// and is refreshed with the rt_ refresh token (grant_type=refresh_token, which
// rotates the token family). /logout revokes the grant (POST /oauth2/revoke).
// There is NO sk- relay key anymore — the server removed POST /oauth2/keys and
// the api_keys scope; see resolveRelayToken/refreshRelayToken for the token
// lifecycle the `newapi` provider relies on.
//
// Every call is best-effort and returns a typed result rather than throwing, so
// the login overlay can render a clean message. Treat any server response as data.
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { normalizeBase } from './newapi'
import { loadCredentials, saveCredentials, type OAuthSession } from './credentials'
import { loadConfig } from '../config'

// Loopback redirect. new-api requires the redirect_uri to match the registered
// value EXACTLY, so the port is fixed (overridable) and the user registers this
// exact string. 127.0.0.1 (not "localhost") avoids IPv6/hosts-file ambiguity.
export const DEFAULT_OAUTH_PORT = 8788
export function redirectUriFor(port: number): string {
  return `http://127.0.0.1:${port}/callback`
}

// The registered public client id for AnyCode's OAuth app on the user's new-api
// instance. NOT a secret — a public client (PKCE, no client_secret) is identified
// by client_id alone, so it's safe to ship in source. Overridable via env /
// settings / a remembered login (see resolveOAuthClientId).
export const DEFAULT_OAUTH_CLIENT_ID = 'cli_58b66dae26024151a27e1a0685cb6463'

// Scopes we request. `models.invoke` is the scope the server now requires to call
// /v1/* on the user's behalf — the at_ access token IS the bearer for /v1/messages,
// there is no sk- key minting anymore. `openid` returns an id_token for identity.
// Both are NON-sensitive, so a public (PKCE) client may be granted them without the
// admin-only `trusted` flag (that flag gates only wallet.topup / apikeys.manage).
//
// IMPORTANT: the server does NOT backfill scopes on existing OAuth clients. A client
// still registered with the old `openid api_keys` fails /oauth2/authorize with
// "unknown scope: api_keys" and holds no models.invoke. Before OAuth login can work,
// an admin must edit the client (MeowArch API「应用管理」) to allow exactly these
// scopes — the built-in DEFAULT_OAUTH_CLIENT_ID needs this one-time re-scope too.
export const OAUTH_SCOPE = 'openid models.invoke'

// base64url of raw bytes, no padding (RFC 7636 §A).
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface Pkce { verifier: string; challenge: string }
function pkcePair(): Pkce {
  const verifier = b64url(crypto.randomBytes(48)) // ~64 chars, within 43–128
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// Resolve the registered public client id. Env wins (standard override), then a
// remembered login, then the settings bag, then the built-in default — so OAuth
// login works out of the box with no configuration.
export function resolveOAuthClientId(): string {
  const env = process.env.NEWAPI_OAUTH_CLIENT_ID?.trim()
  if (env) return env
  const fromCreds = loadCredentials()?.oauth?.clientId
  if (fromCreds) return fromCreds
  const s = loadConfig().settings?.newapiOAuthClientId
  if (typeof s === 'string' && s.trim()) return s.trim()
  return DEFAULT_OAUTH_CLIENT_ID
}

export function resolveOAuthPort(): number {
  const env = Number(process.env.NEWAPI_OAUTH_PORT)
  if (Number.isInteger(env) && env > 0 && env < 65536) return env
  const s = loadConfig().settings?.newapiOAuthPort
  if (typeof s === 'number' && Number.isInteger(s) && s > 0 && s < 65536) return s
  return DEFAULT_OAUTH_PORT
}

// Open the system browser at `url` (best-effort; the overlay also prints the URL
// so the user can open it manually if this silently fails).
function openBrowser(url: string): void {
  const p = process.platform
  const cmd = p === 'darwin' ? 'open' : p === 'win32' ? 'cmd' : 'xdg-open'
  const args = p === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    // 唤起失败（如无 xdg-open）走的是异步 'error' 事件而非同步抛错；不挂监听器它会
    // 冒泡成未处理错误、拖垮进程。静默吞掉即可 —— 登录页已提示可手动打开授权链接。
    child.on('error', () => { /* binary missing / 无法唤起 → 静默，用户手动打开 */ })
    child.unref()
  } catch { /* 同步失败也静默 */ }
}

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>MeowCode</title>' +
  '<body style="font-family:system-ui;background:#0b0b0c;color:#e7e7e7;display:flex;' +
  'align-items:center;justify-content:center;height:100vh;margin:0">' +
  '<div style="text-align:center"><h2>✓ 登录成功</h2>' +
  '<p>已授权 MeowCode，可以关闭本页面回到终端。</p></div></body>'
function errorHtml(reason: string): string {
  return '<!doctype html><meta charset="utf-8"><title>MeowCode</title>' +
    '<body style="font-family:system-ui;background:#0b0b0c;color:#e7e7e7;display:flex;' +
    'align-items:center;justify-content:center;height:100vh;margin:0">' +
    `<div style="text-align:center"><h2>✗ 授权失败</h2><p>${reason}</p>` +
    '<p>请回到终端重试。</p></div></body>'
}

// Start the loopback server and resolve with the authorization code once the
// browser redirects back. Rejects on error/cancel/timeout; always closes itself.
function waitForCallback(port: number, expectedState: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => { if (done) return; done = true; try { server.close() } catch { /* */ } fn() }
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      if (u.pathname !== '/callback') { res.writeHead(404); res.end('Not found'); return }
      const err = u.searchParams.get('error')
      const desc = u.searchParams.get('error_description') || err || ''
      const code = u.searchParams.get('code')
      const state = u.searchParams.get('state')
      const bad = err ? desc : state !== expectedState ? 'state mismatch (可能的 CSRF)' : !code ? '缺少授权码' : ''
      res.writeHead(bad ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(bad ? errorHtml(bad) : SUCCESS_HTML)
      if (bad) finish(() => reject(new Error(bad)))
      else finish(() => resolve(code as string))
    })
    server.on('error', (e) => finish(() => reject(e)))
    server.listen(port, '127.0.0.1')
    const timer = setTimeout(() => finish(() => reject(new Error('等待授权超时（5 分钟）'))), 5 * 60_000)
    timer.unref?.()
    if (signal) {
      if (signal.aborted) return finish(() => reject(new Error('已取消')))
      signal.addEventListener('abort', () => finish(() => reject(new Error('已取消'))), { once: true })
    }
  })
}

interface TokenSet {
  access_token?: string; refresh_token?: string; id_token?: string
  token_type?: string; expires_in?: number; scope?: string
  error?: string; error_description?: string
}

// POST /oauth2/token — exchange the code (+ PKCE verifier) for tokens. Public
// client: the form carries only client_id (no secret); PKCE provides security.
async function exchangeCode(issuer: string, p: { clientId: string; code: string; redirectUri: string; verifier: string }, signal?: AbortSignal): Promise<{ ok: boolean; tokens?: TokenSet; error?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri,
    code_verifier: p.verifier, client_id: p.clientId,
  })
  let res: Response
  try {
    res = await fetch(`${issuer}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal })
  } catch (e) { return { ok: false, error: `无法连接授权服务器 — ${(e as Error).message}` } }
  let json: TokenSet
  try { json = (await res.json()) as TokenSet } catch { json = {} }
  if (!res.ok || !json.access_token) return { ok: false, error: json.error_description || json.error || `令牌交换失败（HTTP ${res.status}）` }
  return { ok: true, tokens: json }
}

// POST /oauth2/token grant_type=refresh_token — rotate the token family. The
// server issues a NEW access token AND a NEW refresh token and invalidates the old
// refresh token; replaying a rotated refresh token revokes the whole family, so the
// caller MUST persist the returned tokens and never reuse the old refresh token.
// Scopes are inherited from the prior grant. Public client → only client_id is sent.
async function refreshTokens(session: OAuthSession, signal?: AbortSignal): Promise<{ ok: boolean; oauth?: OAuthSession; error?: string }> {
  if (!session.refreshToken) return { ok: false, error: 'no refresh token' }
  const issuer = normalizeBase(session.issuer)
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId,
  })
  let res: Response
  try {
    res = await fetch(`${issuer}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal })
  } catch (e) { return { ok: false, error: `无法连接授权服务器 — ${(e as Error).message}` } }
  let json: TokenSet
  try { json = (await res.json()) as TokenSet } catch { json = {} }
  if (!res.ok || !json.access_token) return { ok: false, error: json.error_description || json.error || `刷新令牌失败（HTTP ${res.status}）` }
  const oauth: OAuthSession = {
    issuer, clientId: session.clientId,
    accessToken: json.access_token,
    // Keep the rotated refresh token; fall back to the old one only if the server
    // omitted one (this server always rotates, so that's a defensive fallback).
    refreshToken: json.refresh_token ?? session.refreshToken,
    idToken: json.id_token ?? session.idToken,
    scope: json.scope ?? session.scope,
    expiresAt: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : undefined,
  }
  return { ok: true, oauth }
}

export interface OAuthLoginResult {
  ok: boolean
  oauth?: OAuthSession
  error?: string
}

// Drive the whole browser login: PKCE + loopback callback + token exchange. The
// at_ access token in the returned session is what authorizes /v1/messages.
// `onStatus` surfaces progress to the overlay.
export async function loginWithOAuth(params: {
  baseUrl: string
  clientId: string
  port?: number
  onStatus?: (msg: string) => void
  signal?: AbortSignal
}): Promise<OAuthLoginResult> {
  const issuer = normalizeBase(params.baseUrl)
  const port = params.port ?? resolveOAuthPort()
  const redirectUri = redirectUriFor(port)
  const { verifier, challenge } = pkcePair()
  const state = b64url(crypto.randomBytes(16))
  const nonce = b64url(crypto.randomBytes(16))

  const authorizeUrl = `${issuer}/oauth2/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: params.clientId, redirect_uri: redirectUri,
    scope: OAUTH_SCOPE, state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString()

  let code: string
  try {
    const wait = waitForCallback(port, state, params.signal)
    params.onStatus?.(`已在浏览器打开授权页；若未自动打开，请手动访问：\n${authorizeUrl}`)
    openBrowser(authorizeUrl)
    code = await wait
  } catch (e) {
    const msg = (e as Error).message
    if (/EADDRINUSE/.test(msg)) return { ok: false, error: `本地回调端口 ${port} 被占用。设置 NEWAPI_OAUTH_PORT 换一个端口，并在 MeowArch API 应用里同步更新回调地址。` }
    return { ok: false, error: msg }
  }

  params.onStatus?.('正在交换令牌…')
  const tok = await exchangeCode(issuer, { clientId: params.clientId, code, redirectUri, verifier }, params.signal)
  if (!tok.ok || !tok.tokens?.access_token) return { ok: false, error: tok.error || '令牌交换失败' }

  const t = tok.tokens
  const oauth: OAuthSession = {
    issuer, clientId: params.clientId,
    accessToken: t.access_token as string,
    refreshToken: t.refresh_token,
    idToken: t.id_token,
    scope: t.scope,
    expiresAt: typeof t.expires_in === 'number' ? Date.now() + t.expires_in * 1000 : undefined,
  }
  return { ok: true, oauth }
}

const EXPIRY_SKEW_MS = 60_000 // refresh a minute early to cover clock skew / in-flight latency

// Serializes refreshes: rotation means two concurrent refreshes presenting the
// same rt_ would trip the server's replay detection and revoke the whole token
// family. Sub-agents can fire requests in parallel, so a single-flight guard is
// required — everyone shares the one in-flight refresh.
let refreshInFlight: Promise<string | undefined> | null = null

// Resolve the Bearer token for /v1/* from the stored login. For an OAuth login this
// is the at_ access token, transparently refreshed (and re-persisted) when it is
// expired or about to be; for a pasted or password login it is the stored sk- key.
// Returns undefined when logged out (or when a refresh failed with no usable token).
export async function resolveRelayToken(): Promise<string | undefined> {
  const cur = loadCredentials()
  if (!cur) return undefined
  const oauth = cur.oauth
  if (oauth?.accessToken) {
    const stillFresh = oauth.expiresAt == null || oauth.expiresAt - EXPIRY_SKEW_MS > Date.now()
    if (stillFresh) return oauth.accessToken
    return (await refreshRelayToken()) ?? oauth.accessToken
  }
  return cur.key
}

// Force a rotation of the OAuth token family and persist the result. Called
// proactively (near expiry, from resolveRelayToken) and reactively (on a 401 from
// /v1/*, from the provider). Single-flight. Returns the new access token, or
// undefined when there is nothing to refresh or the refresh failed.
export async function refreshRelayToken(): Promise<string | undefined> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const cur = loadCredentials()
      if (!cur?.oauth?.refreshToken) return undefined
      const r = await refreshTokens(cur.oauth)
      if (!r.ok || !r.oauth) return undefined
      // Re-read so a concurrent /login or /logout isn't clobbered; only persist the
      // rotated tokens if a credential still exists to attach them to.
      const latest = loadCredentials()
      if (!latest) return undefined
      saveCredentials({ ...latest, oauth: r.oauth, savedAt: Date.now() })
      return r.oauth.accessToken
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

// POST /oauth2/revoke — best-effort revoke of the OAuth token family on /logout.
// Public client sends only client_id. Revoking either token kills the whole token
// family, and since the at_ access token IS the /v1/messages credential now (no
// separate sk- key), this genuinely ends the device's access. /logout still also
// clears the local credential regardless of the revoke result.
export async function revokeOAuth(session: OAuthSession, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const token = session.refreshToken || session.accessToken
  if (!token) return { ok: true }
  try {
    const body = new URLSearchParams({ token, client_id: session.clientId })
    const res = await fetch(`${normalizeBase(session.issuer)}/oauth2/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal })
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}
