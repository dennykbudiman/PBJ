// Shop opening hours (Settings → Opening hours). Stored as { mon: { open, start: 'HH:MM', end: 'HH:MM' }, … }.
import { addDays, clock, hhmmToMinutes, minutesToHhmm, shopParts, weekday } from './calendar'

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const DEFAULT_HOURS = Object.fromEntries(DAYS.map((d) => [d, { open: d !== 'sun', start: '08:00', end: '17:00' }]))

export function normHours(h) {
  const out = {}
  for (const d of DAYS) {
    const x = h?.[d]
    out[d] = x && typeof x === 'object'
      ? { open: !!x.open, start: x.start || '08:00', end: x.end || '17:00' }
      : { ...DEFAULT_HOURS[d] }
  }
  return out
}

const toMin = (s) => (s === '24:00' ? 1440 : hhmmToMinutes(s))

// One day's hours in minutes: { open, start, end, key }.
export function dayHours(hours, dateStr) {
  const key = DAYS[weekday(dateStr)]
  const x = normHours(hours)[key]
  return { key, open: x.open, start: toMin(x.start), end: toMin(x.end) }
}

// Why a booking can't be made, or null when it fits the opening hours (the same rule as the database).
export function bookingProblem(hours, startIso, endIso, tz) {
  if (!startIso || !endIso) return null
  const s = shopParts(startIso, tz)
  let e = shopParts(endIso, tz)
  // Ending exactly at midnight counts as 24:00 of the day before.
  if (e.minutes === 0 && e.date > s.date) e = { date: addDays(e.date, -1), minutes: 1440 }
  const ds = dayHours(hours, s.date)
  if (!ds.open) return { key: 'hours.closedDay', day: ds.key }
  if (s.minutes < ds.start) return { key: 'hours.beforeOpen', time: ds.start }
  if (s.minutes >= ds.end) return { key: 'hours.startAfterClose', time: ds.end }
  if (e.date === s.date) {
    if (e.minutes > ds.end) return { key: 'hours.afterClose', time: ds.end }
  } else {
    const de = dayHours(hours, e.date)
    if (!de.open) return { key: 'hours.endClosedDay', day: de.key }
    if (e.minutes > de.end || e.minutes <= de.start) return { key: 'hours.endOutside', from: de.start, to: de.end }
  }
  return null
}

// The hours a calendar shows for a set of days: earliest opening to latest closing (08:00–17:00 if all are closed).
export function hoursRange(hours, dates) {
  let lo = Infinity; let hi = -Infinity
  for (const d of dates) {
    const x = dayHours(hours, d)
    if (x.open) { lo = Math.min(lo, x.start); hi = Math.max(hi, x.end) }
  }
  if (lo === Infinity) return [8 * 60, 17 * 60]
  return [Math.floor(lo / 60) * 60, Math.ceil(hi / 60) * 60]
}

// The opening-hours reason a booking can't go there, in words.
// "17:00", or "24:00" for midnight closing.
export const hhmm24 = (m) => (m >= 1440 ? '24:00' : minutesToHhmm(m))

export function hoursText(p, t, lang) {
  const day = p.day ? t(`hours.day.${p.day}`) : ''
  return t(p.key, { day, time: p.time != null ? (p.time >= 1440 ? '24:00' : clock(p.time, lang)) : '', from: p.from != null ? clock(p.from, lang) : '', to: p.to != null ? clock(p.to, lang) : '' })
}
