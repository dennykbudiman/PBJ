import React from 'react'
import { Button } from '../components/ui'
import Icon from '../components/Icon'
import { AuthShell } from './Login'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'

// Signed in, but not (yet) allowed into the app: waiting for activation,
// disabled, a Fleet manager (no access yet), or no profile at all.
export default function AccountPending() {
  const { t } = useT()
  const { profile, roleName, user, signOut, refreshProfile } = useAuth()

  let key = 'pending.missing'
  if (profile?.status === 'invited') key = 'pending.invited'
  else if (profile?.status === 'disabled') key = 'pending.disabled'
  // Active but not allowed in: a Fleet manager (their role name isn't readable to them).
  else if (profile?.status === 'active' || roleName === 'Fleet manager') key = 'pending.fleet'

  return (
    <AuthShell>
      <div className="row" style={{ gap: 12 }}>
        <span className="center" style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
          <Icon name={profile?.status === 'disabled' ? 'lock' : 'clock'} size={20} />
        </span>
        <h1>{t(`${key}.title`)}</h1>
      </div>
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>{t(`${key}.text`)}</p>
      <div className="small muted">{t('pending.signedInAs', { who: profile?.username ? `@${profile.username}` : user?.email || '' })}</div>
      <div className="row">
        <Button onClick={() => refreshProfile()}>{t('pending.check')}</Button>
        <div className="spacer" />
        <Button variant="ghost" icon="logout" onClick={() => signOut()}>{t('auth.signOut')}</Button>
      </div>
    </AuthShell>
  )
}
