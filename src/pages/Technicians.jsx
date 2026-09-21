import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { colors, fontMono, formatRupiah, formatDate } from '../lib/theme'
import PageHeader from '../components/PageHeader'
import Badge from '../components/Badge'

// Tracks how many labor hours each technician has logged (and the labor
// value it represents), pulled from work_order_line_items where
// type = 'labor', across every work order assigned to them. Meant as the
// raw material for handing out incentives — not payroll itself.

const PERIODS = [
  { key: 'all', label: 'All time' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
]

function periodRange(key) {
  const now = new Date()
  if (key === 'this_month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return { start, end }
  }
  if (key === 'last_month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 1)
    return { start, end }
  }
  return null
}

function laborHours(items) {
  return (items || []).filter((li) => li.type === 'labor').reduce((s, li) => s + (Number(li.qty) || 0), 0)
}
function laborValue(items) {
  return (items || []).filter((li) => li.type === 'labor').reduce((s, li) => s + (Number(li.qty) || 0) * (Number(li.rate) || 0), 0)
}

export default function Technicians() {
  const [technicians, setTechnicians] = useState([])
  const [workOrders, setWorkOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState('all')
  const [selectedId, setSelectedId] = useState(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: t }, { data: w }] = await Promise.all([
      supabase.from('profiles').select('id, name, username, phone, roles!inner(name)').eq('roles.name', 'Technician').order('name', { ascending: true }),
      supabase
        .from('work_orders')
        .select('id, wo_number, service, status, created_at, technician_id, vehicles(name), work_order_line_items(type, qty, rate)')
        .not('technician_id', 'is', null)
        .order('created_at', { ascending: false }),
    ])
    setTechnicians(t ?? [])
    setWorkOrders(w ?? [])
    setLoading(false)
  }

  const range = useMemo(() => periodRange(period), [period])

  const filteredOrders = useMemo(() => {
    if (!range) return workOrders
    return workOrders.filter((w) => {
      const d = new Date(w.created_at)
      return d >= range.start && d < range.end
    })
  }, [workOrders, range])

  const rows = useMemo(() => {
    return technicians.map((t) => {
      const mine = filteredOrders.filter((w) => w.technician_id === t.id)
      const hours = mine.reduce((s, w) => s + laborHours(w.work_order_line_items), 0)
      const value = mine.reduce((s, w) => s + laborValue(w.work_order_line_items), 0)
      return { technician: t, workOrders: mine, hours, value, count: mine.length }
    }).sort((a, b) => b.hours - a.hours)
  }, [technicians, filteredOrders])

  const totals = useMemo(
    () => ({ hours: rows.reduce((s, r) => s + r.hours, 0), value: rows.reduce((s, r) => s + r.value, 0) }),
    [rows]
  )

  const selected = rows.find((r) => r.technician.id === selectedId) || null

  return (
    <>
      <PageHeader title="Technicians">
        <div role="group" aria-label="Filter by time period" style={{ display: 'flex', gap: 8 }}>
          {PERIODS.map((p) => {
            const isOn = period === p.key
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriod(p.key)}
                style={{
                  borderRadius: 999, border: `1px solid ${isOn ? colors.accent : colors.borderStrong}`,
                  background: isOn ? colors.accent : colors.white, color: isOn ? colors.white : colors.text2,
                  font: 'inherit', fontSize: 13, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
                }}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, color: colors.mutedLight, maxWidth: 720 }}>
          Labor hours and value are summed from the labor line items on every work order assigned to each technician — use this to decide who's earned an incentive this period.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          <StatCard label="Technicians" value={technicians.length} />
          <StatCard label="Total labor hours" value={`${totals.hours.toLocaleString('id-ID')} hr`} />
          <StatCard label="Total labor value" value={formatRupiah(totals.value)} />
        </div>

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Technician</th>
                  <th style={thStyle}>Work orders</th>
                  <th style={thStyle}>Labor hours</th>
                  <th style={thStyle}>Labor value</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={4} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Loading technicians…</td></tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No technician accounts found.</td></tr>
                )}
                {!loading && rows.map((r) => (
                  <tr key={r.technician.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                    <td style={{ padding: '16px 20px' }}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(r.technician.id)}
                        aria-label={`View work orders for ${r.technician.name}`}
                        style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
                      >
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: colors.accent }}>{r.technician.name}</span>
                        <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, marginTop: 1, fontFamily: fontMono }}>@{r.technician.username}</span>
                      </button>
                    </td>
                    <td style={tdStyle}><Badge bg={colors.neutralBg} color={colors.neutral}>{r.count}</Badge></td>
                    <td style={{ ...tdStyle, color: colors.ink, fontWeight: 700, fontFamily: fontMono }}>{r.hours.toLocaleString('id-ID')} hr</td>
                    <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{formatRupiah(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {selected && (
        <>
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            aria-label="Close technician details"
            style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,20,0.32)', border: 'none', padding: 0, cursor: 'default' }}
          />
          <aside aria-label="Technician details" style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 440, background: colors.white, boxShadow: '-8px 0 24px rgba(20,20,20,0.10)', display: 'flex', flexDirection: 'column', zIndex: 50 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: `1px solid ${colors.border}` }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{selected.technician.name}</h2>
                <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{PERIODS.find((p) => p.key === period)?.label}</div>
              </div>
              <button type="button" onClick={() => setSelectedId(null)} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: colors.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4B505A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <StatCard label="Labor hours" value={`${selected.hours.toLocaleString('id-ID')} hr`} />
                <StatCard label="Labor value" value={formatRupiah(selected.value)} />
              </div>

              <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Work orders in this period</div>
                {selected.workOrders.length === 0 && (
                  <div style={{ fontSize: 13, color: colors.mutedLight }}>No work orders in this period.</div>
                )}
                {selected.workOrders.map((w) => (
                  <div key={w.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{w.vehicles?.name || '—'}</span>
                      <span style={{ fontSize: 12, color: colors.mutedLight, fontFamily: fontMono }}>{w.wo_number}</span>
                    </div>
                    <div style={{ fontSize: 12, color: colors.text2, marginTop: 2 }}>{w.service}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12 }}>
                      <span style={{ color: colors.mutedLight }}>{formatDate(w.created_at)}</span>
                      <span style={{ fontFamily: fontMono, fontWeight: 700 }}>{laborHours(w.work_order_line_items).toLocaleString('id-ID')} hr · {formatRupiah(laborValue(w.work_order_line_items))}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </>
      )}
    </>
  )
}

function StatCard({ label, value }) {
  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '16px 18px', boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}>
      <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, fontFamily: fontMono }}>{value}</div>
    </div>
  )
}

const thStyle = { padding: '12px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle = { padding: '16px 12px', fontSize: 13, whiteSpace: 'nowrap' }
