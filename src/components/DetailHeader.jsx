import React from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '../lib/theme'
import NotificationBell from './NotificationBell'

// Full-page detail header: a back link, a divider, a title/subtitle block,
// and right-aligned action buttons (Save, Delete, etc). Used by every
// "view one record" page instead of a side-panel drawer, so the browser's
// own back button and a real URL both work the way they would for any
// other page in the app.
export default function DetailHeader({ backTo, backLabel, title, subtitle, badge, children }) {
  const navigate = useNavigate()
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '20px 32px', borderBottom: `1px solid ${colors.border}`, background: colors.white, flexWrap: 'wrap', rowGap: 12, position: 'sticky', top: 0, zIndex: 15 }}>
      <button
        type="button"
        onClick={() => navigate(backTo)}
        aria-label={`Back to ${backLabel}`}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 700, color: colors.accent, flexShrink: 0 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        {backLabel}
      </button>
      <div style={{ width: 1, height: 26, background: colors.border, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: '-0.01em' }}>{title}</h1>
          {badge}
        </div>
        {subtitle && <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{subtitle}</div>}
      </div>
      <div style={{ flex: '1 1 auto' }} />
      {children}
      <NotificationBell />
    </header>
  )
}
