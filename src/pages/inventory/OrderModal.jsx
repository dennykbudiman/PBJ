import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal, Notice } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { num, parseDecimal, readAmount, rp } from '../../lib/format'
import { lineAmount } from '../../lib/inventory'
import { Tick } from './bits'

// Order parts: pick the lines, their supplier, quantity and cost. One purchase order is made per supplier.
// candidates: [{ key, catalog_item_id, ro_service_item_id, name, part_number, cost, core_cost, taxable, qty, supplier_id, checked, note }]
export default function OrderModal({ open, onClose, title, intro, candidates, suppliers, roId, taxRate, showCost, onDone }) {
  const { t } = useT()
  const [rows, setRows] = useState([])
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState(null)
  const running = useRef(false)
  useEffect(() => {
    if (!open) return
    setRows((candidates || []).map((c) => ({ ...c, qtyText: num(c.qty, 2), costText: num(c.cost), supplier_id: c.supplier_id || '' })))
    setErrors({}); setFail(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = suppliers.filter((s) => s.active !== false && s.type !== 'sublet')
  const set = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const picked = rows.filter((r) => r.checked)
  const groups = useMemo(() => {
    const g = {}
    for (const r of picked) if (r.supplier_id) (g[r.supplier_id] ||= []).push(r)
    return g
  }, [picked])

  async function create(status) {
    if (running.current) return
    const errs = {}
    const ready = []
    for (const r of picked) {
      const qty = parseDecimal(r.qtyText)
      const cost = readAmount(r.costText)
      if (!r.supplier_id) errs[`${r.key}.s`] = t('inv.err.supplier')
      if (qty == null || !(qty > 0) || qty > 100000) errs[`${r.key}.q`] = t('inv.err.qty')
      if (cost == null || Number.isNaN(cost)) errs[`${r.key}.c`] = t('inv.err.cost')
      ready.push({ ...r, qty, cost })
    }
    setErrors(errs)
    if (!picked.length || Object.keys(errs).length) return
    running.current = true; setBusy(true); setFail(null)
    const made = []
    try {
      const bySup = {}
      for (const r of ready) (bySup[r.supplier_id] ||= []).push(r)
      for (const [sid, list] of Object.entries(bySup)) {
        const sup = suppliers.find((s) => s.id === sid)
        // Made as a draft first, so a PO whose lines fail can be removed again.
        const po = await supabase.from('purchase_orders').insert({ supplier_id: sid, ro_id: roId || null, status: 'draft', payment_terms_days: sup?.payment_terms_days ?? null }).select().single()
        if (po.error) throw po.error
        const ins = await supabase.from('purchase_order_items').insert(list.map((r) => ({
          po_id: po.data.id, catalog_item_id: r.catalog_item_id || null, ro_service_item_id: r.ro_service_item_id || null,
          name: r.name, part_number: r.part_number || null, cost: r.cost, core_cost: Number(r.core_cost) || 0, taxable: !!r.taxable, qty_ordered: r.qty,
        })))
        if (ins.error) { await supabase.from('purchase_orders').delete().eq('id', po.data.id); throw ins.error }
        if (status === 'ordered') {
          const up = await supabase.from('purchase_orders').update({ status: 'ordered' }).eq('id', po.data.id)
          if (up.error) throw up.error
        }
        made.push(po.data)
      }
      onDone(made)
    } catch (e) {
      // Some POs were made before one failed: close, say so, and show what was made.
      if (made.length) onDone(made, t('inv.order.partial', { n: made.length, error: errorText(e, t) }))
      else setFail(errorText(e, t))
    } finally { running.current = false; setBusy(false) }
  }

  const nGroups = Object.keys(groups).length
  return (
    <Modal open={open} title={title} onClose={onClose} wide
      footer={<>
        <span className="small muted" style={{ marginRight: 'auto' }}>
          {picked.length ? t('inv.order.makes', { n: nGroups, parts: picked.length }) : t('inv.order.pickSome')}
        </span>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button loading={busy} disabled={!picked.length} onClick={() => create('draft')}>{t('inv.order.draft')}</Button>
        <Button variant="primary" loading={busy} disabled={!picked.length} onClick={() => create('ordered')}>{t('inv.order.ordered')}</Button>
      </>}>
      {intro && <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{intro}</div>}
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {rows.length === 0 ? <div className="muted">{t('inv.order.nothing')}</div> : (
        <div className="table compact">
          <table>
            <thead><tr>
              <th style={{ width: 28 }} /><th>{t('inv.col.part')}</th><th>{t('inv.col.supplier')}</th><th className="num">{t('inv.col.qty')}</th>
              {showCost && <th className="num">{t('inv.col.unitCost')}</th>}{showCost && <th className="num">{t('inv.col.amount')}</th>}
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const q = parseDecimal(r.qtyText) || 0
                const c = readAmount(r.costText) || 0
                return (
                  <tr key={r.key} className={r.checked ? '' : 'dim'}>
                    <td><Tick checked={!!r.checked} onChange={(v) => set(r.key, { checked: v })} label={t('inv.order.pick', { name: r.name })} /></td>
                    <td><b>{r.name}</b>{r.part_number && <span className="muted small"> · {r.part_number}</span>}{r.note && <div className="small muted">{r.note}</div>}</td>
                    <td>
                      <select className={`select cell ${errors[`${r.key}.s`] ? 'invalid' : ''}`} value={r.supplier_id} disabled={!r.checked}
                        onChange={(e) => set(r.key, { supplier_id: e.target.value })} aria-label={t('inv.order.supplierFor', { name: r.name })}>
                        <option value="">{t('inv.order.chooseSupplier')}</option>
                        {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      {errors[`${r.key}.s`] && <div className="error small">{errors[`${r.key}.s`]}</div>}
                    </td>
                    <td className="num">
                      <input className={`input cell num narrow ${errors[`${r.key}.q`] ? 'invalid' : ''}`} value={r.qtyText} disabled={!r.checked} inputMode="decimal"
                        onChange={(e) => set(r.key, { qtyText: e.target.value })} aria-label={t('inv.order.qtyFor', { name: r.name })} />
                      {errors[`${r.key}.q`] && <div className="error small">{errors[`${r.key}.q`]}</div>}
                    </td>
                    {showCost && (
                      <td className="num">
                        <input className={`input cell num ${errors[`${r.key}.c`] ? 'invalid' : ''}`} value={r.costText} disabled={!r.checked} inputMode="numeric"
                          onChange={(e) => set(r.key, { costText: e.target.value })} aria-label={t('inv.order.costFor', { name: r.name })} />
                        {errors[`${r.key}.c`] && <div className="error small">{errors[`${r.key}.c`]}</div>}
                      </td>
                    )}
                    {showCost && <td className="num nowrap">{rp(lineAmount(c, r.core_cost, q, r.taxable, taxRate))}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {showCost && <div className="hint">{t('inv.order.costHint')}</div>}
    </Modal>
  )
}
