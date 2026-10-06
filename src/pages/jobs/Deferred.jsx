import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Modal, Notice, Textarea, useToast } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, jobNo, rp } from '../../lib/format'

// Deferred work still waiting: deferred services that were neither carried into a later job nor dismissed.
// `vehicleId` limits it to one vehicle; `excludeRo` leaves out one job (the one being looked at).
export async function loadOpenDeferred({ vehicleId, excludeRo } = {}) {
  let jq = supabase.from('repair_orders').select('id, job_number, vehicle_id, customer_id, order_status, closed_at, invoiced_at, created_at')
  if (vehicleId) jq = jq.eq('vehicle_id', vehicleId)
  const jobs = await jq
  if (jobs.error) return { error: jobs.error }
  // Only work from a visit that is over (invoiced, or closed without invoicing) is waiting.
  const jobIds = (jobs.data || []).filter((j) => j.id !== excludeRo && (j.order_status === 'invoice' || j.closed_at)).map((j) => j.id)
  if (!jobIds.length) return { data: [] }
  const svcs = await supabase.from('ro_services').select('id, ro_id, name, service_total, created_at').eq('approval_status', 'deferred').in('ro_id', jobIds)
  if (svcs.error) return { error: svcs.error }
  const ids = (svcs.data || []).map((s) => s.id)
  if (!ids.length) return { data: [] }
  const [carried, dismissed] = await Promise.all([
    supabase.from('ro_services').select('id, ro_id, carried_from').in('carried_from', ids),
    supabase.from('deferred_dismissals').select('service_id').in('service_id', ids),
  ])
  if (carried.error || dismissed.error) return { error: carried.error || dismissed.error }
  const jobById = Object.fromEntries((jobs.data || []).map((j) => [j.id, j]))
  // A copy on a job that was closed without invoicing doesn't count: the work is waiting again.
  const copyJobs = [...new Set((carried.data || []).map((x) => x.ro_id).filter((id) => !jobById[id]))]
  const extra = copyJobs.length ? await supabase.from('repair_orders').select('id, closed_at').in('id', copyJobs) : { data: [] }
  for (const j of extra.data || []) jobById[j.id] = { ...j, extra: true }
  const live = (c) => jobById[c.ro_id] && !jobById[c.ro_id].closed_at
  const gone = new Set([...(carried.data || []).filter(live).map((x) => x.carried_from), ...(dismissed.data || []).map((x) => x.service_id)])
  return { data: (svcs.data || []).filter((s) => !gone.has(s.id)).map((s) => ({ ...s, job: jobById[s.ro_id] })) }
}

// On an open estimate: "This vehicle has N deferred services from earlier jobs" with a way to add them.
export function DeferredBanner({ job, editable, onCarried }) {
  const { t } = useT()
  const [list, setList] = useState([])
  const [open, setOpen] = useState(false)
  const load = useCallback(() => {
    if (!editable) return
    loadOpenDeferred({ vehicleId: job.ro.vehicle_id, excludeRo: job.ro.id }).then((r) => setList(r.data || []))
  }, [editable, job.ro.vehicle_id, job.ro.id])
  useEffect(() => { load() }, [load, job.version])
  if (!editable || !list.length) return null
  return (
    <>
      <Notice kind="info" style={{ marginTop: 16 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <span>{t('def.banner', { n: list.length })}</span>
          <div className="spacer" />
          <Button size="sm" onClick={() => setOpen(true)}>{t('def.review')}</Button>
        </div>
      </Notice>
      <CarryModal open={open} onClose={() => setOpen(false)} target={job.ro} services={list} onDone={() => { setOpen(false); load(); onCarried?.() }} />
    </>
  )
}

// Pick which deferred services to copy into a job (as pending work, at the price quoted then).
export function CarryModal({ open, onClose, target, services, onDone }) {
  const { t, lang } = useT()
  const toast = useToast()
  const { timezone } = useShop()
  const [pick, setPick] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  useEffect(() => { if (open) { setPick(Object.fromEntries(services.map((s) => [s.id, true]))); setMsg(null) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const ids = services.filter((s) => pick[s.id]).map((s) => s.id)
  async function go() {
    setBusy(true); setMsg(null)
    const { data, error } = await supabase.rpc('carry_deferred_services', { p_ro: target.id, p_services: ids })
    setBusy(false)
    if (error) return setMsg(errorText(error, t))
    toast(t('def.carried', { n: data ?? ids.length, no: jobNo(target.job_number) }))
    onDone?.()
  }
  return (
    <Modal open={open} title={t('def.carryTitle', { no: jobNo(target?.job_number) })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!ids.length} onClick={go}>{t('def.carryYes', { n: ids.length })}</Button></>}>
      {msg && <Notice kind="err" style={{ marginBottom: 12 }}>{msg}</Notice>}
      <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{t('def.carryText')}</div>
      <div className="checklist">
        {services.map((s) => (
          <label key={s.id} className="checkrow">
            <input type="checkbox" checked={!!pick[s.id]} onChange={(e) => setPick((p) => ({ ...p, [s.id]: e.target.checked }))} />
            <span><b>{s.name}</b><span className="muted small"> · #{jobNo(s.job?.job_number)} · {fmtDate(s.job?.invoiced_at || s.created_at, lang, timezone)}</span></span>
            <span className="num">{rp(s.service_total)}</span>
          </label>
        ))}
      </div>
    </Modal>
  )
}

// From the Deferred list: put one deferred service into an open estimate of its vehicle, or a new one.
export function AddToJobModal({ open, service, onClose, onDone }) {
  const { t } = useT()
  const toast = useToast()
  const { profile, roleName } = useAuth()
  const [jobs, setJobs] = useState(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const vehicleId = service?.job?.vehicle_id
  useEffect(() => {
    if (!open || !vehicleId) return
    setJobs(null); setMsg(null)
    supabase.from('repair_orders').select('id, job_number, workflow_status, order_status, closed_at').eq('vehicle_id', vehicleId).eq('order_status', 'estimate').is('closed_at', null)
      .order('job_number', { ascending: false }).then(({ data }) => {
        const list = (data || []).filter((j) => j.id !== service.ro_id)
        setJobs(list)
        setTarget(list[0]?.id || 'new')
      })
  }, [open, vehicleId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !service) return null
  async function go() {
    setBusy(true); setMsg(null)
    let ro = jobs.find((j) => j.id === target)
    if (target === 'new') {
      // The vehicle may have moved to another company since that visit: the new estimate goes to its current owner.
      const veh = await supabase.from('vehicles').select('customer_id').eq('id', vehicleId).maybeSingle()
      if (veh.error || !veh.data) { setBusy(false); return setMsg(errorText(veh.error || { message: 'not found' }, t)) }
      const { data, error } = await supabase.from('repair_orders').insert({
        customer_id: veh.data.customer_id, vehicle_id: vehicleId, priority: 'medium', service_advisor_id: roleName !== 'Technician' ? profile?.id || null : null,
      }).select().single()
      if (error) { setBusy(false); return setMsg(errorText(error, t)) }
      ro = data
    }
    const { error } = await supabase.rpc('carry_deferred_services', { p_ro: ro.id, p_services: [service.id] })
    setBusy(false)
    if (error) return setMsg(errorText(error, t) + (target === 'new' ? ` ${t('appt.jobKept', { no: jobNo(ro.job_number) })}` : ''))
    toast(t('def.carried', { n: 1, no: jobNo(ro.job_number) }))
    onDone?.(ro)
  }
  return (
    <Modal open={open} title={t('def.addTitle', { name: service.name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!jobs} onClick={go}>{t('def.addYes')}</Button></>}>
      {msg && <Notice kind="err" style={{ marginBottom: 12 }}>{msg}</Notice>}
      {!jobs ? <div className="muted">{t('common.loading')}</div> : (
        <div className="checklist">
          {jobs.map((j) => (
            <label key={j.id} className="checkrow">
              <input type="radio" name="def-target" checked={target === j.id} onChange={() => setTarget(j.id)} />
              <span><b>#{jobNo(j.job_number)}</b> <span className="muted small">· {t(`job.wf.${j.workflow_status}`)}</span></span>
              <Link to={`/jobs/${j.id}`} className="small" onClick={onClose}>{t('def.open')}</Link>
            </label>
          ))}
          <label className="checkrow">
            <input type="radio" name="def-target" checked={target === 'new'} onChange={() => setTarget('new')} />
            <span><b>{t('def.newEstimate')}</b></span>
            <span />
          </label>
        </div>
      )}
      <div className="hint">{t('def.carryText')}</div>
    </Modal>
  )
}

// Take a deferred service off the list without doing it (the customer declined, it was done elsewhere…).
export function DismissModal({ open, service, onClose, onDone }) {
  const { t } = useT()
  const toast = useToast()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  useEffect(() => { if (open) { setNote(''); setMsg(null) } }, [open])
  if (!open || !service) return null
  async function go() {
    setBusy(true)
    const { error } = await supabase.from('deferred_dismissals').insert({ service_id: service.id, note: note.trim() || null })
    setBusy(false)
    if (error) return setMsg(errorText(error, t))
    toast(t('def.dismissed'))
    onDone?.()
  }
  return (
    <Modal open={open} title={t('def.dismissTitle', { name: service.name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={go}>{t('def.dismissYes')}</Button></>}>
      {msg && <Notice kind="err" style={{ marginBottom: 12 }}>{msg}</Notice>}
      <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{t('def.dismissText')}</div>
      <Textarea label={t('def.reason')} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={t('def.reasonHint')} />
    </Modal>
  )
}
