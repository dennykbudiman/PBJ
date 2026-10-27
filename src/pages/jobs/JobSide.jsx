import React from 'react'
import { Badge, Button, Modal, Select, useConfirm, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, fmtDateTime, invoiceNo, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { APPT_COLOR, clock, dayLabel, isActiveAppt, shopParts } from '../../lib/calendar'
import { APPROVALS, APPROVAL_COLOR, PAYMENT_COLOR, PRIORITIES, WORKFLOW_COLOR, WORKFLOW_MANUAL, jobState, STATE_COLOR, lineNet, sysText } from '../../lib/jobs'
import { BlurInput, TotalRow } from './common'
import { runsJobs } from './useJobData'

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

export function StatusCard({ job, staff, settings, canEdit, canFaktur, editable, canVoid, run, onInvoice, onVoid }) {
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
          {ro.due_date && <div>{t('job.dueDate')}: <b>{fmtDate(ro.due_date, lang)}</b> {state === 'overdue' && <Badge color="red">{t('job.state.overdue')}</Badge>}</div>}
          <div className="field" style={{ marginTop: 6 }}>
            <label htmlFor="fp-no">{t('job.fakturNo')}</label>
            <BlurInput id="fp-no" value={ro.faktur_pajak_number || ''} disabled={!canFaktur || !!ro.closed_at} placeholder="010.000-26.00000001"
              onCommit={(v) => run(() => supabase.rpc('set_faktur_pajak', { p_ro: ro.id, p_number: v.trim() }), t('job.fakturSaved'))} />
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
            options={[{ value: '', label: '—' }, ...staff.filter((s) => runsJobs(s) || s.id === ro.service_advisor_id).map((s) => ({ value: s.id, label: s.name }))]} />
        </div>
        <div>
          <div className="sectionlabel">{t('job.priority')}</div>
          <Select value={ro.priority} disabled={!canEdit || !!ro.closed_at} onChange={(e) => upd({ priority: e.target.value })} aria-label={t('job.priority')}
            options={PRIORITIES.map((p) => ({ value: p, label: t(`job.pri.${p}`) }))} />
        </div>
      </div>

      <div className="sectionlabel">{t('job.payment')}</div>
      <div className="row wrap" style={{ gap: 6 }}>
        {(invoiced || ro.payment_status) && <Badge color={invoiced ? STATE_COLOR[state] : PAYMENT_COLOR[ro.payment_status]}>{invoiced ? t(`job.state.${state}`) : t(`job.ps.${ro.payment_status}`)}</Badge>}
        <span className="small muted">{terms === 0 ? t('job.termsCash') : t('job.termsNet', { n: terms ?? 30 })}</span>
      </div>
    </section>
  )
}

export function TotalsCard({ job, settings, editable, canPay, canRefund, canFixPaid, canCredit, run, onPayment, onCredit, onFee, onDiscount }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [delPay, setDelPay] = React.useState(null)
  // Money actually received (payments minus refunds); credits are taken off, not refunded.
  const cashIn = job.payments.reduce((a, p) => a + (p.kind === 'refund' ? -1 : 1) * Number(p.amount), 0)
  const ro = job.ro
  // An issued invoice keeps the tax settings it was issued with.
  const tax = ro.order_status === 'invoice' && ro.shop_snapshot ? ro.shop_snapshot : settings
  const taxRate = tax?.pkp_status === 'non_pkp' ? 0 : Number(tax?.tax_rate ?? 11)
  const settingsForTax = tax
  const removeFee = (f) => run(() => supabase.from('ro_job_fees').delete().eq('id', f.id))
  const removeDisc = (d) => run(() => supabase.from('ro_job_discounts').delete().eq('id', d.id))
  const credits = job.appliedCredits.reduce((a, c) => a + Number(c.amount), 0)
  // The database blanks this job's money for people who don't handle money and don't work on it.
  if (ro.total === null || ro.total === undefined) {
    return (
      <section className="card side-card totals">
        <h2>{t('job.totals')}</h2>
        <div className="muted small" style={{ lineHeight: 1.55 }}>{t('job.moneyHidden')}</div>
      </section>
    )
  }
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
        {canPay && !ro.closed_at && (Number(ro.balance) > 0 || ro.order_status !== 'invoice' || (canRefund && cashIn > 0)) && <Button icon="plus" onClick={onPayment}>{t('job.payment')}</Button>}
        {canCredit && <Button icon="plus" onClick={onCredit}>{t('job.credit')}</Button>}
      </div>
      {job.payments.length > 0 && (
        <div className="paylist">
          {job.payments.map((p) => {
            const voided = job.voids.some((v) => v.voided_at >= p.created_at)
            const canDelete = canPay && p.source === 'manual' && !voided && (ro.order_status !== 'invoice' || canFixPaid)
            return (
              <div key={p.id} className="payrow">
                <div>
                  <b style={{ color: p.kind === 'refund' ? 'var(--red)' : undefined }}>{p.kind === 'refund' ? '-' : ''}{rp(p.amount)}</b>
                  <span className="muted small"> · {t(`job.pay.${p.method}`)} · {fmtDate(p.paid_at, lang, timezone)}</span>
                  {(p.reference || p.receipt_number) && <div className="muted small">{[sysText(p.reference, t), p.receipt_number && t('job.receiptX', { no: p.receipt_number })].filter(Boolean).join(' · ')}</div>}
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

// Files on a job: photos and documents (people who edit jobs) and transfer slips (people who record payments; only
// people who handle money see them). The database and file storage check both.
const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
export function AttachmentsCard({ job, canGeneral, canSlip, run }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const input = React.useRef(null)
  const [kind, setKind] = React.useState('general')
  const [busy, setBusy] = React.useState(false)
  const ro = job.ro
  const list = job.attachments || []
  // files on an invoiced job stay, unless the person can void invoices (migration 132)
  const { can } = useAuth()
  const locked = ro.order_status === 'invoice' && !can('void_invoices')
  const mayRemove = (a) => !locked && (a.kind === 'payment' ? canSlip : canGeneral)
  if (!list.length && !canGeneral && !canSlip) return null

  function pick(k) { setKind(k); input.current?.click() }
  async function upload(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!FILE_TYPES.includes(file.type)) return toast(t('job.fileType'), 'err')
    if (file.size > 10 * 1024 * 1024) return toast(t('job.fileTooBig'), 'err')
    const name = file.name.slice(-120)
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_')
    const path = `${kind === 'payment' ? 'payments' : 'jobs'}/${ro.id}/${Date.now()}-${safe}`
    setBusy(true)
    const up = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type, upsert: false })
    if (up.error) { setBusy(false); return toast(errorText(up.error, t), 'err') }
    const ok = await run(async () => {
      const res = await supabase.from('attachments').insert({ entity_type: 'repair_order', entity_id: ro.id, kind, file_path: path, file_name: name })
      if (res.error) await supabase.storage.from('attachments').remove([path])
      return res
    }, t('job.fileAdded', { name }))
    setBusy(false)
    return ok
  }
  async function open(a) {
    // The new tab is opened during the click (browsers block tabs opened later), then sent to the file's address.
    const win = window.open('', '_blank')
    const { data, error } = await supabase.storage.from('attachments').createSignedUrl(a.file_path, 300)
    if (error || !data?.signedUrl) { win?.close(); return toast(errorText(error || { message: 'not found' }, t), 'err') }
    if (win) { win.opener = null; win.location.href = data.signedUrl } else window.location.href = data.signedUrl
  }
  async function remove(a) {
    const yes = await confirm({ title: t('job.removeFile', { name: a.file_name }), text: t('job.removeFileText', { name: a.file_name }), yes: t('job.removeFileYes'), danger: true })
    if (!yes) return
    run(async () => {
      const res = await supabase.from('attachments').delete().eq('id', a.id).select('id')
      if (!res.error && res.data?.length) await supabase.storage.from('attachments').remove([a.file_path])
      return res
    }, t('job.fileRemoved', { name: a.file_name }))
  }
  return (
    <section className="card side-card">
      <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.files')}</div>
      {list.length === 0 ? <div className="muted small">{t('job.noFiles')}</div> : (
        <div className="paylist" style={{ marginTop: 0 }}>
          {list.map((a) => (
            <div key={a.id} className="payrow">
              <div style={{ minWidth: 0 }}>
                <button type="button" className="linkbtn" style={{ textAlign: 'left', overflowWrap: 'anywhere' }} onClick={() => open(a)} aria-label={t('job.openFile', { name: a.file_name })}>
                  <Icon name="paperclip" size={13} /> {a.file_name}
                </button>
                <div className="muted small">{a.kind === 'payment' && <><Badge color="green">{t('job.slip')}</Badge> </>}{fmtDate(a.created_at, lang, timezone)}</div>
              </div>
              {mayRemove(a) && <button type="button" className="xbtn" onClick={() => remove(a)} aria-label={t('job.removeFile', { name: a.file_name })}><Icon name="trash" size={13} /></button>}
            </div>
          ))}
        </div>
      )}
      {(canGeneral || canSlip) && (
        <div className="row wrap" style={{ gap: 12, marginTop: 8 }}>
          {canGeneral && <button type="button" className="linkbtn small" disabled={busy} onClick={() => pick('general')}>+ {t('job.addFile')}</button>}
          {canSlip && <button type="button" className="linkbtn small" disabled={busy} onClick={() => pick('payment')}>+ {t('job.addSlip')}</button>}
        </div>
      )}
      {canSlip && <div className="hint">{t('job.slipsHint')}</div>}
      <input ref={input} type="file" accept={FILE_TYPES.join(',')} style={{ display: 'none' }} onChange={upload} data-testid="file-input" />
      {confirmEl}
    </section>
  )
}
