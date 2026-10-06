import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Notice } from '../components/ui'
import { AuthShell } from './Login'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { supabase, errorText } from '../lib/supabase'

// Shown after an invite or password-reset link: the person is signed in by the
// link but still has to choose a password.
export default function SetPassword() {
  const { t } = useT()
  const navigate = useNavigate()
  const { profile, completePasswordSetup, signOut } = useAuth()
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
    // password_set tells the app this login has finished its invite.
    const { error: err } = await supabase.auth.updateUser({ password: a, data: { password_set: true } })
    setBusy(false)
    if (err) return setError(errorText(err, t))
    completePasswordSetup()
    navigate('/', { replace: true })
  }

  return (
    <AuthShell>
      <h1>{t('auth.setTitle')}</h1>
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
        {profile?.username ? t('auth.setTextUser', { username: profile.username }) : t('auth.setText')}
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
