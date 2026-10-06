// Calendar helpers. Everything is shown in the shop's time zone (Settings → Language & printing),
// whatever time zone the browser is in. Dates are 'YYYY-MM-DD' strings; times are minutes after midnight.

const partsCache = new Map()
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }))
  }
  return partsCache.get(tz)
}
const pad = (n) => String(n).padStart(2, '0')

// A moment as seen on the shop clock: { date: 'YYYY-MM-DD', minutes, hour, minute }.
export function shopParts(value, tz) {
  const d = value instanceof Date ? value : new Date(value)
  const p = Object.fromEntries(formatter(tz).formatToParts(d).map((x) => [x.type, x.value]))
  const hour = Number(p.hour) % 24
  const minute = Number(p.minute)
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, hour, minute, minutes: hour * 60 + minute }
}

// How far the shop clock is ahead of UTC at a given moment, in milliseconds.
function offsetAt(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute))
  return shown - Math.floor(ms / 60000) * 60000
}

// A shop-local date and time (minutes after midnight) as a UTC ISO string.
export function shopTimeToIso(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d) + minutes * 60000
  let ms = guess - offsetAt(guess, tz)
  ms = guess - offsetAt(ms, tz) // second pass settles daylight-saving edges
  return new Date(ms).toISOString()
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
// 0 = Monday … 6 = Sunday.
export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}
export const weekStart = (dateStr) => addDays(dateStr, -weekday(dateStr))
export const monthFirst = (dateStr) => `${dateStr.slice(0, 7)}-01`
export function addMonths(dateStr, n) {
  const [y, m] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-01`
}
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000)
}
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

// "09:30" ↔ 570
export const minutesToHhmm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`
export function hhmmToMinutes(s) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

const loc = (lang) => (lang === 'id' ? 'id-ID' : 'en-GB')
const utcDate = (dateStr) => new Date(`${dateStr}T12:00:00Z`)
export function dayLabel(dateStr, lang, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat(loc(lang), { ...opts, timeZone: 'UTC' }).format(utcDate(dateStr))
}
export function monthLabel(dateStr, lang) {
  return new Intl.DateTimeFormat(loc(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(dateStr))
}
export function weekdayNames(lang, style = 'short') {
  return Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(loc(lang), { weekday: style, timeZone: 'UTC' }).format(utcDate(addDays('2026-01-05', i))))
}
// Clock time for labels: 24-hour, as Indonesia writes it ("09.30" in Indonesian, "09:30" in English).
export function clock(minutes, lang) {
  const s = minutesToHhmm(minutes)
  return lang === 'id' ? s.replace(':', '.') : s
}

// Places overlapping events side by side: each gets { col, cols }.
export function layoutOverlaps(events) {
  const sorted = [...events].sort((a, b) => a.top - b.top || b.bottom - a.bottom)
  const out = []
  let cluster = []
  let clusterEnd = -Infinity
  const flush = () => {
    const cols = []
    for (const e of cluster) {
      let c = cols.findIndex((end) => end <= e.top)
      if (c === -1) { c = cols.length; cols.push(e.bottom) } else cols[c] = e.bottom
      e.col = c
    }
    for (const e of cluster) { e.cols = cols.length; out.push(e) }
    cluster = []
  }
  for (const e of sorted) {
    if (cluster.length && e.top >= clusterEnd) { flush(); clusterEnd = -Infinity }
    cluster.push({ ...e })
    clusterEnd = Math.max(clusterEnd, e.bottom)
  }
  if (cluster.length) flush()
  return out
}

export const APPT_STATUSES = ['requested', 'scheduled', 'confirmed', 'arrived', 'cancelled', 'no_show']
export const APPT_COLOR = { requested: 'amber', scheduled: 'blue', confirmed: 'green', arrived: 'purple', cancelled: 'gray', no_show: 'red' }
export const isActiveAppt = (a) => a.status !== 'cancelled' && a.status !== 'no_show'
