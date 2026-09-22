import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { colors, fontMono, formatRupiah, formatJuta, severityPalette, timeAgo } from '../lib/theme'
import PageHeader, { PrimaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'

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

function StatCard({ label, value, valueColor, sub, subColor }) {
  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '18px 20px', boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}>
      <div style={{ fontSize: 13, color: colors.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6, fontFamily: fontMono, color: valueColor || colors.ink, whiteSpace: 'nowrap' }}>{value}</div>
      <div style={{ fontSize: 12, color: subColor || colors.mutedLight, marginTop: 4, fontWeight: subColor ? 600 : 400 }}>{sub}</div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [maintRows, setMaintRows] = useState([])
  const [alerts, setAlerts] = useState([])
  const [chart, setChart] = useState([])

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [{ data: vehicles }, { data: openWOs }, { data: upcoming }, { data: recentAlerts }, { data: lineItems }] = await Promise.all([
        supabase.from('vehicles').select('id, status'),
        supabase.from('work_orders').select('id, status, priority'),
        supabase
          .from('work_orders')
          .select('id, wo_number, service, eta, priority, status, vehicles(name, model)')
          .eq('status', 'open')
          .order('eta', { ascending: true })
          .limit(5),
        supabase.from('alerts').select('*').order('created_at', { ascending: false }).limit(5),
        supabase
          .from('work_order_line_items')
          .select('qty, rate, work_orders!inner(status, updated_at)')
          .eq('work_orders.status', 'completed'),
      ])
      if (cancelled) return

      const active = (vehicles ?? []).filter((v) => v.status === 'active').length
      const shop = (vehicles ?? []).filter((v) => v.status === 'shop').length
      const open = (openWOs ?? []).filter((w) => w.status === 'open' || w.status === 'inprogress').length
      const inProgress = (openWOs ?? []).filter((w) => w.status === 'inprogress').length

      // Monthly spend from completed work orders' line items.
      const now = new Date()
      const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`
      const thisMonth = monthKey(now)
      let mtdSpend = 0
      const byMonth = {}
      for (const li of lineItems ?? []) {
        const updated = new Date(li.work_orders.updated_at)
        const key = monthKey(updated)
        const total = Number(li.qty) * Number(li.rate)
        byMonth[key] = (byMonth[key] || 0) + total
        if (key === thisMonth) mtdSpend += total
      }
      const months = []
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        months.push({ label: d.toLocaleDateString('en-US', { month: 'short' }), total: byMonth[monthKey(d)] || 0 })
      }
      const maxTotal = Math.max(1, ...months.map((m) => m.total))

      setStats({
        fleetSize: (vehicles ?? []).length,
        active, shop,
        openWorkOrders: open,
        inProgress,
        scheduled: open - inProgress,
        mtdSpend,
      })
      setChart(months.map((m) => ({ ...m, pct: m.total / maxTotal })))
      setMaintRows(
        (upcoming ?? []).map((w) => {
          const dueDate = w.eta ? new Date(w.eta) : null
          const overdue = dueDate && dueDate < now
          const days = dueDate ? Math.round((dueDate - now) / 86400000) : null
          const due = !dueDate ? 'No ETA' : overdue ? `Overdue ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}` : days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`
          const pal = severityPalette(overdue ? 'overdue' : 'default')
          return {
            id: w.id,
            vehicle: w.vehicles ? `${w.vehicles.name}${w.vehicles.model ? ' — ' + w.vehicles.model : ''}` : '—',
            service: w.service,
            due, dueColor: overdue ? colors.danger : colors.text2,
            statusLabel: overdue ? 'Overdue' : 'Scheduled',
            ...pal,
          }
        })
      )
      setAlerts(
        (recentAlerts ?? []).map((a) => {
          const pal = severityPalette(a.severity)
          return { ...a, ...pal, iconColor: a.severity === 'info' ? colors.accent : pal.color }
        })
      )
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (!stats) {
    return (
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading dashboard…</main>
    )
  }

  return (
    <>
      <PageHeader title="Dashboard">
        <Link to="/work-orders">
          <PrimaryButton>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            New Work Order
          </PrimaryButton>
        </Link>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '28px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ fontSize: 13, color: colors.muted }}>
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · Meridian Auto Group
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(max-content,1fr))', gap: 16 }}>
          <StatCard label="Fleet size" value={stats.fleetSize} sub={`${stats.active} active · ${stats.shop} in shop`} />
          <StatCard label="Open work orders" value={stats.openWorkOrders} sub={`${stats.inProgress} in progress · ${stats.scheduled} scheduled`} />
          <StatCard label="Maintenance spend (MTD)" value={formatRupiah(stats.mtdSpend)} sub="Sum of completed work orders this month" />
          <StatCard label="Unread alerts" value={alerts.filter((a) => a.is_unread).length} sub="See the notification bell for details" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.7fr 1fr', gap: 16, alignItems: 'stretch' }}>
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Upcoming maintenance</h2>
              <Link to="/calendar" style={{ fontSize: 13, fontWeight: 600, color: colors.accent }}>View calendar →</Link>
            </div>
            <div style={{ overflowX: 'auto', flex: '1 1 auto' }}>
              <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    <th style={thStyle}>Vehicle</th>
                    <th style={thStyle}>Service</th>
                    <th style={thStyle}>Due</th>
                    <th style={thStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {maintRows.length === 0 && (
                    <tr><td colSpan={4} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No open work orders.</td></tr>
                  )}
                  {maintRows.map((row) => (
                    <tr key={row.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{row.vehicle}</td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{row.service}</td>
                      <td style={{ ...tdStyle, color: row.dueColor }}>{row.due}</td>
                      <td style={{ padding: '13px 20px' }}><Badge bg={row.bg} color={row.color}>{row.statusLabel}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Recent alerts</h2>
              <span style={{ fontSize: 12, color: colors.mutedLight }}>See the bell icon in the header for all notifications</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto' }}>
              {alerts.length === 0 && <div style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No alerts.</div>}
              {alerts.map((a) => (
                <div key={a.id} style={{ display: 'flex', gap: 12, padding: '13px 20px', borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                  <div style={{ width: 28, height: 28, borderRadius: 999, background: a.bg, color: a.iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    {ICONS[a.severity] ?? ICONS.info}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{a.title}</div>
                    <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{timeAgo(a.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}>
            <h2 style={{ margin: '0 0 16px 0', fontSize: 15, fontWeight: 700 }}>Fleet status</h2>
            <div style={{ display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ width: `${stats.fleetSize ? (stats.active / stats.fleetSize) * 100 : 0}%`, background: colors.accent }} />
              <div style={{ width: `${stats.fleetSize ? (stats.shop / stats.fleetSize) * 100 : 0}%`, background: '#C77F1B' }} />
            </div>
            <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
              <Legend color={colors.accent} label="Active" value={stats.active} />
              <Legend color="#C77F1B" label="In shop" value={stats.shop} />
              <Legend color={colors.mutedLight} label="Out of service" value={stats.fleetSize - stats.active - stats.shop} />
            </div>
          </div>

          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}>
            <h2 style={{ margin: '0 0 16px 0', fontSize: 15, fontWeight: 700 }}>Maintenance cost — last 6 months</h2>
            <svg viewBox="0 0 320 120" width="100%" height="120" role="img" aria-label="Bar chart of monthly maintenance cost">
              {chart.map((m, i) => {
                const barW = 34, gap = 17, x = 8 + i * (barW + gap)
                const h = Math.max(4, m.pct * 70)
                const y = 96 - h
                const isLast = i === chart.length - 1
                return (
                  <React.Fragment key={i}>
                    <text x={x + barW / 2} y={y - 6} fontSize="9.5" fontWeight="700" fontFamily={fontMono} fill={colors.text3} textAnchor="middle">
                      {m.total ? formatJuta(m.total) : '0jt'}
                    </text>
                    <rect x={x} y={y} width={barW} height={h} rx="4" fill={isLast ? colors.accent : '#BFD9D7'} />
                    <text x={x + barW / 2} y="112" fontSize="10" fontFamily="Manrope, sans-serif" fill={colors.mutedLight} textAnchor="middle">{m.label}</text>
                  </React.Fragment>
                )
              })}
            </svg>
          </div>
        </div>
      </main>
    </>
  )
}

function Legend({ color, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 9, height: 9, borderRadius: 999, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 13, color: colors.text2 }}>{label} — <strong style={{ fontFamily: fontMono, fontWeight: 600 }}>{value}</strong></span>
    </div>
  )
}

const thStyle = { padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle = { padding: '13px 12px', fontSize: 13, whiteSpace: 'nowrap' }
