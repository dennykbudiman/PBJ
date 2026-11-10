import React, { useEffect, useState } from 'react'
import { Button } from '../components/ui'
import Icon from '../components/Icon'
import { AuthShell } from './Login'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'

// The server couldn't be reached while checking whether this person may use the app (143, Denny Nov 10: Akhmad saw
// "Belum ada akses" when only part of his PC's requests got through). Tries again by itself every few seconds.
export default function ConnectionProblem() {
  const { t } = useT()
  const { profile, user, signOut, refreshProfile } = useAuth()
  const [busy, setBusy] = useState(false)

  async function retry() {
    if (busy) return
    setBusy(true)
    try { await refreshProfile() } finally { setBusy(false) }
  }

  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refreshProfile() }, 8000)
    const online = () => refreshProfile()
    window.addEventListener('online', online)
    return () => { clearInterval(timer); window.removeEventListener('online', online) }
  }, [refreshProfile])

  return (
    <AuthShell>
      <div className="row" style={{ gap: 12 }}>
        <span className="center" style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
          <Icon name="refresh" size={20} />
        </span>
        <h1>{t('conn.title')}</h1>
      </div>
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>{t('conn.text')}</p>
      <p className="muted small" style={{ margin: 0, lineHeight: 1.55 }}>{t('conn.auto')}</p>
      {(profile?.username || user?.email) && <div className="small muted">{t('pending.signedInAs', { who: profile?.username ? `@${profile.username}` : user?.email || '' })}</div>}
      <div className="row">
        <Button onClick={retry} disabled={busy}>{busy ? t('conn.trying') : t('conn.retry')}</Button>
        <div className="spacer" />
        <Button variant="ghost" icon="logout" onClick={() => signOut()}>{t('auth.signOut')}</Button>
      </div>
    </AuthShell>
  )
}
