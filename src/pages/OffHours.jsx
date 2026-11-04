import React from 'react'
import { Button } from '../components/ui'
import Icon from '../components/Icon'
import { AuthShell } from './Login'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { fmtDateTime } from '../lib/format'

// Outside the staff app hours (migration 138): the app opens 1 hour before the shop opens and closes 1 hour after.
// The Owner or an Admin can allow overtime. The use is recorded.
export default function OffHours() {
  const { t, lang } = useT()
  const { offHours, profile, user, signOut, refreshProfile } = useAuth()
  const next = offHours?.nextOpen ? fmtDateTime(offHours.nextOpen, lang, offHours.timezone) : null
  return (
    <AuthShell>
      <div className="row" style={{ gap: 12 }}>
        <span className="center" style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
          <Icon name="clock" size={20} />
        </span>
        <h1>{t('hrs.closedTitle')}</h1>
      </div>
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>{next ? t('hrs.closedTextNext', { when: next }) : t('hrs.closedText')}</p>
      <p className="muted small" style={{ margin: 0, lineHeight: 1.55 }}>{t('hrs.closedOvertime')}</p>
      <div className="small muted">{t('pending.signedInAs', { who: profile?.username ? `@${profile.username}` : user?.email || '' })}</div>
      <div className="row">
        <Button onClick={() => refreshProfile()}>{t('pending.check')}</Button>
        <div className="spacer" />
        <Button variant="ghost" icon="logout" onClick={() => signOut()}>{t('auth.signOut')}</Button>
      </div>
    </AuthShell>
  )
}
