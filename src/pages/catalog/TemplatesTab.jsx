import React, { useEffect, useMemo, useState } from 'react'
import { Badge, Input, Select, Toggle, useToast } from '../../components/ui'
import { EditorPanel, EmptyCard, ListShell, RowButtons, SearchBox, Section, StatusSelect, RowLink, deleteErrorText, move, parseTags, statusMatch, syncRows } from './common'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { num, parseDecimal, readAmount, rp } from '../../lib/format'

// Price of one bundle line: the override when set, otherwise the catalog price.
export function linePrice(line, itemById) {
  return line.price_override != null ? Number(line.price_override) : Number(itemById[line.catalog_item_id]?.price ?? 0)
}
export function templateValue(templateId, data) {
  return data.templateItems.filter((x) => x.template_id === templateId)
    .reduce((sum, x) => sum + linePrice(x, data.itemById) * Number(x.qty), 0)
}

function intervalText(x, t) {
  const parts = []
  if (x.default_interval_km) parts.push(`${num(x.default_interval_km)} km`)
  if (x.default_interval_months) parts.push(t('cat.monthsN', { n: x.default_interval_months }))
  return parts.join(' / ')
}

// Flat rate items and Service bundles are both service templates:
// a flat rate item has one fixed price, a bundle charges each line at its own price.
export default function TemplatesTab({ tab, data, id, canEdit, reload, go }) {
  const { t } = useT()
  const flat = tab === 'flat-rate'
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('active')
  const base = `/catalog/${tab}`
  const mine = data.templates.filter((x) => (x.flat_price != null) === flat)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return mine.filter((x) => statusMatch(x, status, id) && (!needle || [x.name, ...(x.tags || [])].join(' ').toLowerCase().includes(needle)))
  }, [mine, q, status, id])

  const isNew = id === 'new'
  const selected = isNew ? null : mine.find((x) => x.id === id)
  // A flat rate item opened under Service bundles (or the other way round) goes to its own tab.
  const elsewhere = !isNew && id && !selected ? data.templates.find((x) => x.id === id) : null
  useEffect(() => {
    if (elsewhere) go(`/catalog/${elsewhere.flat_price != null ? 'flat-rate' : 'bundles'}/${elsewhere.id}`)
  }, [elsewhere?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const panel = id && (isNew || selected) ? (
    <TemplateEditor key={`${id}:${data.version}`} flat={flat} template={selected} data={data} canEdit={canEdit}
      onClose={() => go(base)}
      onSaved={async (row) => { await reload(); go(`${base}/${row.id}`) }}
      onDeleted={async () => { await reload(); go(base) }} />
  ) : id && !elsewhere ? <EmptyCard icon="info" title={t('cat.notFound')} /> : null

  const empty = mine.length === 0
    ? <EmptyCard icon={flat ? 'tag' : 'layers'} title={t(`cat.empty.${tab}`)} text={t(`cat.emptyText.${tab}`)} />
    : rows.length === 0 ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null

  return (
    <ListShell title={t(`cat.tab.${tab}`)} sub={t(`cat.sub.${tab}`)} addLabel={t(`cat.add.${tab}`)} onAdd={() => go(`${base}/new`)}
      canEdit={canEdit} panel={panel} empty={empty}
      filters={<><SearchBox value={q} onChange={setQ} placeholder={t('cat.search.templates')} /><StatusSelect value={status} onChange={setStatus} /></>}>
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>{t('cat.name')}</th><th className="wide-only">{t('cat.tags')}</th><th className="num">{t('cat.lines')}</th>
              {flat && <th className="num wide-only">{t('cat.itemsValue')}</th>}
              <th className="num">{flat ? t('cat.flatPrice') : t('cat.total')}</th>
              <th className="wide-only">{t('cat.interval')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const lines = data.templateItems.filter((l) => l.template_id === x.id).length
              const value = templateValue(x.id, data)
              return (
                <tr key={x.id} className={`click ${x.id === id ? 'selected' : ''}`} onClick={() => go(`${base}/${x.id}`)}>
                  <td><RowLink to={`${base}/${x.id}`} go={go}>{x.name}</RowLink>{!x.active && <> <Badge color="gray">{t('cat.inactive')}</Badge></>}</td>
                  <td className="wide-only">{(x.tags || []).length ? <span className="row wrap" style={{ gap: 4 }}>{x.tags.map((g) => <Badge key={g} color="gray">{g}</Badge>)}</span> : <span className="muted">—</span>}</td>
                  <td className="num">{lines}</td>
                  {flat && <td className="num wide-only muted">{rp(value)}</td>}
                  <td className="num"><b>{rp(flat ? x.flat_price : value)}</b></td>
                  <td className="wide-only muted">{intervalText(x, t) || '—'}</td>
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

let rowKey = 0
const toLine = (x) => ({ key: ++rowKey, id: x.id, catalog_item_id: x.catalog_item_id, qty: String(Number(x.qty)).replace('.', ','), price: x.price_override == null ? '' : num(x.price_override) })

function TemplateEditor({ flat, template, data, canEdit, onClose, onSaved, onDeleted }) {
  const { t } = useT()
  const toast = useToast()
  const isNew = !template
  const existing = useMemo(() => data.templateItems.filter((x) => x.template_id === template?.id), [data.templateItems, template?.id])
  const [f, setF] = useState(() => ({
    name: template?.name || '', tags: (template?.tags || []).join(', '), flat_price: template?.flat_price == null ? '' : num(template.flat_price),
    checklist_id: template?.checklist_id || '', km: template?.default_interval_km == null ? '' : String(template.default_interval_km),
    months: template?.default_interval_months == null ? '' : String(template.default_interval_months), active: template ? template.active : true,
  }))
  const [lines, setLines] = useState(() => existing.map(toLine))
  const [pick, setPick] = useState('')
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const dis = !canEdit
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const groups = ['labor', 'part', 'fee'].map((type) => ({
    type, items: data.items.filter((x) => x.item_type === type && x.active),
  })).filter((g) => g.items.length)

  function addLine(itemId) {
    const item = data.itemById[itemId]
    if (!item) return
    setLines((ls) => [...ls, { key: ++rowKey, catalog_item_id: itemId, qty: String(Number(item.default_qty || 1)).replace('.', ','), price: '' }])
    setPick('')
  }

  const lineTotal = (l) => {
    const qty = parseDecimal(l.qty) ?? 0
    const over = readAmount(l.price)
    const price = over != null && !Number.isNaN(over) ? over : Number(data.itemById[l.catalog_item_id]?.price ?? 0)
    return qty * price
  }
  const value = lines.reduce((s, l) => s + lineTotal(l), 0)
  const flatPrice = readAmount(f.flat_price)

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    if (flat && (flatPrice === null || Number.isNaN(flatPrice))) e.flat_price = flatPrice === null ? t('settings.required') : t('settings.badAmount')
    const km = f.km.trim() ? Number(f.km.replace(/[.\s]/g, '')) : null
    if (km !== null && (!Number.isInteger(km) || km < 1 || km > 1000000)) e.km = t('cat.kmRule')
    const months = f.months.trim() ? Number(f.months) : null
    if (months !== null && (!Number.isInteger(months) || months < 1 || months > 120)) e.months = t('cat.monthsRule')
    if (lines.length === 0) e.lines = t('cat.needLine')
    const lineErr = {}
    lines.forEach((l) => {
      const qty = parseDecimal(l.qty)
      if (qty === null || qty < 0.01 || qty > 10000) lineErr[l.key] = t('cat.qtyRule')
      const over = readAmount(l.price)
      if (Number.isNaN(over)) lineErr[l.key] = t('settings.badAmount')
    })
    if (Object.keys(lineErr).length) e.lineErr = lineErr
    setErrors(e)
    if (Object.keys(e).length) return

    const row = {
      name: f.name.trim(), tags: parseTags(f.tags), flat_price: flat ? flatPrice : null, checklist_id: f.checklist_id || null,
      default_interval_km: km, default_interval_months: months, active: f.active,
    }
    setBusy(true)
    setMsg(null)
    const res = isNew
      ? await supabase.from('service_templates').insert(row).select().single()
      : await supabase.from('service_templates').update(row).eq('id', template.id).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    const saved = res.data
    const error = await syncRows({
      table: 'service_template_items', existing, rows: lines, keyCols: ['id'],
      toRow: (l, i) => ({
        ...(l.id ? { id: l.id } : {}), template_id: saved.id, catalog_item_id: l.catalog_item_id, qty: parseDecimal(l.qty),
        price_override: flat ? null : readAmount(l.price), position: i,
      }),
      same: (a, b) => a.catalog_item_id === b.catalog_item_id && Number(a.qty) === Number(b.qty) && a.position === b.position
        && (a.price_override == null ? null : Number(a.price_override)) === b.price_override,
    })
    if (error) toast(t('cat.linesFailed', { error: errorText(error, t) }), 'err')
    else toast(t('cat.saved', { name: saved.name }))
    await onSaved(saved)
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('service_templates').delete().eq('id', template.id)
    setBusy(false)
    if (error) return setMsg(deleteErrorText(error, t))
    toast(t('cat.deleted', { name: template.name }))
    onDeleted()
  }

  const checklists = data.checklists.filter((c) => c.active || c.id === f.checklist_id)
  const typeLabel = { labor: t('cat.tab.labor'), part: t('cat.tab.parts'), fee: t('cat.tab.fees') }

  return (
    <EditorPanel title={isNew ? t(flat ? 'cat.new.flat' : 'cat.new.bundle') : template.name}
      subtitle={!isNew ? t('cat.linesN', { n: existing.length }) : null}
      badges={!isNew && !template.active ? <Badge color="gray">{t('cat.inactive')}</Badge> : null}
      canEdit={canEdit} busy={busy} error={msg} onSave={save} onClose={onClose} onDelete={remove} isNew={isNew}>
      <div className="grid2">
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={set('name')} error={errors.name} disabled={dis} autoFocus={isNew} />
        <Input fieldClass={flat ? '' : 'span2'} label={t('cat.tags')} value={f.tags} onChange={set('tags')} disabled={dis} hint={t('cat.tagsHint')} />
        {flat && <Input label={t('cat.flatPrice')} value={f.flat_price} onChange={set('flat_price')} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.flat_price} />}
      </div>

      <Section title={t('cat.lines')}>
        {lines.length === 0 ? <div className="muted small">{t('cat.noLines')}</div> : (
          <div className="lines">
            {lines.map((l, i) => {
              const item = data.itemById[l.catalog_item_id]
              const err = errors.lineErr?.[l.key]
              return (
                <div key={l.key} className={`line tline ${err ? 'invalid' : ''}`}>
                  <div className="tline-top">
                    <div className="line-name">
                      <b title={item?.name}>{item?.name || '?'}</b>
                      <div className="muted small">
                        {typeLabel[item?.item_type]}{item?.code ? ` · ${item.code}` : ''}{!item?.active ? ` · ${t('cat.inactive')}` : ''}
                      </div>
                    </div>
                    <span className="line-total">{item?.item_type === 'fee' && item.fee_kind === 'percent' ? `${num(item.fee_value, 2)}%` : rp(lineTotal(l))}</span>
                    <RowButtons i={i} n={lines.length} disabled={dis} label={item?.name}
                      onMove={(j, d) => setLines((ls) => move(ls, j, d))} onRemove={(j) => setLines((ls) => ls.filter((_, k) => k !== j))} />
                  </div>
                  <div className="tline-inputs">
                    <label className="mini">
                      <span>{t('cat.qty')}</span>
                      <input className="input line-qty" value={l.qty} disabled={dis} inputMode="decimal" aria-label={t('cat.qtyFor', { name: item?.name })}
                        onChange={(e) => setLine(i, { qty: e.target.value })} />
                    </label>
                    {!flat && (
                      <label className="mini">
                        <span>{t('cat.price')}</span>
                        <input className="input line-price" value={l.price} disabled={dis} inputMode="numeric" placeholder={num(item?.price ?? 0)}
                          aria-label={t('cat.priceFor', { name: item?.name })} onChange={(e) => setLine(i, { price: e.target.value })} />
                      </label>
                    )}
                    {!flat && <span className="muted small">{t('cat.catalogPrice', { amount: rp(item?.price) })}</span>}
                  </div>
                  {err && <div className="error">{err}</div>}
                </div>
              )
            })}
          </div>
        )}
        {errors.lines && <div className="error">{errors.lines}</div>}
        {canEdit && (
          <select className="select mt" value={pick} onChange={(e) => addLine(e.target.value)} aria-label={t('cat.addLine')}>
            <option value="">{t('cat.addLine')}</option>
            {groups.map((g) => (
              <optgroup key={g.type} label={typeLabel[g.type]}>
                {g.items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.code ? ` · ${x.code}` : ''} · {rp(x.price)}</option>)}
              </optgroup>
            ))}
          </select>
        )}
        <div className="sumrow">
          <span>{flat ? t('cat.itemsValue') : t('cat.total')}</span><b>{rp(value)}</b>
        </div>
        {flat && flatPrice != null && !Number.isNaN(flatPrice) && value > 0 && flatPrice !== value && (
          <div className="sumrow muted">
            <span>{flatPrice < value ? t('cat.flatSaves') : t('cat.flatAbove')}</span><b>{rp(Math.abs(value - flatPrice))}</b>
          </div>
        )}
        <div className="hint">{flat ? t('cat.flatHint') : t('cat.bundleHint')}</div>
      </Section>

      <Section title={t('cat.afterService')}>
        <div className="grid2">
          <Select fieldClass="span2" label={t('cat.checklist')} value={f.checklist_id} onChange={set('checklist_id')} disabled={dis}
            options={[{ value: '', label: t('cat.noChecklist') }, ...checklists.map((c) => ({ value: c.id, label: c.name }))]} hint={t('cat.checklistHint')} />
          <Input label={t('cat.everyKm')} value={f.km} onChange={set('km')} disabled={dis} inputMode="numeric" suffix="km" error={errors.km} />
          <Input label={t('cat.everyMonths')} value={f.months} onChange={set('months')} disabled={dis} inputMode="numeric" suffix={t('cat.monthsShort')} error={errors.months} />
        </div>
        <div className="hint">{t('cat.intervalHint')}</div>
      </Section>

      <Section title={t('cat.settings')}>
        <Toggle checked={f.active} onChange={set('active')} disabled={dis} label={t('cat.activeLabel')} />
      </Section>
    </EditorPanel>
  )
}
