import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { colors, fontMono, formatRupiah, formatDate } from '../lib/theme'
import DetailHeader from '../components/DetailHeader'

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

export default function TechnicianDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const period = searchParams.get('period') || 'all'

  const [technician, setTechnician] = useState(null)
  const [workOrders, setWorkOrders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function load() {
    setLoading(true)
    const [{ data: t }, { data: w }] = await Promise.all([
      supabase.from('profiles').select('id, name, username, phone').eq('id', id).single(),
      supabase
        .from('work_orders')
        .select('id, wo_number, service, status, created_at, vehicles(name), work_order_line_items(type, qty, rate)')
        .eq('technician_id', id)
        .order('created_at', { ascending: false }),
    ])
    setTechnician(t ?? null)
    setWorkOrders(w ?? [])
    setLoading(false)
  }

  const range = useMemo(() => periodRange(period), [period])
  const filtered = useMemo(() => {
    if (!range) return workOrders
    return workOrders.filter((w) => {
      const d = new Date(w.created_at)
      return d >= range.start && d < range.end
    })
  }, [workOrders, range])

  const hours = filtered.reduce((s, w) => s + laborHours(w.work_order_line_items), 0)
  const value = filtered.reduce((s, w) => s + laborValue(w.work_order_line_items), 0)

  if (loading) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading technician…</main>
  }
  if (!technician) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Technician not found.</main>
  }

  return (
    <>
      <DetailHeader
        backTo="/technicians"
        backLabel="Technicians"
        title={technician.name}
        subtitle={`@${technician.username}${technician.phone ? ` · ${technician.phone}` : ''}`}
      />

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 20 }}>

          <div role="group" aria-label="Filter by time period" style={{ display: 'flex', gap: 8 }}>
            {PERIODS.map((p) => {
              const isOn = period === p.key
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setSearchParams(p.key === 'all' ? {} : { period: p.key })}
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <StatCard label="Labor hours" value={`${hours.toLocaleString('id-ID')} hr`} />
            <StatCard label="Labor value" value={formatRupiah(value)} />
          </div>

          <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Work orders in this period</div>
            {filtered.length === 0 && (
              <div style={{ fontSize: 13, color: colors.mutedLight }}>No work orders in this period.</div>
            )}
            {filtered.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => navigate(`/work-orders/${w.id}`)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px', cursor: 'pointer', font: 'inherit' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: colors.accent }}>{w.vehicles?.name || '—'}</span>
                  <span style={{ fontSize: 12, color: colors.mutedLight, fontFamily: fontMono }}>{w.wo_number}</span>
                </div>
                <div style={{ fontSize: 12, color: colors.text2, marginTop: 2 }}>{w.service}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12 }}>
                  <span style={{ color: colors.mutedLight }}>{formatDate(w.created_at)}</span>
                  <span style={{ fontFamily: fontMono, fontWeight: 700, color: colors.ink }}>{laborHours(w.work_order_line_items).toLocaleString('id-ID')} hr · {formatRupiah(laborValue(w.work_order_line_items))}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </main>
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
