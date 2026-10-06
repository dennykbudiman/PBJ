// Shared helpers for the Customers area (companies, contacts and vehicles).

export const CUSTOMER_TYPES = ['fleet_internal', 'fleet_external', 'regular']
export const CONTACT_ROLES = ['fleet_manager', 'billing', 'other']
export const VEHICLE_STATUSES = ['active', 'in_shop', 'inactive', 'sold']
export const FUEL_TYPES = ['petrol', 'diesel', 'electric', 'hybrid', 'other']
export const VEHICLE_TYPES = ['car', 'pickup', 'van', 'truck', 'bus', 'motorcycle', 'other']

export const TYPE_COLOR = { fleet_internal: 'blue', fleet_external: 'purple', regular: 'gray' }
export const VEHICLE_STATUS_COLOR = { active: 'green', in_shop: 'purple', inactive: 'gray', sold: 'gray' }

// Plates are compared without spaces or case: "b 1188 gh" and "B1188GH" are the same plate.
export function normalizePlate(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Tidies a typed plate into the usual "B 1188 GH" shape (letters, numbers, letters).
export function formatPlate(text) {
  const raw = String(text || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const compact = raw.replace(/ /g, '')
  const m = compact.match(/^([A-Z]{1,2})(\d{1,4})([A-Z]{0,3})$/)
  if (m) return [m[1], m[2], m[3]].filter(Boolean).join(' ')
  return raw
}

export function normalizeVin(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// NPWP may be typed with dots and dashes; only the digits count (15 or 16 of them).
export function npwpDigits(text) {
  return String(text || '').replace(/\D/g, '')
}

export function vehicleName(v) {
  if (!v) return ''
  return [v.year, v.make, v.model].filter(Boolean).join(' ')
}

// Search text sent to PostgREST filters: strip characters that have meaning in its syntax.
export function safeSearch(text) {
  return String(text || '').replace(/[%,()*\\:."']/g, ' ').replace(/\s+/g, ' ').trim()
}

// First day of the current month in the shop's time zone, as YYYY-MM-DD.
export function monthStart(tz = 'Asia/Jakarta') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year').value
  const m = parts.find((p) => p.type === 'month').value
  return `${y}-${m}-01`
}

// The moment a shop-local date (YYYY-MM-DD) starts, as a UTC ISO string, for filtering timestamps.
export function zonedMidnightUtc(dateStr, tz = 'Asia/Jakarta') {
  const [y, m, d] = dateStr.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  // How far the shop clock is ahead of UTC at that moment.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess))
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return new Date(guess - (shown - guess)).toISOString()
}

// Today in the shop's time zone, as YYYY-MM-DD (for date inputs).
export function shopToday(tz = 'Asia/Jakarta') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

// Compact money for KPI tiles: Rp 10,4 jt / Rp 1,2 M.
export function rpShort(n, lang = 'en') {
  const v = Math.round(Number(n) || 0)
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  const fmt = (x) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(x)
  if (abs >= 1e9) return `${sign}Rp ${fmt(abs / 1e9)} M`
  if (abs >= 1e6) return `${sign}Rp ${fmt(abs / 1e6)} jt`
  return `${sign}Rp ${new Intl.NumberFormat('id-ID').format(abs)}`
}
