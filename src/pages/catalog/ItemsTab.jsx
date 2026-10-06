import React, { useEffect, useMemo, useState } from 'react'
import { Badge, Input, Select, Textarea, Toggle, useToast } from '../../components/ui'
import { EditorPanel, EmptyCard, ListShell, SearchBox, Section, RowLink, deleteErrorText } from './common'
import { categoryPath } from './useCatalogData'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { num, parseDecimal, readAmount, rp } from '../../lib/format'

const TYPE_OF_TAB = { labor: 'labor', parts: 'part', fees: 'fee' }
const TAB_OF_TYPE = { labor: 'labor', part: 'parts', fee: 'fees' }

const dec = (v) => (v == null || v === '' ? '' : String(Number(v)).replace('.', ','))
const amt = (v) => (v == null || v === '' ? '' : num(v))

// Labor, Parts and Fees are all catalog items; this tab shows one type at a time.
export default function ItemsTab({ tab, data, id, canEdit, showCost, reload, go }) {
  const { t } = useT()
  const type = TYPE_OF_TAB[tab]
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [status, setStatus] = useState('active')

  const cats = data.categories.filter((c) => c.applies_to === type || c.applies_to === 'any')
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return data.items.filter((x) => {
      if (x.item_type !== type) return false
      if (status === 'active' && !x.active && x.id !== id) return false
      if (status === 'inactive' && x.active) return false
      if (cat !== 'all' && x.category_id !== cat) return false
      if (!needle) return true
      return [x.name, x.code, x.brand, x.description].filter(Boolean).join(' ').toLowerCase().includes(needle)
    })
  }, [data, type, q, cat, status, id])

  const isNew = id === 'new'
  // An item only opens under its own tab, so a part can't be saved as labor from an edited link.
  const selected = isNew ? null : data.itemById[id]?.item_type === type ? data.itemById[id] : null
  const base = `/catalog/${tab}`
  // A link to an item under the wrong tab goes to the right one.
  const elsewhere = !isNew && id && data.itemById[id] && !selected ? data.itemById[id] : null
  useEffect(() => {
    if (elsewhere) go(`/catalog/${TAB_OF_TYPE[elsewhere.item_type]}/${elsewhere.id}`)
  }, [elsewhere?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = data.items.filter((x) => x.item_type === type).length

  const panel = id && (isNew || selected) ? (
    <ItemEditor key={`${id}:${data.version}`} type={type} item={selected} data={data} canEdit={canEdit} showCost={showCost}
      onClose={() => go(base)}
      onSaved={async (row) => { await reload(); go(`${base}/${row.id}`) }}
      onDeleted={async () => { await reload(); go(base) }} />
  ) : id && !elsewhere ? <EmptyCard icon="info" title={t('cat.notFound')} /> : null

  const filters = (
    <>
      <SearchBox value={q} onChange={setQ} placeholder={t(`cat.search.${tab}`)} />
      <select className="select chipselect" value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t('cat.category')}>
        <option value="all">{t('cat.categoryAll')}</option>
        {cats.map((c) => <option key={c.id} value={c.id}>{categoryPath(c, data.categoryById)}</option>)}
      </select>
      <select className="select chipselect" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('cat.status')}>
        <option value="active">{t('cat.statusActive')}</option>
        <option value="inactive">{t('cat.statusInactive')}</option>
        <option value="all">{t('cat.statusAll')}</option>
      </select>
    </>
  )

  const empty = total === 0
    ? <EmptyCard icon="book" title={t(`cat.empty.${tab}`)} text={t(`cat.emptyText.${tab}`)} />
    : rows.length === 0 ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null

  return (
    <ListShell title={t(`cat.tab.${tab}`)} sub={t(`cat.sub.${tab}`)} addLabel={t(`cat.add.${tab}`)} onAdd={() => go(`${base}/new`)}
      canEdit={canEdit} filters={filters} panel={panel} empty={empty}>
      <div className="table">
        <table>
          <thead>
            {type === 'part' && <tr><th>{t('cat.name')}</th><th>{t('cat.partNo')}</th><th className="xwide-only">{t('cat.supplier')}</th><th className="wide-only">{t('cat.category')}</th>{showCost && <th className="num wide-only">{t('cat.cost')}</th>}<th className="num">{t('cat.price')}</th><th className="num wide-only">{t('cat.core')}</th><th className="num">{t('cat.onHand')}</th><th className="xwide-only">{t('cat.tax')}</th></tr>}
            {type === 'labor' && <tr><th>{t('cat.name')}</th><th className="wide-only">{t('cat.code')}</th><th className="wide-only">{t('cat.category')}</th><th className="num">{t('cat.hours')}</th><th className="wide-only">{t('cat.rate')}</th><th className="num">{t('cat.price')}</th><th className="wide-only">{t('cat.tax')}</th></tr>}
            {type === 'fee' && <tr><th>{t('cat.name')}</th><th>{t('cat.feeKind')}</th><th className="num">{t('cat.value')}</th><th className="wide-only">{t('cat.autoAddedTo')}</th><th>{t('cat.tax')}</th></tr>}
          </thead>
          <tbody>
            {rows.map((x) => {
              const stock = data.stockById[x.id]
              const low = x.track_inventory && x.reorder_point != null && Number(stock?.qty_on_hand ?? x.qty_on_hand) <= Number(x.reorder_point)
              const usedBy = type === 'fee' ? data.itemFees.filter((f) => f.fee_item_id === x.id).length : 0
              return (
                <tr key={x.id} className={`click ${x.id === id ? 'selected' : ''}`} onClick={() => go(`${base}/${x.id}`)}>
                  <td><RowLink to={`${base}/${x.id}`} go={go}>{x.name}</RowLink>{!x.active && <> <Badge color="gray">{t('cat.inactive')}</Badge></>}{x.brand && type === 'part' && <div className="muted small">{x.brand}</div>}</td>
                  {type === 'part' && <>
                    <td className="muted code">{x.code || '—'}</td>
                    <td className="xwide-only">{data.supplierById[x.supplier_id]?.name || <span className="muted">—</span>}</td>
                    <td className="wide-only">{x.category_id ? <Badge color="blue">{categoryPath(data.categoryById[x.category_id], data.categoryById)}</Badge> : <span className="muted">—</span>}</td>
                    {showCost && <td className="num wide-only">{rp(x.cost)}</td>}
                    <td className="num">{rp(x.price)}</td>
                    <td className="num wide-only">{x.has_core ? rp(x.core_cost) : '—'}</td>
                    <td className="num" style={{ color: low ? 'var(--red)' : undefined, fontWeight: low ? 800 : undefined }}>{x.track_inventory ? num(stock?.qty_on_hand ?? x.qty_on_hand, 2) : '—'}</td>
                    <td className="xwide-only">{x.taxable ? t('cat.yes') : t('cat.no')}</td>
                  </>}
                  {type === 'labor' && <>
                    <td className="muted wide-only">{x.code || '—'}</td>
                    <td className="wide-only">{x.category_id ? <Badge color="blue">{categoryPath(data.categoryById[x.category_id], data.categoryById)}</Badge> : <span className="muted">—</span>}</td>
                    <td className="num">{x.labor_hours == null ? '—' : num(x.labor_hours, 2)}</td>
                    <td className="wide-only">{data.rateById[x.labor_rate_id]?.name || <span className="muted">—</span>}</td>
                    <td className="num">{rp(x.price)}</td>
                    <td className="wide-only">{x.taxable ? t('cat.yes') : t('cat.no')}</td>
                  </>}
                  {type === 'fee' && <>
                    <td>{t(`cat.feeKind.${x.fee_kind || 'fixed'}`)}</td>
                    <td className="num">{x.fee_kind === 'percent' ? `${num(x.fee_value, 2)}%` : rp(x.fee_value ?? x.price)}</td>
                    <td className="muted wide-only">{usedBy ? t('cat.itemsCount', { n: usedBy }) : '—'}</td>
                    <td>{x.taxable ? t('cat.yes') : t('cat.no')}</td>
                  </>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">{t(`cat.listHint.${tab}`)}</div>
    </ListShell>
  )
}

function emptyItem(type, settings, rates) {
  const defRate = rates.find((r) => r.is_default && r.active) || rates.find((r) => r.active)
  return {
    item_type: type, name: '', code: '', description: '', category_id: '', supplier_id: '', brand: '',
    cost: 0, price: 0, markup_pct: null, default_qty: 1, labor_hours: null, labor_rate_id: type === 'labor' ? defRate?.id || '' : '',
    fee_kind: type === 'fee' ? 'fixed' : null, fee_value: null, taxable: Boolean(settings?.new_items_taxable),
    show_on_invoice: true, show_qty_price: true, track_inventory: type === 'part', qty_on_hand: 0, reorder_point: null,
    has_core: false, core_cost: 0, tire_size: '', notes: '', active: true,
  }
}

function ItemEditor({ type, item, data, canEdit, showCost, onClose, onSaved, onDeleted }) {
  const { t } = useT()
  const toast = useToast()
  const { settings } = useShop()
  const isNew = !item
  const src = item || emptyItem(type, settings, data.rates)
  const [f, setF] = useState(() => ({
    name: src.name || '', code: src.code || '', description: src.description || '', category_id: src.category_id || '',
    supplier_id: src.supplier_id || '', brand: src.brand || '', cost: amt(src.cost), price: amt(src.price),
    markup: dec(src.markup_pct), default_qty: dec(src.default_qty), hours: dec(src.labor_hours), rate_id: src.labor_rate_id || '',
    fee_kind: src.fee_kind || 'fixed', fee_value: src.fee_kind === 'percent' ? dec(src.fee_value) : amt(src.fee_value ?? (type === 'fee' ? src.price : null)),
    taxable: src.taxable, show_on_invoice: src.show_on_invoice, show_qty_price: src.show_qty_price,
    track_inventory: src.track_inventory, reorder_point: dec(src.reorder_point), opening: '',
    has_core: src.has_core, core_cost: amt(src.core_cost), tire_size: src.tire_size || '', notes: src.notes || '', active: src.active,
  }))
  const initialFees = useMemo(() => data.itemFees.filter((x) => x.item_id === item?.id).map((x) => x.fee_item_id), [data.itemFees, item?.id])
  const [fees, setFees] = useState(initialFees)
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const dis = !canEdit
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))

  // Labor price follows hours × rate unless someone typed a different price.
  const rate = data.rateById[f.rate_id]
  const laborSuggest = (h, r) => {
    const hv = parseDecimal(h)
    return hv != null && r ? Math.round(hv * Number(r.rate_per_hour)) : null
  }
  function setHoursOrRate(patch) {
    setF((x) => {
      const before = laborSuggest(x.hours, data.rateById[x.rate_id])
      const next = { ...x, ...patch }
      const after = laborSuggest(next.hours, data.rateById[next.rate_id])
      const current = readAmount(x.price)
      if (after != null && (current === null || current === 0 || current === before)) next.price = num(after)
      return next
    })
  }
  // Part price and markup move together: change one and the other follows.
  function setCostOrMarkup(patch) {
    setF((x) => {
      const next = { ...x, ...patch }
      const c = readAmount(next.cost)
      const m = parseDecimal(next.markup)
      if (c != null && !Number.isNaN(c) && m != null) next.price = num(Math.round(c * (1 + m / 100)))
      return next
    })
  }
  function setPrice(v) {
    setF((x) => {
      const next = { ...x, price: v }
      const c = readAmount(next.cost)
      const p = readAmount(v)
      if (showCost && c && p != null && !Number.isNaN(p) && x.markup !== '') {
        const m = Math.round((p / c - 1) * 1000) / 10
        // Outside the allowed range the markup is cleared rather than left as a value that blocks saving.
        next.markup = m >= -100 && m <= 1000 ? String(m).replace('.', ',') : ''
      }
      return next
    })
  }

  const cats = data.categories.filter((c) => c.applies_to === type || c.applies_to === 'any')
  const feeItems = data.items.filter((x) => x.item_type === 'fee' && (x.active || fees.includes(x.id)))
  const dupCode = f.code.trim() && data.items.find((x) => x.id !== item?.id && x.item_type === type && (x.code || '').trim().toLowerCase() === f.code.trim().toLowerCase())
  const stock = item ? data.stockById[item.id] : null
  const onHand = Number(stock?.qty_on_hand ?? item?.qty_on_hand ?? 0)
  const onEst = Number(stock?.qty_on_estimates ?? 0)

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    const cost = readAmount(f.cost)
    if (Number.isNaN(cost)) e.cost = t('settings.badAmount')
    let price = readAmount(f.price)
    if (Number.isNaN(price)) e.price = t('settings.badAmount')
    const markup = parseDecimal(f.markup)
    if (showCost && f.markup.trim() && (markup === null || markup < -100 || markup > 1000)) e.markup = t('cat.markupRule')
    const qty = parseDecimal(f.default_qty)
    if (qty === null || qty < 0.01 || qty > 10000) e.default_qty = t('cat.qtyRule')
    const hours = parseDecimal(f.hours)
    if (type === 'labor' && f.hours.trim() && (hours === null || hours < 0 || hours > 1000)) e.hours = t('cat.hoursRule')
    let feeValue = null
    if (type === 'fee') {
      feeValue = f.fee_kind === 'percent' ? parseDecimal(f.fee_value) : readAmount(f.fee_value)
      if (feeValue === null || Number.isNaN(feeValue) || feeValue < 0 || (f.fee_kind === 'percent' && feeValue > 100)) e.fee_value = f.fee_kind === 'percent' ? t('settings.max100') : t('settings.badAmount')
      price = f.fee_kind === 'fixed' && !e.fee_value ? feeValue : 0
    }
    const core = readAmount(f.core_cost)
    if (f.has_core && (core === null || Number.isNaN(core))) e.core_cost = t('settings.badAmount')
    const reorder = parseDecimal(f.reorder_point)
    if (f.reorder_point.trim() && (reorder === null || reorder < 0)) e.reorder_point = t('settings.badNumber')
    const opening = parseDecimal(f.opening)
    if (isNew && f.opening.trim() && (opening === null || opening < 0)) e.opening = t('settings.badNumber')
    setErrors(e)
    if (Object.keys(e).length) return

    const row = {
      item_type: type, name: f.name.trim(), code: f.code.trim() || null, description: f.description.trim() || null,
      category_id: f.category_id || null, taxable: f.taxable, show_on_invoice: f.show_on_invoice, show_qty_price: f.show_qty_price,
      active: f.active, notes: f.notes.trim() || null, default_qty: qty, cost: cost ?? 0, price: price ?? 0,
      supplier_id: type === 'part' ? f.supplier_id || null : null,
      brand: type === 'part' ? f.brand.trim() || null : null,
      markup_pct: type === 'part' && f.markup.trim() ? markup : null,
      labor_hours: type === 'labor' && f.hours.trim() ? hours : null,
      labor_rate_id: type === 'labor' ? f.rate_id || null : null,
      fee_kind: type === 'fee' ? f.fee_kind : null, fee_value: type === 'fee' ? feeValue : null,
      track_inventory: type === 'part' ? f.track_inventory : false,
      reorder_point: type === 'part' && f.track_inventory && f.reorder_point.trim() ? reorder : null,
      has_core: type === 'part' ? f.has_core : false, core_cost: type === 'part' && f.has_core ? core ?? 0 : 0,
      tire_size: type === 'part' ? f.tire_size.trim() || null : null,
    }
    setBusy(true)
    setMsg(null)
    const res = isNew
      ? await supabase.from('catalog_items').insert(row).select().single()
      : await supabase.from('catalog_items').update(row).eq('id', item.id).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    const saved = res.data
    // Auto-added fees: add the new links, remove the dropped ones.
    if (type !== 'fee') {
      const add = fees.filter((x) => !initialFees.includes(x)).map((fee) => ({ item_id: saved.id, fee_item_id: fee }))
      const drop = initialFees.filter((x) => !fees.includes(x))
      if (add.length) {
        const { error } = await supabase.from('catalog_item_fees').insert(add)
        if (error) toast(errorText(error, t), 'err')
      }
      if (drop.length) {
        const { error } = await supabase.from('catalog_item_fees').delete().eq('item_id', saved.id).in('fee_item_id', drop)
        if (error) toast(errorText(error, t), 'err')
      }
    }
    // Opening stock for a new tracked part goes in the stock ledger.
    if (isNew && type === 'part' && f.track_inventory && opening) {
      const { error } = await supabase.from('stock_movements').insert({ catalog_item_id: saved.id, qty_change: opening, reason: 'opening', note: t('cat.openingNote') })
      if (error) toast(t('cat.openingFailed', { error: errorText(error, t) }), 'err')
    }
    toast(t('cat.saved', { name: saved.name }))
    await onSaved(saved)
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('catalog_items').delete().eq('id', item.id)
    setBusy(false)
    if (error) return setMsg(deleteErrorText(error, t))
    toast(t('cat.deleted', { name: item.name }))
    onDeleted()
  }

  const suggest = laborSuggest(f.hours, rate)
  const markupHint = showCost && type === 'part' && readAmount(f.cost) > 0 && readAmount(f.price) > 0
    ? t('cat.margin', { pct: num(Math.round((1 - readAmount(f.cost) / Math.max(1, readAmount(f.price))) * 1000) / 10, 1) }) : null

  return (
    <EditorPanel title={isNew ? t(`cat.new.${type}`) : item.name} subtitle={!isNew ? [item.code, categoryPath(data.categoryById[item.category_id], data.categoryById)].filter(Boolean).join(' · ') : null}
      badges={!isNew && !item.active ? <Badge color="gray">{t('cat.inactive')}</Badge> : null}
      canEdit={canEdit} busy={busy} error={msg} onSave={save} onClose={onClose} onDelete={remove} isNew={isNew}>
      <div className="grid2">
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={set('name')} error={errors.name} disabled={dis} autoFocus={isNew} />
        <Input label={type === 'part' ? t('cat.partNo') : t('cat.code')} value={f.code} onChange={set('code')} disabled={dis}
          hint={dupCode ? t('cat.dupCode', { name: dupCode.name }) : null} />
        <Select label={t('cat.category')} value={f.category_id} onChange={set('category_id')} disabled={dis}
          options={[{ value: '', label: '—' }, ...cats.map((c) => ({ value: c.id, label: categoryPath(c, data.categoryById) }))]} />
        {type === 'part' && <>
          <Input label={t('cat.brand')} value={f.brand} onChange={set('brand')} disabled={dis} />
          <Select label={t('cat.supplier')} value={f.supplier_id} onChange={set('supplier_id')} disabled={dis}
            options={[{ value: '', label: '—' }, ...data.suppliers.filter((s) => s.active || s.id === f.supplier_id).map((s) => ({ value: s.id, label: s.name }))]} />
        </>}
        <Textarea fieldClass="span2" label={t('cat.description')} value={f.description} onChange={set('description')} disabled={dis} rows={2} hint={t('cat.descriptionHint')} />
      </div>

      <Section title={t('cat.pricing')}>
        {type === 'labor' && (
          <div className="grid2">
            <Select label={t('cat.laborRate')} value={f.rate_id} disabled={dis} onChange={(e) => setHoursOrRate({ rate_id: e.target.value })}
              options={[{ value: '', label: '—' }, ...data.rates.filter((r) => r.active || r.id === f.rate_id).map((r) => ({ value: r.id, label: `${r.name} · ${rp(r.rate_per_hour)}` }))]} />
            <Input label={t('cat.hours')} value={f.hours} disabled={dis} inputMode="decimal" suffix={t('cat.hoursShort')} error={errors.hours}
              onChange={(e) => setHoursOrRate({ hours: e.target.value })} />
            <Input label={t('cat.price')} value={f.price} onChange={set('price')} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.price}
              hint={suggest != null ? (readAmount(f.price) === suggest ? t('cat.hoursTimesRate') : t('cat.differsFromRate', { amount: rp(suggest) })) : t('cat.pickRate')} />
            {showCost && <Input label={t('cat.costOptional')} value={f.cost} onChange={set('cost')} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.cost} hint={t('cat.laborCostHint')} />}
          </div>
        )}
        {type === 'part' && (
          <div className="grid2">
            {showCost && <>
              <Input label={t('cat.cost')} value={f.cost} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.cost} onChange={(e) => setCostOrMarkup({ cost: e.target.value })} />
              <Input label={t('cat.markup')} value={f.markup} disabled={dis} inputMode="decimal" suffix="%" error={errors.markup} onChange={(e) => setCostOrMarkup({ markup: e.target.value })} hint={t('cat.markupHint')} />
            </>}
            <Input label={t('cat.price')} value={f.price} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.price} onChange={(e) => setPrice(e.target.value)} hint={markupHint} />
            <Input label={t('cat.defaultQty')} value={f.default_qty} onChange={set('default_qty')} disabled={dis} inputMode="decimal" error={errors.default_qty} />
          </div>
        )}
        {type === 'fee' && (
          <div className="grid2">
            <Select label={t('cat.feeKind')} value={f.fee_kind} disabled={dis} onChange={(e) => setF((x) => ({ ...x, fee_kind: e.target.value, fee_value: '' }))}
              options={[{ value: 'fixed', label: t('cat.feeKind.fixed') }, { value: 'percent', label: t('cat.feeKind.percent') }]} />
            <Input label={f.fee_kind === 'percent' ? t('cat.percent') : t('cat.amount')} value={f.fee_value} onChange={set('fee_value')} disabled={dis}
              inputMode="decimal" prefix={f.fee_kind === 'percent' ? null : 'Rp'} suffix={f.fee_kind === 'percent' ? '%' : null} error={errors.fee_value}
              hint={f.fee_kind === 'percent' ? t('cat.percentFeeHint') : null} />
          </div>
        )}
        {type === 'part' && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle checked={f.has_core} onChange={set('has_core')} disabled={dis} label={t('cat.hasCore')} />
            {f.has_core && <Input label={t('cat.coreCharge')} value={f.core_cost} onChange={set('core_cost')} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.core_cost} hint={t('cat.coreHint')} />}
            <Input label={t('cat.tireSize')} value={f.tire_size} onChange={set('tire_size')} disabled={dis} placeholder="265/65 R17" hint={t('cat.tireHint')} />
          </div>
        )}
      </Section>

      {type !== 'fee' && (
        <Section title={t('cat.autoFees')}>
          {feeItems.length === 0 ? <div className="muted small">{t('cat.noFees')}</div> : (
            <div className="checklist">
              {feeItems.map((fee) => (
                <label key={fee.id} className="checkrow">
                  <input type="checkbox" disabled={dis} checked={fees.includes(fee.id)}
                    onChange={(e) => setFees((xs) => (e.target.checked ? [...xs, fee.id] : xs.filter((x) => x !== fee.id)))} />
                  <span>{fee.name}</span>
                  <span className="muted small">{fee.fee_kind === 'percent' ? `${num(fee.fee_value, 2)}%` : rp(fee.fee_value ?? fee.price)}</span>
                </label>
              ))}
            </div>
          )}
          <div className="hint">{t('cat.autoFeesHint')}</div>
        </Section>
      )}

      {type === 'part' && (
        <Section title={t('cat.inventory')}>
          <Toggle checked={f.track_inventory} onChange={set('track_inventory')} disabled={dis || (!isNew && onHand !== 0 && f.track_inventory)} label={t('cat.trackInventory')} />
          {!isNew && onHand !== 0 && <div className="hint">{t('cat.trackLocked')}</div>}
          {f.track_inventory && (
            <div className="grid4" style={{ marginTop: 10 }}>
              {isNew ? (
                <Input label={t('cat.openingStock')} value={f.opening} onChange={set('opening')} disabled={dis} inputMode="decimal" error={errors.opening} />
              ) : <>
                <div className="field"><span className="fieldlabel">{t('cat.onHand')}</span><div className="readonly">{num(onHand, 2)}</div></div>
                <div className="field"><span className="fieldlabel">{t('cat.onEstimates')}</span><div className="readonly">{num(onEst, 2)}</div></div>
                <div className="field"><span className="fieldlabel">{t('cat.available')}</span><div className="readonly" style={{ color: onHand - onEst < 0 ? 'var(--red)' : undefined }}>{num(onHand - onEst, 2)}</div></div>
              </>}
              <Input label={t('cat.reorderAt')} value={f.reorder_point} onChange={set('reorder_point')} disabled={dis} inputMode="decimal" error={errors.reorder_point} />
            </div>
          )}
          {f.track_inventory && <div className="hint">{isNew ? t('cat.openingHint') : t('cat.stockHint')}</div>}
        </Section>
      )}

      <Section title={t('cat.settings')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Toggle checked={f.taxable} onChange={set('taxable')} disabled={dis} label={t('cat.taxable', { tax: settings?.tax_name || 'PPN', rate: num(settings?.tax_rate ?? 11, 2) })} />
          <Toggle checked={f.show_on_invoice} onChange={set('show_on_invoice')} disabled={dis} label={t('cat.showOnInvoice')} />
          {type !== 'fee' && <Toggle checked={f.show_qty_price} onChange={set('show_qty_price')} disabled={dis} label={type === 'labor' ? t('cat.showHoursRate') : t('cat.showQtyPrice')} />}
          <Toggle checked={f.active} onChange={set('active')} disabled={dis} label={t('cat.activeLabel')} />
        </div>
        <Textarea label={t('cat.notes')} value={f.notes} onChange={set('notes')} disabled={dis} rows={2} hint={t('cat.notesHint')} fieldClass="mt" />
      </Section>
    </EditorPanel>
  )
}
