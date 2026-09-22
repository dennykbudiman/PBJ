import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { colors, severityPalette, timeAgo } from '../lib/theme'

const ICONS = {
  critical: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9L2.6 18a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0z" />
      <path d="M12 9.5v4" /><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
  warning: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" />
    </svg>
  ),
  info: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M8.5 12.3l2.3 2.3 4.7-5" />
    </svg>
  ),
}

// Header notification bell — replaces the standalone Alerts page. Reads the
// same `alerts` table the old page used, shows an unread-count badge, and
// opens a dropdown with a per-item dismiss (delete) action plus "mark all
// as read", closing on outside click.
export default function NotificationBell() {
  const navigate = useNavigate()
  const [alerts, setAlerts] = useState([])
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    load()
    const interval = setInterval(load, 60000) // light polling so the badge stays current across pages
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  async function load() {
    const { data } = await supabase.from('alerts').select('*').order('created_at', { ascending: false }).limit(30)
    setAlerts(data ?? [])
    setLoaded(true)
  }

  async function dismiss(id, e) {
    e.stopPropagation()
    setAlerts((prev) => prev.filter((a) => a.id !== id))
    await supabase.from('alerts').delete().eq('id', id)
  }

  async function markAllRead() {
    setAlerts((prev) => prev.map((a) => ({ ...a, is_unread: false })))
    await supabase.from('alerts').update({ is_unread: false }).eq('is_unread', true)
  }

  const unreadCount = alerts.filter((a) => a.is_unread).length

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        style={{
          position: 'relative', width: 38, height: 38, borderRadius: 9, border: `1px solid ${colors.border}`,
          background: open ? colors.bg : colors.white, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 4.5 1.5 6 2 6.5H4c.5-.5 2-2 2-6.5z" />
          <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
        </svg>
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3, minWidth: 16, height: 16, borderRadius: 999, background: colors.danger,
            color: colors.white, fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
          }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 8, width: 360, maxHeight: 440,
          background: colors.white, border: `1px solid ${colors.borderStrong}`, borderRadius: 12,
          boxShadow: '0 16px 40px rgba(20,20,20,0.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 60,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Notifications</span>
            {unreadCount > 0 && (
              <button type="button" onClick={markAllRead} style={{ background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: colors.accent, cursor: 'pointer' }}>
                Mark all as read
              </button>
            )}
          </div>
          <div style={{ overflowY: 'auto', flex: '1 1 auto' }}>
            {!loaded && <div style={{ padding: 18, fontSize: 13, color: colors.mutedLight }}>Loading…</div>}
            {loaded && alerts.length === 0 && <div style={{ padding: 18, fontSize: 13, color: colors.mutedLight }}>No notifications.</div>}
            {alerts.map((a) => {
              const pal = severityPalette(a.severity)
              return (
                <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 16px', borderBottom: `1px solid rgba(28,30,34,0.06)`, background: a.is_unread ? '#FBFAF8' : 'transparent' }}>
                  <div style={{ width: 26, height: 26, borderRadius: 999, background: pal.bg, color: a.severity === 'info' ? colors.accent : pal.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    {ICONS[a.severity] ?? ICONS.info}
                  </div>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{a.title}</span>
                      {a.is_unread && <span aria-label="Unread" style={{ width: 6, height: 6, borderRadius: 999, background: colors.accent, flexShrink: 0 }} />}
                    </div>
                    <div style={{ fontSize: 12, color: colors.muted, marginTop: 2, lineHeight: 1.4 }}>{a.description}</div>
                    <div style={{ fontSize: 11, color: colors.mutedLight, marginTop: 4 }}>
                      {a.related_entity_type ? `${a.related_entity_type} · ` : ''}{timeAgo(a.created_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => dismiss(a.id, e)}
                    aria-label={`Remove notification: ${a.title}`}
                    style={{ width: 22, height: 22, borderRadius: 6, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
