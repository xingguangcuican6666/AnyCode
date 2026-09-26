import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdin } from 'ink'
import { useTheme } from '../theme'
import { login, submit2FA, fetchRelayKey, normalizeBase, resolveNewapiBase } from '../lib/newapi'
import { loginWithOAuth, resolveOAuthClientId } from '../lib/oauth'
import { saveCredentials, loadCredentials, type PanelSession, type OAuthSession } from '../lib/credentials'
import { useT } from '../lib/i18n'

// Interactive /login overlay. Keeps credentials out of the chat transcript: the
// key/password are typed here (masked) and written straight to
// ~/.anycode/credentials.json, never echoed back into the conversation.
//
// Flow: base URL → method (paste sk- key | username+password) → the chosen
// inputs → optional 2FA → save. Owns the keyboard via its own useInput while
// mounted (app.tsx hides the prompt cluster behind `modalOpen`).

interface Props {
  width: number
  onSuccess: (baseUrl: string) => void
  onCancel: () => void
}

// Which single field the keystrokes currently edit. 'method' is a 3-way select;
// 'clientid' collects the OAuth public client id when none is pre-configured.
type Step = 'base' | 'method' | 'oauth' | 'clientid' | 'key' | 'user' | 'pass' | '2fa'

// A masked value shows bullets; a plain one shows the text. Empty → placeholder.
// The active field shows a trailing cursor block so it's clear where input lands.
function fieldView(value: string, masked: boolean, placeholder: string, active: boolean, colors: ReturnType<typeof useTheme>): React.ReactElement {
  if (!value) return <Text color={colors.dim}>{placeholder}{active ? <Text inverse> </Text> : null}</Text>
  return <Text color={colors.text}>{masked ? '•'.repeat(value.length) : value}{active ? <Text inverse> </Text> : null}</Text>
}

export function LoginPanel({ width, onSuccess, onCancel }: Props): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const { stdin } = useStdin()
  const existing = loadCredentials()
  // The instance URL is fixed (NEWAPI_BASE_URL), so pre-fill it and start at the
  // method choice — the user never types a URL. A stored login's baseUrl wins.
  const [step, setStep] = useState<Step>('method')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl || resolveNewapiBase())
  const [key, setKey] = useState('')
  const [username, setUsername] = useState(existing?.session?.username ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [clientId, setClientId] = useState('')
  const [method, setMethod] = useState(0) // 0 = OAuth, 1 = paste key, 2 = username/password
  const [flowToken, setFlowToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  // In-flight OAuth run, so esc can abort the browser wait instead of hanging.
  const abortRef = useRef<AbortController | null>(null)

  // Append/edit the field the current step owns. Returns the setter+value pair.
  const bind = (): [string, (v: string) => void, boolean] => {
    if (step === 'base') return [baseUrl, setBaseUrl, false]
    if (step === 'clientid') return [clientId, setClientId, false]
    if (step === 'key') return [key, setKey, true]
    if (step === 'user') return [username, setUsername, false]
    if (step === 'pass') return [password, setPassword, true]
    return [code, setCode, false]
  }

  // Persist a login and close. `key` is the sk- relay key for pasted/password
  // logins; an OAuth login has no key and carries only its token session instead.
  const finish = (base: string, extra: { key?: string; session?: PanelSession; oauth?: OAuthSession }): void => {
    saveCredentials({ baseUrl: normalizeBase(base), key: extra.key, session: extra.session, oauth: extra.oauth, savedAt: Date.now() })
    onSuccess(normalizeBase(base))
  }

  // Browser (OAuth2 + PKCE) login. Opens the authorize page, waits on a loopback
  // callback, then exchanges the code for tokens. The at_ access token it returns
  // is the bearer for /v1/messages (no sk- key is minted). esc aborts via abortRef.
  const startOAuth = async (cid: string): Promise<void> => {
    setStep('oauth'); setBusy(true); setError(''); setStatus(t('login.oauthStarting'))
    const ac = new AbortController(); abortRef.current = ac
    const r = await loginWithOAuth({ baseUrl, clientId: cid, onStatus: setStatus, signal: ac.signal })
    abortRef.current = null
    if (!r.ok || !r.oauth) { setBusy(false); setStatus(''); setError(r.error || t('login.oauthFailed')); return }
    finish(baseUrl, { oauth: r.oauth })
  }

  // After a panel login yields an access token, fetch a relay key and save.
  const afterSession = async (session: PanelSession): Promise<void> => {
    setStatus(t('login.fetchingRelayKey'))
    const relay = await fetchRelayKey(baseUrl, session.accessToken)
    if (!relay) {
      setBusy(false); setStatus('')
      setError(t('login.noRelayToken'))
      return
    }
    finish(baseUrl, { key: relay, session })
  }

  const doPasswordLogin = async (): Promise<void> => {
    setBusy(true); setError(''); setStatus(t('login.loggingIn'))
    const r = await login(baseUrl, username, password)
    if (!r.ok) { setBusy(false); setStatus(''); setError(r.error || t('login.loginFailed')); return }
    if (r.needs2FA) { setBusy(false); setStatus(''); setFlowToken(r.flowToken || ''); setStep('2fa'); return }
    if (r.session) { await afterSession(r.session); return }
    setBusy(false); setStatus(''); setError(t('login.loginResponseError'))
  }

  const do2FA = async (): Promise<void> => {
    setBusy(true); setError(''); setStatus(t('login.verifying2FA'))
    const r = await submit2FA(baseUrl, code, flowToken, username)
    if (!r.ok || !r.session) { setBusy(false); setStatus(''); setError(r.error || t('login.verify2FAFailed')); return }
    await afterSession(r.session)
  }

  // Commit a login-method choice (shared by Enter and mouse click on a row).
  const chooseMethod = (m: number): void => {
    if (m === 0) { const cid = resolveOAuthClientId(); if (cid) void startOAuth(cid); else setStep('clientid'); return }
    setStep(m === 1 ? 'key' : 'user')
  }

  useInput((input, uKey) => {
    if (uKey.escape) {
      // Cancel an in-flight OAuth wait first; a second esc closes the overlay.
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; return }
      onCancel(); return
    }
    if (busy) return
    // Drop mouse reports Ink may surface here as text (see the stdin listener),
    // so "[<0;10;8M" junk can't get appended into a field value below.
    if (/\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /\x1b?\[M/.test(input)) return

    if (step === 'method') {
      if (uKey.upArrow) { setMethod((m) => (m + 2) % 3); return }
      if (uKey.downArrow) { setMethod((m) => (m + 1) % 3); return }
      if (uKey.return) { chooseMethod(method); return }
      return
    }

    const [value, setValue] = bind()
    if (uKey.return) {
      if (step === 'base') { if (baseUrl.trim()) setStep('method'); else setError(t('login.errBaseRequired')); return }
      if (step === 'clientid') { if (clientId.trim()) void startOAuth(clientId.trim()); else setError(t('login.errClientIdRequired')); return }
      if (step === 'key') { if (key.trim()) finish(baseUrl, { key: key.trim() }); else setError(t('login.errKeyRequired')); return }
      if (step === 'user') { if (username.trim()) setStep('pass'); else setError(t('login.errUsernameRequired')); return }
      if (step === 'pass') { void doPasswordLogin(); return }
      if (step === '2fa') { void do2FA(); return }
      return
    }
    if (uKey.backspace || uKey.delete) { setValue(value.slice(0, -1)); if (error) setError(''); return }
    if (uKey.ctrl || uKey.meta || uKey.tab) return
    if (!input) return
    if (/[\r\n]/.test(input)) return
    setValue(value + input); if (error) setError('')
  })

  // Screen-row geometry for mouse hit-testing on the method list. Top-anchored
  // (the modal wrapper is a default row-direction flex box, so justifyContent
  // doesn't move it vertically): title(1)/subtitle(2)/blank(3)/base field(4)/
  // "登录方式" label(5), then the three method rows at 6/7/8. Only meaningful
  // during the 'method' step; other steps have no clickable rows.
  const METHOD_FIRST_ROW = 6
  const stateRef = useRef({ step, busy })
  stateRef.current = { step, busy }
  const actRef = useRef({ chooseMethod })
  actRef.current = { chooseMethod }

  // Mouse: hover moves the highlight, click selects the method, wheel cycles it.
  // Enable any-motion reporting (?1003h) on mount; on unmount re-assert the app's
  // base modes (?1000h?1002h?1006h) — a bare ?1003l can clear tracking entirely on
  // single-mode terminals, leaving the wheel to emit ↑/↓ (history navigation).
  // Ignored unless we're on the method step.
  useEffect(() => {
    const out = process.stdout
    try { out.write('\x1b[?1003h') } catch { /* best-effort */ }
    const onData = (buf: Buffer): void => {
      const s = buf.toString('utf8')
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) {
        const { step: st, busy: bz } = stateRef.current
        if (bz || st !== 'method') continue
        const b = Number(m[1]); const y = Number(m[3]); const release = m[4] === 'm'
        if (b === 64 || b === 65) {
          setMethod((mm) => (mm + (b === 65 ? 1 : 2)) % 3)
          continue
        }
        const real = y - METHOD_FIRST_ROW
        if (real < 0 || real > 2) continue
        if (release) actRef.current.chooseMethod(real)
        else setMethod((mm) => (mm === real ? mm : real))
      }
    }
    stdin?.on('data', onData)
    return () => { stdin?.off('data', onData); try { out.write('\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h') } catch { /* best-effort */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin])

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text bold color={colors.accent}>{t('login.title')}</Text>
      <Text color={colors.dim}>{t('login.subtitle')}</Text>
      <Text> </Text>

      <Field label={t('login.fieldBase')} active={step === 'base'} colors={colors}>
        {fieldView(baseUrl, false, 'https://your-newapi.example.com', step === 'base', colors)}
      </Field>

      {step !== 'base' ? (
        <Box flexDirection="column">
          <Text color={colors.dim}>{t('login.methodLabel')}</Text>
          <Text color={step === 'method' && method === 0 ? colors.accentBright : colors.text}>
            {step === 'method' && method === 0 ? '❯ ' : '  '}{t('login.methodOAuth')}
          </Text>
          <Text color={step === 'method' && method === 1 ? colors.accentBright : colors.text}>
            {step === 'method' && method === 1 ? '❯ ' : '  '}{t('login.methodKey')}
          </Text>
          <Text color={step === 'method' && method === 2 ? colors.accentBright : colors.text}>
            {step === 'method' && method === 2 ? '❯ ' : '  '}{t('login.methodPassword')}
          </Text>
        </Box>
      ) : null}

      {step === 'clientid' ? (
        <Field label={t('login.fieldClientId')} active colors={colors}>
          {fieldView(clientId, false, t('login.clientIdPlaceholder'), true, colors)}
        </Field>
      ) : null}

      {step === 'key' ? (
        <Field label={t('login.fieldKey')} active colors={colors}>
          {fieldView(key, true, 'sk-…', true, colors)}
        </Field>
      ) : null}

      {(step === 'user' || step === 'pass' || step === '2fa') ? (
        <Field label={t('login.fieldUsername')} active={step === 'user'} colors={colors}>
          {fieldView(username, false, t('login.usernamePlaceholder'), step === 'user', colors)}
        </Field>
      ) : null}

      {(step === 'pass' || step === '2fa') ? (
        <Field label={t('login.fieldPassword')} active={step === 'pass'} colors={colors}>
          {fieldView(password, true, '••••••••', step === 'pass', colors)}
        </Field>
      ) : null}

      {step === '2fa' ? (
        <Field label={t('login.field2FA')} active colors={colors}>
          {fieldView(code, false, t('login.twofaPlaceholder'), true, colors)}
        </Field>
      ) : null}

      <Text> </Text>
      {busy ? <Text color={colors.warning}>{status || t('login.processing')}</Text> : null}
      {error ? <Text color={colors.error}>✗ {error}</Text> : null}
      {step === 'oauth' ? <Text color={colors.dim}>{t('login.oauthManualHint')}</Text> : null}
      <Text color={colors.dim}>
        {step === 'method' ? t('login.footerMethod')
          : step === 'oauth' ? t('login.footerOAuth')
          : t('login.footerDefault')}
      </Text>
    </Box>
  )
}

// One labeled row; the active field is accented so it's clear where input lands.
function Field({ label, active, colors, children }: { label: string; active: boolean; colors: ReturnType<typeof useTheme>; children: React.ReactNode }): React.ReactElement {
  return (
    <Box>
      <Text color={active ? colors.accent : colors.dim}>{active ? '❯ ' : '  '}{label}: </Text>
      {children}
    </Box>
  )
}
