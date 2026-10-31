import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Notice } from '../components/ui'
import { AuthShell, PW_CHANGED_KEY } from './Login'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { supabase, errorText } from '../lib/supabase'

// Shown after an invite or password-reset link, or a sign-in with a temporary password: the person is signed in but
// still has to choose a password. After saving it they are signed out and sign in again with the new password.
export default function SetPassword() {
  const { t } = useT()
  const navigate = useNavigate()
  const { profile, completePasswordSetup, tempPassword } = useAuth()
  const signOut = () => supabase.auth.signOut({ scope: 'local' })
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (a.length < 8) return setError(t('auth.pwTooShort'))
    if (a !== b) return setError(t('auth.pwMismatch'))
    setBusy(true)
    // password_set tells the app this login has finished its invite; the database clears a temporary password itself.
    const { error: err } = await supabase.auth.updateUser({ password: a, data: { password_set: true } })
    if (err) { setBusy(false); return setError(errorText(err, t)) }
    // Then sign out everywhere, so the person signs in again with the new password (Oct 31, Denny). The sign-in page
    // shows that the password was saved and fills in the username.
    try { sessionStorage.setItem(PW_CHANGED_KEY, profile?.username || '1') } catch { /* private window: no notice */ }
    const { error: outErr } = await supabase.auth.signOut({ scope: 'global' })
    if (outErr) await supabase.auth.signOut({ scope: 'local' })
    setBusy(false)
    completePasswordSetup()
    navigate('/', { replace: true })
  }

  return (
    <AuthShell>
      <h1>{t('auth.setTitle')}</h1>
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
        {tempPassword ? t('logins.setTextTemp') : profile?.username ? t('auth.setTextUser', { username: profile.username }) : t('auth.setText')}
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <Notice kind="err">{error}</Notice>}
        <Input type="password" label={t('auth.newPassword')} value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" autoFocus />
        <Input type="password" label={t('auth.confirmPassword')} value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" />
        <Button type="submit" variant="primary" loading={busy}>{t('auth.savePassword')}</Button>
        <button type="button" className="linkbtn" style={{ alignSelf: 'center' }} onClick={() => signOut()}>{t('auth.signOut')}</button>
      </form>
    </AuthShell>
  )
}
