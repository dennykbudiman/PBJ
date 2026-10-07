import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Modal, Notice, Select, Textarea, useToast } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDateTime, jobNo } from '../../lib/format'
import { shopToday, vehicleName } from '../../lib/customers'
import { WORKFLOW_COLOR } from '../../lib/jobs'
import { APPT_COLOR, APPT_STATUSES, addDays, daysBetween, hhmmToMinutes, isActiveAppt, isDate, minutesToHhmm, shopParts, shopTimeToIso } from '../../lib/calendar'
import { selectAll } from '../customers/useCustomerData'
import { bookingProblem, dayHours, hhmm24, hoursText } from '../../lib/hours'
import { Picker } from '../jobs/common'
import { useStaff } from '../jobs/useJobData'

const MAX_DAYS = 14

// Book or edit an appointment. `appointment` edits an existing one; `defaults` pre-fills a new one
// ({ start, end, technician_id, ro_id, customer_id, vehicle_id }). `others` (optional) are the bookings
// already loaded, used to warn when a technician is double-booked.
export default function AppointmentModal({ open, onClose, appointment, defaults, others, onSaved, onDeleted }) {
  const { t, lang } = useT()
  const toast = useToast()
  const { can, profile, roleName } = useAuth()
  const { timezone, settings } = useShop()
  const hours = settings?.opening_hours
  const staff = useStaff()
  const canEdit = can('edit_jobs')
  const [lists, setLists] = useState(null) // { customers, vehicles }
  const [jobs, setJobs] = useState([])
  const [f, setF] = useState(null)
  const [errors, setErrors] = useState({})
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [createdJob, setCreatedJob] = useState(null) // a job made by an earlier save that then failed
  const [history, setHistory] = useState(null)

  // Fresh form each time it opens.
  useEffect(() => {
    if (!open) return
    setErrors({}); setMsg(null); setConfirmDelete(false); setCreatedJob(null); setHistory(null)
    const a = appointment
    const startIso = a?.start_time || defaults?.start || defaultStart(timezone, hours)
    const s = shopParts(startIso, timezone)
    const endIso = a?.end_time || defaults?.end || new Date(new Date(startIso).getTime() + 3600000).toISOString()
    const e = shopParts(endIso, timezone)
    setF({
      title: a?.title || defaults?.title || '',
      startDate: s.date, startTime: minutesToHhmm(s.minutes),
      endDate: e.date, endTime: minutesToHhmm(e.minutes),
      customer_id: a?.customer_id || defaults?.customer_id || '',
      vehicle_id: a?.vehicle_id || defaults?.vehicle_id || '',
      ro: a?.ro_id || defaults?.ro_id || '',
      concerns: '',
      technician_id: a?.technician_id || defaults?.technician_id || '',
      status: a?.status || 'scheduled',
      notes: a?.notes || '',
    })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Companies and vehicles are (re)loaded each time, so ones added a moment ago show up.
  useEffect(() => {
    if (!open) return
    Promise.all([
      selectAll(() => supabase.from('customers').select('id, display_name, legal_name, active').order('display_name').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, customer_id, plate, make, model, year, status').order('plate').order('id')),
    ]).then(([c, v]) => {
      setLists({ customers: c.data || [], vehicles: v.data || [] })
      if (c.error || v.error) setMsg(errorText(c.error || v.error, t))
    })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Open estimates of the chosen vehicle (plus the job it's already linked to, whatever its state).
  const vehicleId = f?.vehicle_id
  const linked = appointment?.ro_id || defaults?.ro_id || null
  useEffect(() => {
    setJobs([])
    if (!open || !vehicleId) return
    let live = true
    supabase.from('repair_orders').select('id, job_number, workflow_status, order_status, closed_at, vehicle_id').eq('vehicle_id', vehicleId).order('job_number', { ascending: false })
      .then(({ data }) => { if (live) setJobs((data || []).filter((j) => (j.order_status === 'estimate' && !j.closed_at) || j.id === linked)) })
    return () => { live = false }
  }, [open, vehicleId, linked])

  const customers = lists?.customers || []
  const vehicles = lists?.vehicles || []
  const customer = customers.find((c) => c.id === f?.customer_id)
  const custVehicles = vehicles.filter((v) => v.customer_id === f?.customer_id && (v.status !== 'sold' || v.id === f?.vehicle_id))
  const pickOptions = useMemo(() => {
    const plates = {}
    for (const v of vehicles) (plates[v.customer_id] ||= []).push(`${v.plate} ${(v.plate || '').replace(/\s/g, '')}`)
    return customers.filter((c) => c.active !== false).map((c) => ({
      key: c.id, c, search: [c.display_name, c.legal_name, ...(plates[c.id] || [])].filter(Boolean).join(' ').toLowerCase(),
    }))
  }, [customers, vehicles])

  if (!open || !f) return null
  const set = (k) => (e) => { const val = e?.target ? e.target.value : e; setF((x) => ({ ...x, [k]: val })) }
  const readOnly = !canEdit
  const job = jobs.find((j) => j.id === f.ro)
  const jobLocked = Boolean(appointment?.ro_id && job && (job.order_status !== 'estimate' || job.closed_at))

  function pickCustomer(c) {
    const vs = vehicles.filter((v) => v.customer_id === c.id && v.status !== 'sold')
    setF((x) => ({ ...x, customer_id: c.id, vehicle_id: vs.length === 1 ? vs[0].id : '', ro: '' }))
  }
  function setStartDate(e) {
    const val = e.target.value
    setF((x) => {
      // Moving the start day moves the end day with it, keeping the length.
      if (!isDate(val) || !isDate(x.startDate) || !isDate(x.endDate)) return { ...x, startDate: val }
      return { ...x, startDate: val, endDate: addDays(x.endDate, daysBetween(x.startDate, val)) }
    })
  }
  function setStartTime(e) {
    const val = e.target.value
    setF((x) => {
      const a = hhmmToMinutes(x.startTime); const b = hhmmToMinutes(val); const end = hhmmToMinutes(x.endTime)
      if (a == null || b == null || end == null || x.startDate !== x.endDate) return { ...x, startTime: val }
      const len = end > a ? end - a : 60 // an end before the start is treated as a one-hour booking
      // Keep the length, but not past closing time.
      const dh = isDate(x.startDate) ? dayHours(hours, x.startDate) : null
      const close = Math.min(dh?.open ? dh.end : 1440, 24 * 60 - 15) // the form can't end at 24:00 on the same day
      const newEnd = Math.min(b + len, close)
      return newEnd > b ? { ...x, startTime: val, endTime: minutesToHhmm(newEnd) } : { ...x, startTime: val }
    })
  }

  const sMin = hhmmToMinutes(f.startTime)
  const eMin = hhmmToMinutes(f.endTime)
  const startIso = isDate(f.startDate) && sMin != null ? shopTimeToIso(f.startDate, sMin, timezone) : null
  const endIso = isDate(f.endDate) && eMin != null ? shopTimeToIso(f.endDate, eMin, timezone) : null
  const clash = (others || []).find((o) => o.id !== appointment?.id && isActiveAppt(o) && f.technician_id && o.technician_id === f.technician_id
    && f.status !== 'cancelled' && f.status !== 'no_show' && startIso && endIso && Date.parse(o.start_time) < Date.parse(endIso) && Date.parse(o.end_time) > Date.parse(startIso))

  // (Before the opening-hours setting exists, the default hours apply: Mon–Sat 08:00–17:00.)
  const startDay = isDate(f.startDate) ? dayHours(hours, f.startDate) : null
  const endDay = isDate(f.endDate) ? dayHours(hours, f.endDate) : null

  function validate() {
    const e = {}
    if (!startIso) e.start = t('appt.badTime')
    if (!endIso) e.end = t('appt.badTime')
    if (startIso && endIso && Date.parse(endIso) <= Date.parse(startIso)) e.end = t('appt.endAfterStart')
    if (startIso && endIso && new Date(endIso) - new Date(startIso) > MAX_DAYS * 86400000) e.end = t('appt.tooLong', { n: MAX_DAYS })
    // Opening hours (Settings), the same rule the database applies. Only checked when the time changes.
    const timeChanged = !appointment || Date.parse(startIso) !== Date.parse(appointment.start_time) || Date.parse(endIso) !== Date.parse(appointment.end_time)
    const problem = !e.start && !e.end && timeChanged ? bookingProblem(hours, startIso, endIso, timezone) : null
    if (problem) e[problem.key.startsWith('hours.end') || problem.key === 'hours.afterClose' ? 'end' : 'start'] = hoursText(problem, t, lang)
    if (!f.customer_id && !f.title.trim()) e.who = t('appt.needWho')
    if (f.ro === 'new' && !f.vehicle_id) e.vehicle = t('appt.needVehicle')
    if (f.title.length > 200) e.title = t('appt.tooLongText')
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function save() {
    if (!validate()) return
    setBusy(true); setMsg(null)
    let roId = f.ro && f.ro !== 'new' ? f.ro : null
    let jobMade = createdJob // the state only updates after this save, so the message below reads this
    if (f.ro === 'new') {
      if (createdJob && createdJob.vehicle_id === f.vehicle_id) roId = createdJob.id
      else {
        const advisor = roleName !== 'Technician' && staff.some((s) => s.id === profile?.id) ? profile.id : null
        const { data: ro, error } = await supabase.from('repair_orders').insert({ customer_id: f.customer_id, vehicle_id: f.vehicle_id, priority: 'medium', service_advisor_id: advisor }).select().single()
        if (error) { setBusy(false); return setMsg(errorText(error, t)) }
        roId = ro.id
        jobMade = ro
        setCreatedJob(ro)
        const lines = f.concerns.split('\n').map((x) => x.trim()).filter(Boolean)
        if (lines.length) {
          const c = await supabase.from('ro_concerns').insert(lines.map((text, position) => ({ ro_id: ro.id, text, position })))
          if (c.error) toast(errorText(c.error, t), 'err')
        }
      }
    }
    const row = {
      title: f.title.trim() || null, start_time: startIso, end_time: endIso,
      customer_id: f.customer_id || null, vehicle_id: f.vehicle_id || null, ro_id: roId,
      technician_id: f.technician_id || null, status: f.status, notes: f.notes.trim() || null,
    }
    const res = appointment
      ? await supabase.from('appointments').update(row).eq('id', appointment.id).select().single()
      : await supabase.from('appointments').insert(row).select().single()
    setBusy(false)
    if (res.error) {
      setMsg(errorText(res.error, t) + (f.ro === 'new' && !appointment ? ` ${t('appt.jobKept', { no: jobNo(jobMade?.job_number) })}` : ''))
      return
    }
    toast(appointment ? t('appt.saved') : t('appt.booked'))
    onSaved?.(res.data)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('appointments').delete().eq('id', appointment.id)
    setBusy(false)
    if (error) return setMsg(errorText(error, t))
    toast(t('appt.deleted'))
    onDeleted?.(appointment)
  }

  async function loadHistory() {
    setHistory('loading')
    const [log, people] = await Promise.all([
      supabase.from('activity_log').select('*').eq('entity_type', 'appointments').eq('entity_id', appointment.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('profiles').select('id, name'),
    ])
    const who = Object.fromEntries((people.data || []).map((p) => [p.id, p.name]))
    setHistory((log.data || []).map((r) => ({ ...r, who: who[r.user_id] })))
  }

  const title = appointment ? (readOnly ? t('appt.view') : t('appt.edit')) : t('appt.new')
  const staffName = (id) => staff.find((s) => s.id === id)?.name || '?'
  const fieldVal = (k, v) => {
    if (v == null || v === '') return '—'
    if (k === 'start_time' || k === 'end_time') return fmtDateTime(v, lang, timezone)
    if (k === 'status') return t(`appt.st.${v}`)
    if (k === 'technician_id') return staffName(v)
    if (k === 'ro_id') return v ? t('appt.linkedJob') : '—'
    if (k === 'customer_id') return customers.find((c) => c.id === v)?.display_name || '?'
    if (k === 'vehicle_id') return vehicles.find((x) => x.id === v)?.plate || '?'
    return String(v)
  }

  return (
    <Modal open={open} title={title} onClose={onClose} wide
      footer={<>
        {appointment && canEdit && (confirmDelete
          ? <Button variant="danger" className="solid" loading={busy} onClick={remove}>{t('appt.deleteYes')}</Button>
          : <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>{t('appt.delete')}</Button>)}
        <div className="spacer" />
        <Button onClick={onClose}>{readOnly ? t('common.close') : t('common.cancel')}</Button>
        {!readOnly && <Button variant="primary" loading={busy} onClick={save}>{appointment ? t('common.save') : t('appt.book')}</Button>}
      </>}>
      {msg && <Notice kind="err" style={{ marginBottom: 12 }}>{msg}</Notice>}
      {readOnly && <Notice kind="info" style={{ marginBottom: 12 }}>{t('appt.readOnly')}</Notice>}
      <div className="grid2">
        <div className="field span2">
          <label htmlFor="ap-title">{t('appt.title')}</label>
          <input id="ap-title" className={`input ${errors.title ? 'invalid' : ''}`} value={f.title} onChange={set('title')} disabled={readOnly} maxLength={200} placeholder={t('appt.titleHint')} />
          {errors.title && <div className="error">{errors.title}</div>}
        </div>
        <div className="field">
          <label htmlFor="ap-sd">{t('appt.start')}</label>
          <div className="row" style={{ gap: 6 }}>
            <input id="ap-sd" type="date" className={`input ${errors.start ? 'invalid' : ''}`} value={f.startDate} onChange={setStartDate} disabled={readOnly} />
            <TimeSelect value={f.startTime} onChange={setStartTime} disabled={readOnly} invalid={!!errors.start} label={t('appt.startTime')} lang={lang}
              range={!startDay ? undefined : startDay.open ? [startDay.start, startDay.end - 15] : null} />
          </div>
          {errors.start ? <div className="error">{errors.start}</div>
            : startDay && !startDay.open ? <div className="error">{hoursText({ key: 'hours.closedDay', day: startDay.key }, t, lang)}</div>
              : startDay && <div className="hint">{t('hours.openFromTo', { from: minutesToHhmm(startDay.start), to: hhmm24(startDay.end) })}</div>}
        </div>
        <div className="field">
          <label htmlFor="ap-ed">{t('appt.end')}</label>
          <div className="row" style={{ gap: 6 }}>
            <input id="ap-ed" type="date" className={`input ${errors.end ? 'invalid' : ''}`} value={f.endDate} onChange={set('endDate')} disabled={readOnly} />
            <TimeSelect value={f.endTime} onChange={set('endTime')} disabled={readOnly} invalid={!!errors.end} label={t('appt.endTime')} lang={lang}
              range={!endDay ? undefined : endDay.open ? [f.endDate === f.startDate && sMin != null ? Math.max(endDay.start, sMin) + 15 : endDay.start, Math.min(endDay.end, 24 * 60 - 15)] : null} />
          </div>
          {errors.end && <div className="error">{errors.end}</div>}
        </div>

        <div className="field span2">
          <label>{t('job.company')}</label>
          {customer ? (
            <div className="pickedbox">
              <b>{customer.display_name}</b>
              <div className="spacer" />
              {!readOnly && !jobLocked && <button type="button" className="linkbtn small" onClick={() => setF((x) => ({ ...x, customer_id: '', vehicle_id: '', ro: '' }))}>{t('appt.change')}</button>}
            </div>
          ) : readOnly ? <div className="muted">—</div> : (
            <Picker options={pickOptions} onPick={(o) => pickCustomer(o.c)} placeholder={lists ? t('job.searchCompany') : t('common.loading')}
              render={(o) => <span><b>{o.c.display_name}</b>{o.c.legal_name && <span className="muted small"> · {o.c.legal_name}</span>}</span>} />
          )}
          {errors.who ? <div className="error">{errors.who}</div> : !customer && <div className="hint">{t('appt.blockHint')}</div>}
        </div>
        {customer && (
          <>
            <Select label={t('job.vehicle')} value={f.vehicle_id} disabled={readOnly || jobLocked} error={errors.vehicle}
              onChange={(e) => setF((x) => ({ ...x, vehicle_id: e.target.value, ro: '' }))}
              options={[{ value: '', label: custVehicles.length ? t('appt.noVehicle') : t('job.noVehicles') }, ...custVehicles.map((v) => ({ value: v.id, label: `${v.plate} · ${vehicleName(v) || '—'}` }))]} />
            <div className="field">
              <label htmlFor="ap-job">{t('appt.job')}</label>
              <select id="ap-job" className="select" value={f.ro} onChange={set('ro')} disabled={readOnly || jobLocked || !f.vehicle_id}>
                <option value="">{f.vehicle_id ? t('appt.noJob') : t('appt.pickVehicleFirst')}</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>#{jobNo(j.job_number)} · {t(`job.wf.${j.workflow_status}`)}</option>)}
                {f.vehicle_id && !appointment?.ro_id && <option value="new">{createdJob?.vehicle_id === f.vehicle_id ? t('appt.newJobMade', { no: jobNo(createdJob.job_number) }) : t('appt.newJob')}</option>}
              </select>
              {job && <div className="hint"><Link to={`/jobs/${job.id}`} onClick={onClose}>{t('appt.openJob', { no: jobNo(job.job_number) })}</Link> <Badge color={WORKFLOW_COLOR[job.workflow_status]}>{t(`job.wf.${job.workflow_status}`)}</Badge></div>}
              {!job && f.ro !== 'new' && f.vehicle_id && <div className="hint">{t('appt.jobHint')}</div>}
            </div>
            {f.ro === 'new' && createdJob?.vehicle_id !== f.vehicle_id && (
              <Textarea fieldClass="span2" label={t('appt.concerns')} rows={2} value={f.concerns} onChange={set('concerns')} placeholder={t('job.concernExample')} hint={t('appt.concernsHint')} />
            )}
          </>
        )}

        <Select label={t('board.technician')} value={f.technician_id} onChange={set('technician_id')} disabled={readOnly}
          options={[{ value: '', label: t('appt.unassigned') }, ...staff.map((s) => ({ value: s.id, label: s.name }))]} />
        <div className="field">
          <label htmlFor="ap-status">{t('appt.status')}</label>
          <select id="ap-status" className="select" value={f.status} onChange={set('status')} disabled={readOnly}>
            {APPT_STATUSES.map((s) => <option key={s} value={s}>{t(`appt.st.${s}`)}</option>)}
          </select>
          <div className="hint"><span className={`dot d-${APPT_COLOR[f.status]}`} /> {t(`appt.stHint.${f.status}`)}</div>
        </div>
        {clash && <Notice kind="warn" style={{ gridColumn: '1 / -1' }}>{t('appt.clash', { name: staffName(f.technician_id), when: fmtDateTime(clash.start_time, lang, timezone) })}</Notice>}
        <Textarea fieldClass="span2" label={t('appt.notes')} rows={2} value={f.notes} onChange={set('notes')} disabled={readOnly} maxLength={4000} placeholder={t('appt.notesHint')} />
      </div>
      {appointment && (
        <div style={{ marginTop: 12 }}>
          {history === null ? <button type="button" className="linkbtn small" onClick={loadHistory}>{t('cat.hist.show')}</button>
            : history === 'loading' ? <div className="muted small">{t('common.loading')}</div>
              : history.length === 0 ? <div className="muted small">{t('cat.hist.none')}</div> : (
                <ol className="hist" style={{ marginTop: 8 }}>
                  {history.map((r) => (
                    <li key={r.id}>
                      <div className="hist-meta">{r.who || t('cat.hist.system')} · {fmtDateTime(r.created_at, lang, timezone)}</div>
                      <div className="hist-body">
                        {r.action === 'create' ? t('appt.histCreated') : r.action === 'delete' ? t('appt.histDeleted')
                          : Object.entries(r.changes || {}).filter(([k]) => k !== 'created_by').map(([k, [a, b]]) => (
                            <div key={k} className="hist-change"><span className="muted">{t(`appt.f.${k}`)}:</span> {fieldVal(k, a)} → <b>{fieldVal(k, b)}</b></div>
                          ))}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
        </div>
      )}
    </Modal>
  )
}

// A new booking made "now": the next quarter hour the shop is open (or the next opening time).
function defaultStart(tz, hours) {
  const today = shopToday(tz)
  const now = shopParts(new Date(), tz)
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i)
    const dh = dayHours(hours, d)
    if (!dh.open) continue
    const m = i === 0 ? Math.max(dh.start, Math.ceil((now.minutes + 1) / 15) * 15) : dh.start
    if (m + 15 <= dh.end) return shopTimeToIso(d, m, tz)
  }
  return shopTimeToIso(addDays(today, 1), 8 * 60, tz)
}

// 24-hour times in quarter hours (the browser's own time picker may show AM/PM).
const QUARTERS = Array.from({ length: 96 }, (_, i) => minutesToHhmm(i * 15))
// `range` [from, to] in minutes limits the choice to opening hours (null = closed: only the current value).
function TimeSelect({ value, onChange, disabled, invalid, label, lang, range }) {
  const within = range === undefined ? QUARTERS : range === null ? [] : QUARTERS.filter((q) => { const m = hhmmToMinutes(q); return m >= range[0] && m <= range[1] })
  const list = !value || within.includes(value) ? within : [...within, value].sort()
  return (
    <select className={`select ${invalid ? 'invalid' : ''}`} style={{ maxWidth: 110 }} value={value} onChange={onChange} disabled={disabled} aria-label={label}>
      {list.map((q) => <option key={q} value={q}>{lang === 'id' ? q.replace(':', '.') : q}</option>)}
    </select>
  )
}
