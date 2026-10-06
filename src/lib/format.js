// Formatting helpers. Money is whole Rupiah; numbers use Indonesian grouping (1.234.567).

const groupFmt = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })

export function rp(n) {
  if (n === null || n === undefined || n === '') return '—'
  const v = Math.round(Number(n))
  if (Number.isNaN(v)) return '—'
  return (v < 0 ? '-Rp ' : 'Rp ') + groupFmt.format(Math.abs(v))
}

export function num(n, digits = 0) {
  if (n === null || n === undefined || n === '') return '—'
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: digits }).format(Number(n))
}

export function km(n) {
  if (n === null || n === undefined || n === '') return '—'
  return `${num(n)} km`
}

// Display formats decided Oct 5: job 100001, invoice INV-000001, stock PO 900001.
export const jobNo = (n) => (n == null ? '—' : String(n).padStart(6, '0'))
export const invoiceNo = (n) => (n == null ? '—' : `INV-${String(n).padStart(6, '0')}`)
export const stockPoNo = (n) => (n == null ? '—' : `9${String(n).padStart(5, '0')}`)

const SHOP_TZ_DEFAULT = 'Asia/Jakarta'

export function fmtDate(value, lang = 'en', tz = SHOP_TZ_DEFAULT) {
  if (!value) return '—'
  const d = typeof value === 'string' && value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const opts = { day: 'numeric', month: 'short', year: 'numeric' }
  if (!(typeof value === 'string' && value.length === 10)) opts.timeZone = tz
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', opts).format(d)
}

export function fmtDateTime(value, lang = 'en', tz = SHOP_TZ_DEFAULT) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz,
  }).format(d)
}

export function timeAgo(value, lang = 'en') {
  if (!value) return ''
  const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(lang === 'id' ? 'id' : 'en', { numeric: 'auto' })
  if (s < 60) return rtf.format(-Math.round(s), 'second')
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  return rtf.format(-Math.round(s / 86400), 'day')
}

export function initials(name) {
  if (!name) return '?'
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Parses a typed decimal such as a rate ("2", "2.5", "2,5") into a number, or null when empty.
export function parseDecimal(text) {
  if (text === null || text === undefined) return null
  const clean = String(text).trim().replace(/[^0-9.,-]/g, '').replace(',', '.')
  if (clean === '' || clean === '-' || clean === '.') return null
  const v = Number(clean)
  return Number.isNaN(v) ? null : v
}

// Reads a typed whole Rupiah amount or count: "150.000", "Rp 150.000", "Rp 10.000,-", "150000".
// Returns null when empty and NaN when it isn't a valid amount, so a typo is never saved as "empty".
export function readAmount(text) {
  if (text === null || text === undefined) return null
  let s = String(text).trim()
  if (s === '') return null
  s = s.replace(/^rp\.?\s*/i, '').replace(/,(-|00?)$/, '').replace(/[\s.]/g, '')
  if (!/^\d+$/.test(s)) return NaN
  return Number(s)
}

// Parses a typed amount ("150.000", "Rp 150.000", "150000") into a number, or null when empty.
export function parseAmount(text) {
  if (text === null || text === undefined) return null
  const clean = String(text).replace(/[^0-9,-]/g, '').replace(',', '.')
  if (clean === '' || clean === '-') return null
  const v = Number(clean)
  return Number.isNaN(v) ? null : v
}
