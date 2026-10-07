import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Empty, Input, Modal, Notice, PageHead, Select, useConfirm } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, num, readAmount, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { RETURN_COLOR, RETURN_STEPS, lineAmount } from '../../lib/inventory'
import { MoreMenu, useRun } from '../jobs/common'
import { SearchBox } from '../catalog/common'
import { JobRef } from './bits'
import { ReturnModal } from './PoModals'

export const returnValue = (r) => lineAmount(r.return_cost, 0, r.qty, false, 0) + Number(r.return_tax || 0)

// Returns made together (one PO, one go) are one row here and move through the steps together.
function groupReturns(list) {
  const out = []
  const by = {}
  for (const r of list) {
    const key = r.batch_id || r.id
    if (!by[key]) { by[key] = { key, rows: [] }; out.push(by[key]) }
    by[key].rows.push(r)
  }
  for (const g of out) {
    g.first = g.rows[0]
    g.ids = g.rows.map((r) => r.id)
    g.value = g.rows.reduce((a, r) => a + returnValue(r), 0)
    g.refund = g.rows.reduce((a, r) => a + Number(r.refund_amount || 0), 0)
    g.qty = g.rows.reduce((a, r) => a + Number(r.qty), 0)
  }
  return out
}

// Inventory → Returns: parts going back to the supplier, from stock or from a job, until the money comes back.
export default function ReturnsTab({ data, reload, canEdit, showCost }) {
  const { t, lang } = useT()
  const { run } = useRun(reload)
  const [confirm, confirmEl] = useConfirm()
  const [q, setQ] = useState('')
  const [show, setShow] = useState('open')
  const [kind, setKind] = useState('')
  const [creating, setCreating] = useState(false)
  const [step, setStep] = useState(null) // { r, to }

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s/g, '')
    return groupReturns(data.returns).filter((g) => {
      const r = g.first
      if (show === 'open' && r.status === 'refunded') return false
      if (show !== 'open' && show !== 'all' && r.status !== show) return false
      if (kind && r.kind !== kind) return false
      if (!needle) return true
      const line = r.po_item_id && data.lineById[r.po_item_id]
      const po = line && data.poById[line.po_id]
      return [...g.rows.map((x) => x.item_name), data.supplierById[r.supplier_id]?.name, po?.po_number, r.credit_number, r.supplier_invoice_no, r.note]
        .filter(Boolean).join(' ').toLowerCase().replace(/\s/g, '').includes(needle)
    })
  }, [data, q, show, kind])

  const openValue = data.returns.filter((r) => r.status !== 'refunded').reduce((a, r) => a + returnValue(r), 0)
  const labelOf = (g) => (g.rows.length === 1 ? g.first.item_name : t('inv.ret.nParts', { n: g.rows.length }))
  const stepFor = (g, to) => setStep({ to, r: { ...g.first, item_name: labelOf(g), ids: g.ids, value: g.value, rows: g.rows } })

  async function remove(g) {
    const ok = await confirm({ title: t('inv.ret.deleteTitle', { name: labelOf(g) }), text: t('inv.ret.deleteText'), yes: t('common.delete'), danger: true })
    if (ok === true) run(() => supabase.from('returns').delete().in('id', g.ids), t('inv.ret.deleted'))
  }

  return (
    <>
      <PageHead title={t('inv.ret.title')} sub={t('inv.ret.sub')}
        actions={canEdit && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>{t('inv.ret.new')}</Button>} />
      {showCost && openValue > 0 && <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}><Badge color="amber">{t('inv.ret.openValue', { amount: rp(openValue) })}</Badge></div>}
      <div className="filterbar">
        <SearchBox value={q} onChange={setQ} placeholder={t('inv.ret.search')} />
        <select className="select chipselect" value={show} onChange={(e) => setShow(e.target.value)} aria-label={t('inv.show')}>
          <option value="open">{t('inv.ret.f.open')}</option>
          {RETURN_STEPS.map((s) => <option key={s} value={s}>{t(`inv.ret.st.${s}`)}</option>)}
          <option value="all">{t('inv.ret.f.all')}</option>
        </select>
        <select className="select chipselect" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('inv.ret.kind')}>
          <option value="">{t('inv.ret.k.all')}</option>
          <option value="inventory">{t('inv.ret.k.inventory')}</option>
          <option value="ro">{t('inv.ret.k.ro')}</option>
        </select>
      </div>
      {groups.length === 0 ? (
        <div className="card"><Empty icon="undo" title={data.returns.length ? t('inv.nothingFound') : t('inv.ret.noneTitle')}>{data.returns.length ? t('inv.nothingFoundText') : t('inv.ret.noneText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr>
              <th>{t('inv.col.parts')}</th><th>{t('inv.col.supplier')}</th><th className="wide-only">{t('inv.col.from')}</th><th className="num">{t('inv.col.qty')}</th>
              {showCost && <th className="num">{t('inv.col.value')}</th>}<th>{t('inv.col.status')}</th><th className="wide-only">{t('inv.ret.credit')}</th><th aria-label={t('inv.more')} />
            </tr></thead>
            <tbody>
              {groups.map((g) => {
                const r = g.first
                const line = r.po_item_id && data.lineById[r.po_item_id]
                const po = line && data.poById[line.po_id]
                const i = RETURN_STEPS.indexOf(r.status)
                const next = RETURN_STEPS[i + 1]
                const date = { marked: r.marked_at, shipped: r.shipped_at, delivered: r.delivered_at, refunded: r.refunded_at }[r.status]
                return (
                  <tr key={g.key}>
                    <td>
                      {g.rows.map((x) => <div key={x.id}><b>{x.item_name}</b> <span className="muted">× {num(x.qty, 2)}</span></div>)}
                      {r.note && <div className="muted small">{r.note}</div>}
                    </td>
                    <td>{data.supplierById[r.supplier_id]?.name || '—'}</td>
                    <td className="wide-only small">
                      <div>{r.kind === 'ro' ? <JobRef data={data} roId={r.ro_id} /> : t('inv.ret.k.inventory')}</div>
                      {po && <Link className="muted" to={`/inventory/purchase-orders/${po.id}`}>{t('inv.po.titleNo', { no: po.po_number })}</Link>}
                    </td>
                    <td className="num">{num(g.qty, 2)}</td>
                    {showCost && <td className="num nowrap">{rp(g.value)}{r.status === 'refunded' && g.refund > 0 && <div className="small" style={{ color: 'var(--green)' }}>{t('inv.ret.refundedAmount', { amount: rp(g.refund) })}</div>}</td>}
                    <td><Badge color={RETURN_COLOR[r.status]}>{t(`inv.ret.st.${r.status}`)}</Badge><div className="muted small">{fmtDate(date, lang)}</div></td>
                    <td className="wide-only small">{r.credit_number || <span className="muted">—</span>}</td>
                    <td className="num">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {canEdit && next && <Button size="sm" onClick={() => stepFor(g, next)}>{t(`inv.ret.to.${next}`)}</Button>}
                        <MoreMenu label={t('inv.ret.menu', { name: labelOf(g) })} items={[
                          canEdit && next && next !== 'refunded' && { label: t('inv.ret.to.refunded'), icon: 'dollar', onClick: () => stepFor(g, 'refunded') },
                          canEdit && r.status === 'marked' && { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => remove(g) },
                        ]} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('inv.ret.listHint')}</div>
      {confirmEl}
      <ReturnModal open={creating} onClose={() => setCreating(false)} data={data} showCost={showCost} onDone={() => { setCreating(false); run(async () => ({}), t('inv.ret.marked')) }} />
      <StepModal open={!!step} step={step} data={data} showCost={showCost} onClose={() => setStep(null)} onDone={(text) => { setStep(null); run(async () => ({}), text) }} />
    </>
  )
}

// Move a return (or a core) on: shipped, delivered, refunded. Refunded asks for the amount and credit note.
export function StepModal({ open, step, onClose, onDone, showCost, data, table = 'returns', statusField = 'status' }) {
  const { t } = useT()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const r = step?.r
  const to = step?.to
  const value = r ? (r.value ?? (table === 'returns' ? returnValue(r) : lineAmount(0, r.core_cost, r.qty, false, 0))) : 0
  useEffect(() => {
    if (!open || !r) return
    setF({ date: today, refund: value ? num(value) : '', credit: r.credit_number || '', supplier: r.supplier_id || '' })
    setErr({}); setFail(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const dateField = { shipped: 'shipped_at', delivered: 'delivered_at', refunded: 'refunded_at' }[to]
  // A core going back needs to know which supplier takes it.
  const needSupplier = table === 'cores' && r && !r.supplier_id && to !== 'damaged'
  async function save() {
    if (running.current) return
    const e = {}
    if (!f.date) e.date = t('inv.err.date')
    else if (f.date > today) e.date = t('inv.err.future')
    const refund = to === 'refunded' && showCost ? (f.refund.trim() === '' ? 0 : readAmount(f.refund)) : null
    if (refund != null && Number.isNaN(refund)) e.refund = t('inv.err.cost')
    if (needSupplier && !f.supplier) e.supplier = t('inv.err.supplier')
    setErr(e)
    if (Object.keys(e).length) return
    running.current = true; setBusy(true)
    const patch = { [statusField]: to }
    if (dateField) patch[dateField] = f.date
    if (needSupplier) patch.supplier_id = f.supplier
    if (to === 'refunded') { if (refund != null) patch.refund_amount = refund; patch.credit_number = f.credit.trim() || null }
    const ids = r.ids || [r.id]
    // Returns move as a batch in one database call, which also shares a refund across the batch's parts.
    const { error } = table === 'returns'
      ? await supabase.rpc('advance_returns', { p_ids: ids, p_status: to, p_date: dateField ? f.date : null, p_refund: refund, p_credit: to === 'refunded' ? f.credit.trim() || null : null })
      : await supabase.from(table).update(patch).in('id', ids)
    running.current = false; setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone(t(`inv.ret.toDone.${to}`, { name: r.item_name }))
  }
  if (!r) return null
  return (
    <Modal open={open} title={t(`inv.ret.toTitle.${to}`, { name: r.item_name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t(`inv.ret.to.${to}`)}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {needSupplier && (
        <Select label={t('inv.col.supplier')} value={f.supplier || ''} onChange={(e) => setF({ ...f, supplier: e.target.value })} error={err.supplier}
          options={[{ value: '', label: t('inv.order.chooseSupplier') }, ...(data?.suppliers || []).filter((s) => s.active !== false && s.type !== 'sublet').map((s) => ({ value: s.id, label: s.name }))]} />
      )}
      {dateField && <Input type="date" label={t(`inv.ret.date.${to}`)} value={f.date || ''} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} error={err.date} />}
      {to === 'refunded' && <>
        {showCost && <Input label={t('inv.ret.refund')} value={f.refund || ''} prefix="Rp" inputMode="numeric" onChange={(e) => setF({ ...f, refund: e.target.value })} error={err.refund} hint={t('inv.ret.refundHint', { amount: rp(value) })} />}
        <Input label={t('inv.ret.credit')} value={f.credit || ''} maxLength={100} onChange={(e) => setF({ ...f, credit: e.target.value })} placeholder={t('inv.ret.creditEx')} />
      </>}
      {to === 'shipped' && table === 'returns' && <div className="hint">{t('inv.ret.shipHint')}</div>}
      {to === 'marked' && <div className="hint">{t('inv.core.markHint')}</div>}
    </Modal>
  )
}
