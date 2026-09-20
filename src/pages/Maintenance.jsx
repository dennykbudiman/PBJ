import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { colors, fontMono, formatDate, formatRupiah, severityPalette } from '../lib/theme'
import PageHeader, { PrimaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'

const TABS = [
  { key: 'upcoming', label: 'Upcoming', status: 'open' },
  { key: 'progress', label: 'In progress', status: 'inprogress' },
  { key: 'history', label: 'History', status: 'completed' },
]

export default function Maintenance() {
  const [tab, setTab] = useState('upcoming')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [counts, setCounts] = useState({ open: 0, inprogress: 0, completed: 0 })

  useEffect(() => {
    loadCounts()
  }, [])

  useEffect(() => {
    loadRows(tab)
  }, [tab])

  async function loadCounts() {
    const { data } = await supabase.from('work_orders').select('status')
    const c = { open: 0, inprogress: 0, completed: 0 }
    for (const w of data ?? []) if (c[w.status] !== undefined) c[w.status]++
    setCounts(c)
  }

  async function loadRows(t) {
    setLoading(true)
    const status = TABS.find((x) => x.key === t).status
    let query = supabase
      .from('work_orders')
      .select('id, wo_number, service, eta, started_at, updated_at, bay, priority, vehicles(name, model), profiles(name), work_order_line_items(qty, rate)')
      .eq('status', status)

    if (t === 'upcoming') query = query.order('eta', { ascending: true })
    if (t === 'progress') query = query.order('started_at', { ascending: false })
    if (t === 'history') query = query.order('updated_at', { ascending: false })

    const { data } = await query
    setRows(data ?? [])
    setLoading(false)
  }

  async function startWorkOrder(id) {
    await supabase.from('work_orders').update({ status: 'inprogress', started_at: new Date().toISOString() }).eq('id', id)
    loadRows(tab)
    loadCounts()
  }

  return (
    <>
      <PageHeader title="Maintenance">
        <Link to="/work-orders">
          <PrimaryButton>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Schedule Service
          </PrimaryButton>
        </Link>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div role="tablist" aria-label="Maintenance views" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${colors.borderStrong}` }}>
          {TABS.map((t, i) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              style={{
                fontFamily: 'inherit', fontSize: 14, fontWeight: 700, background: 'none', border: 'none',
                borderBottom: `2.5px solid ${tab === t.key ? colors.accent : 'transparent'}`,
                color: tab === t.key ? colors.accent : colors.muted, padding: '10px 6px',
                marginLeft: i === 0 ? 0 : 20, marginBottom: -1, cursor: 'pointer',
              }}
            >
              {t.label} · {counts[t.status]}
            </button>
          ))}
        </div>

        {loading && <div style={{ fontSize: 13, color: colors.mutedLight }}>Loading…</div>}

        {!loading && tab === 'upcoming' && (
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                    <th style={thStyle}>Vehicle</th><th style={thStyle}>Service</th><th style={thStyle}>Due</th>
                    <th style={thStyle}>Priority</th><th style={thStyle}>Assigned bay</th><th style={{ ...thStyle, padding: '12px 20px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={6} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Nothing scheduled.</td></tr>}
                  {rows.map((row) => {
                    const overdue = row.eta && new Date(row.eta) < new Date()
                    const pal = severityPalette(overdue ? 'overdue' : row.priority)
                    return (
                      <tr key={row.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>{row.vehicles?.name}</td>
                        <td style={{ ...tdStyle, color: colors.text2 }}>{row.service}</td>
                        <td style={{ ...tdStyle, color: colors.text2 }}>{row.eta ? formatDate(row.eta) : '—'}</td>
                        <td style={tdStyle}><Badge bg={pal.bg} color={pal.color}>{overdue ? 'Overdue' : row.priority}</Badge></td>
                        <td style={{ ...tdStyle, color: colors.text2 }}>{row.bay || 'Unassigned'}</td>
                        <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                          <button
                            type="button"
                            onClick={() => startWorkOrder(row.id)}
                            style={{ border: `1px solid ${colors.borderStrong}`, background: colors.white, color: colors.ink, borderRadius: 7, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                          >
                            Start
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && tab === 'progress' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.length === 0 && <div style={{ fontSize: 13, color: colors.mutedLight }}>Nothing in progress.</div>}
            {rows.map((row) => (
              <div key={row.id} style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '18px 20px', boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{row.vehicles?.name} — {row.service}</div>
                    <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>
                      {row.profiles?.name || 'Unassigned'} · started {row.started_at ? formatDate(row.started_at) : '—'} · est. {row.eta ? formatDate(row.eta) : '—'}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                  <span style={{ fontSize: 12, color: colors.mutedLight, fontFamily: fontMono }}>{row.wo_number}</span>
                  <Link to="/work-orders" style={{ fontSize: 13, fontWeight: 600, color: colors.accent }}>View work order →</Link>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && tab === 'history' && (
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                    <th style={thStyle}>Vehicle</th><th style={thStyle}>Service</th><th style={thStyle}>Completed</th><th style={thStyle}>Cost</th><th style={thStyle}>Technician</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={5} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No completed work orders yet.</td></tr>}
                  {rows.map((row) => {
                    const cost = (row.work_order_line_items ?? []).reduce((sum, li) => sum + Number(li.qty) * Number(li.rate), 0)
                    return (
                      <tr key={row.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>{row.vehicles?.name}</td>
                        <td style={{ ...tdStyle, color: colors.text2 }}>{row.service}</td>
                        <td style={{ ...tdStyle, color: colors.text2 }}>{formatDate(row.updated_at)}</td>
                        <td style={{ ...tdStyle, fontWeight: 600, fontFamily: fontMono }}>{formatRupiah(cost)}</td>
                        <td style={{ ...tdStyle, color: colors.text2 }}>{row.profiles?.name || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </>
  )
}

const thStyle = { padding: '12px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle = { padding: '14px 12px', fontSize: 13, whiteSpace: 'nowrap' }
