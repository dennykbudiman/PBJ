// Report periods, aging buckets and CSV export.
import { addDays, addMonths } from './calendar'

export const PERIODS = ['this_month', 'last_month', 'last_30', 'this_year', 'last_year', 'custom']

// The from / to dates of a preset period, on the shop's calendar ("today" comes from shopToday()).
export function periodRange(preset, today, custom = {}) {
  const m0 = `${today.slice(0, 7)}-01`
  const y = today.slice(0, 4)
  switch (preset) {
    case 'last_month': return { from: addMonths(m0, -1), to: addDays(m0, -1) }
    case 'last_30': return { from: addDays(today, -29), to: today }
    case 'this_year': return { from: `${y}-01-01`, to: today }
    case 'last_year': return { from: `${Number(y) - 1}-01-01`, to: `${Number(y) - 1}-12-31` }
    case 'custom': {
      const a = custom.from || m0, b = custom.to || today
      return a <= b ? { from: a, to: b } : { from: b, to: a }   // dates picked the wrong way round are swapped
    }
    default: return { from: m0, to: today }
  }
}

// Days past due → bucket. "current" = not yet due.
export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90']
export function agingBucket(days) {
  if (days <= 0) return 'current'
  if (days <= 30) return 'd1_30'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  return 'd90'
}

// Adds up the given money fields over rows.
export function sumBy(rows, fields) {
  const out = Object.fromEntries(fields.map((f) => [f, 0]))
  for (const r of rows) for (const f of fields) out[f] += Number(r[f]) || 0
  return out
}

// Groups rows by a key, keeping first-seen order unless sorted afterwards.
export function groupBy(rows, keyOf) {
  const map = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

// Spreadsheet export. Tab-separated UTF-16 with a byte-order mark is what Excel opens straight into columns,
// with accents and dashes intact, whatever the computer's regional settings (Google Sheets and LibreOffice read it too).
// Numbers stay plain numbers (no thousands dots). Text that starts like a formula gets a ' so Excel shows it as text.
export function toCsv(header, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return String(v)
    let s = String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[\t"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [header.map(cell).join('\t'), ...rows.map((r) => r.map(cell).join('\t'))].join('\r\n') + '\r\n'
}

export function csvBytes(text) {
  const out = new Uint8Array(2 + text.length * 2)
  out[0] = 0xff; out[1] = 0xfe
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 + i * 2] = c & 0xff; out[3 + i * 2] = c >> 8 }
  return out
}

export function downloadCsv(name, header, rows) {
  const blob = new Blob([csvBytes(toCsv(header, rows))], { type: 'text/csv;charset=utf-16le' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
