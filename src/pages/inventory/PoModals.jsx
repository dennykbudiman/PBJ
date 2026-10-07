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
      <div className="row" style={{ gap: 10, marginBottom: 8 }}>
        <span className="small muted">{t('inv.receive.partialHint')}</span>
        <div className="spacer" />
        <button type="button" className="linkbtn small" onClick={() => setQty(Object.fromEntries(lines.map((l) => [l.id, qtyText(openQty(l))])))}>{t('inv.receive.allArrived')}</button>
        <button type="button" className="linkbtn small" onClick={() => setQty(Object.fromEntries(lines.map((l) => [l.id, ''])))}>{t('inv.receive.clear')}</button>
      </div>
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
                  <span className="rcv-qty">
                    <input className={`input cell num narrow boxed ${err[l.id] ? 'invalid' : ''}`} value={qty[l.id] ?? ''} inputMode="decimal" placeholder="0"
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))} aria-label={t('inv.receive.qtyFor', { name: l.name })} />
                    <span className="muted small nowrap">{t('inv.receive.ofN', { n: num(openQty(l), 2) })}</span>
                  </span>
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

// Tax on a return follows what the order was charged (the database works it out the same way):
// a PO line's own tax, or for stock the last delivery of that part from that supplier.
export function returnTaxSource(data, { line, po, item, supplier }) {
  if (line) return { taxable: !!line.taxable, rate: Number(po?.tax_rate) || 0 }
  if (!item || !supplier) return { taxable: false, rate: 0 }
  const last = data.lines.filter((l) => l.catalog_item_id === item && Number(l.qty_delivered) > 0 && data.poById[l.po_id]?.supplier_id === supplier)
    .sort((a, b) => String(b.delivered_at || '').localeCompare(String(a.delivered_at || '')) || String(b.created_at).localeCompare(String(a.created_at)))[0]
  return last ? { taxable: !!last.taxable, rate: Number(data.poById[last.po_id].tax_rate) || 0, line: last } : { taxable: false, rate: 0 }
}
const returnedOn = (data, line) => data.returns.filter((r) => r.po_item_id === line.id).reduce((a, r) => a + Number(r.qty), 0)

// Return parts of one PO to its supplier: how many of each received part go back, with one reason.
// The lines are saved together (one batch) and move through the return steps together.
export function PoReturnModal({ open, onClose, data, po, lines, showCost, onDone }) {
  const { t } = useT()
  const once = useOnce()
  const [qty, setQty] = useState({})
  const [note, setNote] = useState('')
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  const rows = lines.map((l) => ({ l, left: Number(l.qty_delivered) - returnedOn(data, l) })).filter((x) => x.left > 0)
  useEffect(() => { if (open) { setQty({}); setNote(''); setErr({}); setFail(null) } }, [open])
  const amountOf = (l, q) => lineAmount(l.cost, 0, q, l.taxable, po.tax_rate)
  const picked = rows.map(({ l, left }) => ({ l, left, q: String(qty[l.id] ?? '').trim() === '' ? 0 : parseDecimal(qty[l.id]) }))
  const total = picked.reduce((a, x) => a + (x.q > 0 ? amountOf(x.l, x.q) : 0), 0)
  const save = () => once(async () => {
    const e = {}
    for (const x of picked) if (x.q == null || x.q < 0 || x.q > x.left) e[x.l.id] = t('inv.err.receiveMax', { n: num(x.left, 2) })
    const go = picked.filter((x) => x.q > 0)
    if (!go.length && !Object.keys(e).length) e.none = t('inv.ret.none')
    setErr(e)
    if (Object.keys(e).length) return
    setBusy(true)
    // crypto.randomUUID needs a secure page; fall back to a random v4 id elsewhere.
    const batch = globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16) })
    const { error } = await supabase.from('returns').insert(go.map(({ l, q }) => ({
      kind: po.ro_id ? 'ro' : 'inventory', po_item_id: l.id, ro_id: po.ro_id, supplier_id: po.supplier_id, catalog_item_id: l.catalog_item_id,
      item_name: l.name, qty: q, return_cost: Number(l.cost) || 0, note: note.trim() || null, batch_id: batch,
    })))
    setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone(go.length)
  })
  return (
    <Modal open={open} title={t('inv.ret.poTitle', { no: po.po_number })} onClose={onClose} wide
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('inv.ret.save')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {err.none && <Notice kind="err" style={{ marginBottom: 10 }}>{err.none}</Notice>}
      <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{t('inv.ret.poHint')}</div>
      {rows.length === 0 ? <div className="muted">{t('inv.ret.nothingToReturn')}</div> : (
        <div className="table compact">
          <table>
            <thead><tr>
              <th>{t('inv.col.part')}</th><th className="num">{t('inv.col.received')}</th><th className="num">{t('inv.ret.canReturn')}</th>
              {showCost && <th className="num wide-only">{t('inv.ret.unitCost')}</th>}<th className="num">{t('inv.ret.sendBack')}</th>{showCost && <th className="num">{t('inv.col.value')}</th>}
            </tr></thead>
            <tbody>
              {picked.map(({ l, left, q }) => {
                const item = l.catalog_item_id && data.itemById[l.catalog_item_id]
                const st = item?.track_inventory ? stockState(item, data.stockById[item.id]) : null
                return (
                  <tr key={l.id}>
                    <td><b>{l.name}</b>{l.part_number && <span className="muted small"> · {l.part_number}</span>}
                      {st && q > st.onHand && <div className="small text-red">{t('inv.ret.notEnough', { n: num(st.onHand, 2) })}</div>}</td>
                    <td className="num">{num(l.qty_delivered, 2)}</td>
                    <td className="num">{num(left, 2)}</td>
                    {showCost && <td className="num wide-only nowrap">{rp(l.cost)}{l.taxable && <div className="small muted">{t('inv.ret.plusTax', { rate: num(po.tax_rate, 2) })}</div>}</td>}
                    <td className="num">
                      <span className="rcv-qty">
                        <input className={`input cell num narrow boxed ${err[l.id] ? 'invalid' : ''}`} value={qty[l.id] ?? ''} placeholder="0" inputMode="decimal"
                          onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))} aria-label={t('inv.ret.qtyFor', { name: l.name })} />
                        <button type="button" className="linkbtn small" onClick={() => setQty((x) => ({ ...x, [l.id]: qtyText(left) }))}>{t('inv.all')}</button>
                      </span>
                      {err[l.id] && <div className="error small">{err[l.id]}</div>}
                    </td>
                    {showCost && <td className="num nowrap">{q > 0 ? rp(amountOf(l, q)) : <span className="muted">—</span>}</td>}
                  </tr>
                )
              })}
            </tbody>
            {showCost && <tfoot><tr><td colSpan={5} className="num"><b>{t('inv.ret.total')}</b></td><td className="num nowrap"><b>{rp(total)}</b></td></tr></tfoot>}
          </table>
        </div>
      )}
      <Textarea label={t('inv.ret.note')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} placeholder={t('inv.ret.noteEx')} />
      <div className="hint">{t('inv.ret.hint')}</div>
    </Modal>
  )
}

// Send parts back to the supplier straight from stock (not tied to a PO).
export function ReturnModal({ open, onClose, data, showCost, onDone }) {
  const { t } = useT()
  const once = useOnce()
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setF({ item: '', supplier: '', name: '', qty: '1', cost: '', note: '' })
    setErr({}); setFail(null)
  }, [open])
  const item = f.item ? data.itemById[f.item] : null
  const src = returnTaxSource(data, { item: f.item, supplier: f.supplier })
  const q = parseDecimal(f.qty) || 0
  const c = readAmount(f.cost) || 0
  const tax = src.taxable ? taxOf(c, q, src.rate) : 0
  const st = item?.track_inventory ? stockState(item, data.stockById[item.id]) : null
  // A part's cost comes from its last delivery from that supplier when there is one, else the catalog.
  const costFor = (itemId, supplier) => {
    const s2 = returnTaxSource(data, { item: itemId, supplier })
    return s2.line ? num(s2.line.cost) : data.itemById[itemId] ? num(data.itemById[itemId].cost) : ''
  }
  const pickItem = (id) => {
    const it = data.itemById[id]
    const sup = it?.supplier_id || f.supplier
    setF((x) => ({ ...x, item: id, name: it ? it.name : x.name, supplier: sup, cost: it ? costFor(id, sup) : x.cost }))
  }
  const pickSupplier = (sup) => setF((x) => ({ ...x, supplier: sup, cost: x.item ? costFor(x.item, sup) : x.cost }))
  const save = () => once(async () => {
    const e = {}
    const qty = parseDecimal(f.qty)
    const cost = f.cost.trim() === '' ? 0 : readAmount(f.cost)
    if (!f.supplier) e.supplier = t('inv.err.supplier')
    if (!f.name.trim()) e.name = t('inv.err.name')
    if (qty == null || !(qty > 0)) e.qty = t('inv.err.qty')
    if (cost == null || Number.isNaN(cost)) e.cost = t('inv.err.cost')
    setErr(e)
    if (Object.keys(e).length) return
    setBusy(true)
    const { error } = await supabase.from('returns').insert({ kind: 'inventory', supplier_id: f.supplier, catalog_item_id: f.item || null, item_name: f.name.trim(), qty, return_cost: cost, note: f.note.trim() || null })
    setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone()
  })
  const parts = data.items.filter((x) => x.active || x.id === f.item)
  return (
    <Modal open={open} title={t('inv.ret.newTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('inv.ret.save')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      <Select label={t('inv.ret.part')} value={f.item || ''} onChange={(e) => pickItem(e.target.value)}
        options={[{ value: '', label: t('inv.ret.notInCatalog') }, ...parts.map((x) => ({ value: x.id, label: `${x.name}${x.code ? ` · ${x.code}` : ''}` }))]} />
      {!f.item && <Input label={t('inv.line.name')} value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} error={err.name} maxLength={200} />}
      <Select label={t('inv.col.supplier')} value={f.supplier || ''} onChange={(e) => pickSupplier(e.target.value)} error={err.supplier}
        options={[{ value: '', label: t('inv.order.chooseSupplier') }, ...data.suppliers.filter((s) => s.active !== false && s.type !== 'sublet').map((s) => ({ value: s.id, label: s.name }))]} />
      <div className="formgrid">
        <Input label={t('inv.line.qty')} value={f.qty || ''} onChange={(e) => setF({ ...f, qty: e.target.value })} error={err.qty} inputMode="decimal" />
        {showCost && <Input label={t('inv.ret.unitCost')} value={f.cost || ''} onChange={(e) => setF({ ...f, cost: e.target.value })} error={err.cost} prefix="Rp" inputMode="numeric" />}
      </div>
      {showCost && <div className="small" style={{ margin: '6px 0' }}>
        {t('inv.ret.value', { amount: rp(lineAmount(c, 0, q, false, 0) + tax) })}{' · '}
        <span className="muted">{src.taxable ? t('inv.ret.taxFromOrder', { rate: num(src.rate, 2) }) : f.item && f.supplier && src.line ? t('inv.ret.noTaxFromOrder') : t('inv.ret.noTaxNoOrder')}</span>
      </div>}
      {st && q > st.onHand && <Notice kind="warn" style={{ marginTop: 8 }}>{t('inv.ret.notEnough', { n: num(st.onHand, 2) })}</Notice>}
      <Textarea label={t('inv.ret.note')} value={f.note || ''} onChange={(e) => setF({ ...f, note: e.target.value })} rows={2} maxLength={1000} placeholder={t('inv.ret.noteEx')} />
      <div className="hint">{t('inv.ret.hint')}</div>
    </Modal>
  )
}

// Fix a received quantity that was entered too high (before the parts are paid for or returned).
export function CorrectReceivedModal({ open, onClose, data, line, onDone }) {
  const { t } = useT()
  const once = useOnce()
  const [v, setV] = useState('')
  const [err, setErr] = useState(null)
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  const floor = line ? Number(line.qty_paid) + returnedOn(data, line) : 0
  // A cancelled PO, or a line whose rest was cancelled, stays closed: what comes off counts as cancelled, not "still to come".
  const closed = line ? data.poById[line.po_id]?.status === 'cancelled' || Number(line.qty_cancelled) > 0 : false
  useEffect(() => { if (open && line) { setV(qtyText(line.qty_delivered)); setErr(null); setFail(null) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!line) return null
  const save = () => once(async () => {
    const n = parseDecimal(v)
    if (n == null || n < floor || n >= Number(line.qty_delivered)) return setErr(t('inv.correct.range', { min: num(floor, 2), max: num(line.qty_delivered, 2) }))
    setErr(null); setBusy(true)
    const { error } = await supabase.rpc('unreceive_po_item', { p_item: line.id, p_qty: Math.round((Number(line.qty_delivered) - n) * 100) / 100 })
    setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone(n)
  })
  return (
    <Modal open={open} title={t('inv.correct.title', { name: line.name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('inv.correct.save')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      <div className="kvlist" style={{ marginBottom: 12 }}>
        <div><span>{t('inv.col.ordered')}</span><b>{num(Number(line.qty_ordered) - Number(line.qty_cancelled), 2)}</b></div>
        <div><span>{t('inv.correct.recorded')}</span><b>{num(line.qty_delivered, 2)}</b></div>
      </div>
      <Input label={t('inv.correct.actually')} value={v} onChange={(e) => setV(e.target.value)} error={err} inputMode="decimal" autoFocus />
      <div className="hint">{floor > 0 ? t('inv.correct.hintFloor', { n: num(floor, 2) }) : closed ? t('inv.correct.hintClosed') : t('inv.correct.hint')}</div>
    </Modal>
  )
}
