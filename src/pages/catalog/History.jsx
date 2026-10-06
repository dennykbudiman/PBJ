import React, { useState } from 'react'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { fmtDateTime, num, rp } from '../../lib/format'
import { categoryPath } from './useCatalogData'

const MONEY = ['cost', 'price', 'core_cost', 'flat_price', 'max_amount', 'price_override']
const COST_FIELDS = ['cost', 'markup_pct']
const HIDDEN = ['id', 'created_at', 'updated_at', 'qty_on_hand', 'template_id', 'item_id', 'checklist_id_line']

// Field name → label key. Unknown fields fall back to the raw name.
const LABEL = {
  name: 'cat.name', code: 'cat.code', description: 'cat.description', category_id: 'cat.category', supplier_id: 'cat.supplier',
  brand: 'cat.brand', cost: 'cat.cost', price: 'cat.price', markup_pct: 'cat.markup', default_qty: 'cat.defaultQty',
  labor_hours: 'cat.hours', labor_rate_id: 'cat.laborRate', fee_kind: 'cat.feeKind', fee_value: 'cat.value', taxable: 'cat.tax',
  show_on_invoice: 'cat.showOnInvoice', show_qty_price: 'cat.showQtyPrice', track_inventory: 'cat.trackInventory',
  reorder_point: 'cat.reorderAt', has_core: 'cat.hasCore', core_cost: 'cat.coreCharge', tire_size: 'cat.tireSize', notes: 'cat.notes',
  active: 'cat.statusActive', item_type: 'cat.feeKind', tags: 'cat.tags', flat_price: 'cat.flatPrice', checklist_id: 'cat.checklist',
  default_interval_km: 'cat.everyKm', default_interval_months: 'cat.everyMonths', level: 'cat.appliesTo', kind: 'cat.discountKind',
  value: 'cat.value', max_amount: 'cat.maxDiscount', valid_from: 'cat.validFrom', valid_to: 'cat.validTo', category: 'cat.group',
  parent_id: 'cat.parent', applies_to: 'cat.usedFor', type: 'cat.supplierType', payment_terms_days: 'cat.termsDays',
  account_number: 'cat.accountNo', contact_name: 'cat.contactName', phone: 'settings.phone', email: 'settings.email',
  address: 'settings.address', pinned_notes: 'cat.pinnedNotes', qty: 'cat.qty', price_override: 'cat.price', position: 'cat.position',
  note: 'cat.note', catalog_item_id: 'cat.line',
}

// Who changed what on one catalog record, newest first. Loaded only when opened.
// Parts also show their stock ledger (opening stock, adjustments, jobs, deliveries).
export default function History({ entityType, entityId, data, showCost, stock }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  async function load() {
    setOpen(true)
    setError(null)
    const [log, people, moves] = await Promise.all([
      supabase.from('activity_log').select('*').eq('entity_type', entityType).eq('entity_id', entityId).order('created_at', { ascending: false }).limit(100),
      supabase.from('profiles').select('id, name'),
      stock ? supabase.from('stock_movements').select('*').eq('catalog_item_id', entityId).order('created_at', { ascending: false }).limit(100) : { data: [] },
    ])
    const err = log.error || people.error || moves.error
    if (err) { setError(errorText(err, t)); setRows([]); return }
    const who = Object.fromEntries((people.data || []).map((p) => [p.id, p.name]))
    const all = [
      ...(log.data || []).map((r) => ({ kind: 'log', at: r.created_at, who: who[r.user_id], r })),
      ...(moves.data || []).map((m) => ({ kind: 'stock', at: m.created_at, who: who[m.created_by], r: m })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    setRows(all)
  }

  const nameOf = (field, v) => {
    if (v == null || v === '') return '—'
    if (field === 'category_id' || field === 'parent_id') return categoryPath(data.categoryById[v], data.categoryById) || '?'
    if (field === 'supplier_id') return data.supplierById[v]?.name || '?'
    if (field === 'labor_rate_id') return data.rateById[v]?.name || '?'
    if (field === 'checklist_id') return data.checklists.find((c) => c.id === v)?.name || '?'
    if (field === 'catalog_item_id' || field === 'fee_item_id') return data.itemById[v]?.name || '?'
    if (field === 'item_id') return data.insp.find((x) => x.id === v)?.name || '?'
    if (typeof v === 'boolean') return v ? t('cat.yes') : t('cat.no')
    if (Array.isArray(v)) return v.length ? v.join(', ') : '—'
    if (MONEY.includes(field)) return rp(v)
    if (typeof v === 'number') return num(v, 2)
    if (field === 'level') return t(`cat.level.${v}`)
    if (field === 'kind') return t(`cat.kind.${v}`)
    if (field === 'fee_kind') return t(`cat.feeKind.${v}`)
    if (field === 'applies_to') return t(`cat.applies.${v}`)
    if (field === 'type') return t(`cat.stype.${v}`)
    return String(v)
  }
  const visible = (field) => !HIDDEN.includes(field) && (showCost || !COST_FIELDS.includes(field))
  const changeList = (diff) => Object.entries(diff || {}).filter(([k]) => visible(k)).map(([k, [a, b]]) => (
    <div key={k} className="hist-change"><span className="muted">{LABEL[k] ? t(LABEL[k]) : k}:</span> {nameOf(k, a)} → <b>{nameOf(k, b)}</b></div>
  ))

  // A line belongs to a bundle, inspection point, checklist or part: say which line in plain words.
  function lineLabel(c) {
    const row = c?.row || {}
    if (c?.table === 'service_template_items') return `${nameOf('catalog_item_id', row.catalog_item_id)} × ${num(row.qty, 2)}${row.price_override != null ? ` · ${rp(row.price_override)}` : ''}`
    if (c?.table === 'inspection_item_notes') return `${row.note} (${t(`cat.flag.${row.red ? 'red' : row.yellow ? 'yellow' : 'green'}`)})`
    if (c?.table === 'inspection_checklist_items') return nameOf('item_id', row.item_id)
    if (c?.table === 'catalog_item_fees') return nameOf('fee_item_id', row.fee_item_id)
    return ''
  }

  function describe(e) {
    if (e.kind === 'stock') {
      const m = e.r
      const q = Number(m.qty_change)
      return <>
        <div><b style={{ color: q < 0 ? 'var(--red)' : 'var(--green)' }}>{q > 0 ? '+' : ''}{num(q, 2)}</b> {t('cat.hist.stock')} · {t(`cat.reason.${m.reason}`)}</div>
        {m.note && !(m.reason === 'opening' && m.note === t('cat.openingNote')) && <div className="muted">{m.note}</div>}
      </>
    }
    const r = e.r
    if (r.action === 'create') return <div>{t('cat.hist.created')}</div>
    if (r.action === 'delete') return <div>{t('cat.hist.deleted')}</div>
    if (r.action === 'line_add') return <div>{t('cat.hist.lineAdd')}: <b>{lineLabel(r.changes)}</b></div>
    if (r.action === 'line_remove') return <div>{t('cat.hist.lineRemove')}: <b>{lineLabel(r.changes)}</b></div>
    if (r.action === 'line_update') {
      const diff = r.changes?.diff || {}
      if (Object.keys(diff).every((k) => k === 'position')) return <div>{t('cat.hist.reordered')}: {lineLabel(r.changes)}</div>
      return <><div>{t('cat.hist.lineUpdate')}: <b>{lineLabel(r.changes)}</b></div>{changeList(Object.fromEntries(Object.entries(diff).filter(([k]) => k !== 'position')))}</>
    }
    const list = changeList(r.changes)
    return list.length ? list : <div className="muted">{t('cat.hist.hiddenChange')}</div>
  }

  return (
    <div className="history">
      {!open ? (
        <button type="button" className="linkbtn small" onClick={load}>{t('cat.hist.show')}</button>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button type="button" className="linkbtn small" onClick={() => { setOpen(false); setRows(null) }}>{t('cat.hist.hide')}</button>
          </div>
          {error && <div className="error">{error}</div>}
          {!rows ? <div className="muted small">{t('common.loading')}</div>
            : rows.length === 0 ? <div className="muted small">{t('cat.hist.none')}</div>
              : (
                <ol className="hist" aria-label={t('cat.hist.title')}>
                  {rows.map((e, i) => (
                    <li key={`${e.kind}-${e.r.id}-${i}`}>
                      <div className="hist-meta">{e.who || t('cat.hist.system')} · {fmtDateTime(e.at, lang, timezone)}</div>
                      <div className="hist-body">{describe(e)}</div>
                    </li>
                  ))}
                </ol>
              )}
          {rows && rows.length >= 100 && <div className="hint">{t('cat.hist.latest100')}</div>}
        </>
      )}
    </div>
  )
}
