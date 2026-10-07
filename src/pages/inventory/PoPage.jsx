import React, { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, Empty, Notice, useConfirm, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { fmtDate, fmtDateTime, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { LINE_COLOR, RETURN_COLOR, lineAmount, lineDue, lineState, openQty, owedQty, poTotals, stockState } from '../../lib/inventory'
import { BlurInput, MoreMenu, Picker, TotalRow, useRun } from '../jobs/common'
import { JobRef, PayBadge, PoBadge, Tick } from './bits'
import { CorrectReceivedModal, LineModal, PayModal, PoReturnModal, ReceiveModal } from './PoModals'
import { returnValue } from './ReturnsTab'

// One purchase order: its parts, deliveries, supplier invoice, payments and returns.
export default function PoPage({ id, data, reload, go, canEdit, showCost }) {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const toast = useToast()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const { run, busy } = useRun(reload)
  const [confirm, confirmEl] = useConfirm()
  const [sel, setSel] = useState(() => new Set())
  const [modal, setModal] = useState(null) // { kind: 'line' | 'receive' | 'pay' | 'return', ... }
  const po = data.poById[id]
  const lines = useMemo(() => data.linesByPo[id] || [], [data, id])

  if (!po) {
    return <Card><Empty icon="packages" title={t('inv.po.notFound')} action={<Link className="btn" to="/inventory/purchase-orders">{t('inv.po.back')}</Link>} /></Card>
  }

  const sup = data.supplierById[po.supplier_id]
  const tot = poTotals(po, lines)
  const cancelled = po.status === 'cancelled'
  const anyDelivered = lines.some((l) => Number(l.qty_delivered) > 0)
  const openLines = lines.filter((l) => openQty(l) > 0)
  const owedLines = lines.filter((l) => owedQty(l) > 0)
  const returnedOf = (l) => data.returns.filter((r) => r.po_item_id === l.id).reduce((a, r) => a + Number(r.qty), 0)
  // Received parts that can still go back to the supplier (returns are made for the whole PO at once).
  const returnable = lines.filter((l) => Number(l.qty_delivered) - returnedOf(l) > 0)
  const lineIds = new Set(lines.map((l) => l.id))
  const returns = data.returns.filter((r) => lineIds.has(r.po_item_id))
  const payments = data.payments.filter((p) => (p.po_item_ids || []).some((x) => lineIds.has(x)))
  const picked = lines.filter((l) => sel.has(l.id))
  const editable = canEdit && !cancelled
  // Parts are received once the PO has been ordered.
  const receivable = editable && po.status !== 'draft'
  const close = () => setModal(null)
  const done = (text) => { close(); setSel(new Set()); reload(); if (text) toast(text) }
  const upd = (patch) => run(() => supabase.from('purchase_orders').update(patch).eq('id', po.id))

  async function markOrdered() {
    if (!lines.length) return toast(t('inv.po.addFirst'), 'err')
    await run(() => supabase.from('purchase_orders').update({ status: 'ordered' }).eq('id', po.id), t('inv.po.orderedToast', { no: po.po_number }))
  }
  async function cancelPo() {
    const ok = await confirm({ title: t('inv.po.cancelTitle', { no: po.po_number }), text: anyDelivered ? t('inv.po.cancelRestText') : t('inv.po.cancelText'), yes: t('inv.po.cancelYes'), no: t('inv.keep'), danger: true })
    if (ok !== true) return
    // With deliveries the status follows the lines, so only what is still to come is cancelled.
    if (anyDelivered) run(() => supabase.rpc('mark_po_items_cancelled', { p_items: openLines.map((l) => l.id) }), t('inv.po.cancelledToast'))
    else run(() => supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', po.id), t('inv.po.cancelledToast'))
  }
  async function deletePo() {
    const ok = await confirm({ title: t('inv.po.deleteTitle', { no: po.po_number }), text: t('inv.po.deleteText'), yes: t('inv.po.deleteYes'), danger: true })
    if (ok !== true) return
    const { error } = await supabase.from('purchase_orders').delete().eq('id', po.id)
    if (error) return run(async () => ({ error }))
    toast(t('inv.po.deletedToast'))
    reload(); go('/inventory/purchase-orders')
  }
  async function cancelLines(ls) {
    const ok = await confirm({ title: t('inv.line.cancelTitle', { n: ls.length }), text: t('inv.line.cancelText'), yes: t('inv.line.cancelYes'), no: t('inv.keep'), danger: true })
    if (ok === true) { setSel(new Set()); run(() => supabase.rpc('mark_po_items_cancelled', { p_items: ls.map((l) => l.id) }), t('inv.line.cancelledToast')) }
  }
  async function deleteLine(l) {
    const ok = await confirm({ title: t('inv.line.deleteTitle', { name: l.name }), text: t('inv.line.deleteText'), yes: t('common.delete'), danger: true })
    if (ok === true) run(() => supabase.from('purchase_order_items').delete().eq('id', l.id))
  }
  async function undoPayment(p) {
    const ok = await confirm({ title: t('inv.pay.undoTitle'), text: t('inv.pay.undoText', { amount: rp(p.amount), date: fmtDate(p.paid_at, lang) }), yes: t('inv.pay.undoYes'), no: t('inv.keep'), danger: true })
    if (ok === true) run(() => supabase.rpc('undo_supplier_payment', { p_payment: p.id }), t('inv.pay.undone'))
  }

  const partOptions = data.items.filter((x) => x.active).map((x) => ({ key: x.id, item: x, search: `${x.name} ${x.code || ''} ${x.brand || ''}`.toLowerCase() }))
  const toggle = (lid, on) => setSel((s) => { const n = new Set(s); if (on) n.add(lid); else n.delete(lid); return n })
  const menu = [
    { label: t('inv.po.print'), icon: 'print', onClick: () => navigate(`/print/po/${po.id}`) },
    canEdit && ['draft', 'ordered', 'partially_delivered'].includes(po.status) && openLines.length > 0 && { label: anyDelivered ? t('inv.po.cancelRest') : t('inv.po.cancel'), icon: 'x', danger: true, onClick: cancelPo },
    canEdit && po.status === 'draft' && { label: t('inv.po.delete'), icon: 'trash', danger: true, onClick: deletePo },
  ]

  return (
    <div className="jobgrid">
      <div className="jobmain">
        <section className="card jobhead">
          <Link to="/inventory/purchase-orders" className="small plainlink"><Icon name="chevronLeft" size={13} /> {t('inv.po.back')}</Link>
          <div className="row wrap" style={{ gap: 10, alignItems: 'flex-start', marginTop: 6 }}>
            <div style={{ minWidth: 0, flex: '1 1 300px' }}>
              <h1 className="jobtitle">{t('inv.po.titleNo', { no: po.po_number })} <span className="muted">— {sup?.name || '—'}</span></h1>
              <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                <PoBadge status={po.status} />
                {showCost && anyDelivered && <PayBadge status={po.payment_status} />}
                <span className="small muted"><JobRef data={data} roId={po.ro_id} /></span>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              {canEdit && po.status === 'draft' && <Button variant="primary" icon="check" loading={busy} onClick={markOrdered}>{t('inv.po.markOrdered')}</Button>}
              {receivable && openLines.length > 0 && <Button variant="primary" icon="packages" onClick={() => setModal({ kind: 'receive', lines: openLines })}>{t('inv.po.receive')}</Button>}
              {canEdit && showCost && owedLines.length > 0 && <Button icon="wallet" onClick={() => setModal({ kind: 'pay', lines: owedLines })}>{t('inv.po.payDelivered')}</Button>}
              {canEdit && returnable.length > 0 && <Button icon="undo" onClick={() => setModal({ kind: 'return' })}>{t('inv.po.returnToSupplier')}</Button>}
              <MoreMenu label={t('inv.more')} items={menu} />
            </div>
          </div>
          {cancelled && <Notice kind="warn" style={{ marginTop: 12 }}>{t('inv.po.cancelledNotice')}</Notice>}
          {po.status === 'draft' && <Notice kind="info" style={{ marginTop: 12 }}>{t('inv.po.draftNotice')}</Notice>}
          {sup?.pinned_notes && <Notice kind="warn" style={{ marginTop: 12 }}>{sup.pinned_notes}</Notice>}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{t('inv.po.parts')}</h2>
            <div className="spacer" />
            {picked.length > 0 && canEdit && (
              <div className="row wrap bulkbar" style={{ gap: 6 }}>
                <span className="small muted">{t('inv.nSelected', { n: picked.length })}</span>
                {receivable && picked.some((l) => openQty(l) > 0) && <Button size="sm" onClick={() => setModal({ kind: 'receive', lines: picked.filter((l) => openQty(l) > 0) })}>{t('inv.po.receive')}</Button>}
                {picked.some((l) => openQty(l) > 0) && <Button size="sm" onClick={() => cancelLines(picked.filter((l) => openQty(l) > 0))}>{t('inv.line.cancel')}</Button>}
                {showCost && picked.some((l) => owedQty(l) > 0) && <Button size="sm" onClick={() => setModal({ kind: 'pay', lines: picked.filter((l) => owedQty(l) > 0) })}>{t('inv.line.pay')}</Button>}
              </div>
            )}
          </div>
          {lines.length === 0 ? <div className="muted small" style={{ marginBottom: 10 }}>{t('inv.po.noLines')}</div> : (
            <div className="table compact flush">
              <table>
                <thead><tr>
                  {canEdit && <th style={{ width: 28 }}><Tick checked={lines.length > 0 && lines.every((l) => sel.has(l.id))} onChange={(v) => setSel(v ? new Set(lines.map((l) => l.id)) : new Set())} label={t('inv.selectAll')} /></th>}
                  <th>{t('inv.col.part')}</th><th className="num">{t('inv.col.ordered')}</th><th className="num">{t('inv.col.received')}</th><th>{t('inv.col.status')}</th>
                  {showCost && <th className="num wide-only">{t('inv.col.unitCost')}</th>}{showCost && <th className="num">{t('inv.col.amount')}</th>}
                  <th className="wide-only">{t('inv.col.invoice')}</th><th aria-label={t('inv.more')} />
                </tr></thead>
                <tbody>
                  {lines.map((l) => {
                    const state = lineState(l)
                    const ret = returnedOf(l)
                    const due = lineDue(l, po, sup)
                    const item = l.catalog_item_id && data.itemById[l.catalog_item_id]
                    const st = item?.track_inventory ? stockState(item, data.stockById[item.id]) : null
                    const q = Math.max(Number(l.qty_ordered) - Number(l.qty_cancelled), 0)
                    return (
                      <tr key={l.id} className={state === 'cancelled' ? 'dim' : ''}>
                        {canEdit && <td><Tick checked={sel.has(l.id)} onChange={(v) => toggle(l.id, v)} label={t('inv.order.pick', { name: l.name })} /></td>}
                        <td>
                          <b>{item ? <Link className="plainlink" to={`/catalog/parts/${item.id}`}>{l.name}</Link> : l.name}</b>
                          <div className="muted small">
                            {[l.part_number, l.ro_service_item_id ? t('inv.line.forJob') : null, st ? t('inv.line.onHand', { n: num(st.onHand, 2) }) : null].filter(Boolean).join(' · ')}
                          </div>
                          {Number(l.qty_cancelled) > 0 && <div className="small muted">{t('inv.line.nCancelled', { n: num(l.qty_cancelled, 2) })}</div>}
                          {ret > 0 && <div className="small" style={{ color: 'var(--amber-ink, #9A5B10)' }}>{t('inv.line.nReturned', { n: num(ret, 2) })}</div>}
                        </td>
                        <td className="num">{num(q, 2)}</td>
                        <td className="num">{num(l.qty_delivered, 2)}</td>
                        <td>
                          <Badge color={LINE_COLOR[state]}>{t(`inv.line.st.${state}`)}</Badge>
                          {showCost && Number(l.qty_delivered) > 0 && (
                            <div className="small" style={{ marginTop: 2, color: owedQty(l) > 0 ? (due && due < today ? 'var(--red)' : 'var(--muted)') : 'var(--green)' }}>
                              {owedQty(l) > 0 ? (due && due < today ? t('inv.line.overdue') : t('inv.line.unpaid')) : t('inv.line.paid')}
                            </div>
                          )}
                        </td>
                        {showCost && <td className="num wide-only nowrap">{rp(l.cost)}{Number(l.core_cost) > 0 && <div className="small muted">{t('inv.line.plusCore', { amount: rp(l.core_cost) })}</div>}{l.taxable && <div className="small muted">{t('inv.line.plusTax')}</div>}</td>}
                        {showCost && <td className="num nowrap">{rp(lineAmount(l.cost, l.core_cost, q, l.taxable, po.tax_rate))}</td>}
                        <td className="wide-only small">
                          {l.supplier_invoice_no || (l.delivered_at ? <span className="muted">{t('inv.line.noInvoiceNo')}</span> : <span className="muted">—</span>)}
                          {l.delivered_at && <div className="muted">{t('inv.line.receivedOn', { date: fmtDate(l.delivered_at, lang) })}</div>}
                          {showCost && owedQty(l) > 0 && due && <div className={due < today ? 'text-red' : 'muted'}>{t('inv.dueOn', { date: fmtDate(due, lang) })}</div>}
                        </td>
                        <td className="num">
                          <MoreMenu label={t('inv.line.menu', { name: l.name })} items={[
                            editable && { label: t('common.edit'), icon: 'edit', onClick: () => setModal({ kind: 'line', line: l }) },
                            receivable && openQty(l) > 0 && { label: t('inv.po.receive'), icon: 'packages', onClick: () => setModal({ kind: 'receive', lines: [l] }) },
                            canEdit && openQty(l) > 0 && { label: t('inv.line.cancelRest'), icon: 'x', onClick: () => cancelLines([l]) },
                            canEdit && showCost && owedQty(l) > 0 && { label: t('inv.line.pay'), icon: 'wallet', onClick: () => setModal({ kind: 'pay', lines: [l] }) },
                            canEdit && Number(l.qty_delivered) - Number(l.qty_paid) - ret > 0 && { label: t('inv.line.correct'), icon: 'edit', onClick: () => setModal({ kind: 'correct', line: l }) },
                            canEdit && Number(l.qty_delivered) === 0 && { label: t('common.delete'), icon: 'trash', danger: true, onClick: () => deleteLine(l) },
                          ]} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {editable && (
            <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
              <div style={{ flex: '1 1 260px' }}>
                <Picker options={partOptions} placeholder={t('inv.po.addPart')}
                  onPick={(o) => setModal({ kind: 'line', preset: { catalog_item_id: o.item.id, name: o.item.name, part_number: o.item.code, cost: o.item.cost, core_cost: o.item.has_core ? o.item.core_cost : 0, taxable: o.item.taxable, qty: 1 } })}
                  render={(o) => {
                    const st = o.item.track_inventory ? stockState(o.item, data.stockById[o.item.id]) : null
                    return <><span style={{ flex: 1, minWidth: 0 }}><b>{o.item.name}</b><span className="muted small">{o.item.code ? ` · ${o.item.code}` : ''}</span></span>
                      {st && <span className="small muted">{t('inv.line.onHand', { n: num(st.onHand, 2) })}</span>}
                      {showCost && <span className="small" style={{ fontWeight: 700 }}>{rp(o.item.cost)}</span>}</>
                  }} />
              </div>
              <Button icon="plus" onClick={() => setModal({ kind: 'line', preset: null })}>{t('inv.po.freeText')}</Button>
            </div>
          )}
        </section>

        {returns.length > 0 && (
          <section className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>{t('inv.po.returns')}</h2><div className="spacer" /><Link className="small" to="/inventory/returns">{t('inv.po.allReturns')}</Link></div>
            <div className="apptlist">
              {returns.map((r) => (
                <div key={r.id} className="row wrap" style={{ gap: 8, fontSize: 13 }}>
                  <Badge color={RETURN_COLOR[r.status]}>{t(`inv.ret.st.${r.status}`)}</Badge>
                  <span><b>{r.item_name}</b> × {num(r.qty, 2)}</span>
                  <span className="muted small">{fmtDate(r.marked_at, lang)}</span>
                  {showCost && <><div className="spacer" /><span className="small">{rp(returnValue(r))}</span></>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="jobside">
        <section className="card side-card">
          <div className="sectionlabel" style={{ marginTop: 0 }}>{t('inv.po.details')}</div>
          <label className="mini" style={{ display: 'block' }}>{t('inv.col.supplier')}
            {editable && !anyDelivered ? (
              <select className="select" value={po.supplier_id} onChange={(e) => upd({ supplier_id: e.target.value })} aria-label={t('inv.col.supplier')}>
                {data.suppliers.filter((s) => (s.active !== false && s.type !== 'sublet') || s.id === po.supplier_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : <div><b>{sup?.name || '—'}</b></div>}
          </label>
          {sup && (sup.contact_name || sup.phone || sup.email) && <div className="small muted" style={{ marginTop: 4 }}>{[sup.contact_name, sup.phone, sup.email].filter(Boolean).join(' · ')}</div>}
          {sup?.account_number && <div className="small muted">{t('inv.po.account', { no: sup.account_number })}</div>}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <label className="mini">{t('inv.po.terms')}
              <BlurInput className="input cell num" style={{ width: 80 }} disabled={!editable} value={po.payment_terms_days == null ? '' : String(po.payment_terms_days)} placeholder={String(sup?.payment_terms_days ?? '—')}
                aria-label={t('inv.po.terms')} onCommit={(v, reset) => {
                  const n = v.trim() === '' ? null : Number(v)
                  if (n != null && (!Number.isInteger(n) || n < 0 || n > 365)) { toast(t('inv.err.terms'), 'err'); reset(); return }
                  return upd({ payment_terms_days: n })
                }} />
            </label>
            <span className="small muted" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>{t('common.days')}</span>
          </div>
          <div className="sectionlabel">{t('inv.po.notes')}</div>
          <BlurInput multiline rows={2} disabled={!editable} value={po.notes || ''} placeholder={t('inv.po.notesHint')} aria-label={t('inv.po.notes')} maxLength={2000}
            onCommit={(v) => upd({ notes: v.trim() || null })} />
          <div className="kvlist" style={{ marginTop: 12 }}>
            <div><span>{t('inv.po.created')}</span><b>{fmtDateTime(po.created_at, lang, timezone)}</b></div>
            {po.ordered_at && <div><span>{t('inv.po.orderedOn')}</span><b>{fmtDate(po.ordered_at, lang, timezone)}</b></div>}
            {po.ro_id && <div><span>{t('inv.col.for')}</span><b><JobRef data={data} roId={po.ro_id} /></b></div>}
          </div>
        </section>

        {showCost && (
          <section className="card side-card">
            <div className="sectionlabel" style={{ marginTop: 0 }}>{t('inv.po.totals')}</div>
            <TotalRow label={t('inv.po.partsTotal')} value={tot.parts} />
            {tot.core > 0 && <TotalRow label={t('inv.po.coreTotal')} value={tot.core} />}
            <TotalRow label={t('inv.po.taxTotal', { rate: num(po.tax_rate, 2) })} value={tot.tax} />
            <TotalRow label={t('inv.po.total')} value={tot.total} strong />
            {anyDelivered && <>
              <div className="sep" />
              <TotalRow label={t('inv.po.receivedValue')} value={tot.delivered} muted />
              <TotalRow label={t('inv.po.paid')} value={tot.paid} muted />
              <TotalRow label={t('inv.po.owed')} value={tot.owed} strong />
            </>}
            {payments.length > 0 && <>
              <div className="sectionlabel">{t('inv.po.payments')}</div>
              <div className="apptlist">
                {payments.map((p) => (
                  <div key={p.id} className="row" style={{ gap: 6, fontSize: 13 }}>
                    <span><b>{rp(p.amount)}</b> <span className="muted small">· {fmtDate(p.paid_at, lang)} · {t(`inv.pay.m.${p.method || 'other'}`)}{p.reference ? ` · ${p.reference}` : ''}</span></span>
                    <div className="spacer" />
                    {canEdit && <button type="button" className="linkbtn small" onClick={() => undoPayment(p)}>{t('inv.pay.undo')}</button>}
                  </div>
                ))}
              </div>
              {payments.some((p) => (p.po_item_ids || []).some((x) => !lineIds.has(x))) && <div className="hint">{t('inv.pay.spansPos')}</div>}
            </>}
          </section>
        )}
      </aside>

      {confirmEl}
      <LineModal open={modal?.kind === 'line'} onClose={close} po={po} line={modal?.line} preset={modal?.preset} showCost={showCost}
        onSaved={(row) => done(modal?.line ? t('inv.line.saved') : t('inv.line.added', { name: row.name }))} />
      <ReceiveModal open={modal?.kind === 'receive'} onClose={close} po={po} supplier={sup} lines={modal?.lines || []}
        onDone={(n, partial) => { if (partial) { close(); reload(); toast(partial, 'err') } else done(t('inv.receive.done', { n })) }} />
      <PayModal open={modal?.kind === 'pay'} onClose={close} supplier={sup} items={(modal?.lines || []).map((l) => ({ line: l, po }))}
        onDone={(amount) => done(t('inv.pay.done', { amount: rp(amount), name: sup?.name || '' }))} />
      <PoReturnModal open={modal?.kind === 'return'} onClose={close} data={data} po={po} lines={lines} showCost={showCost}
        onDone={(n) => done(t('inv.ret.markedN', { n }))} />
      <CorrectReceivedModal open={modal?.kind === 'correct'} onClose={close} data={data} line={modal?.line}
        onDone={(n) => done(t('inv.correct.done', { name: modal?.line?.name || '', n: num(n, 2) }))} />
    </div>
  )
}
