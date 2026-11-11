import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { altBrands, catalogMatches, numberOwners } from '../../lib/alternatives'
import CatalogMatches from '../../components/CatalogMatches'
import { Button, Empty, Input, Modal, Select, useToast } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { supabase, errorText, writeRow } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { jobNo, num, readAmount, rp } from '../../lib/format'
import { Picker } from '../jobs/common'
import { useAuth } from '../../context/AuthContext'

// Parts typed by hand on jobs and POs (not from the catalog), grouped by name (migration 138, item 9, Nov 4). Each
// group can be added to the catalog as a new part or linked to an existing one. Lines on open jobs and PO lines not
// yet received switch to the catalog part; for what already happened, stock gets received (on POs) − used (on
// invoiced jobs), or starts at 0 if chosen.
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()

async function loadTyped() {
  const [items, pol, links] = await Promise.all([
    supabase.from('ro_service_items_read').select('id, service_id, name, qty, cost, price, po_item_id').eq('item_type', 'part').is('catalog_item_id', null),
    supabase.from('purchase_order_items_read').select('id, po_id, name, part_number, cost, qty_ordered, qty_delivered, qty_cancelled, qty_returned, ro_service_item_id').is('catalog_item_id', null).eq('line_type', 'part'),
    supabase.from('typed_part_links').select('line_id'),
  ])
  const err = items.error || pol.error || links.error
  if (err) return { error: err }
  const done = new Set((links.data || []).map((x) => x.line_id))
  const jobLines = (items.data || []).filter((x) => !done.has(x.id))
  const poLines = (pol.data || []).filter((x) => !done.has(x.id) && Number(x.qty_ordered) > Number(x.qty_cancelled))
  const svcIds = [...new Set(jobLines.map((x) => x.service_id))]
  const poIds = [...new Set(poLines.map((x) => x.po_id))]
  const [svcs, pos] = await Promise.all([
    svcIds.length ? supabase.from('ro_services').select('id, ro_id').in('id', svcIds) : { data: [] },
    poIds.length ? supabase.from('purchase_orders').select('id, po_number, supplier_id, ro_id').in('id', poIds) : { data: [] },
  ])
  const roIds = [...new Set((svcs.data || []).map((s) => s.ro_id))]
  const jobs = roIds.length ? await supabase.from('repair_orders').select('id, job_number, order_status').in('id', roIds) : { data: [] }
  const roOf = Object.fromEntries((svcs.data || []).map((s) => [s.id, s.ro_id]))
  const jobById = Object.fromEntries((jobs.data || []).map((j) => [j.id, j]))
  const poById = Object.fromEntries((pos.data || []).map((p) => [p.id, p]))
  const groups = new Map()
  const group = (name) => {
    const k = norm(name)
    if (!groups.has(k)) groups.set(k, { key: k, name: String(name).trim(), job: [], po: [] })
    return groups.get(k)
  }
  const jobRows = jobLines.map((l) => ({ ...l, jobRow: jobById[roOf[l.service_id]] }))
  const poRows = poLines.map((l) => ({ ...l, poRow: poById[l.po_id] }))
  for (const l of jobRows) group(l.name).job.push(l)
  for (const l of poRows) group(l.name).po.push(l)
  // A job line and the PO line ordered for it belong together even when they were typed differently (a received PO
  // line and its open job line can only be added together, migration 139).
  for (const g of groups.values()) {
    for (const l of poRows) if (!g.po.includes(l) && g.job.some((j) => j.id === l.ro_service_item_id)) g.po.push(l)
    for (const l of [...g.po]) {
      const j = jobRows.find((x) => x.id === l.ro_service_item_id)
      if (j && !g.job.includes(j)) g.job.push(j)
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

// What linking these lines does to stock: received on POs − used on invoiced jobs (lines on open jobs come off the
// shelf when their job is invoiced, like any catalog part). What was received for an open job line added with it
// always goes into stock (migration 139): it comes off again when that job is invoiced, so it never ends below 0.
function stockEffect(g, pickedJob, pickedPo) {
  const openJob = new Set(g.job.filter((l) => pickedJob.has(l.id) && l.jobRow?.order_status !== 'invoice').map((l) => l.id))
  const got = (l) => Number(l.qty_delivered) - Number(l.qty_returned || 0)
  const rec = g.po.filter((l) => pickedPo.has(l.id) && Number(l.qty_delivered) > 0)
  const forOpen = rec.filter((l) => openJob.has(l.ro_service_item_id)).reduce((a, l) => a + got(l), 0)
  const received = rec.filter((l) => !openJob.has(l.ro_service_item_id)).reduce((a, l) => a + got(l), 0)
  const used = g.job.filter((l) => pickedJob.has(l.id) && l.jobRow?.order_status === 'invoice').reduce((a, l) => a + Number(l.qty), 0)
  return { received, used, forOpen, change: Math.round((received - used) * 100) / 100 }
}
const halfOpen = (l) => Number(l.qty_delivered) > 0 && Number(l.qty_ordered) - Number(l.qty_delivered) - Number(l.qty_cancelled) > 0

export function useTypedCount() {
  const [n, setN] = useState(null)
  useEffect(() => { loadTyped().then((r) => setN(r.groups ? r.groups.length : null)) }, [])
  return n
}

export default function TypedParts({ open, onClose, data, focus, onDone }) {
  const { t } = useT()
  const [state, setState] = useState(null)
  const [pick, setPick] = useState(null) // the group being added/linked
  const load = useCallback(async () => { setState(null); setState(await loadTyped()) }, [])
  useEffect(() => { if (open) load() }, [open, load])
  useEffect(() => {
    if (open && focus && state?.groups) {
      const g = state.groups.find((x) => x.key === norm(focus))
      if (g) setPick(g)
    }
  }, [open, focus, state])

  return (
    <>
      <Modal open={open && !pick} onClose={onClose} title={t('tp.title')} wide
        footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
        <div className="hint" style={{ marginTop: 0 }}>{t('tp.intro')}</div>
        {!state ? <div className="muted">{t('common.loading')}</div> : state.error ? <div className="text-red">{errorText(state.error, t)}</div>
          : state.groups.length === 0 ? <Empty icon="check" title={t('tp.none')} /> : (
            <div className="table">
              <table>
                <thead><tr><th>{t('cat.name')}</th><th>{t('tp.onJobs')}</th><th>{t('tp.onPos')}</th><th aria-label={t('tp.add')} /></tr></thead>
                <tbody>
                  {state.groups.map((g) => (
                    <tr key={g.key}>
                      <td><b>{g.name}</b></td>
                      <td className="small">{g.job.map((l) => `#${jobNo(l.jobRow?.job_number)} ×${num(l.qty, 2)}`).join(', ') || '—'}</td>
                      <td className="small">{g.po.map((l) => `${l.poRow?.po_number || '—'} (${num(l.qty_delivered, 2)}/${num(Number(l.qty_ordered) - Number(l.qty_cancelled), 2)})`).join(', ') || '—'}</td>
                      <td className="num"><Button size="sm" onClick={() => setPick(g)}>{t('tp.add')}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Modal>
      {pick && <AddTyped group={pick} data={data} onClose={() => { setPick(null); if (focus) onClose() }}
        onDone={async (msg) => { setPick(null); await load(); onDone?.(msg) }} />}
    </>
  )
}

function AddTyped({ group: g, data, onClose, onDone }) {
  const { t } = useT()
  const toast = useToast()
  const { settings } = useShop()
  const lastPo = g.po[g.po.length - 1]
  const lastJob = g.job[g.job.length - 1]
  const cost = Number(lastPo?.cost ?? lastJob?.cost ?? 0)
  const markup = Number(settings?.default_markup_pct ?? 0)
  const [mode, setMode] = useState('new') // new | existing
  const [f, setF] = useState({
    name: g.name, code: lastPo?.part_number || '', brand: '',
    supplier_id: lastPo?.poRow?.supplier_id || '', cost: num(cost), price: num(Number(lastJob?.price) || Math.round(cost * (1 + markup / 100))),
  })
  const [existing, setExisting] = useState(null)
  // Putting parts into stock is a stock adjustment: Owner and Admin (adjust_stock); others link with "start at 0".
  const { can } = useAuth()
  const canCount = can('adjust_stock')
  const [count, setCount] = useState(canCount)
  const [pickedJob, setPickedJob] = useState(() => new Set(g.job.map((l) => l.id)))
  const [pickedPo, setPickedPo] = useState(() => new Set(g.po.filter((l) => !halfOpen(l)).map((l) => l.id)))
  const [busy, setBusy] = useState(false)
  const eff = stockEffect(g, pickedJob, pickedPo)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const toggle = (setter, id, on) => setter((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const parts = useMemo(() => data.items.filter((x) => x.item_type === 'part' && x.active).map((x) => ({
    key: x.id, item: x, search: [x.name, x.code, x.brand, x.alt_numbers, altBrands(x)].filter(Boolean).join(' ').toLowerCase(),
  })), [data.items])
  // "Mungkin sudah ada di katalog": parts that look like this typed one, before a duplicate is made (145, item 39)
  const maybe = useMemo(() => catalogMatches(data.items, { name: g.name, number: lastPo?.part_number, limit: 3 }), [data.items]) // eslint-disable-line react-hooks/exhaustive-deps
  const codeOwners = mode === 'new' ? numberOwners(data.items, f.code) : []

  async function save() {
    if (!pickedJob.size && !pickedPo.size) return toast(t('tp.pickLines'), 'err')
    setBusy(true)
    let itemId = existing?.id
    if (mode === 'new') {
      const c = readAmount(f.cost); const p = readAmount(f.price)
      if (!f.name.trim() || c === null || Number.isNaN(c) || p === null || Number.isNaN(p)) { setBusy(false); return toast(t('tp.fillPart'), 'err') }
      const row = { item_type: 'part', name: f.name.trim(), code: f.code.trim() || null, brand: f.brand.trim() || null, supplier_id: f.supplier_id || null,
        cost: c, price: p, markup_pct: c ? Math.round((p / c - 1) * 1000) / 10 : null, track_inventory: true, taxable: Boolean(settings?.new_items_taxable) }
      const res = await writeRow('catalog_items', row)
      if (res.error) { setBusy(false); return toast(errorText(res.error, t), 'err') }
      itemId = res.data.id
    }
    if (!itemId) { setBusy(false); return toast(t('tp.pickPart'), 'err') }
    const { data: r, error } = await supabase.rpc('link_typed_part', { p_item: itemId, p_job_lines: [...pickedJob], p_po_lines: [...pickedPo], p_count: count && eff.change !== 0 })
    setBusy(false)
    if (error) {
      // The new part was saved already: try again by linking to it, not by making another one.
      if (mode === 'new') { setExisting({ id: itemId, name: f.name.trim(), code: f.code.trim(), brand: f.brand.trim() }); setMode('existing') }
      return toast(errorText(error, t), 'err')
    }
    const change = Number(r?.stock_change || 0)
    onDone(change ? t('tp.doneStock', { n: (change > 0 ? '+' : '') + num(change, 2) }) : t('tp.done'))
  }

  return (
    <Modal open onClose={onClose} title={t('tp.addTitle', { name: g.name })} wide
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{mode === 'new' ? t('tp.saveNew') : t('tp.saveLink')}</Button></>}>
      {mode === 'new' && <CatalogMatches matches={maybe} title={t('u145.maybeInCatalog')} useLabel={t('u145.linkThis')}
        onUse={(x) => { setExisting(x); setMode('existing') }} />}
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={`seg-btn ${mode === 'new' ? 'on' : ''}`} onClick={() => setMode('new')}>{t('tp.modeNew')}</button>
        <button type="button" className={`seg-btn ${mode === 'existing' ? 'on' : ''}`} onClick={() => setMode('existing')}>{t('tp.modeExisting')}</button>
      </div>
      {mode === 'new' ? (
        <div className="grid3">
          <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={set('name')} maxLength={200} hint={t('tp.nameHint')} />
          <Input label={t('cat.partNo')} value={f.code} onChange={set('code')}
            hint={codeOwners.length ? `${t('u145.numberTaken')} ${codeOwners.slice(0, 3).map((o) => o.name).join(', ')}` : null} />
          <Input label={t('cat.brand')} value={f.brand} onChange={set('brand')} />
          <Select label={t('cat.supplier')} value={f.supplier_id} onChange={set('supplier_id')}
            options={[{ value: '', label: '—' }, ...data.suppliers.filter((s) => s.active !== false).map((s) => ({ value: s.id, label: s.name }))]} />
          <div />
          <Input label={t('cat.cost')} value={f.cost} onChange={set('cost')} inputMode="numeric" prefix="Rp" />
          <Input label={t('cat.price')} value={f.price} onChange={set('price')} inputMode="numeric" prefix="Rp" />
        </div>
      ) : (
        <div>
          {existing ? (
            <div className="row" style={{ gap: 8 }}><b>{existing.name}</b><span className="muted small">{[existing.code, existing.brand].filter(Boolean).join(' · ')}</span>
              <button type="button" className="linkbtn small" onClick={() => setExisting(null)}>{t('tp.change')}</button></div>
          ) : (
            <Picker options={parts} onPick={(o) => setExisting(o.item)} placeholder={t('tp.findPart')} autoFocus
              render={(o) => <span><b>{o.item.name}</b> <span className="muted small">{[o.item.code, o.item.brand].filter(Boolean).join(' · ')}</span></span>} />
          )}
        </div>
      )}

      <div className="sectionlabel">{t('tp.lines')}</div>
      {g.job.map((l) => (
        <label key={l.id} className="inlinecheck" style={{ display: 'flex' }}>
          <input type="checkbox" checked={pickedJob.has(l.id)} onChange={(e) => toggle(setPickedJob, l.id, e.target.checked)} />
          <span>{t('tp.jobLine', { job: jobNo(l.jobRow?.job_number), qty: num(l.qty, 2) })} · <span className="muted">{l.jobRow?.order_status === 'invoice' ? t('tp.invoiced') : t('tp.open')}</span></span>
        </label>
      ))}
      {g.po.map((l) => (
        <label key={l.id} className="inlinecheck" style={{ display: 'flex' }}>
          <input type="checkbox" checked={pickedPo.has(l.id)} disabled={halfOpen(l)} onChange={(e) => toggle(setPickedPo, l.id, e.target.checked)} />
          <span>{t('tp.poLine', { po: l.poRow?.po_number || '—', got: num(l.qty_delivered, 2), of: num(Number(l.qty_ordered) - Number(l.qty_cancelled), 2) })}
            {Number(l.cost) > 0 && <span className="muted"> · {rp(l.cost)}</span>}
            {halfOpen(l) && <span className="muted"> · {t('tp.halfOpen')}</span>}</span>
        </label>
      ))}

      <div className="sectionlabel">{t('tp.stock')}</div>
      {/* Nothing received outside open jobs and nothing used: there's no stock choice to make (migration 139). */}
      {eff.change !== 0 && <>
      <label className="inlinecheck" style={{ display: 'flex', opacity: canCount ? 1 : 0.55 }}>
        <input type="radio" checked={count} disabled={!canCount} onChange={() => setCount(true)} />
        <span>{t('tp.count', { received: num(eff.received, 2), used: num(eff.used, 2), change: (eff.change > 0 ? '+' : '') + num(eff.change, 2) })}</span>
      </label>
      <label className="inlinecheck" style={{ display: 'flex' }}>
        <input type="radio" checked={!count} onChange={() => setCount(false)} />
        <span>{t('tp.zero')}</span>
      </label>
      {!canCount && <div className="hint">{t('tp.countOwner')}</div>}
      </>}
      {eff.forOpen > 0 && <div className="hint">{t('u139.forOpenJobs', { n: num(eff.forOpen, 2) })}</div>}
      <div className="hint">{t('tp.stockHint')}</div>
    </Modal>
  )
}
