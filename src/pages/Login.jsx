import React, { useState } from 'react'
import { Button, Input, Notice } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { errorText } from '../lib/supabase'
import { useBranding } from '../lib/branding'
import { initials } from '../lib/format'

export function AuthShell({ children }) {
  const { lang, setLang } = useT()
  const { name, logoUrl } = useBranding() // the shop's name and logo (Settings → Shop profile)
  return (
    <div className="authwrap">
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
          <div className="langtoggle">
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
            <button className={lang === 'id' ? 'on' : ''} onClick={() => setLang('id')}>ID</button>
          </div>
        </div>
        <div className="authcard">
          <div className="authbrand">
            {(logoUrl || name) && <span className={`brand-mark${logoUrl ? ' has-logo' : ''}`}>{logoUrl ? <img src={logoUrl} alt="" /> : initials(name)}</span>}
            <span style={{ fontWeight: 800, fontSize: 17 }}>{name}</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

// Set by SetPassword before it signs out, read once here.
export const PW_CHANGED_KEY = 'axle.passwordChanged'

export default function Login() {
  const { t } = useT()
  const { signIn, sendPasswordReset, linkError, clearLinkError } = useAuth()
  const [mode, setMode] = useState('login') // login | forgot | sent
  // Just chose a new password (SetPassword signs out): say so once, and fill in the username.
  const [changed] = useState(() => {
    try { const v = sessionStorage.getItem(PW_CHANGED_KEY); sessionStorage.removeItem(PW_CHANGED_KEY); return v } catch { return null }
  })
  const [identifier, setIdentifier] = useState(changed && changed !== '1' ? changed : '')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    clearLinkError()
    if (!identifier.trim() || !password) return setError(t('auth.fillBoth'))
    setBusy(true)
    const { error: err } = await signIn(identifier, password)
    setBusy(false)
    if (err) {
      if (err.code === 'bad_login') setError(t('auth.badLogin'))
      else if (err.code === 'too_many') setError(t('auth.tooMany'))
      else if (err.code === 'server') setError(t('auth.serverDown'))
      else setError(errorText(err, t))
    }
  }

  async function sendReset(e) {
    e.preventDefault()
    setError(null)
    if (!email.includes('@')) return setError(t('auth.enterEmail'))
    setBusy(true)
    const { error: err } = await sendPasswordReset(email)
    setBusy(false)
    if (err) setError(errorText(err, t))
    else setMode('sent')
  }

  if (mode === 'sent') {
    return (
      <AuthShell>
        <h1>{t('auth.checkEmail')}</h1>
        <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>{t('auth.resetSent', { email })}</p>
        <Button onClick={() => setMode('login')}>{t('auth.backToLogin')}</Button>
      </AuthShell>
    )
  }

  if (mode === 'forgot') {
    return (
      <AuthShell>
        <h1>{t('auth.forgotTitle')}</h1>
        <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>{t('auth.forgotText')}</p>
        <p className="muted small" style={{ margin: 0, lineHeight: 1.55 }}>{t('logins.forgotNoEmail')}</p>
        <form onSubmit={sendReset} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error && <Notice kind="err">{error}</Notice>}
          <Input type="email" label={t('auth.email')} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
          <Button type="submit" variant="primary" loading={busy}>{t('auth.sendLink')}</Button>
          <button type="button" className="linkbtn" onClick={() => { setMode('login'); setError(null) }}>{t('auth.backToLogin')}</button>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1>{t('auth.signInTitle')}</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {changed && !error && <Notice kind="ok">{t('logins.changedSignIn')}</Notice>}
        {linkError && <Notice kind="err">{t('auth.linkInvalid')}</Notice>}
        {error && <Notice kind="err">{error}</Notice>}
        <Input label={t('auth.username')} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus={!changed} />
        <Input type="password" label={t('auth.password')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!changed} />
        <Button type="submit" variant="primary" loading={busy}>{t('auth.signIn')}</Button>
        <button type="button" className="linkbtn" style={{ alignSelf: 'center' }} onClick={() => { setMode('forgot'); setError(null) }}>{t('auth.forgot')}</button>
      </form>
      <div className="hint" style={{ textAlign: 'center' }}>{t('auth.inviteOnly')}</div>
    </AuthShell>
  )
}
