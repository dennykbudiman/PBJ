import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { colors, fontMono, formatDate } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import ConfirmModal from '../components/ConfirmModal'

// ---- time-grid constants ----
const START_HOUR = 7 // 7 AM
const END_HOUR = 19 // 7 PM
const PX_PER_HOUR = 56
const GRID_HEIGHT = (END_HOUR - START_HOUR) * PX_PER_HOUR
const SLOT_MINUTES = 15 // click-to-create snaps to this

// Deterministic per-technician color palette, cycled by index so the count
// of technicians can grow beyond today's 2 without any code changes.
const TECH_PALETTE = [
  { bg: '#E3F1EF', color: '#146B69' }, // teal (accent)
  { bg: '#FCF0DC', color: '#9A5B10' }, // amber (warn)
  { bg: '#EDE7FA', color: '#5B3FA6' }, // violet
  { bg: '#FBE7E4', color: '#C0392B' }, // red (danger)
  { bg: '#E6F5EA', color: '#227A3E' }, // green (good)
  { bg: '#E3ECFB', color: '#2255A6' }, // blue
]

function techColor(index) {
  return TECH_PALETTE[index % TECH_PALETTE.length]
}

function startOfWeek(date) {
  const d = new Date(date)
  const day = d.getDay() // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day // shift to Monday
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}
function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function dayLabel(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })
}
function hourLabel(h) {
  const period = h < 12 || h === 24 ? 'AM' : 'PM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12} ${period}`
}
function minutesSinceMidnight(d) {
  return d.getHours() * 60 + d.getMinutes()
}
function toInputDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function roundToSlot(minutes) {
  return Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES
}

const EMPTY_FORM = {
  workOrderId: '', technicianId: '', title: '', customerName: '', vehicleId: '',
  start: '', end: '', notes: '',
}

export default function Calendar() {
  const navigate = useNavigate()
  const [view, setView] = useState('week') // 'week' | 'day'
  const [anchor, setAnchor] = useState(() => new Date())

  const [technicians, setTechnicians] = useState([])
  const [vehicles, setVehicles] = useState([])
  const [workOrders, setWorkOrders] = useState([])
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [viewingAppt, setViewingAppt] = useState(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  const days = useMemo(() => {
    if (view === 'day') return [anchor]
    const start = startOfWeek(anchor)
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
  }, [view, anchor])

  const rangeStart = useMemo(() => {
    const d = new Date(days[0])
    d.setHours(0, 0, 0, 0)
    return d
  }, [days])
  const rangeEnd = useMemo(() => {
    const d = new Date(days[days.length - 1])
    d.setHours(23, 59, 59, 999)
    return d
  }, [days])

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, name, roles!inner(name)')
      .eq('roles.name', 'Technician')
      .order('name')
      .then(({ data }) => setTechnicians(data ?? []))
    supabase.from('vehicles').select('id, name, model').order('name').then(({ data }) => setVehicles(data ?? []))
    supabase
      .from('work_orders')
      .select('id, wo_number, service, status, technician_id, vehicles(id, name)')
      .neq('status', 'completed')
      .order('created_at', { ascending: false })
      .then(({ data }) => setWorkOrders(data ?? []))
  }, [])

  useEffect(() => {
    loadAppointments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart, rangeEnd])

  async function loadAppointments() {
    setLoading(true)
    const { data } = await supabase
      .from('appointments')
      .select('*, work_orders(id, wo_number, service), vehicles(id, name), technician:profiles!technician_id(id, name)')
      .gte('start_time', rangeStart.toISOString())
      .lte('start_time', rangeEnd.toISOString())
      .order('start_time', { ascending: true })
    setAppointments(data ?? [])
    setLoading(false)
  }

  const techIndex = (technicianId) => technicians.findIndex((t) => t.id === technicianId)
  const laneCount = Math.max(technicians.length, 1)

  // ---- click-to-create ----
  function handleGridClick(day, e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const offsetY = e.clientY - rect.top
    const offsetX = e.clientX - rect.left
    const minutesFromStart = Math.max(0, Math.min((END_HOUR - START_HOUR) * 60, roundToSlot((offsetY / PX_PER_HOUR) * 60)))
    const laneIdx = Math.max(0, Math.min(laneCount - 1, Math.floor((offsetX / rect.width) * laneCount)))
    const start = new Date(day)
    start.setHours(START_HOUR, 0, 0, 0)
    start.setMinutes(start.getMinutes() + minutesFromStart)
    const end = new Date(start.getTime() + 60 * 60000)
    openNewForm({
      start: toInputDatetimeLocal(start),
      end: toInputDatetimeLocal(end),
      technicianId: technicians[laneIdx]?.id || '',
    })
  }

  function openNewForm(prefill) {
    setForm({ ...EMPTY_FORM, ...prefill })
    setFormOpen(true)
  }

  function updateForm(field, value) {
    setForm((f) => {
      const next = { ...f, [field]: value }
      if (field === 'workOrderId' && value) {
        const wo = workOrders.find((w) => w.id === value)
        if (wo) {
          next.title = wo.service || ''
          next.vehicleId = wo.vehicles?.id || ''
          if (wo.technician_id) next.technicianId = wo.technician_id
        }
      }
      return next
    })
  }

  async function saveAppointment(e) {
    e.preventDefault()
    if (!form.technicianId || !form.title.trim() || !form.start || !form.end) {
      alert('Technician, description, start and end time are required.')
      return
    }
    if (new Date(form.end) <= new Date(form.start)) {
      alert('End time must be after start time.')
      return
    }
    setSaving(true)
    const { error } = await supabase.from('appointments').insert({
      work_order_id: form.workOrderId || null,
      vehicle_id: form.vehicleId || null,
      technician_id: form.technicianId,
      title: form.title.trim(),
      customer_name: form.workOrderId ? null : (form.customerName || null),
      start_time: new Date(form.start).toISOString(),
      end_time: new Date(form.end).toISOString(),
      notes: form.notes || null,
    })
    setSaving(false)
    if (error) { alert('Could not create appointment: ' + error.message); return }
    setFormOpen(false)
    loadAppointments()
  }

  async function deleteAppointment() {
    if (!viewingAppt) return
    const { error } = await supabase.from('appointments').delete().eq('id', viewingAppt.id)
    setConfirmDeleteOpen(false)
    if (error) { alert(error.message); return }
    setViewingAppt(null)
    loadAppointments()
  }

  function goToday() { setAnchor(new Date()) }
  function goPrev() { setAnchor((a) => addDays(a, view === 'day' ? -1 : -7)) }
  function goNext() { setAnchor((a) => addDays(a, view === 'day' ? 1 : 7)) }

  const rangeLabel = view === 'day'
    ? anchor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  return (
    <>
      <PageHeader title="Calendar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" onClick={goPrev} aria-label="Previous" style={navBtnStyle}>‹</button>
          <button type="button" onClick={goToday} style={{ ...navBtnStyle, width: 'auto', padding: '0 12px', fontSize: 12, fontWeight: 700 }}>Today</button>
          <button type="button" onClick={goNext} aria-label="Next" style={navBtnStyle}>›</button>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.ink, marginLeft: 6, whiteSpace: 'nowrap' }}>{rangeLabel}</span>
        </div>
        <div style={{ flex: '1 1 auto' }} />
        <div role="group" aria-label="Calendar view" style={{ display: 'flex', gap: 4, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 9, padding: 3 }}>
          {['day', 'week'].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              style={{
                border: 'none', borderRadius: 7, padding: '6px 14px', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                background: view === v ? colors.white : 'transparent', color: view === v ? colors.ink : colors.mutedLight,
                boxShadow: view === v ? '0 1px 2px rgba(20,20,20,0.08)' : 'none',
              }}
            >
              {v === 'day' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>
        <PrimaryButton onClick={() => openNewForm({})}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          New Appointment
        </PrimaryButton>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '20px 32px 40px 32px', display: 'flex', flexDirection: 'column', gap: 14 }}>

        {technicians.length === 0 && !loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.warnBg, border: '1px solid rgba(154,91,16,0.2)', borderRadius: 10, padding: '12px 16px' }}>
            <div style={{ fontSize: 13, color: colors.warn }}>No technician accounts found — add one under Technicians to book appointments against them.</div>
          </div>
        )}

        {/* Legend */}
        {technicians.length > 0 && (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {technicians.map((t, i) => {
              const pal = techColor(i)
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: colors.text2 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: pal.color, flexShrink: 0 }} />
                  {t.name}
                </div>
              )
            })}
          </div>
        )}

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'flex', minWidth: view === 'week' ? 1000 : 480 }}>
              {/* time labels column */}
              <div style={{ width: 64, flexShrink: 0, borderRight: `1px solid ${colors.border}` }}>
                <div style={{ height: 44, borderBottom: `1px solid ${colors.border}` }} />
                <div style={{ position: 'relative', height: GRID_HEIGHT }}>
                  {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i).map((h) => (
                    <div key={h} style={{ position: 'absolute', top: (h - START_HOUR) * PX_PER_HOUR - 7, right: 8, fontSize: 11, color: colors.mutedLight, fontWeight: 600 }}>
                      {hourLabel(h)}
                    </div>
                  ))}
                </div>
              </div>

              {/* day columns */}
              {days.map((day, dayIdx) => {
                const isToday = sameDay(day, new Date())
                const dayAppts = appointments.filter((a) => sameDay(new Date(a.start_time), day))
                return (
                  <div key={dayIdx} style={{ flex: '1 1 0', minWidth: view === 'week' ? 130 : 400, borderRight: dayIdx < days.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                    <div style={{ height: 44, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 700, color: isToday ? colors.accent : colors.ink, background: isToday ? colors.accentBg : 'transparent' }}>
                      {dayLabel(day)}
                    </div>
                    <div
                      onClick={(e) => handleGridClick(day, e)}
                      style={{
                        position: 'relative', height: GRID_HEIGHT, cursor: 'pointer',
                        backgroundImage: `repeating-linear-gradient(to bottom, rgba(28,30,34,0.05) 0, rgba(28,30,34,0.05) 1px, transparent 1px, transparent ${PX_PER_HOUR}px)`,
                      }}
                    >
                      {/* technician lane dividers */}
                      {laneCount > 1 && Array.from({ length: laneCount - 1 }, (_, i) => (
                        <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${((i + 1) / laneCount) * 100}%`, width: 1, background: 'rgba(28,30,34,0.05)' }} />
                      ))}

                      {dayAppts.map((appt) => {
                        const start = new Date(appt.start_time)
                        const end = new Date(appt.end_time)
                        const top = Math.max(0, minutesSinceMidnight(start) - START_HOUR * 60) * (PX_PER_HOUR / 60)
                        const height = Math.max(20, (minutesSinceMidnight(end) - minutesSinceMidnight(start)) * (PX_PER_HOUR / 60))
                        const idx = Math.max(0, techIndex(appt.technician_id))
                        const pal = techColor(idx)
                        const laneWidth = 100 / laneCount
                        return (
                          <button
                            key={appt.id}
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setViewingAppt(appt) }}
                            style={{
                              position: 'absolute', top, height, left: `${idx * laneWidth}%`, width: `calc(${laneWidth}% - 4px)`, marginLeft: 2,
                              background: pal.bg, color: pal.color, border: `1px solid ${pal.color}33`, borderRadius: 6, padding: '4px 6px',
                              textAlign: 'left', cursor: 'pointer', overflow: 'hidden', fontFamily: 'inherit',
                            }}
                          >
                            <div style={{ fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{appt.title}</div>
                            <div style={{ fontSize: 10, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · {appt.vehicles?.name || appt.customer_name || ''}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div style={{ fontSize: 12, color: colors.mutedLight }}>Click anywhere on the calendar to book a new appointment. Each day is split into one column per technician.</div>
      </main>

      {/* New appointment modal */}
      {formOpen && (
        <ModalShell title="New Appointment" onClose={() => setFormOpen(false)}>
          <form onSubmit={saveAppointment} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Link to work order (optional)">
              <select value={form.workOrderId} onChange={(e) => updateForm('workOrderId', e.target.value)} style={selectStyle}>
                <option value="">No work order — fill in manually</option>
                {workOrders.map((w) => <option key={w.id} value={w.id}>{w.wo_number} · {w.vehicles?.name || '—'} · {w.service}</option>)}
              </select>
              {form.workOrderId && <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: 5 }}>Vehicle and description are filled in from the work order.</div>}
            </Field>

            <Field label="Description">
              <input required type="text" value={form.title} onChange={(e) => updateForm('title', e.target.value)} placeholder="e.g. Brake inspection" style={inputStyle} />
            </Field>

            {!form.workOrderId && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Customer name">
                  <input type="text" value={form.customerName} onChange={(e) => updateForm('customerName', e.target.value)} style={inputStyle} />
                </Field>
                <Field label="Vehicle (optional)">
                  <select value={form.vehicleId} onChange={(e) => updateForm('vehicleId', e.target.value)} style={selectStyle}>
                    <option value="">—</option>
                    {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </Field>
              </div>
            )}

            <Field label="Technician">
              <select required value={form.technicianId} onChange={(e) => updateForm('technicianId', e.target.value)} style={selectStyle}>
                <option value="">Select a technician…</option>
                {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Start">
                <input required type="datetime-local" value={form.start} onChange={(e) => updateForm('start', e.target.value)} style={inputStyle} />
              </Field>
              <Field label="End">
                <input required type="datetime-local" value={form.end} onChange={(e) => updateForm('end', e.target.value)} style={inputStyle} />
              </Field>
            </div>

            <Field label="Notes (optional)">
              <textarea value={form.notes} onChange={(e) => updateForm('notes', e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </Field>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <SecondaryButton type="button" onClick={() => setFormOpen(false)}>Cancel</SecondaryButton>
              <PrimaryButton type="submit" disabled={saving}>{saving ? 'Saving…' : 'Create Appointment'}</PrimaryButton>
            </div>
          </form>
        </ModalShell>
      )}

      {/* View appointment modal */}
      {viewingAppt && (
        <ModalShell title={viewingAppt.title} onClose={() => setViewingAppt(null)}>
          <ConfirmModal
            open={confirmDeleteOpen}
            title="Delete appointment?"
            body="This permanently removes this appointment from the calendar."
            confirmLabel="Delete"
            onCancel={() => setConfirmDeleteOpen(false)}
            onConfirm={deleteAppointment}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DL label="Technician" value={viewingAppt.technician?.name || 'Unassigned'} />
            <DL label="When" value={`${formatDate(viewingAppt.start_time)} · ${new Date(viewingAppt.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – ${new Date(viewingAppt.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`} />
            <DL label="Vehicle / customer" value={viewingAppt.vehicles?.name || viewingAppt.customer_name || '—'} />
            {viewingAppt.notes && <DL label="Notes" value={viewingAppt.notes} />}
            {viewingAppt.work_orders?.id ? (
              <button
                type="button"
                onClick={() => navigate(`/work-orders/${viewingAppt.work_orders.id}`)}
                style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: colors.accent, cursor: 'pointer', textDecoration: 'underline' }}
              >
                Open work order {viewingAppt.work_orders.wo_number} →
              </button>
            ) : (
              <div style={{ fontSize: 12, color: colors.mutedLight }}>Not linked to a work order.</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6, borderTop: `1px solid ${colors.border}`, paddingTop: 14 }}>
              <button type="button" onClick={() => setConfirmDeleteOpen(true)} style={{ background: colors.white, color: colors.danger, border: '1px solid rgba(192,57,43,0.35)', borderRadius: 8, padding: '9px 16px', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Delete</button>
              <SecondaryButton onClick={() => setViewingAppt(null)}>Close</SecondaryButton>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  )
}

function ModalShell({ title, onClose, children }) {
  return (
    <>
      <button type="button" onClick={onClose} aria-label="Close" style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,20,0.45)', border: 'none', padding: 0, cursor: 'default', zIndex: 79 }} />
      <div role="dialog" aria-modal="true" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 520, maxWidth: 'calc(100vw - 48px)', maxHeight: '85vh', background: colors.white, borderRadius: 14, boxShadow: '0 24px 64px rgba(20,20,20,0.30)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 80 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: '#F7F6F2', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={colors.text3} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: 22 }}>{children}</div>
      </div>
    </>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  )
}

function DL({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: 13.5, color: colors.ink, marginTop: 3, whiteSpace: 'pre-wrap' }}>{value}</div>
    </div>
  )
}

const navBtnStyle = { width: 30, height: 30, borderRadius: 7, border: `1px solid ${colors.border}`, background: colors.white, color: colors.ink, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }
const inputStyle = { width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 11px', fontFamily: 'inherit', fontSize: 13, color: colors.ink }
const selectStyle = { ...inputStyle, background: colors.white }
