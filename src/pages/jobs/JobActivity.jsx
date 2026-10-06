import React, { useEffect, useState } from 'react'
import { Badge, Empty } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDateTime, invoiceNo, num, rp } from '../../lib/format'
import { APPROVAL_COLOR } from '../../lib/jobs'
import { APPT_COLOR } from '../../lib/calendar'

const MONEY = ['price', 'cost', 'discount_amount', 'core_charge', 'flat_price', 'amount', 'value_money', 'total', 'max_amount']
const HIDE = ['id', 'ro_id', 'service_id', 'position', 'created_at', 'updated_at', 'service_total', 'service_discount', 'service_net', 'amount_calc',
  'parts_total', 'labor_total', 'other_total', 'service_fees_total', 'item_discount_total', 'service_discount_total', 'job_fees_total', 'job_discount_total',
  'subtotal', 'taxable_base', 'tax_total', 'paid_total', 'balance', 'payment_status', 'bill_to_snapshot', 'shop_snapshot', 'stock_deducted', 'completed_at', 'catalog_item_id']
const COSTS = ['cost']

// Everything that happened on this job, newest first: edits, approvals, payments, invoicing and voids.
export default function JobActivity({ job, cat, staff, showCost }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [people, setPeople] = useState({})
  const id = job.ro.id
  // Everyone who ever worked here, including people who have left, so their edits keep their names.
  useEffect(() => { supabase.from('profiles').select('id, name').then(({ data }) => setPeople(Object.fromEntries((data || []).map((p) => [p.id, p.name])))) }, [])
  const svcIds = job.services.map((s) => s.id)

  useEffect(() => {
    let live = true
    const ids = [id, ...svcIds, ...job.items.map((x) => x.id), ...job.fees.map((x) => x.id), ...job.discounts.map((x) => x.id),
      ...job.approvals.map((x) => x.id), ...job.payments.map((x) => x.id)]
    const itemIds = job.items.map((x) => x.id)
    Promise.all([
      supabase.from('activity_log').select('*').in('entity_id', ids).order('created_at', { ascending: false }).limit(300),
      // Removed services, fees and discounts no longer have an id to look up; their delete record names the job.
      supabase.from('activity_log').select('*').eq('action', 'delete').in('entity_type', ['ro_services', 'ro_job_fees', 'ro_job_discounts', 'payments', 'approvals'])
        .eq('changes->>ro_id', id).order('created_at', { ascending: false }).limit(100),
      svcIds.length ? supabase.from('activity_log').select('*').eq('action', 'delete').eq('entity_type', 'ro_service_items')
        .in('changes->>service_id', svcIds).order('created_at', { ascending: false }).limit(100) : { data: [] },
      // Parts taken from stock at invoicing (and put back by a void).
      itemIds.length ? supabase.from('stock_movements').select('*').in('ro_service_item_id', itemIds).order('created_at', { ascending: false }).limit(200) : { data: [] },
    ]).then(([a, b, c, d]) => {
      if (!live) return
      const err = a.error || b.error || c.error || d.error
      if (err) setError(errorText(err, t))
      const seen = new Set()
      const stock = (d.data || []).map((m) => ({ id: `sm-${m.id}`, entity_type: 'stock', action: 'stock', created_at: m.created_at, user_id: m.created_by, changes: m }))
      const all = [...(a.data || []), ...(b.data || []), ...(c.data || []), ...stock].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)))
      all.sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : String(y.id).localeCompare(String(x.id))))
      // Starting an inspection adds every checklist point at once: show that as one entry.
      const grouped = []
      for (const r of all) {
        const prev = grouped[grouped.length - 1]
        const isAdd = r.action === 'line_add' && r.changes?.table === 'ro_inspection_results'
        if (isAdd && prev?.action === 'line_add' && prev.changes?.table === 'ro_inspection_results' && prev.user_id === r.user_id
          && Math.abs(new Date(prev.created_at) - new Date(r.created_at)) < 5000) {
          prev.count = (prev.count || 1) + 1
          continue
        }
        grouped.push({ ...r })
      }
      setRows(grouped)
    })
    return () => { live = false }
  }, [job.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const who = (uid) => people[uid] || staff.find((p) => p.id === uid)?.name || t('cat.hist.system')
  const svcName = (sid) => job.services.find((s) => s.id === sid)?.name
  const value = (field, v) => {
    if (v == null || v === '') return '—'
    if (typeof v === 'boolean') return v ? t('cat.yes') : t('cat.no')
    if (MONEY.includes(field)) return rp(v)
    if (field === 'technician_id' || field === 'service_advisor_id') return staff.find((p) => p.id === v)?.name || '?'
    if (field === 'workflow_status') return t(`job.wf.${v}`)
    if (field === 'work_status' || field === 'inspection_status') return t(`job.work.${v}`)
    if (field === 'approval_status') return t(`job.appr.${v}`)
    if (field === 'priority') return t(`job.pri.${v}`)
    if (field === 'order_status') return v === 'invoice' ? t('job.invoice') : t('job.estimate')
    if (field === 'item_type') return t(`job.type.${v}`)
    if (field === 'invoice_number') return invoiceNo(v)
    if (field === 'archived_at' || field === 'closed_at' || field === 'invoiced_at') return fmtDateTime(v, lang, timezone)
    if (typeof v === 'number') return num(v, 2)
    if (Array.isArray(v)) return v.join(', ') || '—'
    return String(v)
  }
  const label = (field) => {
    const k = `job.f.${field}`
    const s = t(k)
    return s === k ? field : s
  }
  function changes(diff) {
    const list = Object.entries(diff || {}).filter(([k]) => !HIDE.includes(k) && (showCost || !COSTS.includes(k)))
    return list.map(([k, [a, b]]) => <div key={k} className="hist-change"><span className="muted">{label(k)}:</span> {value(k, a)} → <b>{value(k, b)}</b></div>)
  }

  // Concerns, inspections, inspection points and credits are logged on the job itself (migration 119).
  function describeLine(r) {
    const row = r.changes?.row || {}
    const diff = r.changes?.diff || {}
    const add = r.action === 'line_add'
    const remove = r.action === 'line_remove'
    switch (r.changes?.table) {
      case 'ro_concerns':
        if (add) return <div>{t('job.act.concernAdded')}: <b>{row.text}</b></div>
        if (remove) return <div>{t('job.act.concernRemoved')}: <b>{row.text}</b></div>
        if (diff.text) return <div>{t('job.act.concernChanged')}: {diff.text[0]} → <b>{diff.text[1]}</b></div>
        return Object.keys(diff).every((k) => k === 'position') ? <div className="muted">{t('job.act.concernsReordered')}</div> : null
      case 'ro_inspections': {
        const name = cat.checklists.find((c) => c.id === row.checklist_id)?.name || t('job.inspection')
        if (add) return <div>{t('job.act.inspStarted')}: <b>{name}</b></div>
        if (remove) return <div>{t('job.act.inspDeleted')}: <b>{name}</b></div>
        return <><div className="muted small">{name}</div>{changes(Object.fromEntries(Object.entries(diff).map(([k, v]) => [k === 'status' ? 'inspection_status' : k, v])))}</>
      }
      case 'ro_inspection_results': {
        if (add) return r.count > 1 ? <div>{t('job.act.pointsAdded', { n: r.count })}</div> : <div>{t('job.act.pointAdded')}: <b>{row.item_name}</b></div>
        if (remove) return <div>{t('job.act.pointRemoved')}: <b>{row.item_name}</b></div>
        const parts = []
        if (diff.color) parts.push(<span key="c">{diff.color[0] ? t(`cat.flag.${diff.color[0]}`) : '—'} → <b>{diff.color[1] ? t(`cat.flag.${diff.color[1]}`) : '—'}</b></span>)
        if (diff.note) parts.push(<span key="n">{parts.length ? ' · ' : ''}{t('job.f.note')}: <b>{diff.note[1] || '—'}</b></span>)
        if (diff.concern_id && diff.concern_id[1]) parts.push(<span key="k">{parts.length ? ' · ' : ''}{t('job.isConcern')}</span>)
        return parts.length ? <div><b>{row.item_name}</b>: {parts}</div> : null
      }
      case 'appointments': {
        const when = (iso) => fmtDateTime(iso, lang, timezone)
        if (add) return <div>{t('job.act.apptBooked')}: <b>{when(row.start_time)}</b> <Badge color={APPT_COLOR[row.status]}>{t(`appt.st.${row.status}`)}</Badge></div>
        if (remove) return <div>{t('job.act.apptRemoved')}: <b>{when(row.start_time)}</b></div>
        const parts = []
        if (diff.start_time || diff.end_time) parts.push(<div key="t">{t('job.act.apptMoved')}: {when((diff.start_time || [row.start_time])[0])} → <b>{when(row.start_time)}</b></div>)
        if (diff.status) parts.push(<div key="s">{t('appt.status')}: {t(`appt.st.${diff.status[0]}`)} → <b>{t(`appt.st.${diff.status[1]}`)}</b></div>)
        if (diff.technician_id) parts.push(<div key="k">{t('board.technician')}: {value('technician_id', diff.technician_id[0])} → <b>{value('technician_id', diff.technician_id[1])}</b></div>)
        if (diff.notes || diff.title) parts.push(<div key="n" className="muted">{t('job.act.apptNotes')}</div>)
        return parts.length ? <><div className="muted small">{t('job.act.appt')}</div>{parts}</> : null
      }
      case 'deferred_dismissals':
        return add
          ? <div>{t('job.act.deferredDismissed')}: <b>{row.name}</b>{row.note && <span className="muted"> · {row.note}</span>}</div>
          : <div>{t('job.act.deferredRestored')}: <b>{row.name}</b></div>
      case 'credit_memos':
        return add
          ? <div>{t('job.act.creditApplied')}: <b>{rp(row.amount)}</b>{row.reason && <span className="muted"> · {row.reason}</span>}</div>
          : <div>{t('job.act.creditUnapplied')}: <b>{rp(row.amount)}</b></div>
      default:
        return null
    }
  }

  function describe(r) {
    const old = r.action === 'delete' ? r.changes : null
    switch (r.entity_type) {
      case 'stock': {
        const m = r.changes
        const item = job.items.find((x) => x.id === m.ro_service_item_id)
        const q = Number(m.qty_change)
        return <div>{item?.name || '?'}: <b style={{ color: q < 0 ? 'var(--red)' : 'var(--green)' }}>{q > 0 ? '+' : ''}{num(q, 2)}</b> <span className="muted">{q < 0 ? t('job.act.stockTaken') : t('job.act.stockBack')}</span></div>
      }
      case 'repair_orders':
        if (r.action === 'create') return <div>{t('job.act.created')}</div>
        if (r.action?.startsWith('line_')) return describeLine(r)
        if (r.changes?.order_status?.[1] === 'invoice') return <div><b>{t('job.act.invoiced', { no: invoiceNo(r.changes.invoice_number?.[1]) })}</b></div>
        if (r.changes?.order_status?.[1] === 'estimate') return <div><b style={{ color: 'var(--red)' }}>{t('job.act.voided', { no: invoiceNo(r.changes.invoice_number?.[0]) })}</b></div>
        if (r.changes?.closed_at && r.changes.closed_at[1]) return <div><b>{t('job.act.closed')}</b>{r.changes.close_reason?.[1] && <span className="muted"> · {r.changes.close_reason[1]}</span>}</div>
        if (r.changes?.closed_at && !r.changes.closed_at[1]) return <div><b>{t('job.act.reopened')}</b></div>
        return changes(r.changes)
      case 'ro_services': {
        const name = old?.name || svcName(r.entity_id) || '?'
        if (r.action === 'create') return <div>{t('job.act.serviceAdded')}: <b>{name}</b></div>
        if (r.action === 'delete') return <div>{t('job.act.serviceRemoved')}: <b>{name}</b></div>
        const diff = { ...(r.changes || {}) }
        delete diff.approval_status
        const list = changes(diff)
        return list.length ? <><div className="muted small">{name}</div>{list}</> : null
      }
      case 'ro_service_items': {
        const cur = job.items.find((x) => x.id === r.entity_id)
        const name = old?.name || cur?.name || '?'
        const where = svcName(old?.service_id || cur?.service_id)
        if (r.action === 'create') return <div>{t('job.act.lineAdded')}: <b>{name}</b>{cur && <span className="muted"> · {num(cur.qty, 2)} × {rp(cur.price)}</span>}{where && <span className="muted"> · {where}</span>}</div>
        if (r.action === 'delete') return <div>{t('job.act.lineRemoved')}: <b>{name}</b>{where && <span className="muted"> · {where}</span>}</div>
        const list = changes(r.changes)
        return list.length ? <><div className="muted small">{name}</div>{list}</> : null
      }
      case 'ro_job_fees':
      case 'ro_job_discounts': {
        const cur = (r.entity_type === 'ro_job_fees' ? job.fees : job.discounts).find((x) => x.id === r.entity_id)
        const name = old?.name || cur?.name || '?'
        const what = r.entity_type === 'ro_job_fees' ? t('job.fee') : t('job.discount')
        if (r.action === 'create') return <div>{what} {t('job.act.added')}: <b>{name}</b></div>
        if (r.action === 'delete') return <div>{what} {t('job.act.removed')}: <b>{name}</b></div>
        return <><div className="muted small">{name}</div>{changes(r.changes)}</>
      }
      case 'approvals': {
        const a = old || job.approvals.find((x) => x.id === r.entity_id)
        if (!a) return null
        if (r.action === 'delete') return <div className="muted">{t('job.act.approvalRemoved')}: {svcName(a.service_id) || '?'}</div>
        if (r.action === 'update') return changes(r.changes)
        return (
          <div>
            <Badge color={APPROVAL_COLOR[a.decision]}>{t(`job.appr.${a.decision}`)}</Badge> <b>{svcName(a.service_id) || '?'}</b>
            <span className="muted"> · {[a.approved_by_name, t(`job.via.${a.method}`)].filter(Boolean).join(' · ')}</span>
            {a.note && <div className="muted">{a.note}</div>}
          </div>
        )
      }
      case 'payments': {
        const p = old || job.payments.find((x) => x.id === r.entity_id)
        if (!p) return null
        if (r.action === 'delete') return <div className="muted">{t('job.act.paymentDeleted')}: {rp(p.amount)}</div>
        if (r.action === 'update') return changes(r.changes)
        return <div>{p.kind === 'refund' ? t('job.act.refund') : t('job.act.payment')}: <b>{rp(p.amount)}</b> <span className="muted">· {t(`job.pay.${p.method}`)}{p.reference ? ` · ${p.reference}` : ''}</span></div>
      }
      case 'credit_memos':
        return null
      default:
        return null
    }
  }

  const items = (rows || []).map((r) => ({ r, body: describe(r) })).filter((x) => x.body)
  return (
    <section className="card">
      <h2>{t('job.tab.activity')}</h2>
      {job.voids.length > 0 && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          {job.voids.map((v) => <div key={v.id}>{t('job.voidLine', { no: v.invoice_no, date: fmtDateTime(v.voided_at, lang, timezone), reason: v.reason, who: who(v.voided_by) })}</div>)}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {!rows ? <div className="muted">{t('common.loading')}</div> : items.length === 0 ? <Empty icon="clock" title={t('cat.hist.none')} /> : (
        <ol className="hist">
          {items.map(({ r, body }) => (
            <li key={r.id}>
              <div className="hist-meta">{who(r.user_id)} · {fmtDateTime(r.created_at, lang, timezone)}</div>
              <div className="hist-body">{body}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
