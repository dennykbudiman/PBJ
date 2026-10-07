import React, { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, Notice, Select, Textarea, Toggle } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, num, parseDecimal, readAmount, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { PAY_METHODS, lineAmount, lineDue, openQty, owedQty, stockState } from '../../lib/inventory'
import { addDays } from '../../lib/calendar'

// Tax on a cost × quantity, rounded the same way as everywhere else.
const taxOf = (cost, qty, rate) => lineAmount(cost, 0, qty, true, rate) - lineAmount(cost, 0, qty, false, 0)
const qtyText = (v) => (v == null || v === '' ? '' : num(v, 2))
// One submit at a time, even for a quick double click.
function useOnce() {
  const r = useRef(false)
  return async (fn) => { if (r.current) return; r.current = true; try { await fn() } finally { r.current = false } }
}

// Add a part to a PO, or change one of its lines.
export function LineModal({ open, onClose, po, line, preset, showCost, onSaved }) {
  const { t } = useT()
  const once = useOnce()
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    const src = line || preset || {}
    setF({ name: src.name || '', part_number: src.part_number || '', qty: qtyText(src.qty_ordered ?? src.qty ?? 1), cost: src.cost == null ? '' : num(src.cost),
      core: Number(src.core_cost) ? num(src.core_cost) : '', taxable: !!src.taxable })
    setErr({}); setFail(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  const paid = line && Number(line.qty_paid) > 0
  const floor = line ? Number(line.qty_delivered) + Number(line.qty_cancelled) : 0
  const save = () => once(async () => {
    const e = {}
    const qty = parseDecimal(f.qty)
    const cost = f.cost.trim() === '' ? 0 : readAmount(f.cost)
    const core = f.core.trim() === '' ? 0 : readAmount(f.core)
    if (!f.name.trim()) e.name = t('inv.err.name')
    if (qty == null || !(qty > 0) || qty > 100000) e.qty = t('inv.err.qty')
    else if (qty < floor) e.qty = t('inv.err.qtyFloor', { n: num(floor, 2) })
    if (cost == null || Number.isNaN(cost)) e.cost = t('inv.err.cost')
    if (core == null || Number.isNaN(core)) e.core = t('inv.err.cost')
    setErr(e)
    if (Object.keys(e).length) return
    setBusy(true)
    const row = { name: f.name.trim(), part_number: f.part_number.trim() || null, qty_ordered: qty }
    if (!paid) Object.assign(row, { cost, core_cost: core, taxable: f.taxable })
    const res = line
      ? await supabase.from('purchase_order_items').update(row).eq('id', line.id)
      : await supabase.from('purchase_order_items').insert({ ...row, po_id: po.id, catalog_item_id: preset?.catalog_item_id || null })
    setBusy(false)
    if (res.error) return setFail(errorText(res.error, t))
    onSaved(row)
  })
  return (
    <Modal open={open} title={line ? t('inv.line.editTitle') : t('inv.line.addTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{line ? t('common.save') : t('inv.line.add')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {preset?.catalog_item_id && !line && <div className="hint" style={{ marginTop: 0 }}>{t('inv.line.fromCatalog')}</div>}
      <Input label={t('inv.line.name')} value={f.name || ''} onChange={set('name')} error={err.name} maxLength={200} autoFocus={!preset} />
      <Input label={t('inv.line.partNo')} value={f.part_number || ''} onChange={set('part_number')} maxLength={100} />
      <div className="formgrid">
        <Input label={t('inv.line.qty')} value={f.qty || ''} onChange={set('qty')} error={err.qty} inputMode="decimal" />
        {showCost && <Input label={t('inv.line.cost')} value={f.cost || ''} onChange={set('cost')} error={err.cost} prefix="Rp" inputMode="numeric" disabled={paid} />}
        {showCost && <Input label={t('inv.line.core')} value={f.core || ''} onChange={set('core')} error={err.core} prefix="Rp" inputMode="numeric" disabled={paid} hint={t('inv.line.coreHint')} />}
      </div>
      {showCost && <Toggle checked={!!f.taxable} disabled={paid} onChange={(v) => setF((x) => ({ ...x, taxable: v }))} label={t('inv.line.taxable', { rate: num(po.tax_rate, 2) })} />}
      {paid && <div className="hint">{t('inv.line.paidLocked')}</div>}
      {line && Number(line.qty_delivered) > 0 && <div className="hint">{t('inv.line.deliveredNote', { n: num(line.qty_delivered, 2) })}</div>}
    </Modal>
  )
}

// Receive delivered parts: how many of each arrived, and the supplier's invoice for them.
export function ReceiveModal({ open, onClose, po, supplier, lines, onDone }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const once = useOnce()
  const today = shopToday(timezone)
  const [qty, setQty] = useState({})
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setQty(Object.fromEntries(lines.map((l) => [l.id, qtyText(openQty(l))])))
    setF({ delivered: today, invoice_no: '', invoice_date: '', due: '' })
    setErr({}); setFail(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const terms = po.payment_terms_days ?? supplier?.payment_terms_days ?? 0
  const autoDue = addDays(f.invoice_date || f.delivered || today, Number(terms) || 0)
  const save = () => once(async () => {
    const e = {}
    const take = []
    for (const l of lines) {
      const q = String(qty[l.id] ?? '').trim() === '' ? 0 : parseDecimal(qty[l.id])
      if (q == null || q < 0 || q > openQty(l)) e[l.id] = t('inv.err.receiveMax', { n: num(openQty(l), 2) })
      else if (q > 0) take.push([l, q])
    }
    if (!f.delivered) e.delivered = t('inv.err.date')
    else if (f.delivered > today) e.delivered = t('inv.err.future')
    if (f.invoice_date && f.invoice_date > today) e.invoice_date = t('inv.err.future')
    if (!take.length && !Object.keys(e).length) e.none = t('inv.receive.none')
    setErr(e)
    if (Object.keys(e).length) return
    setBusy(true); setFail(null)
    let done = 0
    for (const [l, q] of take) {
      const { error } = await supabase.rpc('deliver_po_item', {
        p_item: l.id, p_qty: q, p_delivered: f.delivered, p_invoice_no: f.invoice_no.trim() || null,
        p_invoice_date: f.invoice_date || null, p_due: f.due || autoDue,
      })
      if (error) {
        setBusy(false)
        // Lines before the failed one were received: close and say which part didn't go through.
        if (done) onDone(done, t('inv.receive.partial', { n: done, error: errorText(error, t) }))
        else setFail(errorText(error, t))
        return
      }
      done++
    }
    setBusy(false)
    onDone(done)
  })
  return (
    <Modal open={open} title={t('inv.receive.title', { no: po.po_number })} onClose={onClose} wide
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('inv.receive.save')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {err.none && <Notice kind="err" style={{ marginBottom: 10 }}>{err.none}</Notice>}
      <div className="table compact">
        <table>
          <thead><tr><th>{t('inv.col.part')}</th><th className="num">{t('inv.col.ordered')}</th><th className="num">{t('inv.col.received')}</th><th className="num">{t('inv.receive.now')}</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td><b>{l.name}</b>{l.part_number && <span className="muted small"> · {l.part_number}</span>}</td>
                <td className="num">{num(Number(l.qty_ordered) - Number(l.qty_cancelled), 2)}</td>
                <td className="num">{num(l.qty_delivered, 2)}</td>
                <td className="num">
                  <input className={`input cell num narrow ${err[l.id] ? 'invalid' : ''}`} value={qty[l.id] ?? ''} inputMode="decimal"
                    onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))} aria-label={t('inv.receive.qtyFor', { name: l.name })} />
                  {err[l.id] && <div className="error small">{err[l.id]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="formgrid" style={{ marginTop: 12 }}>
        <Input type="date" label={t('inv.receive.date')} value={f.delivered || ''} max={today} onChange={(e) => setF({ ...f, delivered: e.target.value })} error={err.delivered} />
        <Input label={t('inv.receive.invoiceNo')} value={f.invoice_no || ''} maxLength={100} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} placeholder={t('inv.receive.invoiceNoEx')} />
        <Input type="date" label={t('inv.receive.invoiceDate')} value={f.invoice_date || ''} max={today} onChange={(e) => setF({ ...f, invoice_date: e.target.value })} error={err.invoice_date} />
        <Input type="date" label={t('inv.receive.due')} value={f.due || ''} onChange={(e) => setF({ ...f, due: e.target.value })}
          hint={f.due ? null : t('inv.receive.dueAuto', { date: fmtDate(autoDue, lang), n: terms })} />
      </div>
      <div className="hint">{t('inv.receive.hint')}</div>
    </Modal>
  )
}

// Pay a supplier for delivered parts. The amount is worked out by the database from what was delivered.
// items: [{ line, po }] for one supplier.
export function PayModal({ open, onClose, supplier, items, onDone }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const once = useOnce()
  const today = shopToday(timezone)
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setF({ paid_at: today, method: 'transfer', reference: '' }); setErr({}); setFail(null) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = items.filter(({ line }) => owedQty(line) > 0)
  const total = rows.reduce((a, { line, po }) => a + lineAmount(line.cost, line.core_cost, owedQty(line), line.taxable, po.tax_rate), 0)
  const save = () => once(async () => {
    const e = {}
    if (!f.paid_at) e.paid_at = t('inv.err.date')
    else if (f.paid_at > today) e.paid_at = t('inv.err.future')
    setErr(e)
    if (Object.keys(e).length || !rows.length) return
    setBusy(true)
    // The total shown goes along: if more arrived meanwhile, the database refuses rather than paying a different amount.
    const { data: paid, error } = await supabase.rpc('pay_po_items', { p_items: rows.map(({ line }) => line.id), p_paid_at: f.paid_at, p_method: f.method, p_reference: f.reference.trim() || null, p_expected: total })
    setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone(paid ?? total)
  })
  return (
    <Modal open={open} title={t('inv.pay.title', { name: supplier?.name || '' })} onClose={onClose} wide
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!rows.length} onClick={save}>{t('inv.pay.save', { amount: rp(total) })}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {!rows.length ? <div className="muted">{t('inv.pay.nothing')}</div> : (
        <div className="table compact">
          <table>
            <thead><tr><th>{t('inv.col.po')}</th><th>{t('inv.col.part')}</th><th className="wide-only">{t('inv.col.invoice')}</th><th className="num">{t('inv.col.qty')}</th><th className="num">{t('inv.col.amount')}</th></tr></thead>
            <tbody>
              {rows.map(({ line, po }) => (
                <tr key={line.id}>
                  <td className="nowrap">{po.po_number}</td>
                  <td>{line.name}</td>
                  <td className="wide-only small">{line.supplier_invoice_no || <span className="muted">—</span>}{lineDue(line, po, supplier) && <div className="muted">{t('inv.dueOn', { date: fmtDate(lineDue(line, po, supplier), lang) })}</div>}</td>
                  <td className="num">{num(owedQty(line), 2)}</td>
                  <td className="num nowrap">{rp(lineAmount(line.cost, line.core_cost, owedQty(line), line.taxable, po.tax_rate))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4} className="num"><b>{t('inv.pay.total')}</b></td><td className="num nowrap"><b>{rp(total)}</b></td></tr></tfoot>
          </table>
        </div>
      )}
      <div className="formgrid" style={{ marginTop: 12 }}>
        <Input type="date" label={t('inv.pay.date')} value={f.paid_at || ''} max={today} onChange={(e) => setF({ ...f, paid_at: e.target.value })} error={err.paid_at} />
        <Select label={t('inv.pay.method')} value={f.method || 'transfer'} onChange={(e) => setF({ ...f, method: e.target.value })}
          options={PAY_METHODS.map((m) => ({ value: m, label: t(`inv.pay.m.${m}`) }))} />
        <Input label={t('inv.pay.reference')} value={f.reference || ''} maxLength={200} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder={t('inv.pay.referenceEx')} />
      </div>
      <div className="hint">{t('inv.pay.hint')}</div>
    </Modal>
  )
}

// Send parts back to the supplier, from a PO line (stock or job) or straight from stock.
// return_cost is per unit; return_tax is the tax on the whole return.
export function ReturnModal({ open, onClose, data, line, po, showCost, onDone }) {
  const { t } = useT()
  const { settings } = useShop()
  const once = useOnce()
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  const returned = line ? data.returns.filter((r) => r.po_item_id === line.id).reduce((a, r) => a + Number(r.qty), 0) : 0
  const left = line ? Number(line.qty_delivered) - returned : null
  useEffect(() => {
    if (!open) return
    setF(line
      ? { item: line.catalog_item_id || '', supplier: po.supplier_id, name: line.name, qty: qtyText(left), cost: num(line.cost), taxable: !!line.taxable, note: '' }
      : { item: '', supplier: '', name: '', qty: '1', cost: '', taxable: false, note: '' })
    setErr({}); setFail(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const item = f.item ? data.itemById[f.item] : null
  const rate = po?.tax_rate ?? settings?.tax_rate ?? 0
  const q = parseDecimal(f.qty) || 0
  const c = readAmount(f.cost) || 0
  const tax = f.taxable ? taxOf(c, q, rate) : 0
  const st = item?.track_inventory ? stockState(item, data.stockById[item.id]) : null
  const pickItem = (id) => {
    const it = data.itemById[id]
    setF((x) => ({ ...x, item: id, name: it ? it.name : x.name, supplier: it?.supplier_id || x.supplier, cost: it ? num(it.cost) : x.cost }))
  }
  const save = () => once(async () => {
    const e = {}
    const qty = parseDecimal(f.qty)
    const cost = f.cost.trim() === '' ? 0 : readAmount(f.cost)
    if (!line && !f.supplier) e.supplier = t('inv.err.supplier')
    if (!f.name.trim()) e.name = t('inv.err.name')
    if (qty == null || !(qty > 0)) e.qty = t('inv.err.qty')
    else if (line && qty > left) e.qty = t('inv.err.returnMax', { n: num(left, 2) })
    if (cost == null || Number.isNaN(cost)) e.cost = t('inv.err.cost')
    setErr(e)
    if (Object.keys(e).length) return
    setBusy(true)
    const row = line
      ? { kind: po.ro_id ? 'ro' : 'inventory', po_item_id: line.id, ro_id: po.ro_id, supplier_id: po.supplier_id, catalog_item_id: line.catalog_item_id, item_name: f.name.trim() }
      : { kind: 'inventory', supplier_id: f.supplier, catalog_item_id: f.item || null, item_name: f.name.trim() }
    const { error } = await supabase.from('returns').insert({ ...row, qty, return_cost: cost, return_tax: f.taxable ? taxOf(cost, qty, rate) : 0, note: f.note.trim() || null })
    setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone()
  })
  const parts = data.items.filter((x) => x.active || x.id === f.item)
  return (
    <Modal open={open} title={line ? t('inv.ret.fromLineTitle', { name: line.name }) : t('inv.ret.newTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('inv.ret.save')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {line ? <div className="hint" style={{ marginTop: 0 }}>{t('inv.ret.fromLineHint', { no: po.po_number, n: num(left, 2) })}</div> : (
        <>
          <Select label={t('inv.ret.part')} value={f.item || ''} onChange={(e) => pickItem(e.target.value)}
            options={[{ value: '', label: t('inv.ret.notInCatalog') }, ...parts.map((x) => ({ value: x.id, label: `${x.name}${x.code ? ` · ${x.code}` : ''}` }))]} />
          {!f.item && <Input label={t('inv.line.name')} value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} error={err.name} maxLength={200} />}
          <Select label={t('inv.col.supplier')} value={f.supplier || ''} onChange={(e) => setF({ ...f, supplier: e.target.value })} error={err.supplier}
            options={[{ value: '', label: t('inv.order.chooseSupplier') }, ...data.suppliers.filter((s) => s.active !== false && s.type !== 'sublet').map((s) => ({ value: s.id, label: s.name }))]} />
        </>
      )}
      <div className="formgrid">
        <Input label={t('inv.line.qty')} value={f.qty || ''} onChange={(e) => setF({ ...f, qty: e.target.value })} error={err.qty} inputMode="decimal" />
        {showCost && <Input label={t('inv.ret.unitCost')} value={f.cost || ''} onChange={(e) => setF({ ...f, cost: e.target.value })} error={err.cost} prefix="Rp" inputMode="numeric" />}
      </div>
      {showCost && <Toggle checked={!!f.taxable} onChange={(v) => setF((x) => ({ ...x, taxable: v }))} label={t('inv.ret.taxable', { rate: num(rate, 2) })} />}
      {showCost && <div className="small" style={{ margin: '6px 0' }}>{t('inv.ret.value', { amount: rp(lineAmount(c, 0, q, false, 0) + tax) })}</div>}
      {st && q > st.onHand && <Notice kind="warn" style={{ marginTop: 8 }}>{t('inv.ret.notEnough', { n: num(st.onHand, 2) })}</Notice>}
      <Textarea label={t('inv.ret.note')} value={f.note || ''} onChange={(e) => setF({ ...f, note: e.target.value })} rows={2} maxLength={1000} placeholder={t('inv.ret.noteEx')} />
      <div className="hint">{t('inv.ret.hint')}</div>
    </Modal>
  )
}
