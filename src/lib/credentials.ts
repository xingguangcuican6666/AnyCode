// Persistent login credentials for the `newapi` provider (see /login, /logout).
//
// This is DELIBERATELY separate from settings.json (see src/config.ts, which
// strips `apiKey` before every write). settings.json must never hold a key; a
// login credential is different — it is written only by an explicit /login, to
// its own file, with 0600 permissions. That keeps the "never silently persist
// the env-sourced key" rule intact while still letting /login survive a restart
// (and /logout revoke it). The relay key here authorizes model calls through
// new-api's Anthropic-compatible `/v1/messages` endpoint.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const CREDENTIALS_FILE = path.join(os.homedir(), '.anycode', 'credentials.json')

// The panel login session — present only for password logins, so /logout can
// revoke it server-side (POST /api/user/auth/logout). Absent for a pasted key.
export interface PanelSession {
  accessToken: string   // panel JWT/PAT (Authorization: Bearer for /api/*)
  sid?: string          // login session id (sent as X-Auth-Session on logout)
  cookie?: string       // raw Cookie header to replay (holds the refresh token)
  username?: string
  expiresAt?: number    // access_expires_at (epoch seconds), informational
}

// The OAuth session — present only for browser (OAuth2/PKCE) logins. Unlike a
// panel/pasted login, an OAuth login has NO separate sk- relay key: the at_ access
// token below is itself the bearer for /v1/messages (scope models.invoke). It
// expires (~1h) and is rotated via the rt_ refresh token, so refreshToken is now
// load-bearing (see lib/oauth resolveRelayToken/refreshRelayToken), not just kept
// for /logout's POST /oauth2/revoke.
export interface OAuthSession {
  issuer: string        // authorization server base (new-api host)
  clientId: string      // the registered public client id (cli_…)
  accessToken: string   // at_… — the Bearer for /v1/messages and /oauth2/userinfo
  refreshToken?: string // rt_… (rotates on every refresh; replay revokes the family)
  idToken?: string      // RS256 JWT (only when openid scope granted)
  scope?: string        // granted scopes, space-separated
  expiresAt?: number    // access token expiry (epoch ms); drives proactive refresh
}

export interface Credentials {
  baseUrl: string       // new-api host base, e.g. https://newapi.example.com
  // Relay key (sk-…) for /v1/messages, from a pasted key or a password login.
  // ABSENT for an OAuth login — that uses oauth.accessToken (at_…) as the bearer.
  key?: string
  session?: PanelSession
  oauth?: OAuthSession
  savedAt: number       // epoch ms
}

export function loadCredentials(): Credentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')) as Partial<Credentials>
    // Valid when there's a base plus SOME usable credential: a relay key (pasted /
    // password login) or an OAuth access token (browser login).
    const hasKey = typeof raw?.key === 'string' && raw.key.length > 0
    const hasOAuth = typeof raw?.oauth?.accessToken === 'string' && raw.oauth.accessToken.length > 0
    if (raw && typeof raw.baseUrl === 'string' && raw.baseUrl && (hasKey || hasOAuth)) {
      return raw as Credentials
    }
  } catch {
    // no credentials yet, or unreadable — treat as logged out
  }
  return null
}

export function saveCredentials(c: Credentials): void {
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true })
  // 0600: owner read/write only — a key on disk should never be world-readable.
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(c, null, 2), { mode: 0o600 })
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600) } catch { /* best-effort on platforms without chmod */ }
}

export function clearCredentials(): void {
  try { fs.rmSync(CREDENTIALS_FILE, { force: true }) } catch { /* already gone */ }
}
