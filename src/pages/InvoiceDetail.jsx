import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, formatRupiah, formatDate } from '../lib/theme'
import { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import DetailHeader from '../components/DetailHeader'

const STATUS_META = {
  sent: { label: 'Sent', bg: colors.accentBg, color: colors.accent },
  paid: { label: 'Paid', bg: '#E6F5EA', color: '#227A3E' },
  void: { label: 'Void', bg: colors.neutralBg, color: colors.neutral },
}
const TYPE_META = {
  labor: { label: 'Labor', bg: colors.accentBg, color: colors.accent },
  part: { label: 'Part', bg: colors.neutralBg, color: colors.neutral },
}

export default function InvoiceDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, hasPermission } = useAuth()
  const canManage = hasPermission('edit_settings')

  const [invoice, setInvoice] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('invoices')
      .select('*, vehicles(id, name, vehicle_year, make, model, plate), owners(id, name, email, phone, billing_address), work_orders(id, wo_number, service), paid_by_profile:profiles!paid_by(name)')
      .eq('id', id)
      .single()
    setInvoice(data ?? null)
    setLoading(false)
  }

  async function markAsPaid() {
    if (!invoice) return
    setSaving(true)
    const { error } = await supabase
      .from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString(), paid_by: user?.id || null })
      .eq('id', invoice.id)
    setSaving(false)
    if (error) { alert(error.message); return }
    load()
  }

  if (loading) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading invoice…</main>
  }
  if (!invoice) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Invoice not found.</main>
  }

  const meta = STATUS_META[invoice.status] || STATUS_META.sent
  const lineItems = Array.isArray(invoice.line_items) ? invoice.line_items : []
  const ymm = invoice.vehicles ? [invoice.vehicles.vehicle_year, invoice.vehicles.make, invoice.vehicles.model].filter(Boolean).join(' ') : ''

  return (
    <>
      <DetailHeader
        backTo="/invoices"
        backLabel="Invoices"
        title={invoice.invoice_number}
        subtitle={invoice.work_orders ? `${invoice.work_orders.wo_number} · ${invoice.work_orders.service}` : undefined}
        badge={<Badge bg={meta.bg} color={meta.color}>{meta.label}</Badge>}
      >
        {invoice.work_orders?.id && (
          <SecondaryButton onClick={() => navigate(`/work-orders/${invoice.work_orders.id}`)}>View work order</SecondaryButton>
        )}
        {canManage && invoice.status === 'sent' && (
          <PrimaryButton onClick={markAsPaid} disabled={saving}>{saving ? 'Saving…' : 'Mark as Paid'}</PrimaryButton>
        )}
      </DetailHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 20 }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.neutralBg, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 16px' }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={colors.neutral} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
            <div style={{ fontSize: 13, color: colors.text2 }}>
              {invoice.recipient_email
                ? `Simulated: this would have been emailed to ${invoice.recipient_email}. No message provider is connected yet, so nothing was actually sent.`
                : 'No owner email was on file, so nothing could be sent — this record was still created for tracking.'}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 8 }}>Bill to</div>
              {invoice.owners ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{invoice.owners.name}</div>
                  {invoice.owners.email && <div style={{ fontSize: 12, color: colors.text2, marginTop: 2 }}>{invoice.owners.email}</div>}
                  {invoice.owners.phone && <div style={{ fontSize: 12, color: colors.text2, marginTop: 2 }}>{invoice.owners.phone}</div>}
                  {invoice.owners.billing_address && <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 6, whiteSpace: 'pre-wrap' }}>{invoice.owners.billing_address}</div>}
                </>
              ) : (
                <div style={{ fontSize: 13, color: colors.mutedLight }}>No fleet group assigned to this vehicle.</div>
              )}
            </div>
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 8 }}>Vehicle</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{invoice.vehicles?.name || '—'}</div>
              <div style={{ fontSize: 12, color: colors.text2, marginTop: 2 }}>{ymm}</div>
              {invoice.vehicles?.plate && <div style={{ fontSize: 12, color: colors.mutedLight, fontFamily: fontMono, marginTop: 2 }}>{invoice.vehicles.plate}</div>}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
            <DL label="Sent" value={formatDate(invoice.sent_at)} />
            <DL label="Due" value={formatDate(invoice.due_date)} />
            <DL label="Paid" value={invoice.status === 'paid' ? `${formatDate(invoice.paid_at)}${invoice.paid_by_profile?.name ? ` · ${invoice.paid_by_profile.name}` : ''}` : '—'} />
          </div>

          <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Description</th>
                  <th style={thStyle}>Qty</th>
                  <th style={thStyle}>Rate</th>
                  <th style={thStyle}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li, i) => {
                  const tm = TYPE_META[li.type] || TYPE_META.part
                  return (
                    <tr key={i} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '10px 12px' }}><Badge bg={tm.bg} color={tm.color}>{tm.label}</Badge></td>
                      <td style={{ padding: '10px 12px', fontSize: 13 }}>{li.description || '—'}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, fontFamily: fontMono }}>{li.qty} {li.unit}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, fontFamily: fontMono }}>{formatRupiah(li.rate)}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600, fontFamily: fontMono }}>{formatRupiah((Number(li.qty) || 0) * (Number(li.rate) || 0))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignSelf: 'flex-end', minWidth: 260 }}>
            <TotalsRow label="Subtotal" value={invoice.subtotal} />
            <TotalsRow label="PPN (11%)" value={invoice.tax} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, color: colors.ink, borderTop: `1px solid ${colors.borderStrong}`, paddingTop: 8 }}>
              <span>Total</span><span style={{ fontFamily: fontMono }}>{formatRupiah(invoice.total)}</span>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}

function DL({ label, value }) {
  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 3 }}>{value || '—'}</div>
    </div>
  )
}

function TotalsRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: colors.text2 }}>
      <span>{label}</span><span style={{ fontFamily: fontMono }}>{formatRupiah(value)}</span>
    </div>
  )
}

const thStyle = { padding: '9px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
