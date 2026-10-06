import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Button, Notice, PageHead, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { initials, jobNo } from '../../lib/format'
import { shopToday, vehicleName } from '../../lib/customers'
import {
  addDays, addMonths, clock, dayLabel, daysBetween, isDate, layoutOverlaps, monthFirst, monthLabel,
  shopParts, shopTimeToIso, weekStart, weekdayNames,
} from '../../lib/calendar'
import { selectAll } from '../customers/useCustomerData'
import { useStaff } from '../jobs/useJobData'
import AppointmentModal from './AppointmentModal'

const HOUR_PX = 52
const SLOT = 30 // minutes per clickable slot
const DAY_START = 7 * 60
const DAY_END = 18 * 60
const MIN_EV = 30 // shortest drawn booking, in minutes, so short ones stay readable and never overlap
const VIEWS = ['day', 'week', 'month']

// The days a view covers: [first, last] inclusive.
function rangeFor(view, date) {
  if (view === 'day') return [date, date]
  if (view === 'week') { const s = weekStart(date); return [s, addDays(s, 6)] }
  const s = weekStart(monthFirst(date))
  return [s, addDays(s, 41)]
}

function SearchBox({ value, onChange, placeholder }) {
  const { t } = useT()
  return (
    <div className="searchbox">
      <Icon name="search" size={14} color="var(--muted)" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button className="btn ghost sm" onClick={() => onChange('')} aria-label={t('common.clear')} style={{ padding: 2 }}><Icon name="x" size={13} /></button>}
    </div>
  )
}

// Calendar: appointments by day (one column per technician), week or month, on the shop clock.
export default function CalendarPage() {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const { can } = useAuth()
  const { timezone } = useShop()
  const staff = useStaff()
  const canEdit = can('edit_jobs')
  const params = new URLSearchParams(location.search)
  const today = shopToday(timezone)
  const view = VIEWS.includes(params.get('v')) ? params.get('v') : 'week'
  const date = isDate(params.get('d')) ? params.get('d') : today
  const [first, last] = rangeFor(view, date)

  const [appts, setAppts] = useState(null)
  const [requests, setRequests] = useState([])
  const [names, setNames] = useState(null)
  const [jobs, setJobs] = useState({})
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [tech, setTech] = useState('')
  const [showCancelled, setShowCancelled] = useState(false)
  const [allHours, setAllHours] = useState(false)
  const [panel, setPanel] = useState(true)
  const [modal, setModal] = useState(null) // { appointment } | { defaults }
  const loads = useRef(0)

  const go = (v, d) => navigate(`/calendar?v=${v}&d=${d}`, { replace: true })

  useEffect(() => {
    Promise.all([
      selectAll(() => supabase.from('customers').select('id, display_name').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, plate, make, model, year').order('id')),
    ]).then(([c, v]) => setNames({
      customer: Object.fromEntries((c.data || []).map((x) => [x.id, x])),
      vehicle: Object.fromEntries((v.data || []).map((x) => [x.id, x])),
    }))
  }, [])

  const load = useCallback(async () => {
    const n = ++loads.current
    const from = shopTimeToIso(first, 0, timezone)
    const to = shopTimeToIso(addDays(last, 1), 0, timezone)
    const [a, r] = await Promise.all([
      selectAll(() => supabase.from('appointments').select('*').lt('start_time', to).gt('end_time', from).order('start_time').order('id')),
      selectAll(() => supabase.from('appointments').select('*').eq('status', 'requested').gt('end_time', new Date().toISOString()).order('start_time').order('id')),
    ])
    const roIds = [...new Set([...(a.data || []), ...(r.data || [])].map((x) => x.ro_id).filter(Boolean))]
    const j = roIds.length ? await supabase.from('repair_orders').select('id, job_number, workflow_status, order_status').in('id', roIds) : { data: [] }
    if (n !== loads.current) return
    setAppts(a.data || [])
    setRequests(r.data || [])
    setJobs(Object.fromEntries((j.data || []).map((x) => [x.id, x])))
    setError(a.error || r.error || j.error || null)
  }, [first, last, timezone])
  useEffect(() => { load() }, [load])

  // "+ New appointment" from the top bar arrives as ?new=1.
  useEffect(() => {
    if (params.get('new') !== '1') return
    if (canEdit) setModal({ defaults: {} })
    go(view, date)
  }, [location.search]) // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase()
  const label = (a) => {
    const c = names?.customer[a.customer_id]
    const v = names?.vehicle[a.vehicle_id]
    return { who: c?.display_name || a.title || '—', title: c ? a.title : null, plate: v?.plate, vehicle: v ? vehicleName(v) : '', job: a.ro_id ? jobs[a.ro_id] : null }
  }
  const shown = useMemo(() => (appts || []).filter((a) => {
    if (!showCancelled && a.status === 'cancelled') return false
    if (tech === 'none' ? a.technician_id : tech && a.technician_id !== tech) return false
    if (!needle) return true
    const l = label(a)
    return [l.who, l.title, l.plate, l.plate?.replace(/\s/g, ''), l.vehicle, l.job && jobNo(l.job.job_number), a.notes].filter(Boolean).join(' ').toLowerCase().includes(needle)
  }), [appts, showCancelled, tech, needle, names, jobs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rescheduling by drag: same length, new start (and, in the day view, maybe a new technician).
  async function moveTo(a, dateStr, minutes, technicianId) {
    const len = new Date(a.end_time) - new Date(a.start_time)
    const start = shopTimeToIso(dateStr, minutes, timezone)
    const patch = { start_time: start, end_time: new Date(new Date(start).getTime() + len).toISOString() }
    if (technicianId !== undefined) patch.technician_id = technicianId || null
    if (Date.parse(patch.start_time) === Date.parse(a.start_time) && (technicianId === undefined || (technicianId || null) === a.technician_id)) return
    setAppts((list) => list.map((x) => (x.id === a.id ? { ...x, ...patch } : x)))
    const { error: err } = await supabase.from('appointments').update(patch).eq('id', a.id)
    if (err) toast(errorText(err, t), 'err')
    else toast(t('cal.moved', { when: `${dayLabel(dateStr, lang)} ${clock(minutes, lang)}` }))
    load()
  }
  const newAt = (dateStr, minutes, technicianId) => {
    if (!canEdit) return
    const start = shopTimeToIso(dateStr, minutes, timezone)
    setModal({ defaults: { start, end: new Date(new Date(start).getTime() + 3600000).toISOString(), technician_id: technicianId || '' } })
  }

  const step = (dir) => {
    if (view === 'day') go(view, addDays(date, dir))
    else if (view === 'week') go(view, addDays(date, dir * 7))
    else go(view, addMonths(date, dir))
  }
  const title = view === 'day' ? dayLabel(date, lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : view === 'week' ? `${dayLabel(first, lang, { day: 'numeric', month: 'short' })} – ${dayLabel(last, lang, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : monthLabel(date, lang)

  const techs = staff.filter((s) => s.roles?.name === 'Technician' || (appts || []).some((a) => a.technician_id === s.id))
  const common = { appts: shown, label, staff, canEdit, today, allHours, onOpen: (a) => setModal({ appointment: a }), onNew: newAt, onMove: moveTo }

  return (
    <main className="content cal-page">
      <PageHead title={t('nav.calendar')} sub={t('cal.sub')}
        actions={<>
          <Link className="btn" to="/board"><Icon name="layout-kanban" size={15} />{t('nav.board')}</Link>
          {canEdit && <Button variant="primary" icon="plus" onClick={() => setModal({ defaults: {} })}>{t('cal.newAppt')}</Button>}
        </>} />
      <div className="filterbar cal-bar">
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn sm" onClick={() => step(-1)} aria-label={t('cal.prev')}><Icon name="chevronLeft" size={15} /></button>
          <button type="button" className="btn sm" onClick={() => go(view, today)}>{t('cal.today')}</button>
          <button type="button" className="btn sm" onClick={() => step(1)} aria-label={t('cal.next')}><Icon name="chevronRight" size={15} /></button>
        </div>
        <h2 className="cal-title" aria-live="polite">{title}</h2>
        <div className="seg" role="tablist" aria-label={t('cal.view')}>
          {VIEWS.map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} className={`seg-btn ${view === v ? 'on' : ''}`} onClick={() => go(v, date)}>{t(`cal.${v}`)}</button>)}
        </div>
        <div className="spacer" />
        <SearchBox value={q} onChange={setQ} placeholder={t('cal.search')} />
        <select className="select chipselect" value={tech} onChange={(e) => setTech(e.target.value)} aria-label={t('board.technician')}>
          <option value="">{t('board.allTechs')}</option>
          <option value="none">{t('appt.unassigned')}</option>
          {techs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label className="checkline"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> {t('cal.showCancelled')}</label>
        {view !== 'month' && <label className="checkline"><input type="checkbox" checked={allHours} onChange={(e) => setAllHours(e.target.checked)} /> {t('cal.allHours')}</label>}
      </div>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      <div className={`cal-layout ${panel ? 'with-panel' : ''}`}>
        <aside className="cal-panel card">
          <div className="row" style={{ gap: 8 }}>
            <h3>{t('cal.requests')} <span className="bcol-count">{requests.length}</span></h3>
            <div className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => setPanel((p) => !p)} aria-expanded={panel} aria-label={panel ? t('cal.hideRequests') : t('cal.showRequests')}>
              <Icon name={panel ? 'chevronLeft' : 'chevronRight'} size={15} />
            </button>
          </div>
          {panel && (requests.length === 0 ? <div className="muted small" style={{ marginTop: 8 }}>{t('cal.noRequests')}</div> : (
            <ul className="reqlist">
              {requests.map((a) => {
                const l = label(a)
                const p = shopParts(a.start_time, timezone)
                return (
                  <li key={a.id}>
                    <button type="button" className="reqrow" onClick={() => setModal({ appointment: a })}>
                      <span className="muted small">{dayLabel(p.date, lang)} · {clock(p.minutes, lang)}</span>
                      <b>{l.who}</b>
                      {l.plate && <span className="small">{l.plate} <span className="muted">{l.vehicle}</span></span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          ))}
        </aside>
        <div className="cal-main">
          {!appts || !names ? <div className="card muted">{t('common.loading')}</div>
            : view === 'month' ? <MonthView {...common} date={date} first={first} onDay={(d) => go('day', d)} />
              : view === 'week' ? <TimeGrid {...common} columns={Array.from({ length: 7 }, (_, i) => { const d = addDays(first, i); return { key: d, date: d, label: dayLabel(d, lang, { weekday: 'short' }), sub: dayLabel(d, lang, { day: 'numeric', month: 'short' }), onHead: () => go('day', d) } })} />
                : <TimeGrid {...common} byTech columns={dayColumns(date, staff, shown, tech, t, lang)} />}
          {appts && appts.length === 0 && <div className="hint">{t('cal.emptyRange')}</div>}
        </div>
      </div>
      <AppointmentModal open={!!modal} onClose={() => setModal(null)} appointment={modal?.appointment} defaults={modal?.defaults} others={appts || []}
        onSaved={() => { setModal(null); load() }} onDeleted={() => { setModal(null); load() }} />
    </main>
  )
}

// Day view columns: Unassigned, then each technician (or just the one picked in the filter).
function dayColumns(date, staff, appts, tech, t) {
  const cols = [{ key: 'none', date, techId: '', label: t('appt.unassigned') }]
  const ids = new Set(staff.filter((s) => s.roles?.name === 'Technician').map((s) => s.id))
  for (const a of appts) if (a.technician_id) ids.add(a.technician_id)
  for (const s of staff) if (ids.has(s.id)) cols.push({ key: s.id, date, techId: s.id, label: s.name })
  for (const id of ids) if (!staff.some((s) => s.id === id)) cols.push({ key: id, date, techId: id, label: '?' })
  if (tech === 'none') return cols.slice(0, 1)
  if (tech) return cols.filter((c) => c.techId === tech)
  return cols
}

// The part of an appointment that falls on one day, in minutes on the shop clock (multi-day bookings span days).
function pieceOn(a, dateStr, tz) {
  const s = shopParts(a.start_time, tz)
  const e = shopParts(a.end_time, tz)
  if (s.date > dateStr || e.date < dateStr || (e.date === dateStr && e.minutes === 0 && s.date !== dateStr)) return null
  return { start: s.date === dateStr ? s.minutes : 0, end: e.date === dateStr ? e.minutes : 24 * 60, first: s.date === dateStr, last: e.date === dateStr }
}

// "08:00–10:00"; for bookings over several days: "08:00 →", "All day", "→ 17:00".
function spanText(p, lang, t) {
  if (p.first && p.last) return `${clock(p.start, lang)}–${clock(p.end, lang)}`
  if (p.first) return `${clock(p.start, lang)} →`
  if (p.last) return `→ ${clock(p.end, lang)}`
  return t('cal.allDay')
}

function TimeGrid({ columns, byTech, appts, label, staff, canEdit, today, allHours, onOpen, onNew, onMove }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [drag, setDrag] = useState(null)
  const [over, setOver] = useState(null)
  const scroller = useRef(null)
  const pieces = columns.map((col) => appts.filter((a) => !byTech || (a.technician_id || '') === col.techId)
    .map((a) => ({ a, p: pieceOn(a, col.date, timezone) })).filter((x) => x.p))
  // Office hours, stretched to fit anything booked outside them.
  let lo = DAY_START; let hi = DAY_END
  if (allHours) { lo = 0; hi = 24 * 60 } else {
    // Only real start and end times stretch the hours; the in-between days of a long booking don't.
    for (const list of pieces) for (const { p } of list) {
      if (p.first) lo = Math.min(lo, Math.floor(p.start / 60) * 60)
      if (p.last) hi = Math.max(hi, Math.ceil(p.end / 60) * 60)
    }
  }
  const px = (m) => ((m - lo) / 60) * HOUR_PX
  const hours = []
  for (let m = lo; m < hi; m += 60) hours.push(m)
  const slots = []
  for (let m = lo; m < hi; m += SLOT) slots.push(m)
  const now = shopParts(new Date(), timezone)

  // Start the view at the first booking (or office hours) rather than midnight.
  useEffect(() => {
    if (scroller.current && allHours) scroller.current.scrollTop = px(Math.max(0, DAY_START - 60))
  }, [allHours]) // eslint-disable-line react-hooks/exhaustive-deps

  const minutesAt = (e, el) => {
    const r = el.getBoundingClientRect()
    const m = lo + ((e.clientY - r.top) / HOUR_PX) * 60
    return Math.max(lo, Math.min(hi - 15, Math.round(m / 15) * 15))
  }

  return (
    <div className="tgrid card" style={{ '--cols': columns.length }}>
      <div className="tgrid-head">
        <div className="tgrid-gutter" />
        {columns.map((c) => (
          <div key={c.key} className={`tgrid-colhead ${c.date === today && !byTech ? 'today' : ''}`}>
            {c.onHead ? <button type="button" className="linkbtn" onClick={c.onHead}><b>{c.label}</b> <span className="muted">{c.sub}</span></button>
              : <><b>{c.label}</b>{c.techId && <span className="avatar tiny">{initials(c.label)}</span>}</>}
          </div>
        ))}
      </div>
      <div className="tgrid-scroll" ref={scroller}>
        <div className="tgrid-body" style={{ height: px(hi) }}>
          <div className="tgrid-gutter">
            {hours.map((m) => <div key={m} className="tgrid-hour" style={{ top: px(m) }}>{clock(m, lang)}</div>)}
          </div>
          {columns.map((c, ci) => (
            <div key={c.key} className={`tgrid-col ${over === c.key ? 'over' : ''}`}
              onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(c.key) } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o === c.key ? null : o)) }}
              onDrop={(e) => {
                e.preventDefault(); setOver(null)
                if (!drag) return
                const m = minutesAt(e, e.currentTarget) - drag.offset
                onMove(drag.a, c.date, Math.max(0, Math.round(m / 15) * 15), byTech ? c.techId : undefined)
                setDrag(null)
              }}>
              {slots.map((m) => (
                <button key={m} type="button" tabIndex={-1} className={`tgrid-slot ${m % 60 === 0 ? 'hour' : ''}`} style={{ top: px(m), height: (SLOT / 60) * HOUR_PX }}
                  disabled={!canEdit} aria-label={canEdit ? t('cal.newAt', { when: `${dayLabel(c.date, lang)} ${clock(m, lang)}`, who: byTech ? c.label : '' }) : undefined}
                  onClick={() => onNew(c.date, m, byTech ? c.techId : '')} />
              ))}
              {c.date === today && now.minutes >= lo && now.minutes <= hi && <div className="tgrid-now" style={{ top: px(now.minutes) }} aria-hidden="true" />}
              {layoutOverlaps(pieces[ci].map(({ a, p }) => ({ a, p, top: Math.max(p.start, lo), bottom: Math.max(Math.min(p.end, hi), Math.max(p.start, lo) + MIN_EV) }))).map((ev) => {
                const l = label(ev.a)
                const height = px(ev.bottom) - px(ev.top)
                const tech = staff.find((s) => s.id === ev.a.technician_id)
                return (
                  <button key={ev.a.id} type="button" draggable={canEdit && ev.p.first}
                    className={`ev s-${ev.a.status} ${drag?.a.id === ev.a.id ? 'dragging' : ''} ${height < 40 ? 'short' : ''}`}
                    style={{ top: px(ev.top), height, left: `calc(${(ev.col / ev.cols) * 100}% + 2px)`, width: `calc(${100 / ev.cols}% - 4px)` }}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ev.a.id)
                      const r = e.currentTarget.getBoundingClientRect()
                      setDrag({ a: ev.a, offset: Math.round(((e.clientY - r.top) / HOUR_PX) * 60 / 15) * 15 })
                    }}
                    onDragEnd={() => { setDrag(null); setOver(null) }}
                    onClick={() => onOpen(ev.a)}
                    title={`${spanText(ev.p, lang, t)} · ${l.who}${l.plate ? ` · ${l.plate}` : ''} · ${t(`appt.st.${ev.a.status}`)}`}>
                    <span className="ev-time">{spanText(ev.p, lang, t)}{tech && !byTech && <span className="ev-tech">{initials(tech.name)}</span>}</span>
                    <span className="ev-who">{l.who}</span>
                    {height >= 56 && l.plate && <span className="ev-sub">{l.plate}{l.job ? ` · #${jobNo(l.job.job_number)}` : ''}</span>}
                    {height >= 74 && l.title && <span className="ev-sub">{l.title}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MonthView({ appts, label, date, first, staff, canEdit, today, onOpen, onNew, onMove, onDay }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [drag, setDrag] = useState(null)
  const [over, setOver] = useState(null)
  const month = date.slice(0, 7)
  const names = weekdayNames(lang)
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i))
  return (
    <div className="mgrid card">
      {names.map((n) => <div key={n} className="mgrid-head">{n}</div>)}
      {days.map((d) => {
        const list = appts.map((a) => ({ a, p: pieceOn(a, d, timezone) })).filter((x) => x.p).sort((x, y) => x.p.start - y.p.start)
        return (
          <div key={d} className={`mcell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today ? 'today' : ''} ${over === d ? 'over' : ''}`}
            onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(d) } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o === d ? null : o)) }}
            onDrop={(e) => {
              e.preventDefault(); setOver(null)
              if (!drag) return
              // Dropping a later day of a long booking shifts it by the same number of days.
              const s0 = shopParts(drag.a.start_time, timezone)
              onMove(drag.a, addDays(s0.date, daysBetween(drag.day, d)), s0.minutes)
              setDrag(null)
            }}>
            <div className="mcell-head">
              <button type="button" className="mcell-day" onClick={() => onDay(d)} aria-label={dayLabel(d, lang, { weekday: 'long', day: 'numeric', month: 'long' })}>{Number(d.slice(8))}</button>
              {canEdit && <button type="button" className="mcell-add" onClick={() => onNew(d, 8 * 60, '')} aria-label={t('cal.newOn', { day: dayLabel(d, lang) })}><Icon name="plus" size={12} /></button>}
            </div>
            {list.slice(0, 3).map(({ a, p }) => {
              const l = label(a)
              const tech = staff.find((s) => s.id === a.technician_id)
              return (
                <button key={a.id} type="button" draggable={canEdit} className={`mev s-${a.status}`} onClick={() => onOpen(a)}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.id); setDrag({ a, day: d }) }} onDragEnd={() => { setDrag(null); setOver(null) }}
                  title={`${l.who}${l.plate ? ` · ${l.plate}` : ''} · ${t(`appt.st.${a.status}`)}`}>
                  <span className="mev-time">{p.first ? clock(p.start, lang) : '→'}</span> <span className="mev-who">{l.who}</span>
                  {tech && <span className="ev-tech">{initials(tech.name)}</span>}
                </button>
              )
            })}
            {list.length > 3 && <button type="button" className="linkbtn small mmore" onClick={() => onDay(d)}>{t('cal.more', { n: list.length - 3 })}</button>}
          </div>
        )
      })}
    </div>
  )
}

