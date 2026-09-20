import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { colors, severityPalette, timeAgo } from '../lib/theme'
import PageHeader, { SecondaryButton } from '../components/PageHeader'

const ICONS = {
  critical: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9L2.6 18a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0z" />
      <path d="M12 9.5v4" /><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
  warning: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" />
    </svg>
  ),
  info: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M8.5 12.3l2.3 2.3 4.7-5" />
    </svg>
  ),
}

function sectionOf(createdAt) {
  const d = new Date(createdAt)
  const now = new Date()
  const startOfDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 7) return 'week'
  return 'older'
}

export default function Alerts() {
  const [alerts, setAlerts] = useState([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('alerts').select('*').order('created_at', { ascending: false })
    setAlerts(data ?? [])
    setLoading(false)
  }

  async function dismiss(id) {
    setAlerts((prev) => prev.filter((a) => a.id !== id))
    await supabase.from('alerts').delete().eq('id', id)
  }

  async function markAllRead() {
    setAlerts((prev) => prev.map((a) => ({ ...a, is_unread: false })))
    await supabase.from('alerts').update({ is_unread: false }).eq('is_unread', true)
  }

  const counts = useMemo(
    () => ({
      all: alerts.length,
      critical: alerts.filter((a) => a.severity === 'critical').length,
      warning: alerts.filter((a) => a.severity === 'warning').length,
      info: alerts.filter((a) => a.severity === 'info').length,
    }),
    [alerts]
  )

  const visible = alerts.filter((a) => filter === 'all' || a.severity === filter)
  const sections = {
    today: visible.filter((a) => sectionOf(a.created_at) === 'today'),
    yesterday: visible.filter((a) => sectionOf(a.created_at) === 'yesterday'),
    week: visible.filter((a) => ['week', 'older'].includes(sectionOf(a.created_at))),
  }

  return (
    <>
      <PageHeader title="Alerts">
        <SecondaryButton onClick={markAllRead}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4B505A" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 6" /></svg>
          Mark all as read
        </SecondaryButton>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 880 }}>
        <div role="group" aria-label="Filter alerts by severity" style={{ display: 'flex', gap: 8 }}>
          {[
            { key: 'all', label: 'All' },
            { key: 'critical', label: 'Critical' },
            { key: 'warning', label: 'Warning' },
            { key: 'info', label: 'Info' },
          ].map((f) => {
            const isOn = filter === f.key
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  borderRadius: 999, border: `1px solid ${isOn ? colors.accent : colors.borderStrong}`,
                  background: isOn ? colors.accent : colors.white, color: isOn ? colors.white : colors.text2,
                  fontSize: 13, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
                }}
              >
                {f.label} · {counts[f.key]}
              </button>
            )
          })}
        </div>

        {loading && <div style={{ fontSize: 13, color: colors.mutedLight }}>Loading…</div>}

        {!loading && visible.length === 0 && (
          <div style={{ fontSize: 13, color: colors.mutedLight }}>No alerts match this filter.</div>
        )}

        {[
          ['today', 'Today'],
          ['yesterday', 'Yesterday'],
          ['week', 'This week'],
        ].map(([key, label]) =>
          sections[key].length > 0 ? (
            <section key={key}>
              <h2 style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, margin: '0 0 10px 2px' }}>{label}</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {sections[key].map((al) => {
                  const pal = severityPalette(al.severity)
                  return (
                    <div key={al.id} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '16px 18px', boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}>
                      <div style={{ width: 32, height: 32, borderRadius: 999, background: pal.bg, color: al.severity === 'info' ? colors.accent : pal.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {ICONS[al.severity] ?? ICONS.info}
                      </div>
                      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 700 }}>{al.title}</span>
                          {al.is_unread && <span aria-label="Unread" style={{ width: 7, height: 7, borderRadius: 999, background: colors.accent, flexShrink: 0 }} />}
                        </div>
                        <div style={{ fontSize: 13, color: colors.muted, marginTop: 3, lineHeight: 1.5 }}>{al.description}</div>
                        <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 6 }}>
                          {al.related_entity_type ? `${al.related_entity_type} · ` : ''}{timeAgo(al.created_at)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => dismiss(al.id)}
                        aria-label={`Dismiss alert: ${al.title}`}
                        style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null
        )}
      </main>
    </>
  )
}
