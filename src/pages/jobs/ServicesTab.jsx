import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Avatar, Badge, Button, Empty, Modal, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { num, parseDecimal, readAmount, rp } from '../../lib/format'
import { APPROVAL_COLOR, LINE_TYPES, WORK_STATUS, autoFeesFor, linesFromCatalogItem, lineAmount, lineDiscount, lineNet } from '../../lib/jobs'
import { discountState } from '../catalog/DiscountsTab'
import { useShop } from '../../context/ShopContext'
import { shopToday } from '../../lib/customers'
import { LINE_COLOR, lineState } from '../../lib/inventory'
import { BlurInput, MoreMenu, Picker, discountText, parseDiscount } from './common'

const nextPos = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.position) || 0), -1) + 1

// Adds the lines (and percent job fees) for a set of catalog items to one service.
async function insertLines(serviceId, roId, startPos, built, existingFees) {
  const lines = built.lines.map((l, i) => ({ ...l, service_id: serviceId, position: startPos + i }))
  const res = []
  if (lines.length) res.push(await supabase.from('ro_service_items').insert(lines))
  const have = new Set(existingFees.map((f) => `${f.kind}|${f.name.toLowerCase()}`))
  const fees = built.jobFees.filter((f) => !have.has(`${f.kind}|${f.name.toLowerCase()}`))
    .filter((f, i, a) => a.findIndex((x) => x.name === f.name) === i)
    .map((f) => ({ ...f, ro_id: roId }))
  if (fees.length) res.push(await supabase.from('ro_job_fees').insert(fees))
  return res
}

// Lines for one catalog item plus the fees set to come with it.
// Inside a flat-rate service, percent fees are left out: the flat price is all the company pays for it.
function buildFor(item, cat, opts = {}, flat = false) {
  const r = linesFromCatalogItem(item, opts)
  if (item.item_type !== 'fee') {
    const q = item.item_type === 'labor' ? (opts.qty ?? 1) : (r.lines[0]?.qty ?? 1)
    const af = autoFeesFor(item, q, cat)
    r.lines.push(...af.lines)
    if (!flat) r.jobFees.push(...af.jobFees)
  }
  if (flat) r.jobFees = []
  return r
}

// Adds a service bundle (or, with no bundle, a plain named service) to a job with all its lines.
// `scheduleId` links it to a service schedule. Returns the database results, for useRun.
export async function addBundleService({ job, cat, tp, name, scheduleId }) {
  const ro = job.ro
  const { data: svc, error } = await supabase.from('ro_services').insert({
    ro_id: ro.id, name: tp ? tp.name : name, template_id: tp?.id || null, checklist_id: tp?.checklist_id || null,
    flat_price: tp?.flat_price ?? null, position: nextPos(job.services), service_schedule_id: scheduleId || null,
  }).select().single()
  if (error) return { error }
  if (!tp) return { data: svc }
  const built = { lines: [], jobFees: [] }
  for (const ti of cat.templateItems.filter((x) => x.template_id === tp.id)) {
    const item = cat.itemById[ti.catalog_item_id]
    if (!item) continue
    const q = Number(ti.qty)
    const r = buildFor(item, cat, { qty: q, priceOverride: ti.price_override }, tp.flat_price != null)
    built.lines.push(...r.lines)
    built.jobFees.push(...r.jobFees)
  }
  return insertLines(svc.id, ro.id, 0, built, job.fees)
}

export default function ServicesTab({ job, cat, staff, editable, workEditable, showCost, run, busy, openApproval }) {
  const { t } = useT()
  const ro = job.ro
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const templateOptions = useMemo(() => cat.templates.filter((x) => x.active).map((x) => ({
    key: x.id, tp: x, search: [x.name, ...(x.tags || [])].join(' ').toLowerCase(),
  })), [cat.templates])

  async function addTemplate(tp) {
    await run(() => addBundleService({ job, cat, tp }), t('job.serviceAdded', { name: tp.name }))
  }

  async function addBlank() {
    const name = newName.trim()
    if (!name) return
    const ok = await run(() => supabase.from('ro_services').insert({ ro_id: ro.id, name, position: nextPos(job.services) }))
    if (ok) { setNewName(''); setAdding(false) }
  }

  return (
    <div>
      {editable && (
        <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
          <div style={{ flex: '1 1 280px' }}>
            <Picker options={templateOptions} onPick={(o) => addTemplate(o.tp)} placeholder={t('job.searchBundles')} disabled={busy}
              render={(o) => (
                <>
                  <span style={{ flex: 1 }}><b>{o.tp.name}</b>{(o.tp.tags || []).length > 0 && <span className="muted small"> · {o.tp.tags.join(', ')}</span>}</span>
                  <Badge color={o.tp.flat_price != null ? 'purple' : 'blue'}>{o.tp.flat_price != null ? t('job.flat') : t('job.bundle')}</Badge>
                  {o.tp.flat_price != null && <span className="small" style={{ fontWeight: 700 }}>{rp(o.tp.flat_price)}</span>}
                </>
              )} />
          </div>
          {!adding ? (
            <Button icon="plus" onClick={() => setAdding(true)}>{t('job.addService')}</Button>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              <input className="input" style={{ width: 240 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('job.serviceName')} autoFocus
                aria-label={t('job.serviceName')} onKeyDown={(e) => { if (e.key === 'Enter') addBlank(); if (e.key === 'Escape') setAdding(false) }} />
              <Button variant="primary" onClick={addBlank} loading={busy}>{t('job.add')}</Button>
              <Button variant="ghost" onClick={() => { setAdding(false); setNewName('') }}>{t('common.cancel')}</Button>
            </div>
          )}
        </div>
      )}
      {job.services.length === 0 ? (
        <div className="card"><Empty icon="wrench" title={t('job.noServices')}>{editable ? t('job.noServicesText') : null}</Empty></div>
      ) : job.services.map((s, i) => (
        <ServiceCard key={s.id} s={s} index={i} job={job} cat={cat} staff={staff} editable={editable} workEditable={workEditable}
          showCost={showCost} run={run} busy={busy} openApproval={openApproval} />
      ))}
    </div>
  )
}

function ServiceCard({ s, index, job, cat, staff, editable, workEditable, showCost, run, busy, openApproval }) {
  const { t } = useT()
  const toast = useToast()
  const ro = job.ro
  const lines = job.items.filter((x) => x.service_id === s.id)
  const [discOpen, setDiscOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const checklist = s.checklist_id ? cat.checklists.find((c) => c.id === s.checklist_id) : null
  const inspection = job.inspections.find((x) => x.service_id === s.id)
  const template = s.template_id ? cat.templates.find((x) => x.id === s.template_id) : null
  const schedule = s.service_schedule_id ? (job.schedules || []).find((x) => x.id === s.service_schedule_id) : null
  const tech = staff.find((p) => p.id === s.technician_id)
  const upd = (patch, okText) => run(() => supabase.from('ro_services').update(patch).eq('id', s.id), okText)
  const updLine = (id, patch) => run(() => supabase.from('ro_service_items').update(patch).eq('id', id))

  const itemOptions = useMemo(() => cat.items.filter((x) => x.active).map((x) => ({
    key: x.id, item: x, search: [x.name, x.code, x.brand, x.tire_size].filter(Boolean).join(' ').toLowerCase(),
  })), [cat.items])

  function addItem(item) {
    run(() => insertLines(s.id, ro.id, nextPos(lines), buildFor(item, cat), job.fees))
  }
  function addCustom(type) {
    run(() => supabase.from('ro_service_items').insert({
      service_id: s.id, item_type: type, name: t(`job.newLine.${type}`), qty: 1, price: 0, position: nextPos(lines),
    }))
  }
  function moveService(dir) {
    const other = job.services[index + dir]
    if (!other) return
    run(() => Promise.all([
      supabase.from('ro_services').update({ position: other.position === s.position ? index + dir : other.position }).eq('id', s.id),
      supabase.from('ro_services').update({ position: other.position === s.position ? index : s.position }).eq('id', other.id),
    ]))
  }

  const commitMoney = (id, field) => (v, reset) => {
    const n = readAmount(v)
    if (n === null || Number.isNaN(n)) { toast(t('settings.badAmount'), 'err'); reset(); return }
    return updLine(id, { [field]: n })
  }
  const commitQty = (id) => (v, reset) => {
    const n = parseDecimal(v)
    if (n === null || n < 0 || n > 100000) { toast(t('job.qtyRule'), 'err'); reset(); return }
    return updLine(id, { qty: Math.round(n * 100) / 100 })
  }
  const commitDiscount = (id) => (v, reset) => {
    const d = parseDiscount(v)
    if (!d) { toast(t('job.discountRule'), 'err'); reset(); return }
    const line = lines.find((x) => x.id === id)
    if (line && d.amount > lineAmount(line)) { toast(t('job.discountTooBig'), 'err'); reset(); return }
    return updLine(id, { discount_pct: d.pct, discount_amount: d.amount })
  }
  const commitHours = (id) => (v, reset) => {
    const n = String(v).trim() === '' ? null : parseDecimal(v)
    if (n !== null && (Number.isNaN(n) || n < 0 || n > 1000)) { toast(t('cat.hoursRule'), 'err'); reset(); return }
    return updLine(id, { hours_worked: n })
  }

  const isFlat = s.flat_price != null
  const lineSum = lines.reduce((a, l) => a + lineNet(l) + Math.round(Number(l.core_charge) * Number(l.qty)), 0)
  const declinedLike = s.approval_status === 'declined' || s.approval_status === 'deferred'
  const concern = job.concerns.find((c) => c.id === s.concern_id)

  return (
    <section className={`card svc ${declinedLike ? 'svc-out' : ''}`} aria-label={s.name}>
      <div className="svc-head">
        {editable ? (
          <BlurInput className="input svc-name" value={s.name} aria-label={t('job.serviceName')}
            onCommit={(v, reset) => (v.trim() ? upd({ name: v.trim() }) : reset())} />
        ) : <h3 className="svc-title">{s.name}</h3>}
        <div className="spacer" />
        <button type="button" className="badgebtn" disabled={!editable} onClick={() => openApproval([s.id])} title={editable ? t('job.recordApproval') : undefined}>
          <Badge color={APPROVAL_COLOR[s.approval_status]}>{t(`job.appr.${s.approval_status}`)}</Badge>
        </button>
        <label className="techpick" title={t('job.technician')}>
          {tech ? <Avatar name={tech.name} size={24} /> : <span className="avatar noone"><Icon name="user" size={13} /></span>}
          <select className="select bare" value={s.technician_id || ''} disabled={!workEditable} aria-label={t('job.technician')}
            onChange={(e) => upd({ technician_id: e.target.value || null })}>
            <option value="">{t('job.noTechnician')}</option>
            {staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <select className="select bare work" value={s.work_status} disabled={!workEditable} aria-label={t('job.workStatus')}
          onChange={(e) => upd({ work_status: e.target.value })}>
          {WORK_STATUS.map((w) => <option key={w} value={w}>{t(`job.work.${w}`)}</option>)}
        </select>
        {editable && (
          <MoreMenu label={t('job.serviceMenu', { name: s.name })} items={[
            index > 0 && { label: t('job.moveUp'), icon: 'chevronUp', onClick: () => moveService(-1) },
            index < job.services.length - 1 && { label: t('job.moveDown'), icon: 'chevronDown', onClick: () => moveService(1) },
            { label: t('job.serviceDiscount'), icon: 'percent', onClick: () => setDiscOpen(true) },
            isFlat ? { label: t('job.removeFlat'), icon: 'tag', onClick: () => upd({ flat_price: null }) }
              : { label: t('job.makeFlat'), icon: 'tag', onClick: () => upd({ flat_price: lineSum }) },
            { label: t('job.deleteService'), icon: 'trash', danger: true, onClick: () => setConfirmDelete(true) },
          ]} />
        )}
      </div>

      <div className="svc-meta">
        {editable ? (
          <BlurInput multiline rows={2} value={s.notes_external || ''} placeholder={t('job.serviceNotes')} aria-label={t('job.serviceNotes')}
            onCommit={(v) => upd({ notes_external: v.trim() || null })} />
        ) : s.notes_external ? <div className="svc-notes">{s.notes_external}</div> : null}
        <div className="svc-side">
          {checklist && (
            <div>{t('job.checklist')}: <b>{checklist.name}</b> · <Badge color={inspection?.status === 'completed' ? 'green' : inspection?.status === 'in_progress' ? 'blue' : 'amber'}>
              {t(`job.work.${inspection?.status || 'todo'}`)}</Badge></div>
          )}
          {schedule ? (
            <div className="small"><Icon name="clock" size={12} /> {t('job.countsTowards')} <b>{schedule.name}</b></div>
          ) : template && (template.default_interval_km || template.default_interval_months) && (
            <div className="muted small">{t('job.nextDue', { when: [template.default_interval_km ? `+${num(template.default_interval_km)} km` : null, template.default_interval_months ? t('cat.monthsN', { n: template.default_interval_months }) : null].filter(Boolean).join(' / ') })}</div>
          )}
          {workEditable && (job.schedules || []).some((x) => x.active || x.id === s.service_schedule_id) && (
            <select className="select bare small" value={s.service_schedule_id || ''} onChange={(e) => upd({ service_schedule_id: e.target.value || null })} aria-label={t('job.scheduleFor', { name: s.name })}>
              <option value="">{t('job.noSchedule')}</option>
              {(job.schedules || []).filter((x) => x.active || x.id === s.service_schedule_id).map((x) => <option key={x.id} value={x.id}>{t('job.countsTowardsX', { name: x.name })}</option>)}
            </select>
          )}
          {(job.concerns.length > 0 && editable) ? (
            <select className="select bare small" value={s.concern_id || ''} onChange={(e) => upd({ concern_id: e.target.value || null })} aria-label={t('job.forConcern')}>
              <option value="">{t('job.noConcernLink')}</option>
              {job.concerns.map((c) => <option key={c.id} value={c.id}>{t('job.forConcernX', { text: c.text.slice(0, 60) })}</option>)}
            </select>
          ) : concern ? <div className="muted small">{t('job.forConcernX', { text: concern.text })}</div> : null}
        </div>
      </div>

      <div className="table lines-table">
        <table>
          <thead>
            <tr>
              <th>{t('job.col.type')}</th><th>{t('cat.name')}</th>
              {showCost && <th className="num">{t('cat.cost')}</th>}
              <th className="num">{t('cat.price')}</th><th className="num">{t('job.col.qty')}</th><th className="num">{t('job.col.amount')}</th>
              <th className="num">{t('job.col.discount')}</th><th className="num">{t('job.col.net')}</th><th>{t('cat.tax')}</th><th>{t('job.col.status')}</th>
              {editable && <th aria-label={t('job.col.actions')} />}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={showCost ? 11 : 10} className="muted" style={{ textAlign: 'center', padding: 14 }}>{t('job.noLines')}</td></tr>
            )}
            {lines.map((l) => {
              const item = l.catalog_item_id ? cat.itemById[l.catalog_item_id] : null
              const rate = item?.labor_rate_id ? cat.rateById[item.labor_rate_id] : null
              const disc = lineDiscount(l)
              return (
                <tr key={l.id}>
                  <td>
                    {editable ? (
                      <select className="select bare small" value={l.item_type} onChange={(e) => updLine(l.id, { item_type: e.target.value })} aria-label={t('job.col.type')}>
                        {LINE_TYPES.map((x) => <option key={x} value={x}>{t(`job.type.${x}`)}</option>)}
                      </select>
                    ) : t(`job.type.${l.item_type}`)}
                  </td>
                  <td className="line-cell">
                    {editable ? (
                      <>
                        <BlurInput className="input cell strong" value={l.name} aria-label={t('cat.name')} onCommit={(v, reset) => (v.trim() ? updLine(l.id, { name: v.trim() }) : reset())} />
                        {l.description && <div className="muted small cellpad">{l.description}</div>}
                      </>
                    ) : <><b>{l.name}</b>{l.description && <div className="muted small">{l.description}</div>}</>}
                    <div className="muted small cellpad">
                      {[item?.code, rate ? t('job.rateHint', { name: rate.name, amount: rp(rate.rate_per_hour) }) : null, Number(l.core_charge) > 0 ? t('job.coreHint', { amount: rp(l.core_charge) }) : null].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  {showCost && (
                    <td className="num">{editable ? <BlurInput className="input cell num" value={num(l.cost)} aria-label={t('cat.cost')} onCommit={commitMoney(l.id, 'cost')} /> : (Number(l.cost) ? rp(l.cost) : '—')}</td>
                  )}
                  <td className="num">{editable ? <BlurInput className="input cell num" value={num(l.price)} aria-label={t('cat.price')} onCommit={commitMoney(l.id, 'price')} /> : rp(l.price)}</td>
                  <td className="num">{editable ? <BlurInput className="input cell num narrow" value={String(Number(l.qty)).replace('.', ',')} aria-label={t('job.col.qty')} onCommit={commitQty(l.id)} /> : num(l.qty, 2)}</td>
                  <td className="num">{rp(lineAmount(l))}</td>
                  <td className="num">
                    {editable ? <BlurInput className="input cell num narrow" value={discountText(l.discount_pct, l.discount_amount)} placeholder="—" aria-label={t('job.col.discount')} onCommit={commitDiscount(l.id)} />
                      : disc ? `-${rp(disc)}${Number(l.discount_pct) > 0 ? ` (${num(l.discount_pct, 2)}%)` : ''}` : '—'}
                  </td>
                  <td className="num"><b>{rp(lineNet(l))}</b></td>
                  <td>
                    <input type="checkbox" checked={l.taxable} disabled={!editable} aria-label={t('cat.tax')} onChange={(e) => updLine(l.id, { taxable: e.target.checked })} />
                  </td>
                  <td><LineStatus l={l} item={item} cat={cat} job={job} workEditable={workEditable} commitHours={commitHours(l.id)} /></td>
                  {editable && (
                    <td><button type="button" className="btn ghost sm" onClick={() => run(() => supabase.from('ro_service_items').delete().eq('id', l.id))} aria-label={t('job.removeLine', { name: l.name })}><Icon name="x" size={14} /></button></td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          <div style={{ flex: '1 1 260px' }}>
            <Picker options={itemOptions} onPick={(o) => addItem(o.item)} placeholder={t('job.searchItems')} disabled={busy}
              render={(o) => <ItemOption item={o.item} cat={cat} />} />
          </div>
          <select className="select" style={{ width: 'auto' }} value="" aria-label={t('job.customLine')} onChange={(e) => e.target.value && addCustom(e.target.value)}>
            <option value="">{t('job.customLine')}</option>
            {LINE_TYPES.map((x) => <option key={x} value={x}>{t(`job.type.${x}`)}</option>)}
          </select>
        </div>
      )}
      <div className="svc-foot">
        {isFlat && (
          <span className="row" style={{ gap: 6 }}>
            {t('job.flatPrice')}
            {editable ? <BlurInput className="input cell num" style={{ width: 120 }} value={num(s.flat_price)} aria-label={t('job.flatPrice')}
              onCommit={(v, reset) => { const n = readAmount(v); if (n === null || Number.isNaN(n)) { toast(t('settings.badAmount'), 'err'); reset(); return } upd({ flat_price: n }) }} />
              : <b>{rp(s.flat_price)}</b>}
            <span className="muted small">({t('job.linesWorth', { amount: rp(lineSum) })})</span>
          </span>
        )}
        <div className="spacer" />
        <span>{t('job.serviceTotal')} <b>{rp(s.service_total)}</b></span>
        <span>{t('job.col.discount')} <b>{Number(s.service_discount) ? `-${rp(s.service_discount)}` : rp(0)}</b>
          {Number(s.discount_pct) > 0 && <span className="muted small"> ({num(s.discount_pct, 2)}%)</span>}</span>
        <span>{t('job.serviceNet')} <b>{rp(s.service_net)}</b></span>
      </div>
      {declinedLike && <div className="hint">{t(`job.outHint.${s.approval_status}`)}</div>}

      <ServiceDiscountModal open={discOpen} onClose={() => setDiscOpen(false)} s={s} cat={cat}
        onSave={(patch) => upd(patch).then((ok) => ok && setDiscOpen(false))} busy={busy} />
      <Modal open={confirmDelete} title={t('job.deleteService')} onClose={() => setConfirmDelete(false)}
        footer={<><Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" className="solid" loading={busy} onClick={() => run(() => supabase.from('ro_services').delete().eq('id', s.id)).then(() => setConfirmDelete(false))}>{t('job.deleteServiceYes')}</Button></>}>
        {t('job.deleteServiceText', { name: s.name, n: lines.length })}
      </Modal>
    </section>
  )
}

// Stock or purchase-order badge for parts, hours worked for labor.
function LineStatus({ l, item, cat, job, workEditable, commitHours }) {
  const { t } = useT()
  if (l.item_type === 'labor') {
    return (
      <span className="row" style={{ gap: 4 }} title={t('job.hoursWorkedHint')}>
        <span className="muted small">{t('job.worked')}</span>
        {workEditable ? <BlurInput className="input cell num narrow" value={l.hours_worked == null ? '' : String(Number(l.hours_worked)).replace('.', ',')} placeholder="—"
          aria-label={t('job.hoursWorked')} onCommit={commitHours} /> : <span>{l.hours_worked == null ? '—' : num(l.hours_worked, 2)}</span>}
      </span>
    )
  }
  if (l.item_type !== 'part') return null
  if (l.stock_deducted) return <Badge color="gray">{t('job.stock.taken')}</Badge>
  // Ordered on a purchase order for this job: On order → Part delivered → Delivered.
  const pl = l.po_item_id && (job?.poLines || []).find((x) => x.id === l.po_item_id)
  const po = pl && job.pos.find((x) => x.id === pl.po_id)
  if (pl && po && lineState(pl) !== 'cancelled') {
    const st = lineState(pl)
    const label = st === 'waiting' ? (po.status === 'draft' ? t('job.po.draft') : t('job.po.onOrder')) : st === 'partial' ? t('job.po.partial', { n: num(pl.qty_delivered, 2), of: num(Number(pl.qty_ordered) - Number(pl.qty_cancelled), 2) }) : t('job.po.delivered')
    return <Link to={`/inventory/purchase-orders/${po.id}`} className="plainlink" title={t('job.po.title', { no: po.po_number })}><Badge color={st === 'waiting' ? (po.status === 'draft' ? 'gray' : 'blue') : LINE_COLOR[st]}>{label}</Badge></Link>
  }
  if (!item?.track_inventory) return null
  const onHand = Number(cat.stockById[item.id]?.qty_on_hand ?? item.qty_on_hand ?? 0)
  if (onHand >= Number(l.qty)) return <Badge color="green">{t('job.stock.in')}</Badge>
  if (onHand > 0) return <Badge color="amber">{t('job.stock.only', { n: num(onHand, 2) })}</Badge>
  return <Badge color="red">{t('job.stock.out')}</Badge>
}

function ItemOption({ item, cat }) {
  const { t } = useT()
  const stock = item.track_inventory ? Number(cat.stockById[item.id]?.qty_on_hand ?? item.qty_on_hand ?? 0) : null
  return (
    <>
      <span className={`typedot t-${item.item_type}`} title={t(`job.type.${item.item_type}`)} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{item.name}</b>
        <span className="muted small">{item.code ? ` · ${item.code}` : ''} · {t(`job.type.${item.item_type}`)}</span>
      </span>
      {stock != null && <span className="small" style={{ color: stock > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{t('job.stockN', { n: num(stock, 2) })}</span>}
      <span className="small" style={{ fontWeight: 700 }}>{item.item_type === 'fee' && item.fee_kind === 'percent' ? `${num(item.fee_value, 2)}%` : rp(item.item_type === 'fee' ? item.fee_value ?? item.price : item.price)}</span>
    </>
  )
}

function ServiceDiscountModal({ open, onClose, s, cat, onSave, busy }) {
  const { t } = useT()
  const [v, setV] = useState('')
  const [err, setErr] = useState(null)
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const presets = cat.discounts.filter((d) => d.level === 'service' && discountState(d, today) === 'running')
  React.useEffect(() => { if (open) { setV(discountText(s.discount_pct, s.discount_amount)); setErr(null) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  function save() {
    const d = parseDiscount(v)
    if (!d) return setErr(t('job.discountRule'))
    onSave({ discount_pct: d.pct, discount_amount: d.amount })
  }
  return (
    <Modal open={open} title={t('job.serviceDiscountFor', { name: s.name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button></>}>
      <div className="field">
        <label htmlFor="sd-v">{t('job.discountValue')}</label>
        <input id="sd-v" className={`input ${err ? 'invalid' : ''}`} value={v} onChange={(e) => { setV(e.target.value); setErr(null) }} placeholder="10% / 50.000" autoFocus />
        {err ? <div className="error">{err}</div> : <div className="hint">{t('job.discountHint')}</div>}
      </div>
      {presets.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
          {presets.map((d) => (
            <button key={d.id} type="button" className="btn sm" onClick={() => {
              // A percentage with a maximum becomes the capped amount, since a service discount has no maximum of its own.
              if (d.kind === 'percent' && d.max_amount != null) setV(num(Math.min(Math.round(Number(s.service_total) * Number(d.value) / 100), Number(d.max_amount))))
              else setV(d.kind === 'percent' ? `${String(Number(d.value)).replace('.', ',')}%` : num(d.value))
            }}>
              {d.name}
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
