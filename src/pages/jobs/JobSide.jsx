import React from 'react'
import { Badge, Button, Modal, Select } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { supabase } from '../../lib/supabase'
import { fmtDate, fmtDateTime, invoiceNo, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { APPT_COLOR, clock, dayLabel, isActiveAppt, shopParts } from '../../lib/calendar'
import { APPROVALS, APPROVAL_COLOR, PAYMENT_COLOR, PRIORITIES, WORKFLOW_COLOR, WORKFLOW_MANUAL, jobState, STATE_COLOR, lineNet } from '../../lib/jobs'
import { BlurInput, TotalRow } from './common'

export function ApprovalsCard({ job, editable, onRecord }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const counts = Object.fromEntries(APPROVALS.map((a) => [a, job.services.filter((s) => s.approval_status === a).length]))
  const recent = job.approvals.slice(0, 3)
  return (
    <section className="card side-card">
      <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.approvals')}</div>
      <div className="appr-grid">
        {APPROVALS.map((a) => <div key={a}><span className="muted">{t(`job.appr.${a}`)}</span> <b style={{ color: counts[a] && a === 'pending' ? 'var(--amber)' : undefined }}>{counts[a]}</b></div>)}
      </div>
      {editable && <Button variant="primary" className="block" onClick={onRecord} disabled={!job.services.length}>{t('job.recordApproval')}</Button>}
      {recent.length > 0 && (
        <div className="appr-recent">
          {recent.map((a) => {
            const svc = job.services.find((s) => s.id === a.service_id)
            return (
              <div key={a.id} className="small">
                <Badge color={APPROVAL_COLOR[a.decision]}>{t(`job.appr.${a.decision}`)}</Badge> {svc?.name || '—'}
                <div className="muted">{[a.approved_by_name, t(`job.via.${a.method}`), fmtDateTime(a.decided_at, lang, timezone)].filter(Boolean).join(' · ')}</div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export function StatusCard({ job, staff, settings, canEdit, editable, canVoid, run, onInvoice, onVoid }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const ro = job.ro
  const invoiced = ro.order_status === 'invoice'
  const upd = (patch) => run(() => supabase.from('repair_orders').update(patch).eq('id', ro.id))
  const terms = job.customer?.payment_terms_days ?? settings?.default_payment_terms_days
  const state = jobState(ro, shopToday(timezone))
  return (
    <section className="card side-card">
      <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.orderStatus')}</div>
      <div className="seg" aria-label={t('job.orderStatus')}>
        <span className={`seg-btn ${!invoiced ? 'on' : ''}`}>{t('job.estimate')}</span>
        <span className={`seg-btn ${invoiced ? 'on' : ''}`}>{t('job.invoice')}</span>
      </div>
      {!invoiced && editable && <Button className="block" style={{ marginTop: 8 }} icon="receipt" onClick={onInvoice}>{t('job.createInvoice')}</Button>}
      {invoiced && (
        <div className="small" style={{ marginTop: 8, lineHeight: 1.7 }}>
          <div><b>{invoiceNo(ro.invoice_number)}</b> · {fmtDate(ro.invoiced_at, lang, timezone)}</div>
          <div>{t('job.dueDate')}: <b>{fmtDate(ro.due_date, lang)}</b> {state === 'overdue' && <Badge color="red">{t('job.state.overdue')}</Badge>}</div>
          <div className="field" style={{ marginTop: 6 }}>
            <label htmlFor="fp-no">{t('job.fakturNo')}</label>
            <BlurInput id="fp-no" value={ro.faktur_pajak_number || ''} disabled={!canEdit} placeholder="010.000-26.00000001"
              onCommit={(v) => upd({ faktur_pajak_number: v.trim() || null })} />
          </div>
          {canVoid && <button type="button" className="linkbtn small" style={{ color: 'var(--red)', marginTop: 6 }} onClick={onVoid}>{t('job.voidInvoice')}</button>}
        </div>
      )}
      {ro.closed_at && <div className="notice warn small" style={{ marginTop: 8 }}>{t('job.closedOn', { date: fmtDate(ro.closed_at, lang, timezone), reason: ro.close_reason || '' })}</div>}

      <div className="sectionlabel">{t('job.workflow')}</div>
      {invoiced ? (
        <div className="row wrap" style={{ gap: 6 }}>
          <Badge color={WORKFLOW_COLOR[ro.workflow_status]}>{t(`job.wf.${ro.workflow_status}`)}</Badge>
          {ro.archived_at ? (
            <>
              <span className="small muted">{t('job.pickedUp', { date: fmtDate(ro.archived_at, lang, timezone) })}</span>
              {canEdit && <button type="button" className="linkbtn small" onClick={() => upd({ archived_at: null })}>{t('job.undo')}</button>}
            </>
          ) : canEdit && <Button size="sm" icon="car" onClick={() => upd({ archived_at: new Date().toISOString() })}>{t('job.markPickedUp')}</Button>}
        </div>
      ) : (
        <Select value={ro.workflow_status} disabled={!editable} onChange={(e) => upd({ workflow_status: e.target.value })} aria-label={t('job.workflow')}
          options={WORKFLOW_MANUAL.map((w) => ({ value: w, label: t(`job.wf.${w}`) }))} />
      )}

      <div className="grid2" style={{ marginTop: 4 }}>
        <div>
          <div className="sectionlabel">{t('job.advisor')}</div>
          <Select value={ro.service_advisor_id || ''} disabled={!canEdit || !!ro.closed_at} onChange={(e) => upd({ service_advisor_id: e.target.value || null })} aria-label={t('job.advisor')}
            options={[{ value: '', label: '—' }, ...staff.filter((s) => s.roles?.name !== 'Technician' || s.id === ro.service_advisor_id).map((s) => ({ value: s.id, label: s.name }))]} />
        </div>
        <div>
          <div className="sectionlabel">{t('job.priority')}</div>
          <Select value={ro.priority} disabled={!canEdit || !!ro.closed_at} onChange={(e) => upd({ priority: e.target.value })} aria-label={t('job.priority')}
            options={PRIORITIES.map((p) => ({ value: p, label: t(`job.pri.${p}`) }))} />
        </div>
      </div>

      <div className="sectionlabel">{t('job.payment')}</div>
      <div className="row wrap" style={{ gap: 6 }}>
        <Badge color={invoiced ? STATE_COLOR[state] : PAYMENT_COLOR[ro.payment_status]}>{invoiced ? t(`job.state.${state}`) : t(`job.ps.${ro.payment_status}`)}</Badge>
        <span className="small muted">{terms === 0 ? t('job.termsCash') : t('job.termsNet', { n: terms ?? 30 })}</span>
      </div>
    </section>
  )
}

export function TotalsCard({ job, settings, editable, canPay, canRefund, canCredit, run, onPayment, onCredit, onFee, onDiscount }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [delPay, setDelPay] = React.useState(null)
  const ro = job.ro
  // An issued invoice keeps the tax settings it was issued with.
  const tax = ro.order_status === 'invoice' && ro.shop_snapshot ? ro.shop_snapshot : settings
  const taxRate = tax?.pkp_status === 'non_pkp' ? 0 : Number(tax?.tax_rate ?? 11)
  const settingsForTax = tax
  const removeFee = (f) => run(() => supabase.from('ro_job_fees').delete().eq('id', f.id))
  const removeDisc = (d) => run(() => supabase.from('ro_job_discounts').delete().eq('id', d.id))
  const credits = job.appliedCredits.reduce((a, c) => a + Number(c.amount), 0)
  return (
    <section className="card side-card totals">
      <h2>{t('job.totals')}</h2>
      <TotalRow label={t('job.parts')} value={ro.parts_total} />
      <TotalRow label={t('job.labor')} value={ro.labor_total} />
      {Number(ro.other_total) > 0 && <TotalRow label={t('job.sublet')} value={ro.other_total} />}
      {Number(ro.item_discount_total) > 0 && <div className="trow muted small"><span>{t('job.itemDiscountIncl')}</span><span className="trow-val">{rp(ro.item_discount_total)}</span></div>}
      {Number(ro.service_fees_total) > 0 && <TotalRow label={t('job.serviceFees')} value={ro.service_fees_total} />}
      {Number(ro.service_discount_total) > 0 && <TotalRow label={t('job.serviceDiscounts')} value={ro.service_discount_total} negative />}
      {job.fees.map((f) => (
        <div key={f.id} className="trow">
          <span>
            {f.is_shop_supplies ? t('job.shopSupplies') : f.name}
            {f.kind === 'percent' && (
              editable && f.is_shop_supplies ? (
                <span className="inline-rate">(<BlurInput className="input cell num tiny" value={String(Number(f.value)).replace('.', ',')} aria-label={t('job.shopSuppliesRate')}
                  onCommit={(v, reset) => { const n = Number(String(v).replace(',', '.')); if (Number.isNaN(n) || n < 0 || n > 100) { reset(); return } run(() => supabase.from('ro_job_fees').update({ value: n }).eq('id', f.id)) }} />%)</span>
              ) : ` (${num(f.value, 2)}%)`
            )}
            {editable && <button type="button" className="xbtn" onClick={() => removeFee(f)} aria-label={t('job.removeX', { name: f.name })}><Icon name="x" size={12} /></button>}
          </span>
          <span className="trow-val">{rp(f.amount)}</span>
        </div>
      ))}
      {job.discounts.map((d) => (
        <div key={d.id} className="trow">
          <span>{d.name}{d.kind === 'percent' && ` (${num(d.value, 2)}%)`}
            {editable && <button type="button" className="xbtn" onClick={() => removeDisc(d)} aria-label={t('job.removeX', { name: d.name })}><Icon name="x" size={12} /></button>}
          </span>
          <span className="trow-val">-{rp(d.amount)}</span>
        </div>
      ))}
      {editable && (
        <div className="row" style={{ gap: 12, margin: '4px 0 2px' }}>
          <button type="button" className="linkbtn small" onClick={onFee}>+ {t('job.fee')}</button>
          <button type="button" className="linkbtn small" onClick={onDiscount}>+ {t('job.discount')}</button>
        </div>
      )}
      <div className="trule" />
      <TotalRow label={t('job.subtotal')} value={ro.subtotal} strong />
      <TotalRow label={job.customer?.tax_exempt ? t('job.taxExempt', { tax: settingsForTax?.tax_name || 'PPN' }) : t('job.taxLine', { tax: settingsForTax?.tax_name || 'PPN', rate: num(taxRate, 2), base: rp(ro.taxable_base) })} value={ro.tax_total} />
      <div className="trule" />
      <TotalRow label={t('job.total')} value={ro.total} strong />
      <TotalRow label={t('job.paidToDate')} value={ro.paid_total} muted />
      {credits > 0 && <div className="trow muted small"><span>{t('job.ofWhichCredit')}</span><span className="trow-val">{rp(credits)}</span></div>}
      <TotalRow label={t('job.balance')} value={ro.balance} strong />
      <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
        {canPay && !ro.closed_at && (Number(ro.balance) > 0 || ro.order_status !== 'invoice' || (canRefund && Number(ro.paid_total) > 0)) && <Button icon="plus" onClick={onPayment}>{t('job.payment')}</Button>}
        {canCredit && <Button icon="plus" onClick={onCredit}>{t('job.credit')}</Button>}
      </div>
      {job.payments.length > 0 && (
        <div className="paylist">
          {job.payments.map((p) => {
            const voided = job.voids.some((v) => v.voided_at >= p.created_at)
            const canDelete = canPay && p.source === 'manual' && !voided && (ro.order_status !== 'invoice' || canRefund)
            return (
              <div key={p.id} className="payrow">
                <div>
                  <b style={{ color: p.kind === 'refund' ? 'var(--red)' : undefined }}>{p.kind === 'refund' ? '-' : ''}{rp(p.amount)}</b>
                  <span className="muted small"> · {t(`job.pay.${p.method}`)} · {fmtDate(p.paid_at, lang, timezone)}</span>
                  {(p.reference || p.receipt_number) && <div className="muted small">{[p.reference, p.receipt_number && t('job.receiptX', { no: p.receipt_number })].filter(Boolean).join(' · ')}</div>}
                </div>
                {canDelete && <button type="button" className="xbtn" onClick={() => setDelPay(p)} aria-label={t('job.deletePayment')}><Icon name="trash" size={13} /></button>}
              </div>
            )
          })}
        </div>
      )}
      <Modal open={!!delPay} title={t('job.deletePayment')} onClose={() => setDelPay(null)}
        footer={<><Button onClick={() => setDelPay(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" className="solid" onClick={() => { const p = delPay; setDelPay(null); run(() => supabase.from('payments').delete().eq('id', p.id), t('job.paymentDeleted')) }}>{t('job.deletePaymentYes')}</Button></>}>
        {delPay && t('job.deletePaymentText', { amount: rp(delPay.amount), date: fmtDate(delPay.paid_at, lang, timezone), method: t(`job.pay.${delPay.method}`) })}
      </Modal>
    </section>
  )
}

// What the job earns the shop: revenue minus cost on approved (and still pending) work.
export function ProfitCard({ job }) {
  const { t } = useT()
  const liveSvcs = job.services.filter((s) => s.approval_status === 'approved' || s.approval_status === 'pending')
  const live = new Set(liveSvcs.map((s) => s.id))
  // A flat-rate service earns its flat price, not the sum of its lines: scale its lines to it.
  const scale = {}
  for (const s of liveSvcs) {
    const sumLines = job.items.filter((l) => l.service_id === s.id).reduce((a, l) => a + lineNet(l), 0)
    scale[s.id] = s.flat_price != null && sumLines > 0 ? Number(s.flat_price) / sumLines : 1
  }
  const lines = job.items.filter((l) => live.has(l.service_id))
  const sum = (type, f) => lines.filter((l) => l.item_type === type).reduce((a, l) => a + f(l), 0)
  const rev = (l) => lineNet(l) * scale[l.service_id]
  const partsRev = Math.round(sum('part', rev))
  const partsCost = sum('part', (l) => Math.round(Number(l.cost) * Number(l.qty)))
  const laborRev = Math.round(sum('labor', rev))
  const laborCost = sum('labor', (l) => Math.round(Number(l.cost) * Number(l.qty)))
  const subRev = Math.round(sum('sublet', rev))
  const subCost = sum('sublet', (l) => Math.round(Number(l.cost) * Number(l.qty)))
  const pct = (rev, cost) => (rev > 0 ? Math.round(((rev - cost) / rev) * 100) : 0)
  const billed = sum('labor', (l) => Number(l.qty))
  const worked = sum('labor', (l) => Number(l.hours_worked) || 0)
  const gross = partsRev - partsCost + laborRev - laborCost + subRev - subCost
  return (
    <section className="card side-card totals">
      <h2>{t('job.profit')}</h2>
      <div className="trow"><span>{t('job.parts')} · {pct(partsRev, partsCost)}%</span><span className="trow-val">{rp(partsRev - partsCost)}</span></div>
      <div className="trow"><span>{t('job.labor')} · {pct(laborRev, laborCost)}%</span><span className="trow-val">{rp(laborRev - laborCost)}</span></div>
      {subRev > 0 && <div className="trow"><span>{t('job.sublet')} · {pct(subRev, subCost)}%</span><span className="trow-val">{rp(subRev - subCost)}</span></div>}
      <div className="trule" />
      <div className="trow strong"><span>{t('job.grossProfit')}</span><span className="trow-val">{rp(gross)}</span></div>
      <div className="trow muted"><span>{t('job.hoursBilledWorked')}</span><span className="trow-val">{num(billed, 2)} / {num(worked, 2)}</span></div>
      <div className="hint">{t('job.profitHint')}</div>
    </section>
  )
}

// Bookings for this job. New ones can be made while it is an open estimate.
export function AppointmentsCard({ job, staff, canBook, onOpen, onNew }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const now = Date.now()
  // Coming bookings first (soonest first), then past or cancelled ones (latest first).
  const list = [...job.appointments].sort((a, b) => {
    const fa = Date.parse(a.end_time) >= now && isActiveAppt(a); const fb = Date.parse(b.end_time) >= now && isActiveAppt(b)
    if (fa !== fb) return fa ? -1 : 1
    const d = Date.parse(a.start_time) - Date.parse(b.start_time)
    return fa ? d : -d
  })
  if (!list.length && !canBook) return null
  return (
    <section className="card side-card">
      <div className="row" style={{ gap: 8 }}>
        <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.appointments')}</div>
        <div className="spacer" />
        {canBook && <button type="button" className="linkbtn small" onClick={onNew}><Icon name="calendar" size={13} /> {t('board.book')}</button>}
      </div>
      {list.length === 0 ? <div className="muted small">{t('job.noAppointments')}</div> : (
        <div className="apptlist">
          {list.slice(0, 4).map((a) => {
            const p = shopParts(a.start_time, timezone)
            const e = shopParts(a.end_time, timezone)
            const tech = staff.find((s) => s.id === a.technician_id)
            return (
              <button key={a.id} type="button" className={`apptrow ${isActiveAppt(a) ? '' : 'off'}`} onClick={() => onOpen(a)}>
                <span><b>{dayLabel(p.date, lang)}</b> {clock(p.minutes, lang)}–{e.date !== p.date && <b>{dayLabel(e.date, lang)} </b>}{clock(e.minutes, lang)}{tech && <span className="muted"> · {tech.name}</span>}</span>
                <Badge color={APPT_COLOR[a.status]}>{t(`appt.st.${a.status}`)}</Badge>
              </button>
            )
          })}
          {list.length > 4 && <div className="muted small">{t('job.moreAppointments', { n: list.length - 4 })}</div>}
        </div>
      )}
    </section>
  )
}
