import React from 'react'
import { Link } from 'react-router-dom'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { num } from '../../lib/format'
import { openQty, stockState } from '../../lib/inventory'
import { PoBadge } from '../inventory/bits'

// Part lines on this job that could still be ordered: on pending or approved work and not already on a PO.
export function partCandidates(job, cat, t) {
  const live = new Set(job.services.filter((s) => s.approval_status === 'pending' || s.approval_status === 'approved').map((s) => s.id))
  return job.items.filter((l) => l.item_type === 'part' && live.has(l.service_id) && !l.po_item_id && !l.stock_deducted).map((l) => {
    const ci = l.catalog_item_id ? cat.itemById[l.catalog_item_id] : null
    const st = ci?.track_inventory ? stockState(ci, cat.stockById[ci.id]) : null
    // Ticked when the shelf can't cover it (or the part isn't stocked at all).
    const short = st ? st.onHand < Number(l.qty) : true
    return {
      key: l.id, ro_service_item_id: l.id, catalog_item_id: l.catalog_item_id, name: l.name, part_number: ci?.code || null,
      cost: Number(l.cost) || Number(ci?.cost) || 0, core_cost: ci?.has_core ? Number(ci.core_cost) || 0 : 0, taxable: !!ci?.taxable,
      qty: Number(l.qty), supplier_id: ci?.supplier_id || '', checked: short,
      note: st ? t('job.po.stockNote', { n: num(st.onHand, 2) }) : ci ? t('job.po.notTracked') : t('job.po.notInCatalog'),
    }
  })
}

// Side card: the purchase orders raised for this job, and a way to order its parts.
export function PartsOrdersCard({ job, cat, canOrder, candidates, onOrder }) {
  const { t } = useT()
  if (!job.pos.length && !(canOrder && candidates.length)) return null
  return (
    <section className="card side-card">
      <div className="row" style={{ gap: 8 }}>
        <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.po.card')}</div>
        <div className="spacer" />
        {canOrder && candidates.length > 0 && <button type="button" className="linkbtn small" onClick={onOrder}><Icon name="packages" size={13} /> {t('job.po.order')}</button>}
      </div>
      {job.pos.length === 0 ? <div className="muted small">{t('job.po.none', { n: candidates.length })}</div> : (
        <div className="partsorders">
          {job.pos.map((po) => {
            const lines = job.poLines.filter((l) => l.po_id === po.id)
            const waiting = lines.reduce((a, l) => a + openQty(l), 0)
            return (
              <Link key={po.id} to={`/inventory/purchase-orders/${po.id}`} className="porow">
                <span style={{ flex: 1, minWidth: 0 }}><b>{po.po_number}</b><span className="muted small"> · {cat.supplierById[po.supplier_id]?.name || '—'} · {t(lines.length === 1 ? 'job.po.nPart' : 'job.po.nParts', { n: lines.length })}{waiting > 0 && po.status !== 'draft' ? ` · ${t('job.po.waiting', { n: num(waiting, 2) })}` : ''}</span></span>
                <PoBadge status={po.status} />
              </Link>
            )
          })}
        </div>
      )}
    </section>
  )
}
