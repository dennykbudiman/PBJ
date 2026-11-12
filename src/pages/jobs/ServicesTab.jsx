import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Avatar, Badge, Button, Empty, Modal, useToast, Input, Notice, Toggle } from '../../components/ui'
import CatalogMatches from '../../components/CatalogMatches'
import LeftoverNote from '../../components/LeftoverNote'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { supabase, errorText, writeRow } from '../../lib/supabase'
import { num, parseDecimal, readAmount, rp, fmtDate, jobNo, invoiceNo } from '../../lib/format'
import { APPROVAL_COLOR, LINE_TYPES, WORK_STATUS, autoFeesFor, linesFromCatalogItem, lineAmount, lineDiscount, lineNet } from '../../lib/jobs'
import { discountState } from '../catalog/DiscountsTab'
import { useShop } from '../../context/ShopContext'
import { shopToday } from '../../lib/customers'
import { LINE_COLOR, isNonPkp, jobToPoCost, lineState, poToJobCost } from '../../lib/inventory'
import { BlurInput, MoreMenu, Picker, discountText, parseDiscount } from './common'
import { worksOnJobs } from './useJobData'
import { useAuth } from '../../context/AuthContext'
import { alternativesIndex, fitsVehicle, numberTokens, altBrands, catalogMatches } from '../../lib/alternatives'

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
  const { data: svc, error } = await writeRow('ro_services', {
    ro_id: ro.id, name: tp ? tp.name : name, template_id: tp?.id || null, checklist_id: tp?.checklist_id || null,
    flat_price: tp?.flat_price ?? null, position: nextPos(job.services), service_schedule_id: scheduleId || null,
  })
  if (error) return { error }
  if (!tp) return { data: svc }
  return insertLines(svc.id, ro.id, 0, bundleLines(cat, tp), job.fees)
}

function bundleLines(cat, tp) {
  const built = { lines: [], jobFees: [] }
  for (const ti of cat.templateItems.filter((x) => x.template_id === tp.id)) {
    const item = cat.itemById[ti.catalog_item_id]
    if (!item) continue
    const q = Number(ti.qty)
    const r = buildFor(item, cat, { qty: q, priceOverride: ti.price_override }, tp.flat_price != null)
    built.lines.push(...r.lines)
    built.jobFees.push(...r.jobFees)
  }
  return built
}

// An empty service (e.g. one made from a complaint, migration 139) filled with a package's lines; it keeps its name.
export async function fillFromBundle({ job, cat, tp, svc }) {
  const { error } = await supabase.from('ro_services')
    .update({ template_id: tp.id, checklist_id: tp.checklist_id || null, flat_price: tp.flat_price ?? null }).eq('id', svc.id)
  if (error) return { error }
  return insertLines(svc.id, job.ro.id, 0, bundleLines(cat, tp), job.fees)
}

export default function ServicesTab({ job, cat, staff, editable, workEditable, showCost, run, busy, openApproval }) {
  const { t, lang } = useT()
  const ro = job.ro
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  // Parts sharing a part number (migration 136), shown on each part line as alternatives.
  const alts = useMemo(() => alternativesIndex(cat.items), [cat.items])

  const templateOptions = useMemo(() => cat.templates.filter((x) => x.active).map((x) => ({
    key: x.id, tp: x, search: [x.name, ...(x.tags || [])].join(' ').toLowerCase(),
  })), [cat.templates])

  async function addTemplate(tp) {
    await run(() => addBundleService({ job, cat, tp }), t('job.serviceAdded', { name: tp.name }))
  }

  // One mechanic on every service of the job (Denny, Nov 5). Finished work that already has a mechanic keeps theirs.
  const { isFleet } = useAuth()
  async function setTechAll(id) {
    if (!id) return
    const ids = job.services.filter((s) => ['approved', 'pending'].includes(s.approval_status) && s.technician_id !== id
      && !(s.work_status === 'completed' && s.technician_id)).map((s) => s.id)
    const name = staff.find((p) => p.id === id)?.name || ''
    if (!ids.length) return
    await run(() => supabase.from('ro_services').update({ technician_id: id }).in('id', ids), t('u139.techAllDone', { name, n: ids.length }))
  }

  // "Ulangi pekerjaan sebelumnya" (145, item 33): copy services from an earlier job of this truck
  const [repeatOpen, setRepeatOpen] = useState(false)
  const [lastJob, setLastJob] = useState(null)
  const fresh = editable && ro.order_status === 'estimate' && !job.items.length
  useEffect(() => {
    if (!fresh || !ro.vehicle_id) return
    let live = true
    previousJobs(ro.vehicle_id, ro.id, 1).then((list) => { if (live) setLastJob(list[0] || null) })
    return () => { live = false }
  }, [fresh, ro.vehicle_id, ro.id])

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
          {!isFleet && editable && job.services.length > 1 && (
            <label className="row techall" style={{ gap: 6 }}>
              <span className="muted small">{t('u139.techAll')}</span>
              <select className="select" value="" disabled={busy} aria-label={t('u139.techAll')} onChange={(e) => setTechAll(e.target.value)}>
                <option value="" disabled>{t('u139.techAllPick')}</option>
                {staff.filter(worksOnJobs).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          {!isFleet && ro.vehicle_id && <Button icon="undo" onClick={() => setRepeatOpen(true)}>{t('u145.repeat')}</Button>}
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
      {fresh && lastJob && lastJob.services.length > 0 && (
        <Notice kind="info" style={{ marginBottom: 12 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <span>{t('u145.repeatHint', { date: fmtDate(lastJob.day, lang), names: lastJob.services.map((x) => x.name).slice(0, 3).join(', ') + (lastJob.services.length > 3 ? '…' : '') })}</span>
            <Button size="sm" onClick={() => setRepeatOpen(true)}>{t('u145.repeatYes')}</Button>
          </div>
        </Notice>
      )}
      {repeatOpen && <RepeatJobModal job={job} cat={cat} staff={staff} run={run} busy={busy} onClose={() => setRepeatOpen(false)} />}
      {job.services.length === 0 ? (
        <div className="card"><Empty icon="wrench" title={t('job.noServices')}>{editable ? t('job.noServicesText') : null}</Empty></div>
      ) : job.services.map((s, i) => (
        <ServiceCard key={s.id} s={s} index={i} job={job} cat={cat} staff={staff} editable={editable} workEditable={workEditable}
          showCost={showCost} run={run} busy={busy} openApproval={openApproval} alts={alts} templateOptions={templateOptions} />
      ))}
    </div>
  )
}

function ServiceCard({ s, index, job, cat, staff, editable, workEditable, showCost, run, busy, openApproval, alts, templateOptions }) {
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
  const { isFleet, can } = useAuth()
  const canPkg = can('edit_catalog') && !isFleet
  const [pkgOpen, setPkgOpen] = useState(false)
  const { settings } = useShop()
  const tech = staff.find((p) => p.id === s.technician_id)
  const upd = (patch, okText) => run(() => supabase.from('ro_services').update(patch).eq('id', s.id), okText)
  const updLine = (id, patch) => run(() => supabase.from('ro_service_items').update(patch).eq('id', id))

  // Search covers part numbers with or without dashes, alternative numbers and fitment; parts that fit this job's
  // vehicle come first (migration 136).
  const itemOptions = useMemo(() => cat.items.filter((x) => x.active).map((x) => ({
    key: x.id, item: x, fits: x.item_type === 'part' && fitsVehicle(x, job.vehicle),
    search: [x.name, x.code, x.brand, x.tire_size, x.alt_numbers, altBrands(x), x.fits, ...numberTokens(x.code), ...numberTokens(x.alt_numbers)].filter(Boolean).join(' ').toLowerCase(),
  })).sort((a, b) => Number(b.fits) - Number(a.fits)), [cat.items, job.vehicle])
  const [altFor, setAltFor] = useState(null) // the job line whose alternatives are shown

  function addItem(item) {
    run(() => insertLines(s.id, ro.id, nextPos(lines), buildFor(item, cat), job.fees))
  }
  // Swap a part line for an alternative: the new part goes in at the same place with the same quantity and discount,
  // then the old line is removed (only while the part isn't taken from stock or ordered on a PO). If the old line can't
  // be removed, the new one is taken out again, so the job never ends up with both. A fixed discount larger than the
  // new line is capped at the new line's amount. Fee lines that come with the new part are added unless the service
  // already has a line of that name.
  function swapLine(line, item) {
    return run(async () => {
      const built = buildFor(item, cat, { qty: line.qty })
      const [main, ...extra] = built.lines
      const gross = Number(lineAmount(main))
      const fixed = Number(line.discount_amount) || 0
      const ins = await supabase.from('ro_service_items').insert({
        ...main, service_id: s.id, position: line.position, discount_pct: line.discount_pct,
        discount_amount: fixed > gross ? gross : line.discount_amount,
      }).select('id').single()
      if (ins.error) return ins
      const del = await supabase.from('ro_service_items').delete().eq('id', line.id)
      if (del.error) {
        await supabase.from('ro_service_items').delete().eq('id', ins.data.id)
        return del
      }
      const have = new Set(lines.map((l) => String(l.name || '').toLowerCase()))
      const fees = extra.filter((l) => !have.has(String(l.name || '').toLowerCase()))
      return insertLines(s.id, ro.id, nextPos(lines), { lines: fees, jobFees: built.jobFees }, job.fees)
    }, t('alt.swapped', { name: item.name }))
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
    // A typed-in part (not from the catalog): its price follows the cost at the shop's default markup (Nov 4), unless
    // someone already typed a different price.
    const line = lines.find((x) => x.id === id)
    if (field === 'cost' && line && line.item_type === 'part' && !line.catalog_item_id) {
      const m = Number(settings?.default_markup_pct ?? 0)
      const suggest = (c) => Math.round(Number(c || 0) * (1 + m / 100))
      const price = Number(line.price || 0)
      if (price === 0 || price === suggest(line.cost)) return updLine(id, { cost: n, price: suggest(n) })
    }
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

  const isFlat = s.is_flat ?? s.flat_price != null
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
        {/* A fleet manager doesn't see the shop's staff, so there's no technician to show (migration 133). */}
        {!isFleet && <label className="techpick" title={t('job.technician')}>
          {tech ? <Avatar name={tech.name} size={24} /> : <span className="avatar noone"><Icon name="user" size={13} /></span>}
          <select className="select bare" value={s.technician_id || ''} disabled={!workEditable} aria-label={t('job.technician')}
            onChange={(e) => upd({ technician_id: e.target.value || null })}>
            {/* An invoiced job keeps a technician on approved work, so "No technician" isn't offered there. */}
            <option value="" disabled={job.ro.order_status === 'invoice' && s.approval_status === 'approved' && !!s.technician_id}>{t('job.noTechnician')}</option>
            {staff.filter((p) => worksOnJobs(p) || p.id === s.technician_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>}
        <select className="select bare work" value={s.work_status} disabled={!workEditable} aria-label={t('job.workStatus')}
          onChange={(e) => upd({ work_status: e.target.value })}>
          {WORK_STATUS.map((w) => <option key={w} value={w}>{t(`job.work.${w}`)}</option>)}
        </select>
        {(editable || canPkg) && (
          <MoreMenu label={t('job.serviceMenu', { name: s.name })} items={[
            editable && index > 0 && { label: t('job.moveUp'), icon: 'chevronUp', onClick: () => moveService(-1) },
            editable && index < job.services.length - 1 && { label: t('job.moveDown'), icon: 'chevronDown', onClick: () => moveService(1) },
            editable && { label: t('job.serviceDiscount'), icon: 'percent', onClick: () => setDiscOpen(true) },
            editable && (isFlat ? { label: t('job.removeFlat'), icon: 'tag', onClick: () => upd({ flat_price: null }) }
              : { label: t('job.makeFlat'), icon: 'tag', onClick: () => upd({ flat_price: lineSum }) }),
            // the work on this service as a package for next time (145, item 32), also on an invoiced job
            canPkg && lines.length > 0 && { label: t('u145.savePkg'), icon: 'layers', onClick: () => setPkgOpen(true) },
            editable && { label: t('job.deleteService'), icon: 'trash', danger: true, onClick: () => setConfirmDelete(true) },
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
              <tr><td colSpan={showCost ? 11 : 10} className="muted" style={{ textAlign: 'center', padding: 14 }}>
                {t('job.noLines')}
                {editable && templateOptions?.length > 0 && (
                  <div style={{ maxWidth: 360, margin: '8px auto 0', textAlign: 'left' }}>
                    <Picker options={templateOptions} placeholder={t('u139.fillFrom')} disabled={busy}
                      onPick={(o) => run(() => fillFromBundle({ job, cat, tp: o.tp, svc: s }), t('u139.filled', { name: o.tp.name }))}
                      render={(o) => <span style={{ flex: 1 }}><b>{o.tp.name}</b></span>} />
                  </div>
                )}
              </td></tr>
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
                      {[item?.code, item?.brand, rate ? t('job.rateHint', { name: rate.name, amount: rp(rate.rate_per_hour) }) : null, Number(l.core_charge) > 0 ? t('job.coreHint', { amount: rp(l.core_charge) }) : null].filter(Boolean).join(' · ')}
                      {item && (alts.get(item.id) || []).length > 0 && (
                        <> · <button type="button" className="linkbtn small" onClick={() => setAltFor(l)}>
                          {(alts.get(item.id) || []).length === 1 ? t('alt.one') : t('alt.count', { n: (alts.get(item.id) || []).length })}
                        </button></>
                      )}
                      {/* A part typed by hand: add it to the catalog (item 9, Nov 4). */}
                      {!item && l.item_type === 'part' && can('edit_catalog') && !isFleet && (
                        <> <Link className="small" to={`/catalog/parts?typed=${encodeURIComponent(l.name)}`}>{t('tp.addLink')}</Link></>
                      )}
                    </div>
                    {/* A part typed by hand that looks like a catalog part: use the catalog part instead (145, item 39) */}
                    {!item && l.item_type === 'part' && editable && !isFleet && (
                      <CatalogMatches matches={catalogMatches(cat.items, { name: l.name, vehicle: job.vehicle, limit: 2 })}
                        onUse={l.stock_deducted || l.po_item_id ? null : (x) => swapLine(l, x)}
                        disabledHint={l.po_item_id ? t('u145.cantSwapPo') : null} />
                    )}
                    {/* taken (or to be taken) from a part left over on another job's PO (147, item 40) */}
                    {!isFleet && <LeftoverNote leftover={job.leftover} lineId={l.id} t={t} />}
                  </td>
                  {showCost && (
                    <td className="num">{editable ? <BlurInput className="input cell num" value={num(l.cost)} aria-label={t('cat.cost')} onCommit={commitMoney(l.id, 'cost')} /> : (Number(l.cost) ? rp(l.cost) : '—')}</td>
                  )}
                  <td className="num">{editable ? <BlurInput className="input cell num" value={num(l.price)} aria-label={t('cat.price')} onCommit={commitMoney(l.id, 'price')} /> : rp(l.price)}</td>
                  <td className="num">{editable ? <BlurInput className="input cell num narrow" value={String(Number(l.qty)).replace('.', ',')} aria-label={t('job.col.qty')} onCommit={commitQty(l.id)} /> : num(l.qty, 2)}</td>
                  <td className="num">{l.price == null ? '—' : rp(lineAmount(l))}</td>
                  <td className="num">
                    {editable ? <BlurInput className="input cell num narrow" value={discountText(l.discount_pct, l.discount_amount)} placeholder="—" aria-label={t('job.col.discount')} onCommit={commitDiscount(l.id)} />
                      : disc ? `-${rp(disc)}${Number(l.discount_pct) > 0 ? ` (${num(l.discount_pct, 2)}%)` : ''}` : '—'}
                  </td>
                  <td className="num"><b>{l.price == null ? '—' : rp(lineNet(l))}</b>
                    {/* labour of a company that isn't charged for it (142) */}
                    {l.item_type === 'labor' && Number(ro.labor_waived) > 0 && Number(lineNet(l)) > 0 && <div className="small muted nowrap">{t('u142.notCharged')}</div>}</td>
                  <td>
                    <input type="checkbox" checked={l.taxable} disabled={!editable} aria-label={t('cat.tax')} onChange={(e) => updLine(l.id, { taxable: e.target.checked })} />
                  </td>
                  <td><LineStatus l={l} item={item} cat={cat} job={job} workEditable={workEditable} commitHours={commitHours(l.id)} showCost={showCost} /></td>
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
              render={(o) => <ItemOption item={o.item} cat={cat} fits={o.fits} />} />
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
            <span className="muted small">({t('job.linesWorth', { amount: lines.some((l) => l.price == null) ? '—' : rp(lineSum) })})</span>
          </span>
        )}
        <div className="spacer" />
        <span>{t('job.serviceTotal')} <b>{rp(s.service_total)}</b></span>
        <span>{t('job.col.discount')} <b>{s.service_discount == null ? '—' : Number(s.service_discount) ? `-${rp(s.service_discount)}` : rp(0)}</b>
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
      <AltModal line={altFor} alts={altFor ? alts.get(altFor.catalog_item_id) || [] : []} cat={cat} vehicle={job.vehicle} busy={busy}
        canAdd={editable} canSwap={editable && altFor && !altFor.stock_deducted && !altFor.po_item_id}
        onClose={() => setAltFor(null)}
        onAdd={(item) => run(() => insertLines(s.id, ro.id, nextPos(lines), buildFor(item, cat), job.fees)).then((ok) => ok && setAltFor(null))}
        onSwap={(item) => swapLine(altFor, item).then(() => setAltFor(null))} />
      {pkgOpen && <SavePackageModal s={s} lines={lines} cat={cat} onClose={() => setPkgOpen(false)} />}
    </section>
  )
}

// Stock or purchase-order badge for parts, hours worked for labor.
function LineStatus({ l, item, cat, job, workEditable, commitHours, showCost }) {
  const { settings } = useShop()
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
  if (l.item_type !== 'part' && l.item_type !== 'sublet') return null
  if (l.item_type === 'part' && l.stock_deducted) return <Badge color="gray">{t('job.stock.taken')}</Badge>
  // Ordered on a purchase order for this job: On order → Part delivered → Delivered.
  const pl = l.po_item_id && (job?.poLines || []).find((x) => x.id === l.po_item_id)
  const po = pl && job.pos.find((x) => x.id === pl.po_id)
  if (pl && po && lineState(pl) !== 'cancelled') {
    const st = lineState(pl)
    const label = st === 'waiting' ? (po.status === 'draft' ? t('job.po.draft') : t('job.po.onOrder')) : st === 'partial' ? t('job.po.partial', { n: num(pl.qty_delivered, 2), of: num(Number(pl.qty_ordered) - Number(pl.qty_cancelled), 2) }) : t('job.po.delivered')
    // The PO line is connected (141): say when its price or (once ordered) its quantity differs from the job line.
    const ordered = Number(pl.qty_ordered) - Number(pl.qty_cancelled)
    // (compared in PO terms, before the supplier's PPN while the shop is non-PKP; shown as the job would count it, 142)
    const nonPkp = isNonPkp(settings)
    const costDiff = showCost && pl.cost != null && Number(pl.cost) !== jobToPoCost(l.cost, pl.taxable, po.tax_rate, nonPkp)
    const qtyDiff = po.status !== 'draft' && ordered !== Number(l.qty)
    return (
      <span>
        <Link to={`/inventory/purchase-orders/${po.id}`} className="plainlink" title={t('job.po.title', { no: po.po_number })}><Badge color={st === 'waiting' ? (po.status === 'draft' ? 'gray' : 'blue') : LINE_COLOR[st]}>{label}</Badge></Link>
        {costDiff && <span className="small" style={{ display: 'block', color: 'var(--amber-ink, #9A5B10)' }} title={t('u141.poCostTitle')}>{t('u141.poCost', { po: po.po_number, amount: rp(poToJobCost(pl.cost, pl.taxable, po.tax_rate, nonPkp)) })}</span>}
        {qtyDiff && <span className="small" style={{ display: 'block', color: 'var(--amber-ink, #9A5B10)' }} title={t('u141.poQtyTitle')}>{t('u141.poQty', { po: po.po_number, ordered: num(ordered, 2), need: num(l.qty, 2) })}</span>}
      </span>
    )
  }
  if (l.item_type === 'sublet' || !item?.track_inventory) return null
  const onHand = Number(cat.stockById[item.id]?.qty_on_hand ?? item.qty_on_hand ?? 0)
  if (onHand >= Number(l.qty)) return <Badge color="green">{t('job.stock.in')}</Badge>
  if (onHand > 0) return <Badge color="amber">{t('job.stock.only', { n: num(onHand, 2) })}</Badge>
  return <Badge color="red">{t('job.stock.out')}</Badge>
}

function ItemOption({ item, cat, fits }) {
  const { t } = useT()
  const stock = item.track_inventory ? Number(cat.stockById[item.id]?.qty_on_hand ?? item.qty_on_hand ?? 0) : null
  return (
    <>
      <span className={`typedot t-${item.item_type}`} title={t(`job.type.${item.item_type}`)} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{item.name}</b>
        <span className="muted small">{item.code ? ` · ${item.code}` : ''}{item.brand ? ` · ${item.brand}` : ''} · {t(`job.type.${item.item_type}`)}</span>
        {fits && <span className="small" style={{ color: 'var(--green)' }}> · {t('alt.fitsVehicle')}</span>}
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

// The alternatives of one part line: other parts sharing its part number, with brand, price and stock on hand.
function AltModal({ line, alts, cat, vehicle, busy, canAdd, canSwap, onClose, onAdd, onSwap }) {
  const { t } = useT()
  if (!line) return null
  return (
    <Modal open title={t('alt.showFor', { name: line.name })} onClose={onClose} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="altbox">
        {alts.map((a) => {
          const stock = a.track_inventory ? Number(cat.stockById[a.id]?.qty_on_hand ?? a.qty_on_hand ?? 0) : null
          return (
            <div key={a.id} className="altrow">
              <span style={{ minWidth: 0 }}>
                <b>{a.name}</b>
                <div className="muted small">{[a.code, a.brand, a.fits].filter(Boolean).join(' · ')}{fitsVehicle(a, vehicle) && <span style={{ color: 'var(--green)' }}> · {t('alt.fitsVehicle')}</span>}</div>
              </span>
              <span className="row" style={{ gap: 8, flexShrink: 0 }}>
                {stock != null && <span className="small" style={{ color: stock > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{t('alt.inStock', { n: num(stock, 2) })}</span>}
                {a.price != null && <span className="small" style={{ fontWeight: 700 }}>{rp(a.price)}</span>}
                {canSwap && <Button size="sm" variant="primary" disabled={busy} onClick={() => onSwap(a)}>{t('alt.swap')}</Button>}
                {canAdd && <Button size="sm" disabled={busy} onClick={() => onAdd(a)}>{t('alt.add')}</Button>}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

// ---- 145 · packages from done work (item 32) and repeating an earlier job (item 33) ---------------------------------

// "Simpan sebagai paket": the service's catalog lines (parts with their quantity, bulk oil in litres, labour) become
// a package (Katalog → Paket servis). Prices aren't copied: a package uses the catalog's prices when it is used; a
// flat-price service can keep its flat price. Fee lines aren't copied (they come with their parts by themselves);
// parts typed by hand aren't in the catalog, so they can't be in a package: they are listed, with a link to add them.
function SavePackageModal({ s, lines, cat, onClose }) {
  const { t } = useT()
  const toast = useToast()
  const flat = s.flat_price != null
  const [f, setF] = useState({ name: s.name, tags: '', keepFlat: flat })
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState(null)
  const take = lines.filter((l) => l.catalog_item_id && cat.itemById[l.catalog_item_id] && cat.itemById[l.catalog_item_id].item_type !== 'fee' && Number(l.qty) > 0)
  const typed = lines.filter((l) => !l.catalog_item_id && l.item_type !== 'fee')
  const dup = cat.templates.find((x) => x.active && x.name.trim().toLowerCase() === f.name.trim().toLowerCase())
  async function save() {
    if (!f.name.trim()) return setFail(t('settings.required'))
    if (!take.length) return setFail(t('u145.pkgNothing'))
    setBusy(true); setFail(null)
    const tags = f.tags.split(',').map((x) => x.trim()).filter(Boolean)
    const tp = await writeRow('service_templates', { name: f.name.trim(), tags, flat_price: flat && f.keepFlat ? s.flat_price : null, checklist_id: s.checklist_id || null, active: true })
    if (tp.error) { setBusy(false); return setFail(errorText(tp.error, t)) }
    const rows = take.map((l, i) => ({ template_id: tp.data.id, catalog_item_id: l.catalog_item_id, qty: Number(l.qty), position: i }))
    const r = await supabase.from('service_template_items').insert(rows)
    setBusy(false)
    if (r.error) return setFail(errorText(r.error, t))
    toast(t('u145.pkgSaved', { name: f.name.trim(), n: rows.length }))
    onClose()
  }
  return (
    <Modal open title={t('u145.savePkgTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('u145.savePkg')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      <Input label={t('u145.pkgName')} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} maxLength={200}
        hint={dup ? t('u145.pkgDup', { name: dup.name }) : null} />
      <Input label={t('u145.pkgTags')} value={f.tags} onChange={(e) => setF((x) => ({ ...x, tags: e.target.value }))} placeholder={t('u145.pkgTagsPh')} />
      {flat && <Toggle checked={f.keepFlat} onChange={(v) => setF((x) => ({ ...x, keepFlat: v }))} label={t('u145.pkgKeepFlat', { amount: rp(s.flat_price) })} />}
      <div className="sectionlabel">{t('u145.pkgLines', { n: take.length })}</div>
      {take.map((l) => <div key={l.id} className="small">{cat.itemById[l.catalog_item_id].name} × {num(l.qty, 2)}{cat.itemById[l.catalog_item_id].unit ? ` ${cat.itemById[l.catalog_item_id].unit}` : ''}</div>)}
      {typed.length > 0 && <>
        <div className="sectionlabel">{t('u145.pkgTyped')}</div>
        {typed.map((l) => <div key={l.id} className="small">{l.name} · <Link to={`/catalog/parts?typed=${encodeURIComponent(l.name)}`}>{t('tp.addLink')}</Link></div>)}
      </>}
      <div className="hint">{t('u145.pkgHint')}</div>
    </Modal>
  )
}

// A truck's earlier jobs (newest first), each with its services and their lines (cancelled/declined ones left out).
async function previousJobs(vehicleId, exceptId, limit = 8, jobNumber = null) {
  let q = supabase.from('repair_orders').select('id, job_number, invoice_number, order_status, created_at, invoiced_at, closed_at, vehicle_id')
  q = jobNumber ? q.eq('job_number', jobNumber) : q.eq('vehicle_id', vehicleId).neq('id', exceptId).order('created_at', { ascending: false }).limit(limit)
  const jobs = await q
  const list = jobs.data || []
  if (!list.length) return []
  const svc = await supabase.from('ro_services').select('id, ro_id, name, approval_status, flat_price, notes_external, template_id, checklist_id, position')
    .in('ro_id', list.map((j) => j.id)).order('position')
  const services = (svc.data || []).filter((x) => x.approval_status !== 'declined')
  const items = services.length ? await supabase.from('ro_service_items').select('id, service_id, item_type, catalog_item_id, name, description, qty, price, cost, taxable, show_qty_price, position')
    .in('service_id', services.map((x) => x.id)).order('position') : { data: [] }
  return list.map((j) => ({
    ...j, day: (j.invoiced_at || j.created_at || '').slice(0, 10),
    services: services.filter((x) => x.ro_id === j.id).map((x) => ({ ...x, lines: (items.data || []).filter((l) => l.service_id === x.id) })),
  })).filter((j) => j.id !== exceptId)
}

// "Ulangi pekerjaan sebelumnya": tick services of an earlier job; they are added as new services, parts and labour at
// today's catalog prices with the same quantities (bulk oil at the old litres, to check), status "Belum", a mechanic
// if chosen. Concerns aren't copied; lines that were on a PO come as plain lines (no PO link).
function RepeatJobModal({ job, cat, staff, run, busy, onClose }) {
  const { t, lang } = useT()
  const [jobs, setJobs] = useState(null)
  const [pick, setPick] = useState(() => new Set())
  const [tech, setTech] = useState('')
  const [no, setNo] = useState('')
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    let live = true
    previousJobs(job.ro.vehicle_id, job.ro.id).then((list) => { if (live) setJobs(list) })
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  async function findByNo() {
    const n = Number(no.replace(/\D/g, ''))
    if (!n) return
    const list = await previousJobs(null, job.ro.id, 1, n)
    if (!list.length) return setMsg(t('u145.repeatNotFound', { no }))
    setMsg(null)
    setJobs((x) => [...list.filter((j) => !(x || []).some((y) => y.id === j.id)), ...(x || [])])
  }
  const all = (jobs || []).flatMap((j) => j.services)
  const chosen = all.filter((x) => pick.has(x.id))
  async function copy() {
    const ok = await run(async () => {
      let pos = nextPos(job.services)
      for (const old of chosen) {
        const tp = old.template_id ? cat.templates.find((x) => x.id === old.template_id && x.active) : null
        const { data: svc, error } = await writeRow('ro_services', {
          ro_id: job.ro.id, name: old.name, notes_external: old.notes_external || null, template_id: tp?.id || null,
          checklist_id: old.checklist_id || null, flat_price: tp?.flat_price ?? null, position: pos++, technician_id: tech || null,
        })
        if (error) return { error }
        const built = { lines: [], jobFees: [] }
        for (const l of old.lines) {
          const item = l.catalog_item_id ? cat.itemById[l.catalog_item_id] : null
          if (item && item.item_type === 'fee') continue // fees come with their parts by themselves
          if (item && item.active) {
            const r = buildFor(item, cat, { qty: Number(l.qty) }, tp?.flat_price != null)
            built.lines.push(...r.lines); built.jobFees.push(...r.jobFees)
          } else if (!item) {
            built.lines.push({ item_type: l.item_type, name: l.name, description: l.description || null, qty: l.qty, price: l.price ?? 0,
              ...(l.cost != null ? { cost: l.cost } : {}), taxable: l.taxable, show_qty_price: l.show_qty_price })
          }
        }
        const res = await insertLines(svc.id, job.ro.id, 0, built, job.fees)
        const bad = res.find((x) => x.error)
        if (bad) return bad
      }
      return { data: true }
    }, t('u145.repeatDone', { n: chosen.length }))
    if (ok) onClose()
  }
  return (
    <Modal open wide title={t('u145.repeatTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!chosen.length} onClick={copy}>{t('u145.repeatCopy', { n: chosen.length })}</Button></>}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
        <input className="input" style={{ width: 170 }} value={no} onChange={(e) => setNo(e.target.value)} placeholder={t('u145.repeatByNo')} aria-label={t('u145.repeatByNo')}
          onKeyDown={(e) => { if (e.key === 'Enter') findByNo() }} />
        <Button size="sm" onClick={findByNo}>{t('u145.repeatFind')}</Button>
        <div className="spacer" />
        <label className="row" style={{ gap: 6 }}><span className="small muted">{t('u145.repeatTech')}</span>
          <select className="select" value={tech} onChange={(e) => setTech(e.target.value)} aria-label={t('u145.repeatTech')}>
            <option value="">—</option>
            {staff.filter(worksOnJobs).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
      </div>
      {msg && <Notice kind="warn" style={{ marginBottom: 8 }}>{msg}</Notice>}
      {jobs == null ? <div className="muted">{t('common.loading')}</div> : jobs.length === 0 ? <div className="muted">{t('u145.repeatNone')}</div> : jobs.map((j) => (
        <div key={j.id} className="repeat-job">
          <div className="row wrap" style={{ gap: 8 }}>
            <b>#{jobNo(j.job_number)}</b><span className="muted small">{fmtDate(j.day, lang)}{j.invoice_number ? ` · ${invoiceNo(j.invoice_number)}` : ''}</span>
          </div>
          {j.services.length === 0 && <div className="muted small">{t('u145.repeatEmpty')}</div>}
          {j.services.map((x) => (
            <label key={x.id} className="inlinecheck" style={{ display: 'flex' }}>
              <input type="checkbox" checked={pick.has(x.id)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n })} />
              <span><b>{x.name}</b> <span className="muted small">{x.lines.filter((l) => l.item_type !== 'fee').map((l) => `${l.name} × ${num(l.qty, 2)}`).join(', ') || t('u145.repeatNoLines')}</span></span>
            </label>
          ))}
        </div>
      ))}
      <div className="hint">{t('u145.repeatHintText')}</div>
    </Modal>
  )
}
