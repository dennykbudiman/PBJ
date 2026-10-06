// Service schedules: when a vehicle's preventive maintenance is next due.
// The rule matches the database's reminders (migration 123): overdue once the odometer or the date passes
// the due point; due soon within the shop's "due soon" km / days (Settings → Invoices & numbering).
import { daysBetween } from './calendar'

export const SCHEDULE_COLOR = { overdue: 'red', due_soon: 'amber', ok: 'green', never: 'gray', off: 'gray' }
export const SCHEDULE_ORDER = { overdue: 0, due_soon: 1, never: 2, ok: 3, off: 4 }

const addMonths = (dateStr, n) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  // Postgres adds months by clamping to the month's last day (31 Jan + 1 month = 28/29 Feb); do the same.
  const target = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, last))
  return target.toISOString().slice(0, 10)
}

// Next due point, worked out the way the database does (next_due_km / next_due_date are stored, but
// a schedule edited in the browser has to be shown before it is saved too).
export function nextDue(s) {
  return {
    km: s.last_done_km != null && s.interval_km != null ? Number(s.last_done_km) + Number(s.interval_km) : null,
    date: s.last_done_date && s.interval_months != null ? addMonths(s.last_done_date, Number(s.interval_months)) : null,
  }
}

// { status, kmLeft, daysLeft, km, date } for a schedule on a vehicle with `mileage` km, on shop date `today`.
export function scheduleStatus(s, mileage, settings, today) {
  const due = nextDue(s)
  const soonKm = Number(settings?.due_soon_km ?? 1000)
  const soonDays = Number(settings?.due_soon_days ?? 14)
  const km = mileage == null ? null : Number(mileage)
  const kmLeft = due.km != null && km != null ? due.km - km : null
  const daysLeft = due.date ? daysBetween(today, due.date) : null
  let status
  if (!s.active) status = 'off'
  else if (due.km == null && due.date == null) status = 'never'
  else if ((kmLeft != null && kmLeft <= 0) || (daysLeft != null && daysLeft <= 0)) status = 'overdue'
  else if ((kmLeft != null && kmLeft <= soonKm) || (daysLeft != null && daysLeft <= soonDays)) status = 'due_soon'
  else status = 'ok'
  return { status, kmLeft, daysLeft, km: due.km, date: due.date }
}

// "Every 10.000 km or 6 months"
export function intervalText(s, t, num) {
  const parts = []
  if (s.interval_km != null) parts.push(`${num(s.interval_km)} km`)
  if (s.interval_months != null) parts.push(t('sch.months', { n: s.interval_months }))
  return parts.length ? t('sch.every', { what: parts.join(t('sch.or')) }) : '—'
}

// "Overdue by 1.200 km", "In 850 km or 12 days", "Not done yet"
export function leftText(st, t, num) {
  if (st.status === 'never') return t('sch.neverDone')
  if (st.status === 'off') return t('sch.off')
  const parts = []
  if (st.kmLeft != null) parts.push(st.kmLeft <= 0 ? t('sch.kmOver', { km: num(-st.kmLeft) }) : t('sch.kmLeft', { km: num(st.kmLeft) }))
  if (st.daysLeft != null) parts.push(st.daysLeft <= 0 ? t('sch.daysOver', { n: -st.daysLeft }) : t('sch.daysLeft', { n: st.daysLeft }))
  return parts.join(' · ')
}
