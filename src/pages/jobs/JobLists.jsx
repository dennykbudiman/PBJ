import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Empty, Notice, PageHead } from '../../components/ui'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, invoiceNo, jobNo, rp } from '../../lib/format'
import { shopToday, vehicleName } from '../../lib/customers'
import { STATE_COLOR, WORKFLOW_COLOR, jobState } from '../../lib/jobs'
import { selectAll } from '../customers/useCustomerData'
import { MoreMenu } from './common'
import { AddToJobModal, DismissModal } from './Deferred'

const JOB_COLS = 'id, job_number, invoice_number, customer_id, vehicle_id, order_status, workflow_status, priority, total, balance, paid_total, payment_status, invoiced_at, due_date, closed_at, archived_at, created_at'

function useNames() {
  const [names, setNames] = useState(null)
  useEffect(() => {
    Promise.all([
      selectAll(() => supabase.from('customers').select('id, display_name').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, plate, make, model, year, customer_id').order('id')),
    ]).then(([c, v]) => setNames({
      customer: Object.fromEntries((c.data || []).map((x) => [x.id, x])),
      vehicle: Object.fromEntries((v.data || []).map((x) => [x.id, x])),
    }))
  }, [])
  return names
}

function SearchBox({ value, onChange, placeholder }) {
  const { t } = useT()
  return (
    <div className="searchbox">
      <Icon name="search" size={14} color="var(--muted)" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button className="btn ghost sm" onClick={() => onChange('')} aria-label={t('common.clear')} style={{ padding: 2 }}><Icon name="x" size={13} /></button>}
    </div>
  )
}

const matches = (needle, ...parts) => !needle || parts.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').includes(needle)

// Customers → Repair orders / Invoices / Payments / Deferred.
export default function JobLists({ tab }) {
  if (tab === 'invoices') return <InvoicesList />
  if (tab === 'payments') return <PaymentsList />
  if (tab === 'deferred') return <DeferredList />
  return <RepairOrdersList />
}

function RepairOrdersList() {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { timezone } = useShop()
  const names = useNames()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('open')
  useEffect(() => {
    selectAll(() => supabase.from('repair_orders').select(JOB_COLS).eq('order_status', 'estimate').order('job_number', { ascending: false }).order('id'))
      .then((r) => { setRows(r.data || []); setError(r.error || null) })
  }, [])
  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => (rows || []).filter((j) => {
    if (status === 'open' && j.closed_at) return false
    if (status === 'closed' && !j.closed_at) return false
    const c = names?.customer[j.customer_id]
    const v = names?.vehicle[j.vehicle_id]
    return matches(needle, jobNo(j.job_number), c?.display_name, v?.plate, v && vehicleName(v))
  }), [rows, names, status, needle])
  const sum = shown.reduce((a, j) => a + Number(j.total), 0)
  return (
    <>
      <PageHead title={t('cust.area.repair-orders')} sub={t('jobs.roSub')}
        actions={can('edit_jobs') && <Button variant="primary" icon="plus" onClick={() => navigate('/jobs/new')}>{t('create.job')}</Button>} />
      <div className="filterbar">
        <SearchBox value={q} onChange={setQ} placeholder={t('jobs.search')} />
        <select className="select chipselect" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('cat.status')}>
          <option value="open">{t('jobs.f.open')}</option>
          <option value="closed">{t('jobs.f.closed')}</option>
          <option value="all">{t('cat.statusAll')}</option>
        </select>
      </div>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!rows || !names ? <div className="muted">{t('common.loading')}</div> : shown.length === 0 ? (
        <div className="card"><Empty icon="wrench" title={rows.length ? t('cust.noMatch') : t('jobs.noEstimates')}>{rows.length ? t('cust.noMatchText') : t('jobs.noEstimatesText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr><th>{t('jobs.col.job')}</th><th>{t('job.company')}</th><th>{t('job.vehicle')}</th><th className="wide-only">{t('jobs.col.created')}</th><th>{t('job.workflow')}</th><th className="num">{t('job.total')}</th></tr></thead>
            <tbody>
              {shown.map((j) => {
                const v = names.vehicle[j.vehicle_id]
                return (
                  <tr key={j.id} className="click" onClick={() => navigate(`/jobs/${j.id}`)}>
                    <td><Link className="rowlink" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>#{jobNo(j.job_number)}</Link></td>
                    <td>{names.customer[j.customer_id]?.display_name || '—'}</td>
                    <td><b>{v?.plate}</b> <span className="muted small">{v ? vehicleName(v) : ''}</span></td>
                    <td className="wide-only muted">{fmtDate(j.created_at, lang, timezone)}</td>
                    <td>{j.closed_at ? <Badge color="gray">{t('job.closed')}</Badge> : <Badge color={WORKFLOW_COLOR[j.workflow_status]}>{t(`job.wf.${j.workflow_status}`)}</Badge>}</td>
                    <td className="num">{rp(j.total)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && shown.length > 0 && <div className="hint">{t('jobs.roTotal', { n: shown.length, amount: rp(sum) })}</div>}
    </>
  )
}

function InvoicesList() {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const names = useNames()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('open')
  useEffect(() => {
    selectAll(() => supabase.from('repair_orders').select(JOB_COLS).eq('order_status', 'invoice').order('invoice_number', { ascending: false }).order('id'))
      .then((r) => { setRows(r.data || []); setError(r.error || null) })
  }, [])
  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => (rows || []).filter((j) => {
    const st = jobState(j, today)
    if (status === 'open' && st === 'paid') return false
    if (status === 'overdue' && st !== 'overdue') return false
    if (status === 'paid' && st !== 'paid') return false
    const c = names?.customer[j.customer_id]
    const v = names?.vehicle[j.vehicle_id]
    return matches(needle, invoiceNo(j.invoice_number), jobNo(j.job_number), c?.display_name, v?.plate)
  }), [rows, names, status, needle, today])
  const outstanding = shown.reduce((a, j) => a + Math.max(0, Number(j.balance)), 0)
  const overdue = shown.filter((j) => jobState(j, today) === 'overdue').reduce((a, j) => a + Number(j.balance), 0)
  return (
    <>
      <PageHead title={t('cust.area.invoices')} sub={t('jobs.invSub')} />
      <div className="filterbar">
        <SearchBox value={q} onChange={setQ} placeholder={t('jobs.searchInv')} />
        <select className="select chipselect" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('cat.status')}>
          <option value="open">{t('jobs.f.unpaid')}</option>
          <option value="overdue">{t('job.state.overdue')}</option>
          <option value="paid">{t('job.state.paid')}</option>
          <option value="all">{t('cat.statusAll')}</option>
        </select>
      </div>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!rows || !names ? <div className="muted">{t('common.loading')}</div> : shown.length === 0 ? (
        <div className="card"><Empty icon="receipt" title={rows.length ? t('cust.noMatch') : t('jobs.noInvoices')}>{rows.length ? t('cust.noMatchText') : t('jobs.noInvoicesText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr><th>{t('jobs.col.invoice')}</th><th className="wide-only">{t('jobs.col.job')}</th><th>{t('job.company')}</th><th className="wide-only">{t('job.vehicle')}</th><th>{t('jobs.col.date')}</th><th>{t('job.dueDate')}</th><th className="num">{t('job.total')}</th><th className="num">{t('job.balance')}</th><th>{t('cat.status')}</th></tr></thead>
            <tbody>
              {shown.map((j) => {
                const st = jobState(j, today)
                return (
                  <tr key={j.id} className="click" onClick={() => navigate(`/jobs/${j.id}`)}>
                    <td><Link className="rowlink" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>{invoiceNo(j.invoice_number)}</Link></td>
                    <td className="wide-only muted">#{jobNo(j.job_number)}</td>
                    <td>{names.customer[j.customer_id]?.display_name || '—'}</td>
                    <td className="wide-only">{names.vehicle[j.vehicle_id]?.plate}</td>
                    <td className="muted">{fmtDate(j.invoiced_at, lang, timezone)}</td>
                    <td style={{ color: st === 'overdue' ? 'var(--red)' : undefined }}>{fmtDate(j.due_date, lang)}</td>
                    <td className="num">{rp(j.total)}</td>
                    <td className="num"><b>{rp(j.balance)}</b></td>
                    <td><Badge color={STATE_COLOR[st]}>{t(`job.state.${st}`)}</Badge></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && shown.length > 0 && <div className="hint">{t('jobs.invTotal', { n: shown.length, amount: rp(outstanding), overdue: rp(overdue) })}</div>}
    </>
  )
}

function PaymentsList() {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { timezone } = useShop()
  const names = useNames()
  const [rows, setRows] = useState(null)
  const [jobs, setJobs] = useState({})
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    Promise.all([
      selectAll(() => supabase.from('payments').select('*').order('paid_at', { ascending: false }).order('id')),
      selectAll(() => supabase.from('repair_orders').select('id, job_number, invoice_number, vehicle_id').order('id')),
      // Company credit paid back as money is money out too, so it is listed with the refunds.
      selectAll(() => supabase.from('credit_memos').select('id, customer_id, amount, refunded_at, refund_method, refund_reference').not('refunded_at', 'is', null).order('id')),
    ]).then(([p, j, cm]) => {
      const paidBack = (cm.data || []).map((c) => ({ id: `cm-${c.id}`, payback: true, ro_id: null, customer_id: c.customer_id, kind: 'refund', source: 'manual',
        method: c.refund_method, amount: c.amount, paid_at: c.refunded_at, reference: c.refund_reference, receipt_number: null }))
      setRows([...(p.data || []), ...paidBack].sort((a, b) => (a.paid_at < b.paid_at ? 1 : a.paid_at > b.paid_at ? -1 : 0)))
      setJobs(Object.fromEntries((j.data || []).map((x) => [x.id, x])))
      setError(p.error || j.error || cm.error || null)
    })
  }, [])
  const needle = q.trim().toLowerCase()
  const shown = (rows || []).filter((p) => {
    const j = jobs[p.ro_id]
    return matches(needle, names?.customer[p.customer_id]?.display_name, j && jobNo(j.job_number), j?.invoice_number && invoiceNo(j.invoice_number), p.reference, p.receipt_number)
  })
  // The automatic "moved to company credit" entry of a void isn't money given back.
  const sum = shown.filter((p) => p.source !== 'void_credit').reduce((a, p) => a + (p.kind === 'refund' ? -1 : 1) * Number(p.amount), 0)
  return (
    <>
      <PageHead title={t('cust.area.payments')} sub={t('jobs.paySub')} />
      <div className="filterbar"><SearchBox value={q} onChange={setQ} placeholder={t('jobs.searchPay')} /></div>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!rows || !names ? <div className="muted">{t('common.loading')}</div> : shown.length === 0 ? (
        <div className="card"><Empty icon="receipt" title={rows.length ? t('cust.noMatch') : t('jobs.noPayments')}>{rows.length ? t('cust.noMatchText') : t('jobs.noPaymentsText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr><th>{t('jobs.col.date')}</th><th>{t('job.company')}</th><th>{t('jobs.col.forJob')}</th><th>{t('job.payMethod')}</th><th className="wide-only">{t('job.reference')}</th><th className="num">{t('cat.amount')}</th></tr></thead>
            <tbody>
              {shown.map((p) => {
                const j = jobs[p.ro_id]
                const to = p.payback ? `/customers/${p.customer_id}` : `/jobs/${p.ro_id}`
                return (
                  <tr key={p.id} className="click" onClick={() => navigate(to)}>
                    <td className="muted">{fmtDate(p.paid_at, lang, timezone)}</td>
                    <td>{names.customer[p.customer_id]?.display_name || '—'}</td>
                    <td>{p.payback ? <Badge color="gray">{t('jobs.creditPaidBack')}</Badge> : <Link className="rowlink" to={to} onClick={(e) => e.stopPropagation()}>{j?.invoice_number ? invoiceNo(j.invoice_number) : j ? `#${jobNo(j.job_number)}` : '—'}</Link>}</td>
                    <td>{p.method ? t(`job.pay.${p.method}`) : '—'}{p.payback ? null : p.source === 'void_credit' ? <> <Badge color="gray">{t('jobs.movedToCredit')}</Badge></> : p.kind === 'refund' && <> <Badge color="red">{t('job.kind.refund')}</Badge></>}</td>
                    <td className="wide-only muted">{[p.reference, p.receipt_number].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="num" style={{ color: p.kind === 'refund' ? 'var(--red)' : undefined }}><b>{p.kind === 'refund' ? '-' : ''}{rp(p.amount)}</b></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows && shown.length > 0 && <div className="hint">{t('jobs.payTotal', { n: shown.length, amount: rp(sum) })}</div>}
    </>
  )
}

// Work the company put off: deferred services, to bring back on a later visit.
function DeferredList({ customerId, embedded }) {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { timezone } = useShop()
  const names = useNames()
  const [rows, setRows] = useState(null)
  const [jobs, setJobs] = useState({})
  const [gone, setGone] = useState({ carried: {}, dismissed: {} })
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [show, setShow] = useState('open')
  const [modal, setModal] = useState(null) // { kind: 'add' | 'dismiss', service }
  const [n, setN] = useState(0)
  const canEdit = can('edit_jobs')
  useEffect(() => {
    Promise.all([
      selectAll(() => supabase.from('ro_services').select('id, ro_id, name, approval_status, service_net, service_total, created_at').eq('approval_status', 'deferred').order('created_at', { ascending: false }).order('id')),
      selectAll(() => supabase.from('repair_orders').select('id, job_number, invoice_number, customer_id, vehicle_id, order_status, closed_at, invoiced_at').order('id')),
      selectAll(() => supabase.from('approvals').select('service_id, decided_at, decision').eq('decision', 'deferred').order('decided_at', { ascending: false }).order('id')),
      // Carried into a later job (migration 121) or dismissed: off the list.
      selectAll(() => supabase.from('ro_services').select('id, ro_id, carried_from').not('carried_from', 'is', null).order('id')),
      selectAll(() => supabase.from('deferred_dismissals').select('*').order('service_id')),
    ]).then(([s, j, a, c, d]) => {
      const when = {}
      for (const x of a.data || []) if (!when[x.service_id]) when[x.service_id] = x.decided_at
      setRows((s.data || []).map((x) => ({ ...x, deferred_at: when[x.id] || x.created_at })))
      setJobs(Object.fromEntries((j.data || []).map((x) => [x.id, x])))
      setGone({
        // Carried over while the copy's job wasn't closed without invoicing (migration 121).
        carried: Object.fromEntries((c.data || []).filter((x) => x.carried_from && j.data?.find((r) => r.id === x.ro_id && !r.closed_at)).map((x) => [x.carried_from, x.ro_id])),
        dismissed: Object.fromEntries((d.data || []).map((x) => [x.service_id, x])),
      })
      setError(s.error || j.error || a.error || c.error || d.error || null)
    })
  }, [n])
  const reload = () => setN((x) => x + 1)
  const needle = q.trim().toLowerCase()
  // Deferred on an estimate still open isn't waiting yet: it can be approved on that job.
  const stateOf = (s) => {
    const j = jobs[s.ro_id]
    if (gone.carried[s.id]) return 'carried'
    if (gone.dismissed[s.id]) return 'dismissed'
    return j && (j.order_status === 'invoice' || j.closed_at) ? 'open' : 'onjob'
  }
  const shown = (rows || []).filter((s) => {
    const j = jobs[s.ro_id]
    if (!j || (customerId && j.customer_id !== customerId)) return false
    // "Waiting" also lists work deferred on estimates still open (shown with a note, without actions).
    const st = stateOf(s)
    if (show !== 'all' && st !== show && !(show === 'open' && st === 'onjob')) return false
    return matches(needle, s.name, names?.customer[j.customer_id]?.display_name, names?.vehicle[j.vehicle_id]?.plate, jobNo(j.job_number))
  })
  async function restore(s) {
    const { error: err } = await supabase.from('deferred_dismissals').delete().eq('service_id', s.id)
    if (err) setError(err)
    reload()
  }
  const body = !rows || !names ? <div className="muted">{t('common.loading')}</div> : shown.length === 0 ? (
    embedded ? <Empty icon="clock" title={t('jobs.noDeferred')}>{t('jobs.noDeferredText')}</Empty>
      : <div className="card"><Empty icon="clock" title={rows.length ? t('cust.noMatch') : t('jobs.noDeferred')}>{t('jobs.noDeferredText')}</Empty></div>
  ) : (
    <div className="table" style={embedded ? { borderRadius: 10 } : undefined}>
      <table style={embedded ? { minWidth: 0 } : undefined}>
        <thead><tr><th>{t('jobs.col.service')}</th><th>{t('job.vehicle')}</th>{!embedded && <th>{t('job.company')}</th>}<th>{t('jobs.col.job')}</th><th className="wide-only">{t('jobs.col.deferredOn')}</th><th className="num">{t('cat.amount')}</th>{canEdit && <th aria-label={t('def.actions')} />}</tr></thead>
        <tbody>
          {shown.map((s) => {
            const j = jobs[s.ro_id]
            const st = stateOf(s)
            const into = gone.carried[s.id] && jobs[gone.carried[s.id]]
            return (
              <tr key={s.id} className="click" onClick={() => navigate(`/jobs/${s.ro_id}`)}>
                <td>
                  <b>{s.name}</b>
                  {st === 'carried' && <div className="small muted">{t('def.carriedInto')} {into ? <Link to={`/jobs/${into.id}`} onClick={(e) => e.stopPropagation()}>#{jobNo(into.job_number)}</Link> : '—'}</div>}
                  {st === 'onjob' && <div className="small muted">{t('def.onOpenJob')}</div>}
                  {st === 'dismissed' && <div className="small muted">{t('def.dismissedOn', { date: fmtDate(gone.dismissed[s.id].dismissed_at, lang, timezone) })}{gone.dismissed[s.id].note ? ` · ${gone.dismissed[s.id].note}` : ''}</div>}
                </td>
                <td>{names.vehicle[j.vehicle_id]?.plate}</td>
                {!embedded && <td>{names.customer[j.customer_id]?.display_name}</td>}
                <td><Link className="rowlink" to={`/jobs/${s.ro_id}`} onClick={(e) => e.stopPropagation()}>#{jobNo(j.job_number)}</Link></td>
                <td className="wide-only muted">{fmtDate(s.deferred_at, lang, timezone)}</td>
                <td className="num">{rp(s.service_total)}</td>
                {canEdit && (
                  <td className="num" onClick={(e) => e.stopPropagation()}>
                    {st === 'open' && <MoreMenu label={t('def.actionsFor', { name: s.name })} items={[
                      { label: t('def.addToJob'), icon: 'wrench', onClick: () => setModal({ kind: 'add', service: { ...s, job: j } }) },
                      { label: t('def.dismiss'), icon: 'x', onClick: () => setModal({ kind: 'dismiss', service: s }) },
                    ]} />}
                    {st === 'dismissed' && <button type="button" className="linkbtn small" onClick={() => restore(s)}>{t('def.restore')}</button>}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
  const filter = (
    <select className="select chipselect" value={show} onChange={(e) => setShow(e.target.value)} aria-label={t('cat.status')}>
      <option value="open">{t('def.f.open')}</option>
      <option value="carried">{t('def.f.carried')}</option>
      <option value="dismissed">{t('def.f.dismissed')}</option>
      <option value="all">{t('cat.statusAll')}</option>
    </select>
  )
  const modals = (
    <>
      <AddToJobModal open={modal?.kind === 'add'} service={modal?.service} onClose={() => setModal(null)} onDone={(ro) => { setModal(null); navigate(`/jobs/${ro.id}`) }} />
      <DismissModal open={modal?.kind === 'dismiss'} service={modal?.service} onClose={() => setModal(null)} onDone={() => { setModal(null); reload() }} />
    </>
  )
  if (embedded) return <>{error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}{rows && rows.length > 0 && <div className="filterbar">{filter}</div>}{body}{modals}</>
  return (
    <>
      <PageHead title={t('cust.area.deferred')} sub={t('jobs.defSub')} />
      <div className="filterbar"><SearchBox value={q} onChange={setQ} placeholder={t('jobs.searchDef')} />{filter}</div>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {body}
      {modals}
    </>
  )
}
export { DeferredList }

// A company's or a vehicle's jobs, newest first (customer and vehicle panels).
export function JobsFor({ customerId, vehicleId }) {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [rows, setRows] = useState(null)
  const [plates, setPlates] = useState({})
  useEffect(() => {
    selectAll(() => {
      const q = supabase.from('repair_orders').select(JOB_COLS)
      return (vehicleId ? q.eq('vehicle_id', vehicleId) : q.eq('customer_id', customerId)).order('created_at', { ascending: false }).order('id')
    }).then((r) => setRows(r.data || []))
    if (!vehicleId) {
      supabase.from('vehicles').select('id, plate').eq('customer_id', customerId).then(({ data }) => setPlates(Object.fromEntries((data || []).map((v) => [v.id, v.plate]))))
    }
  }, [customerId, vehicleId])
  if (!rows) return <div className="muted">{t('common.loading')}</div>
  if (!rows.length) return <Empty icon="wrench" title={t('jobs.noJobsYet')}>{t('jobs.noJobsYetText')}</Empty>
  return (
    <div className="table" style={{ borderRadius: 10 }}>
      <table style={{ minWidth: 0 }}>
        <thead><tr><th>{t('jobs.col.job')}</th>{!vehicleId && <th>{t('job.vehicle')}</th>}<th>{t('jobs.col.date')}</th><th className="num">{t('job.total')}</th><th>{t('cat.status')}</th></tr></thead>
        <tbody>
          {rows.map((j) => {
            const st = jobState(j, today)
            return (
              <tr key={j.id} className="click" onClick={() => navigate(`/jobs/${j.id}`)}>
                <td><Link className="rowlink" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>{j.invoice_number ? invoiceNo(j.invoice_number) : `#${jobNo(j.job_number)}`}</Link></td>
                {!vehicleId && <td>{plates[j.vehicle_id] || '—'}</td>}
                <td className="muted">{fmtDate(j.invoiced_at || j.created_at, lang, timezone)}</td>
                <td className="num">{rp(j.total)}</td>
                <td>{st === 'estimate' ? <Badge color={WORKFLOW_COLOR[j.workflow_status]}>{t(`job.wf.${j.workflow_status}`)}</Badge> : <Badge color={STATE_COLOR[st]}>{t(`job.state.${st}`)}</Badge>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// A vehicle's inspection findings across its jobs, newest first.
export function VehicleInspections({ vehicleId }) {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { timezone } = useShop()
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      const jobs = await supabase.from('repair_orders').select('id, job_number, created_at').eq('vehicle_id', vehicleId).order('created_at', { ascending: false })
      const ids = (jobs.data || []).map((j) => j.id)
      const ins = ids.length ? await supabase.from('ro_inspections').select('*').in('ro_id', ids).order('created_at', { ascending: false }) : { data: [] }
      const insIds = (ins.data || []).map((x) => x.id)
      const res = insIds.length ? await supabase.from('ro_inspection_results').select('*').in('inspection_id', insIds).order('id') : { data: [] }
      if (live) setData({ jobs: Object.fromEntries((jobs.data || []).map((j) => [j.id, j])), ins: ins.data || [], res: res.data || [] })
    })()
    return () => { live = false }
  }, [vehicleId])
  if (!data) return <div className="muted">{t('common.loading')}</div>
  if (!data.ins.length) return <Empty icon="clipboard" title={t('jobs.noVehicleInsp')}>{t('jobs.noVehicleInspText')}</Empty>
  return (
    <div className="lines">
      {data.ins.map((x) => {
        const j = data.jobs[x.ro_id]
        const res = data.res.filter((r) => r.inspection_id === x.id)
        const flagged = res.filter((r) => r.color === 'red' || r.color === 'yellow')
        return (
          <div key={x.id} className="line" style={{ flexDirection: 'column', alignItems: 'stretch', cursor: 'pointer' }} onClick={() => navigate(`/jobs/${x.ro_id}`)}>
            <div className="row" style={{ gap: 6 }}>
              <b>#{jobNo(j?.job_number)}</b><span className="muted small">{fmtDate(x.created_at, lang, timezone)}</span>
              <div className="spacer" />
              <Badge color="green">{res.filter((r) => r.color === 'green').length} {t('cat.flag.green')}</Badge>
              <Badge color="amber">{res.filter((r) => r.color === 'yellow').length} {t('cat.flag.yellow')}</Badge>
              <Badge color="red">{res.filter((r) => r.color === 'red').length} {t('cat.flag.red')}</Badge>
            </div>
            {flagged.map((r) => (
              <div key={r.id} className="small"><span className={`dot d-${r.color}`} /> <b>{r.item_name}</b>{r.note ? ` — ${r.note}` : ''}</div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
