import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Notice, Select, Textarea } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, num, parseDecimal, readAmount, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { APPROVAL_METHODS, PAY_METHODS, shopDateToTimestamp } from '../../lib/jobs'
import { discountState } from '../catalog/DiscountsTab'

// Record the company's decision (approve, defer, decline) for one or more services.
export function ApprovalModal({ open, onClose, job, preselect, run, busy }) {
  const { t } = useT()
  const [picked, setPicked] = useState([])
  const [decision, setDecision] = useState('approved')
  const [method, setMethod] = useState('phone')
  const [contact, setContact] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState(null)
  useEffect(() => {
    if (!open) return
    setPicked(preselect?.length ? preselect : job.services.filter((s) => s.approval_status === 'pending').map((s) => s.id))
    setDecision('approved'); setNote(''); setErr(null)
    const first = job.contacts.find((c) => c.can_approve) || null
    setContact(first ? first.id : ''); setName('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!picked.length) return setErr(t('job.pickServices'))
    const c = job.contacts.find((x) => x.id === contact)
    const who = c ? c.name : name.trim() || null
    if (method !== 'internal' && !who) return setErr(t('job.whoApproved'))
    const rows = picked.map((sid) => ({ ro_id: job.ro.id, service_id: sid, decision, method, contact_id: c ? c.id : null, approved_by_name: who, note: note.trim() || null }))
    const ok = await run(() => supabase.from('approvals').insert(rows), t('job.approvalSaved', { n: rows.length }))
    if (ok) onClose()
  }
  const approvers = [...job.contacts].sort((a, b) => Number(b.can_approve) - Number(a.can_approve))
  return (
    <Modal open={open} title={t('job.recordApproval')} onClose={onClose} wide
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} loading={busy}>{t('job.saveDecision')}</Button></>}>
      {err && <Notice kind="err" style={{ marginBottom: 10 }}>{err}</Notice>}
      <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.services')}</div>
      <div className="checklist">
        {job.services.map((s) => (
          <label key={s.id} className="checkrow">
            <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((xs) => (e.target.checked ? [...xs, s.id] : xs.filter((x) => x !== s.id)))} />
            <span>{s.name}</span>
            <span className="muted small">{t(`job.appr.${s.approval_status}`)} · {rp(s.service_net)}</span>
          </label>
        ))}
      </div>
      <div className="sectionlabel">{t('job.decision')}</div>
      <div className="seg" role="radiogroup" aria-label={t('job.decision')}>
        {['approved', 'deferred', 'declined', 'pending'].map((d) => (
          <button key={d} type="button" role="radio" aria-checked={decision === d} className={`seg-btn ${decision === d ? 'on' : ''} d-${d}`} onClick={() => setDecision(d)}>
            {t(`job.decide.${d}`)}
          </button>
        ))}
      </div>
      <div className="hint">{t(`job.decideHint.${decision}`)}</div>
      <div className="grid2" style={{ marginTop: 12 }}>
        <Select label={t('job.method')} value={method} onChange={(e) => setMethod(e.target.value)} options={APPROVAL_METHODS.map((m) => ({ value: m, label: t(`job.via.${m}`) }))} />
        <Select label={t('job.approvedBy')} value={contact} onChange={(e) => setContact(e.target.value)}
          options={[...approvers.map((c) => ({ value: c.id, label: `${c.name}${c.can_approve ? ` · ${t('job.canApprove')}` : ''}` })), { value: '', label: t('job.someoneElse') }]} />
        {!contact && <Input fieldClass="span2" label={t('job.approverName')} value={name} onChange={(e) => setName(e.target.value)} placeholder={method === 'internal' ? t('job.optional') : ''} />}
        <Textarea fieldClass="span2" label={t('job.note')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t('job.approvalNoteExample')} />
      </div>
    </Modal>
  )
}

// Turn the estimate into an invoice. The database refuses if any service is still undecided.
export function InvoiceModal({ open, onClose, job, settings, staff, run, busy, onDone }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const ro = job.ro
  const pending = job.services.filter((s) => s.approval_status === 'pending')
  const approved = job.services.filter((s) => s.approval_status === 'approved')
  const terms = job.customer?.payment_terms_days ?? settings?.default_payment_terms_days ?? 30
  const today = shopToday(timezone)
  const due = new Date(`${today}T00:00:00Z`)
  due.setUTCDate(due.getUTCDate() + Number(terms))
  // Denny, Oct 7: an invoice needs the km out and a technician on every approved service.
  const noKmOut = ro.odometer_out == null
  const kmBelow = !noKmOut && ro.odometer_in != null && Number(ro.odometer_out) < Number(ro.odometer_in)
  // A technician who has since been disabled doesn't count.
  const noTech = approved.filter((s) => !s.technician_id || (staff?.length > 0 && !staff.some((p) => p.id === s.technician_id)))
  const blocked = pending.length > 0 || approved.length === 0 || noKmOut || kmBelow || noTech.length > 0
  async function go() {
    let no = null
    const ok = await run(async () => {
      const r = await supabase.rpc('convert_to_invoice', { p_ro: ro.id })
      no = r.data
      return r
    })
    if (ok) { onClose(); onDone?.(no) }
  }
  return (
    <Modal open={open} title={t('job.createInvoice')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={go} loading={busy} disabled={blocked}>{t('job.createInvoiceYes')}</Button></>}>
      {pending.length > 0 && <Notice kind="warn" style={{ marginBottom: 10 }}>{t('job.stillPending', { n: pending.length, names: pending.map((s) => s.name).join(', ') })}</Notice>}
      {pending.length === 0 && approved.length === 0 && <Notice kind="warn" style={{ marginBottom: 10 }}>{t('job.noneApproved')}</Notice>}
      {noKmOut && <Notice kind="warn" style={{ marginBottom: 10 }}>{t('job.needKmOut')}</Notice>}
      {kmBelow && <Notice kind="warn" style={{ marginBottom: 10 }}>{t('job.kmOutBelow')}</Notice>}
      {noTech.length > 0 && <Notice kind="warn" style={{ marginBottom: 10 }}>{t('job.needTech', { names: noTech.map((s) => s.name).join(', ') })}</Notice>}
      <div className="kvlist">
        <div><span>{t('job.billTo')}</span><b>{job.customer?.legal_name || job.customer?.display_name}</b></div>
        <div><span>{t('job.approvedServices')}</span><b>{approved.length}</b></div>
        <div><span>{t('job.total')}</span><b>{rp(ro.total)}</b></div>
        <div><span>{t('job.dueDate')}</span><b>{fmtDate(due.toISOString().slice(0, 10), lang)} ({t('job.netDays', { n: terms })})</b></div>
      </div>
      <div className="hint">{t('job.invoiceHint')}</div>
    </Modal>
  )
}

// A payment (or, for Owners and Admins on an invoice, a refund).
export function PaymentModal({ open, onClose, job, canRefund, run, busy }) {
  const { t } = useT()
  const { timezone } = useShop()
  const ro = job.ro
  const [f, setF] = useState({})
  const [errors, setErrors] = useState({})
  useEffect(() => {
    if (!open) return
    setF({ kind: 'payment', amount: Number(ro.balance) > 0 ? num(ro.balance) : '', method: 'transfer', date: shopToday(timezone), reference: '', receipt: '' })
    setErrors({})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const isInvoice = ro.order_status === 'invoice'
  // Only money actually received can be refunded (credits are taken off instead).
  const cash = job.payments.reduce((a, p) => a + (p.kind === 'refund' ? -1 : 1) * Number(p.amount), 0)
  async function save() {
    const e = {}
    const amount = readAmount(f.amount)
    if (!amount || Number.isNaN(amount)) e.amount = t('job.amountRule')
    else if (f.kind === 'payment' && isInvoice && amount > Number(ro.balance)) e.amount = t('job.overBalance', { amount: rp(ro.balance) })
    else if (f.kind === 'refund' && amount > cash) e.amount = t('job.overPaid', { amount: rp(cash) })
    if (!f.date) e.date = t('settings.required')
    setErrors(e)
    if (Object.keys(e).length) return
    const ok = await run(() => supabase.from('payments').insert({
      ro_id: ro.id, kind: f.kind, method: f.method, amount, paid_at: shopDateToTimestamp(f.date, timezone),
      reference: f.reference.trim() || null, receipt_number: f.receipt.trim() || null,
    }), f.kind === 'refund' ? t('job.refundSaved', { amount: rp(amount) }) : t('job.paymentSaved', { amount: rp(amount) }))
    if (ok) onClose()
  }
  return (
    <Modal open={open} title={f.kind === 'refund' ? t('job.recordRefund') : t('job.recordPayment')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button></>}>
      {!isInvoice && f.kind === 'payment' && <Notice kind="info" style={{ marginBottom: 10 }}>{t('job.depositNote')}</Notice>}
      <div className="grid2">
        {canRefund && cash > 0 && (
          <Select fieldClass="span2" label={t('job.kind')} value={f.kind} onChange={set('kind')}
            options={[{ value: 'payment', label: t('job.kind.payment') }, { value: 'refund', label: t('job.kind.refund') }]} />
        )}
        <Input label={t('cat.amount')} value={f.amount ?? ''} onChange={set('amount')} inputMode="numeric" prefix="Rp" error={errors.amount} autoFocus
          hint={isInvoice && f.kind === 'payment' ? t('job.balanceIs', { amount: rp(ro.balance) }) : null} />
        <Select label={t('job.payMethod')} value={f.method} onChange={set('method')} options={PAY_METHODS.map((m) => ({ value: m, label: t(`job.pay.${m}`) }))} />
        <Input type="date" label={t('job.payDate')} value={f.date ?? ''} onChange={set('date')} error={errors.date} max={shopToday(timezone)} />
        <Input label={t('job.reference')} value={f.reference ?? ''} onChange={set('reference')} placeholder={t('job.referenceExample')} />
        <Input fieldClass="span2" label={t('job.receiptNo')} value={f.receipt ?? ''} onChange={set('receipt')} />
      </div>
    </Modal>
  )
}

// Apply the company's unused credits to this job, take them off again, or issue a new credit.
export function CreditModal({ open, onClose, job, canApply, canIssue, canUnapplyInvoiced, run, busy }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const ro = job.ro
  const [amounts, setAmounts] = useState({})
  const [issue, setIssue] = useState({ amount: '', reason: '' })
  const [errors, setErrors] = useState({})
  useEffect(() => { if (open) { setAmounts({}); setIssue({ amount: '', reason: '' }); setErrors({}) } }, [open])
  const open_ = Math.max(0, Number(ro.balance))
  const closed = !!ro.closed_at

  async function apply(c) {
    const typed = amounts[c.id]
    const amount = typed ? readAmount(typed) : null
    if (typed && (!amount || Number.isNaN(amount))) return setErrors({ [c.id]: t('job.amountRule') })
    const ok = await run(() => supabase.rpc('apply_credit', { p_credit: c.id, p_ro: ro.id, p_amount: amount }), t('job.creditApplied'))
    if (ok) { setAmounts((x) => ({ ...x, [c.id]: '' })); setErrors({}) }
  }
  async function issueCredit() {
    const amount = readAmount(issue.amount)
    const e = {}
    if (!amount || Number.isNaN(amount)) e.issue = t('job.amountRule')
    if (!issue.reason.trim()) e.reason = t('settings.required')
    setErrors(e)
    if (Object.keys(e).length) return
    const ok = await run(() => supabase.from('credit_memos').insert({ customer_id: ro.customer_id, amount, reason: issue.reason.trim() }), t('job.creditIssued', { amount: rp(amount) }))
    if (ok) setIssue({ amount: '', reason: '' })
  }
  return (
    <Modal open={open} title={t('job.credits')} onClose={onClose} wide footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.appliedHere')}</div>
      {job.appliedCredits.length === 0 ? <div className="muted small">{t('job.noAppliedCredits')}</div> : (
        <div className="checklist">
          {job.appliedCredits.map((c) => (
            <div key={c.id} className="checkrow">
              <span>{c.reason || t('job.credit')}</span>
              <span className="muted small">{fmtDate(c.applied_at, lang, timezone)}</span>
              <b>{rp(c.amount)}</b>
              {canApply && (ro.order_status !== 'invoice' || canUnapplyInvoiced) && (
                <Button size="sm" onClick={() => run(() => supabase.rpc('unapply_credit', { p_credit: c.id }), t('job.creditUnapplied'))} loading={busy}>{t('job.unapply')}</Button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="sectionlabel">{t('job.availableCredits')}</div>
      {job.availableCredits.length === 0 ? <div className="muted small">{t('job.noAvailableCredits')}</div> : (
        <div className="checklist">
          {job.availableCredits.map((c) => (
            <div key={c.id} className="checkrow" style={{ flexWrap: 'wrap' }}>
              <span>{c.reason || t('job.credit')}</span>
              <b>{rp(c.amount)}</b>
              {canApply && !closed && (
                <>
                  <input className={`input cell num ${errors[c.id] ? 'invalid' : ''}`} style={{ width: 120 }} placeholder={num(Math.min(Number(c.amount), open_))}
                    value={amounts[c.id] || ''} onChange={(e) => setAmounts((x) => ({ ...x, [c.id]: e.target.value }))} aria-label={t('job.applyAmount')} />
                  <Button size="sm" variant="primary" onClick={() => apply(c)} loading={busy} disabled={open_ <= 0 && !amounts[c.id]}>{t('job.apply')}</Button>
                </>
              )}
              {errors[c.id] && <div className="error" style={{ flexBasis: '100%' }}>{errors[c.id]}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="hint">{t('job.creditHint', { amount: rp(open_) })}</div>
      {canIssue && (
        <>
          <div className="sectionlabel">{t('job.issueCredit')}</div>
          <div className="grid2">
            <Input label={t('cat.amount')} value={issue.amount} onChange={(e) => setIssue((x) => ({ ...x, amount: e.target.value }))} inputMode="numeric" prefix="Rp" error={errors.issue} />
            <Input label={t('job.reason')} value={issue.reason} onChange={(e) => setIssue((x) => ({ ...x, reason: e.target.value }))} error={errors.reason} placeholder={t('job.creditReasonExample')} />
          </div>
          <div className="row" style={{ marginTop: 8 }}><div className="spacer" /><Button onClick={issueCredit} loading={busy}>{t('job.issueCreditYes')}</Button></div>
          <div className="hint">{t('job.issueHint', { name: job.customer?.display_name })}</div>
        </>
      )}
    </Modal>
  )
}

// A short reason is required for closing a job without invoice and for voiding an invoice.
export function ReasonModal({ open, onClose, title, text, label, confirm, danger, onConfirm, busy }) {
  const { t } = useT()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState(null)
  useEffect(() => { if (open) { setReason(''); setErr(null) } }, [open])
  return (
    <Modal open={open} title={title} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant={danger ? 'danger' : 'primary'} className={danger ? 'solid' : ''} loading={busy}
          onClick={() => (reason.trim() ? onConfirm(reason.trim()) : setErr(t('settings.required')))}>{confirm}</Button></>}>
      <p style={{ marginTop: 0, lineHeight: 1.55 }}>{text}</p>
      <Textarea label={label} value={reason} onChange={(e) => { setReason(e.target.value); setErr(null) }} rows={2} error={err} autoFocus />
    </Modal>
  )
}

// A job fee: one from the catalog (fixed or percent) or typed in.
export function FeeModal({ open, onClose, job, cat, run, busy }) {
  const { t } = useT()
  const [pick, setPick] = useState('')
  const [f, setF] = useState({ name: '', kind: 'fixed', value: '', taxable: false })
  const [err, setErr] = useState({})
  useEffect(() => { if (open) { setPick(''); setF({ name: '', kind: 'fixed', value: '', taxable: false }); setErr({}) } }, [open])
  const fees = cat.items.filter((x) => x.item_type === 'fee' && x.active)
  function choose(id) {
    setPick(id)
    const fee = cat.itemById[id]
    if (fee) setF({ name: fee.name, kind: fee.fee_kind || 'fixed', value: fee.fee_kind === 'percent' ? String(Number(fee.fee_value)).replace('.', ',') : num(fee.fee_value ?? fee.price), taxable: fee.taxable })
  }
  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    const value = f.kind === 'percent' ? parseDecimal(f.value) : readAmount(f.value)
    if (value === null || Number.isNaN(value) || value < 0 || (f.kind === 'percent' && value > 100)) e.value = f.kind === 'percent' ? t('settings.max100') : t('settings.badAmount')
    setErr(e)
    if (Object.keys(e).length) return
    const ok = await run(() => supabase.from('ro_job_fees').insert({ ro_id: job.ro.id, name: f.name.trim(), kind: f.kind, value, taxable: f.taxable }), t('job.feeAdded'))
    if (ok) onClose()
  }
  return (
    <Modal open={open} title={t('job.addFee')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} loading={busy}>{t('job.add')}</Button></>}>
      <div className="grid2">
        <Select fieldClass="span2" label={t('job.fromCatalog')} value={pick} onChange={(e) => choose(e.target.value)}
          options={[{ value: '', label: t('job.customFee') }, ...fees.map((x) => ({ value: x.id, label: `${x.name} · ${x.fee_kind === 'percent' ? `${num(x.fee_value, 2)}%` : rp(x.fee_value ?? x.price)}` }))]} />
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} error={err.name} />
        <Select label={t('cat.feeKind')} value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value, value: '' }))}
          options={[{ value: 'fixed', label: t('cat.feeKind.fixed') }, { value: 'percent', label: t('cat.feeKind.percent') }]} />
        <Input label={f.kind === 'percent' ? t('cat.percent') : t('cat.amount')} value={f.value} onChange={(e) => setF((x) => ({ ...x, value: e.target.value }))}
          inputMode="decimal" prefix={f.kind === 'percent' ? null : 'Rp'} suffix={f.kind === 'percent' ? '%' : null} error={err.value}
          hint={f.kind === 'percent' ? t('cat.percentFeeHint') : null} />
        <label className="checkrow span2" style={{ border: 'none', padding: 0 }}>
          <input type="checkbox" checked={f.taxable} onChange={(e) => setF((x) => ({ ...x, taxable: e.target.checked }))} /> <span>{t('job.taxableFee')}</span>
        </label>
      </div>
    </Modal>
  )
}

// A job-level discount: one from the catalog or typed in.
export function DiscountModal({ open, onClose, job, cat, run, busy }) {
  const { t } = useT()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [pick, setPick] = useState('')
  const [f, setF] = useState({ name: '', kind: 'percent', value: '', max: '' })
  const [err, setErr] = useState({})
  useEffect(() => { if (open) { setPick(''); setF({ name: '', kind: 'percent', value: '', max: '' }); setErr({}) } }, [open])
  const list = cat.discounts.filter((d) => d.level === 'job' && discountState(d, today) === 'running')
  function choose(id) {
    setPick(id)
    const d = cat.discounts.find((x) => x.id === id)
    if (d) setF({ name: d.name, kind: d.kind, value: d.kind === 'percent' ? String(Number(d.value)).replace('.', ',') : num(d.value), max: d.max_amount == null ? '' : num(d.max_amount) })
  }
  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    const value = f.kind === 'percent' ? parseDecimal(f.value) : readAmount(f.value)
    if (value === null || Number.isNaN(value) || value <= 0 || (f.kind === 'percent' && value > 100)) e.value = f.kind === 'percent' ? t('cat.percentRule') : t('settings.badAmount')
    const max = f.kind === 'percent' && f.max.trim() ? readAmount(f.max) : null
    if (Number.isNaN(max)) e.max = t('settings.badAmount')
    setErr(e)
    if (Object.keys(e).length) return
    const ok = await run(() => supabase.from('ro_job_discounts').insert({ ro_id: job.ro.id, discount_id: pick || null, name: f.name.trim(), kind: f.kind, value, max_amount: max }), t('job.discountAdded'))
    if (ok) onClose()
  }
  return (
    <Modal open={open} title={t('job.addDiscount')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} loading={busy}>{t('job.add')}</Button></>}>
      <div className="grid2">
        <Select fieldClass="span2" label={t('job.fromCatalog')} value={pick} onChange={(e) => choose(e.target.value)}
          options={[{ value: '', label: t('job.customDiscount') }, ...list.map((d) => ({ value: d.id, label: d.name }))]} />
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} error={err.name} />
        <Select label={t('cat.discountKind')} value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value, value: '', max: '' }))}
          options={[{ value: 'percent', label: t('cat.kind.percent') }, { value: 'amount', label: t('cat.kind.amount') }]} />
        <Input label={f.kind === 'percent' ? t('cat.percent') : t('cat.amount')} value={f.value} onChange={(e) => setF((x) => ({ ...x, value: e.target.value }))}
          inputMode="decimal" prefix={f.kind === 'percent' ? null : 'Rp'} suffix={f.kind === 'percent' ? '%' : null} error={err.value} />
        {f.kind === 'percent' && <Input fieldClass="span2" label={t('cat.maxDiscountOptional')} value={f.max} onChange={(e) => setF((x) => ({ ...x, max: e.target.value }))} inputMode="numeric" prefix="Rp" error={err.max} />}
      </div>
    </Modal>
  )
}

// Issue a company credit from the customer panel (Owners and Admins: issue_credits).
export function IssueCreditModal({ open, customer, onClose, onDone }) {
  const { t } = useT()
  const [f, setF] = useState({ amount: '', reason: '' })
  const [err, setErr] = useState({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setF({ amount: '', reason: '' }); setErr({}) } }, [open])
  async function save() {
    const amount = readAmount(f.amount)
    const e = {}
    if (!amount || Number.isNaN(amount)) e.amount = t('job.amountRule')
    if (!f.reason.trim()) e.reason = t('settings.required')
    setErr(e)
    if (Object.keys(e).length) return
    setBusy(true)
    const { error } = await supabase.from('credit_memos').insert({ customer_id: customer.id, amount, reason: f.reason.trim() })
    setBusy(false)
    if (error) return setErr({ amount: errorText(error, t) })
    onDone()
  }
  return (
    <Modal open={open} title={t('job.issueCreditFor', { name: customer?.display_name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} loading={busy}>{t('job.issueCreditYes')}</Button></>}>
      <div className="grid2">
        <Input label={t('cat.amount')} value={f.amount} onChange={(e) => setF((x) => ({ ...x, amount: e.target.value }))} inputMode="numeric" prefix="Rp" error={err.amount} autoFocus />
        <Input label={t('job.reason')} value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))} error={err.reason} placeholder={t('job.creditReasonExample')} />
      </div>
      <div className="hint">{t('job.issueHint', { name: customer?.display_name })}</div>
    </Modal>
  )
}
