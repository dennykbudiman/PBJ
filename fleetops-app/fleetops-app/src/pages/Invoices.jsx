import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { colors, fontMono, formatRupiah, formatDate } from '../lib/theme'
import PageHeader from '../components/PageHeader'
import Badge from '../components/Badge'

const STATUS_META = {
  sent: { label: 'Sent', bg: colors.accentBg, color: colors.accent },
  paid: { label: 'Paid', bg: '#E6F5EA', color: '#227A3E' },
  void: { label: 'Void', bg: colors.neutralBg, color: colors.neutral },
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
]

export default function Invoices() {
  const navigate = useNavigate()
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('invoices')
      .select('id, invoice_number, status, total, sent_at, due_date, recipient_email, vehicles(name), owners(name), work_orders(wo_number)')
      .order('sent_at', { ascending: false })
    setInvoices(data ?? [])
    setLoading(false)
  }

  const counts = useMemo(
    () => ({
      all: invoices.length,
      sent: invoices.filter((i) => i.status === 'sent').length,
      paid: invoices.filter((i) => i.status === 'paid').length,
      void: invoices.filter((i) => i.status === 'void').length,
    }),
    [invoices]
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return invoices
      .filter((i) => filter === 'all' || i.status === filter)
      .filter((i) => {
        if (!q) return true
        return [i.invoice_number, i.owners?.name, i.vehicles?.name, i.work_orders?.wo_number].some((s) => (s || '').toLowerCase().includes(q))
      })
  }, [invoices, filter, search])

  const totals = useMemo(
    () => ({
      outstanding: invoices.filter((i) => i.status === 'sent').reduce((s, i) => s + Number(i.total || 0), 0),
      paid: invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.total || 0), 0),
    }),
    [invoices]
  )

  return (
    <>
      <PageHeader title="Invoices">
        <div style={{ flex: '0 1 360px', display: 'flex', alignItems: 'center', gap: 8, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by invoice #, owner, vehicle…"
            aria-label="Search invoices"
            style={{ border: 'none', background: 'transparent', outline: 'none', font: 'inherit', fontSize: 13, width: '100%', color: colors.ink }}
          />
        </div>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.neutralBg, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 16px' }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={colors.neutral} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          <div style={{ fontSize: 13, color: colors.text2 }}>Email delivery is simulated for now — invoices are recorded and tracked here, but no message provider is connected yet to actually send them.</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <StatCard label="Outstanding (sent, unpaid)" value={formatRupiah(totals.outstanding)} />
          <StatCard label="Collected (paid)" value={formatRupiah(totals.paid)} />
        </div>

        <div role="group" aria-label="Filter invoices by status" style={{ display: 'flex', gap: 8 }}>
          {FILTERS.map((f) => {
            const isOn = filter === f.key
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  borderRadius: 999, border: `1px solid ${isOn ? colors.accent : colors.borderStrong}`,
                  background: isOn ? colors.accent : colors.white, color: isOn ? colors.white : colors.text2,
                  font: 'inherit', fontSize: 13, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
                }}
              >
                {f.label} · {counts[f.key]}
              </button>
            )
          })}
        </div>

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Invoice</th>
                  <th style={thStyle}>Owner</th>
                  <th style={thStyle}>Vehicle</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Sent</th>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={6} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Loading invoices…</td></tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No invoices match this view. Invoices are created from a work order once it's checked out and "Send Invoice" is clicked.</td></tr>
                )}
                {!loading && visible.map((inv) => {
                  const meta = STATUS_META[inv.status] || STATUS_META.sent
                  return (
                    <tr key={inv.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '16px 20px' }}>
                        <button
                          type="button"
                          onClick={() => navigate(`/invoices/${inv.id}`)}
                          aria-label={`View invoice ${inv.invoice_number}`}
                          style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
                        >
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: colors.accent, fontFamily: fontMono }}>{inv.invoice_number}</span>
                          <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, marginTop: 1 }}>{inv.work_orders?.wo_number || '—'}</span>
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{inv.owners?.name || 'Unassigned'}</td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{inv.vehicles?.name || '—'}</td>
                      <td style={{ padding: '16px 12px' }}><Badge bg={meta.bg} color={meta.color}>{meta.label}</Badge></td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{formatDate(inv.sent_at)}</td>
                      <td style={{ padding: '16px 20px', fontSize: 13, fontWeight: 600, fontFamily: fontMono }}>{formatRupiah(inv.total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {!loading && (
          <div style={{ fontSize: 13, color: colors.mutedLight }}>
            Showing {visible.length} of {invoices.length} invoices
          </div>
        )}
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

const thStyle = { padding: '12px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle = { padding: '16px 12px', fontSize: 13, whiteSpace: 'nowrap' }
