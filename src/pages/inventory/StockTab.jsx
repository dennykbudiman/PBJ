import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Empty, PageHead, useToast } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { num } from '../../lib/format'
import { STOCK_COLOR, stockState } from '../../lib/inventory'
import { SearchBox } from '../catalog/common'
import OrderModal from './OrderModal'
import { Tick } from './bits'

// Inventory → Stock: every tracked part with what's on the shelf, promised to open estimates and on order.
export default function StockTab({ data, reload, go, canEdit, showCost }) {
  const { t } = useT()
  const toast = useToast()
  const { settings } = useShop()
  const [q, setQ] = useState('')
  const [show, setShow] = useState('all')
  const [sup, setSup] = useState('')
  const [sel, setSel] = useState(() => new Set())
  const [ordering, setOrdering] = useState(false)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return data.items.filter((x) => x.track_inventory)
      .map((x) => ({ x, s: stockState(x, data.stockById[x.id]) }))
      .filter(({ x, s }) => {
        if (!x.active && s.onHand === 0 && s.onOrder === 0) return false
        if (show === 'low' && s.status === 'ok') return false
        if (show === 'order' && !s.needsOrder) return false
        if (sup && (x.supplier_id || 'none') !== sup) return false
        if (!needle) return true
        return [x.name, x.code, x.brand].filter(Boolean).join(' ').toLowerCase().includes(needle)
      })
  }, [data, q, show, sup])

  const counts = useMemo(() => {
    const c = { out: 0, low: 0, order: 0 }
    for (const x of data.items) {
      if (!x.track_inventory || !x.active) continue
      const s = stockState(x, data.stockById[x.id])
      if (s.status !== 'ok') c[s.status]++
      if (s.needsOrder) c.order++
    }
    return c
  }, [data])

  const toggle = (id, on) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const allOn = rows.length > 0 && rows.every(({ x }) => sel.has(x.id))
  const candidates = [...sel].map((id) => data.itemById[id]).filter(Boolean).map((x) => {
    const s = stockState(x, data.stockById[x.id])
    return {
      key: x.id, catalog_item_id: x.id, name: x.name, part_number: x.code, cost: x.cost, core_cost: x.has_core ? x.core_cost : 0,
      taxable: x.taxable, qty: s.suggest, supplier_id: x.supplier_id, checked: true,
      note: t('inv.stock.note', { onHand: num(s.onHand, 2), available: num(s.available, 2), onOrder: num(s.onOrder, 2) }),
    }
  })
  const tracked = data.items.some((x) => x.track_inventory)

  return (
    <>
      <PageHead title={t('inv.stock.title')} sub={t('inv.stock.sub')}
        actions={canEdit && sel.size > 0 && <Button variant="primary" icon="packages" onClick={() => setOrdering(true)}>{t('inv.stock.orderSelected', { n: sel.size })}</Button>} />
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <button type="button" className="chipbtn" onClick={() => setShow('low')}><Badge color="red">{t('inv.stock.countOut', { n: counts.out })}</Badge></button>
        <button type="button" className="chipbtn" onClick={() => setShow('low')}><Badge color="amber">{t('inv.stock.countLow', { n: counts.low })}</Badge></button>
        <button type="button" className="chipbtn" onClick={() => setShow('order')}><Badge color="blue">{t('inv.stock.countOrder', { n: counts.order })}</Badge></button>
      </div>
      <div className="filterbar">
        <SearchBox value={q} onChange={setQ} placeholder={t('inv.stock.search')} />
        <select className="select chipselect" value={show} onChange={(e) => setShow(e.target.value)} aria-label={t('inv.show')}>
          <option value="all">{t('inv.stock.f.all')}</option>
          <option value="low">{t('inv.stock.f.low')}</option>
          <option value="order">{t('inv.stock.f.order')}</option>
        </select>
        <select className="select chipselect" value={sup} onChange={(e) => setSup(e.target.value)} aria-label={t('inv.col.supplier')}>
          <option value="">{t('inv.allSuppliers')}</option>
          {data.suppliers.filter((s) => s.type !== 'sublet').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="none">{t('inv.noSupplier')}</option>
        </select>
      </div>
      {!tracked ? (
        <div className="card"><Empty icon="packages" title={t('inv.stock.noneTitle')} action={<Link className="btn" to="/catalog/parts">{t('inv.stock.toCatalog')}</Link>}>{t('inv.stock.noneText')}</Empty></div>
      ) : rows.length === 0 ? (
        <div className="card"><Empty icon="packages" title={t('inv.nothingFound')}>{t('inv.nothingFoundText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr>
              {canEdit && <th style={{ width: 28 }}><Tick checked={allOn} onChange={(v) => setSel(v ? new Set(rows.map(({ x }) => x.id)) : new Set())} label={t('inv.selectAll')} /></th>}
              <th>{t('inv.col.part')}</th><th className="wide-only">{t('inv.col.supplier')}</th>
              <th className="num">{t('inv.col.onHand')}</th><th className="num wide-only">{t('inv.col.onEstimates')}</th><th className="num">{t('inv.col.available')}</th>
              <th className="num">{t('inv.col.onOrder')}</th><th className="num wide-only">{t('inv.col.reorderAt')}</th><th>{t('inv.col.status')}</th>
            </tr></thead>
            <tbody>
              {rows.map(({ x, s }) => (
                <tr key={x.id}>
                  {canEdit && <td><Tick checked={sel.has(x.id)} onChange={(v) => toggle(x.id, v)} label={t('inv.order.pick', { name: x.name })} /></td>}
                  <td>
                    <Link className="rowlink" to={`/catalog/parts/${x.id}`}>{x.name}</Link>
                    <div className="muted small">{[x.code, x.brand].filter(Boolean).join(' · ')}{!x.active ? ` · ${t('inv.inactive')}` : ''}</div>
                  </td>
                  <td className="wide-only">{data.supplierById[x.supplier_id]?.name || <span className="muted">—</span>}</td>
                  <td className="num"><b>{num(s.onHand, 2)}</b></td>
                  <td className="num wide-only">{s.onEst ? num(s.onEst, 2) : <span className="muted">0</span>}</td>
                  <td className="num" style={{ color: s.available < 0 ? 'var(--red)' : undefined, fontWeight: s.available < 0 ? 800 : undefined }}>{num(s.available, 2)}</td>
                  <td className="num">{s.onOrder ? <Link to={`/inventory/purchase-orders?part=${x.id}`}>{num(s.onOrder, 2)}</Link> : <span className="muted">0</span>}</td>
                  <td className="num wide-only">{s.reorder == null ? <span className="muted">—</span> : num(s.reorder, 2)}</td>
                  <td>
                    <Badge color={STOCK_COLOR[s.status]}>{t(`inv.stock.st.${s.status}`)}</Badge>
                    {s.needsOrder && <div className="small" style={{ color: 'var(--blue)' }}>{t('inv.stock.needsOrder')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('inv.stock.hint')}</div>
      <OrderModal open={ordering} onClose={() => setOrdering(false)} title={t('inv.stock.orderTitle')} intro={t('inv.stock.orderIntro')}
        candidates={candidates} suppliers={data.suppliers} roId={null} taxRate={settings?.tax_rate} showCost={showCost}
        onDone={(made, partial) => {
          setOrdering(false); setSel(new Set()); reload()
          if (partial) { toast(partial, 'err'); go('/inventory/purchase-orders'); return }
          toast(made.length === 1 ? t('inv.order.madeOne', { no: made[0].po_number || '' }) : t('inv.order.madeMany', { n: made.length }))
          go(made.length === 1 ? `/inventory/purchase-orders/${made[0].id}` : '/inventory/purchase-orders')
        }} />
    </>
  )
}
