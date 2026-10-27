// Importing master data from CSV files (Settings → Import data, migration 129 release).
// The shop starts fresh, so companies, vehicles, service schedules, the catalog, suppliers and opening stock can be
// typed into a spreadsheet and loaded in one go. Rows go in with the signed-in person's own permissions, so the
// database checks them exactly like rows entered on screen. Unpaid invoices from before Axle are not imported
// (Denny, Oct 24: there are none).
//
// Each template has a header row (the column names below; * = required) and a "# " row explaining the columns.
// Lines starting with "# " (hash and space) are skipped, so a part code like "#123" still loads. Rows that already exist in Axle (same company name, plate, supplier name,
// part code, schedule name on that vehicle) are skipped, so a file can be loaded again after fixing a problem.
import { CUSTOMER_TYPES, FUEL_TYPES, VEHICLE_TYPES, formatPlate, normalizePlate, normalizeVin, npwpDigits } from './customers'

export const IMPORT_TYPES = ['suppliers', 'companies', 'vehicles', 'catalog', 'schedules', 'stock']

// Columns per type, in template order. Help text is in strings-golive.js (key imp.help.<type>).
export const COLUMNS = {
  suppliers: ['name*', 'type', 'payment_terms_days', 'account_number', 'contact_name', 'phone', 'email', 'address', 'notes'],
  companies: ['name*', 'legal_name', 'npwp', 'type', 'billing_address', 'phone', 'email', 'payment_terms_days', 'credit_limit',
    'charge_account', 'tax_exempt', 'contact_name', 'contact_phone', 'contact_email'],
  vehicles: ['company*', 'plate*', 'make', 'model', 'year', 'vin', 'type', 'fuel_type', 'mileage_km', 'notes'],
  catalog: ['type*', 'name*', 'code', 'category', 'supplier', 'brand', 'cost', 'price', 'taxable', 'track_inventory',
    'reorder_point', 'labor_hours', 'fee_kind', 'fee_value', 'notes'],
  schedules: ['plate*', 'service*', 'interval_km', 'interval_months', 'last_done_km', 'last_done_date', 'template'],
  stock: ['part*', 'qty*', 'note'],
}

// Who may load each kind (the database enforces the same).
export const IMPORT_PERMISSION = {
  suppliers: 'edit_catalog', companies: 'edit_customers', vehicles: 'edit_customers', catalog: 'edit_catalog',
  schedules: 'edit_customers', stock: 'manage_inventory',
}

// ---------------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------------

// Reads CSV text: comma, semicolon or tab separated (Excel in Indonesian uses semicolons), quotes, a "sep=;" first
// line, and a byte-order mark. Returns an array of rows (arrays of trimmed strings).
export function parseCsv(text) {
  let s = String(text || '').replace(/^﻿/, '')
  let delim = null
  const sep = s.match(/^sep=(.)\r?\n/i)
  if (sep) { delim = sep[1]; s = s.slice(sep[0].length) }
  if (!delim) {
    const first = s.split(/\r?\n/, 1)[0] || ''
    const count = (c) => first.split(c).length - 1
    delim = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0]
    if (!count(delim)) delim = ','
  }
  // Each row remembers its line in the file (as Excel numbers it: the "sep=" line isn't shown there).
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  let line = 1
  let start = 1
  const end = () => { row.push(cell.trim()); row.line = start; rows.push(row); row = []; cell = ''; start = line }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else { if (c === '\n') line++; cell += c }
    } else if (c === '"' && cell.trim() === '') { quoted = true; cell = '' }
    else if (c === delim) { row.push(cell.trim()); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      line++
      end()
    } else cell += c
  }
  if (cell !== '' || row.length) end()
  return rows.filter((r) => r.some((x) => x !== ''))
}

const csvCell = (v) => (/[",;\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v))

// The template file: "sep=," so Excel splits columns whatever its language, the header row, and a "#" help row.
export function templateCsv(type, help) {
  const cols = COLUMNS[type]
  return '﻿' + ['sep=,', cols.map(csvCell).join(','), ['# ' + (help[0] || ''), ...help.slice(1)].map(csvCell).join(',')].join('\r\n') + '\r\n'
}

// Header names → column keys ("Name*" → "name"); unknown columns are reported.
export function readTable(type, rows) {
  const body = rows.filter((r) => !/^#(\s|$)/.test(String(r[0] || '')))
  if (!body.length) return { error: 'empty' }
  const keys = COLUMNS[type].map((c) => c.replace('*', ''))
  const head = body[0].map((h) => h.toLowerCase().replace(/\*/g, '').trim().replace(/\s+/g, '_'))
  const unknown = head.filter((h) => h && !keys.includes(h))
  const missing = COLUMNS[type].filter((c) => c.endsWith('*')).map((c) => c.replace('*', '')).filter((k) => !head.includes(k))
  if (missing.length) return { error: 'missingColumns', columns: missing }
  const records = body.slice(1).map((r) => {
    const o = { _row: r.line }
    head.forEach((h, j) => { if (keys.includes(h)) o[h] = (r[j] ?? '').trim() })
    return o
  })
  return { records, unknown }
}

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

const YES = ['yes', 'y', 'ya', 'true', '1', 'x']
const NO = ['no', 'n', 'tidak', 'false', '0']
export function readBool(v, fallback) {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return fallback
  if (YES.includes(s)) return true
  if (NO.includes(s)) return false
  return undefined
}
// Numbers as people and Excel write them, Indonesian or English style:
//   "1250000", "1.250.000", "1,250,000", "Rp 1.250.000", "1.250.000,00", "1,250,000.00", "1,5", "1.5".
// With both "." and "," the last one is the decimal mark. With one kind used once, exactly three digits after it
// means thousands ("1.500" = 1500); otherwise it is the decimal mark ("1,5" = 1.5). Anything else is refused
// rather than guessed. Returns a number, null for an empty cell, or undefined when it can't be read.
export function readNumber(v) {
  let s = String(v ?? '').trim().replace(/^rp\.?/i, '').replace(/[\s\u00a0]/g, '')
  if (!s) return null
  let sign = 1
  if (s.startsWith('-')) { sign = -1; s = s.slice(1) }
  if (/^\d+$/.test(s)) return sign * Number(s)
  const grouped = (intPart, sep) => (intPart.includes(sep) ? new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(intPart) : /^\d+$/.test(intPart))
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ','
    const thou = dec === '.' ? ',' : '.'
    const at = s.lastIndexOf(dec)
    const intPart = s.slice(0, at)
    const frac = s.slice(at + 1)
    if (!/^\d+$/.test(frac) || intPart.includes(dec) || !grouped(intPart, thou)) return undefined
    return sign * Number(intPart.split(thou).join('') + '.' + frac)
  }
  const sep = lastDot >= 0 ? '.' : ','
  const parts = s.split(sep)
  if (parts.some((x) => !/^\d+$/.test(x))) return undefined
  if (parts.length > 2) return grouped(s, sep) ? sign * Number(parts.join('')) : undefined
  if (parts[1].length === 3 && parts[0].length <= 3) return sign * Number(parts.join(''))
  return sign * Number(parts[0] + '.' + parts[1])
}
// Whole numbers and rupiah amounts ("1.250.000,00" is fine; "1.250,50" isn't whole rupiah and is refused).
export function readInt(v) {
  const n = readNumber(v)
  if (n === null || n === undefined) return n
  return Number.isInteger(n) ? n : undefined
}
// Quantities, hours and percentages, which often have decimals. One comma is always the decimal mark here
// ("4,250" litres = 4,25, as Indonesian Excel writes it). One dot followed by exactly three digits ("4.250") could
// be 4250 or 4,25, so it is refused (NaN) rather than guessed; the row says to write it without separators.
export function readDecimal(v) {
  const s = String(v ?? '').trim().replace(/[\s ]/g, '')
  const m = s.match(/^(-?)(\d+)([.,])(\d+)$/)
  if (m) {
    if (m[3] === ',') return Number(m[1] + m[2] + '.' + m[4])
    if (m[4].length === 3 && /^0+$/.test(m[2])) return Number(m[1] + '0.' + m[4])   // "0.750": can't be thousands
    if (m[4].length === 3 && m[2].length <= 3) return NaN
  }
  return readNumber(v)
}
// The error for a readDecimal result that isn't usable: 'ambiguous' for "4.250", otherwise the caller's own code.
export const decimalProblem = (n, code) => (Number.isNaN(n) ? 'ambiguous' : code)
// Dates: 2026-10-24, 24/10/2026, 24-10-2026.
export function readDate(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  let y, mo, d
  if (m) [, y, mo, d] = m
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, mo, y] = m
  else return undefined
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const dt = new Date(iso + 'T00:00:00Z')
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? undefined : iso
}
const key = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// ---------------------------------------------------------------------------------------------------------------
// Checking rows. ctx holds what Axle already has: { customers, vehicles, suppliers, categories, items, templates,
// schedules, settings, today }. Returns { rows: [...ready], skipped: n, errors: [{ row, code, vars }] }.
// ---------------------------------------------------------------------------------------------------------------

export function checkRows(type, records, ctx) {
  const errors = []
  const ready = []
  let skipped = 0
  const err = (r, code, vars = {}) => errors.push({ row: r._row, code, vars })
  const seen = new Set()
  const dupInFile = (r, k) => { if (seen.has(k)) { err(r, 'dupInFile'); return true } seen.add(k); return false }
  const year = Number(String(ctx.today || new Date().toISOString()).slice(0, 4))

  for (const r of records) {
    const before = errors.length
    if (type === 'suppliers') {
      if (!r.name) { err(r, 'required', { col: 'name' }); continue }
      if (r.name.length > 200) err(r, 'tooLong', { col: 'name' })
      const typ = key(r.type) || 'internal'
      if (!['internal', 'sublet'].includes(typ)) err(r, 'oneOf', { col: 'type', list: 'internal, sublet' })
      const terms = readInt(r.payment_terms_days)
      if (terms === undefined || (terms !== null && (terms < 0 || terms > 365))) err(r, 'range', { col: 'payment_terms_days', min: 0, max: 365 })
      if (dupInFile(r, key(r.name))) continue
      if (errors.length > before) continue
      if (ctx.suppliers.some((x) => key(x.name) === key(r.name))) { skipped++; continue }
      ready.push({ name: r.name.trim(), type: typ, payment_terms_days: terms, account_number: r.account_number || null, contact_name: r.contact_name || null,
        phone: r.phone || null, email: r.email || null, address: r.address || null, pinned_notes: r.notes || null })
    } else if (type === 'companies') {
      if (!r.name) { err(r, 'required', { col: 'name' }); continue }
      if (r.name.length > 200) err(r, 'tooLong', { col: 'name' })
      const alias = { internal: 'fleet_internal', external: 'fleet_external', fleet: 'fleet_internal', umum: 'regular' }
      const typ = alias[key(r.type)] || key(r.type).replace(/\s+/g, '_') || 'fleet_internal'
      if (!CUSTOMER_TYPES.includes(typ)) err(r, 'oneOf', { col: 'type', list: CUSTOMER_TYPES.join(', ') })
      const npwp = r.npwp ? npwpDigits(r.npwp) : null
      if (npwp && npwp.length !== 15 && npwp.length !== 16) err(r, 'npwp')
      const terms = readInt(r.payment_terms_days)
      if (terms === undefined || (terms !== null && (terms < 0 || terms > 365))) err(r, 'range', { col: 'payment_terms_days', min: 0, max: 365 })
      const limit = readInt(r.credit_limit)
      if (limit === undefined || (limit !== null && limit < 0)) err(r, 'amount', { col: 'credit_limit' })
      const charge = readBool(r.charge_account, true)
      const exempt = readBool(r.tax_exempt, false)
      if (charge === undefined) err(r, 'yesNo', { col: 'charge_account' })
      if (exempt === undefined) err(r, 'yesNo', { col: 'tax_exempt' })
      if (dupInFile(r, key(r.name))) continue
      if (errors.length > before) continue
      if (ctx.customers.some((x) => key(x.display_name) === key(r.name))) { skipped++; continue }
      ready.push({
        row: { display_name: r.name.trim(), legal_name: r.legal_name || null, npwp: r.npwp ? r.npwp.trim() : null, type: typ, billing_address: r.billing_address || null, phone: r.phone || null,
          email: r.email || null, payment_terms_days: terms, credit_limit: limit, charge_account: charge, tax_exempt: exempt },
        contact: r.contact_name ? { name: r.contact_name, phone: r.contact_phone || null, email: r.contact_email || null, is_primary: true } : null,
      })
    } else if (type === 'vehicles') {
      if (!r.company) err(r, 'required', { col: 'company' })
      if (!r.plate) err(r, 'required', { col: 'plate' })
      if (errors.length > before) continue
      const cust = ctx.customers.find((x) => key(x.display_name) === key(r.company))
      if (!cust) err(r, 'notFound', { col: 'company', value: r.company })
      const plate = formatPlate(r.plate)
      const yr = readInt(r.year)
      if (yr === undefined || (yr !== null && (yr < 1950 || yr > year + 1))) err(r, 'range', { col: 'year', min: 1950, max: year + 1 })
      const km = readInt(r.mileage_km)
      if (km === undefined || (km !== null && (km < 0 || km > 9999999))) err(r, 'range', { col: 'mileage_km', min: 0, max: 9999999 })
      const vt = key(r.type)
      if (vt && !VEHICLE_TYPES.includes(vt)) err(r, 'oneOf', { col: 'type', list: VEHICLE_TYPES.join(', ') })
      const fuel = key(r.fuel_type)
      if (fuel && !FUEL_TYPES.includes(fuel)) err(r, 'oneOf', { col: 'fuel_type', list: FUEL_TYPES.join(', ') })
      const vin = r.vin ? normalizeVin(r.vin) : null
      if (dupInFile(r, normalizePlate(r.plate))) continue
      if (vin && dupInFile(r, 'vin:' + vin)) continue
      if (errors.length > before) continue
      if (ctx.vehicles.some((x) => normalizePlate(x.plate) === normalizePlate(r.plate))) { skipped++; continue }
      if (vin && ctx.vehicles.some((x) => x.vin && normalizeVin(x.vin) === vin)) { err(r, 'vinTaken'); continue }
      ready.push({ customer_id: cust.id, plate, make: r.make || null, model: r.model || null, year: yr, vin, type: vt || null, fuel_type: fuel || null,
        mileage_km: km, notes: r.notes || null, status: 'active' })
    } else if (type === 'catalog') {
      const typ = key(r.type)
      if (!['part', 'labor', 'fee'].includes(typ)) err(r, 'oneOf', { col: 'type', list: 'part, labor, fee' })
      if (!r.name) err(r, 'required', { col: 'name' })
      if (errors.length > before) continue
      const sup = r.supplier ? ctx.suppliers.find((x) => key(x.name) === key(r.supplier)) : null
      if (r.supplier && !sup) err(r, 'notFound', { col: 'supplier', value: r.supplier })
      const cost = readInt(r.cost)
      const price = readInt(r.price)
      if (cost === undefined || (cost !== null && cost < 0)) err(r, 'amount', { col: 'cost' })
      if (price === undefined || (price !== null && price < 0)) err(r, 'amount', { col: 'price' })
      const taxable = readBool(r.taxable, ctx.settings?.new_items_taxable ?? false)
      if (taxable === undefined) err(r, 'yesNo', { col: 'taxable' })
      const track = readBool(r.track_inventory, typ === 'part')
      if (track === undefined) err(r, 'yesNo', { col: 'track_inventory' })
      if (track && typ !== 'part') err(r, 'trackPartsOnly')
      const reorder = readDecimal(r.reorder_point)
      if (reorder === undefined || Number.isNaN(reorder) || (reorder !== null && reorder < 0)) err(r, decimalProblem(reorder, 'number'), { col: 'reorder_point', value: r.reorder_point })
      const hours = readDecimal(r.labor_hours)
      if (hours === undefined || Number.isNaN(hours) || (hours !== null && (hours < 0 || hours > 1000))) err(r, decimalProblem(hours, 'number'), { col: 'labor_hours', value: r.labor_hours })
      const feeKind = key(r.fee_kind) || 'fixed'
      if (typ === 'fee' && !['fixed', 'percent'].includes(feeKind)) err(r, 'oneOf', { col: 'fee_kind', list: 'fixed, percent' })
      // a fixed fee is rupiah ("2.500" = 2500, as cost and price); a percent fee can have decimals ("2,5")
      const feeValue = feeKind === 'percent' ? readDecimal(r.fee_value) : readInt(r.fee_value)
      if (feeKind !== 'percent' && (feeValue === undefined || (feeValue !== null && feeValue < 0))) err(r, 'amount', { col: 'fee_value' })
      else if (feeValue === undefined || Number.isNaN(feeValue) || (feeValue !== null && feeValue < 0)) err(r, decimalProblem(feeValue, 'number'), { col: 'fee_value', value: r.fee_value })
      else if (typ === 'fee' && feeKind === 'percent' && feeValue > 100) err(r, 'range', { col: 'fee_value', min: 0, max: 100 })
      const codeKey = r.code ? 'code:' + key(r.code) : 'name:' + typ + ':' + key(r.name)
      if (dupInFile(r, codeKey)) continue
      if (errors.length > before) continue
      const exists = r.code ? ctx.items.some((x) => x.code && key(x.code) === key(r.code)) : ctx.items.some((x) => x.item_type === typ && key(x.name) === key(r.name))
      if (exists) { skipped++; continue }
      ready.push({
        category: r.category ? r.category.trim() : null,
        row: { item_type: typ, name: r.name.trim(), code: r.code || null, supplier_id: sup?.id || null, brand: r.brand || null, cost: cost ?? 0, price: price ?? 0,
          taxable, track_inventory: !!track, reorder_point: track ? reorder : null, labor_hours: typ === 'labor' ? hours : null,
          fee_kind: typ === 'fee' ? feeKind : 'fixed', fee_value: typ === 'fee' ? feeValue ?? 0 : null, notes: r.notes || null },
      })
    } else if (type === 'schedules') {
      if (!r.plate) err(r, 'required', { col: 'plate' })
      if (!r.service) err(r, 'required', { col: 'service' })
      if (errors.length > before) continue
      const veh = ctx.vehicles.find((x) => normalizePlate(x.plate) === normalizePlate(r.plate))
      if (!veh) err(r, 'notFound', { col: 'plate', value: r.plate })
      if (r.service.length > 120) err(r, 'tooLong', { col: 'service' })
      const ikm = readInt(r.interval_km)
      const imo = readInt(r.interval_months)
      if (ikm === undefined || (ikm !== null && (ikm < 100 || ikm > 1000000))) err(r, 'range', { col: 'interval_km', min: 100, max: 1000000 })
      if (imo === undefined || (imo !== null && (imo < 1 || imo > 120))) err(r, 'range', { col: 'interval_months', min: 1, max: 120 })
      if (ikm == null && imo == null) err(r, 'intervalNeeded')
      const lkm = readInt(r.last_done_km)
      if (lkm === undefined || (lkm !== null && (lkm < 0 || lkm > 9999999))) err(r, 'range', { col: 'last_done_km', min: 0, max: 9999999 })
      const ld = readDate(r.last_done_date)
      if (ld === undefined) err(r, 'date', { col: 'last_done_date' })
      if (ld && ctx.today && ld > ctx.today) err(r, 'futureDate', { col: 'last_done_date' })
      const tpl = r.template ? ctx.templates.find((x) => key(x.name) === key(r.template)) : null
      if (r.template && !tpl) err(r, 'notFound', { col: 'template', value: r.template })
      if (veh && dupInFile(r, veh.id + ':' + key(r.service))) continue
      if (errors.length > before) continue
      if (ctx.schedules.some((x) => x.vehicle_id === veh.id && key(x.name) === key(r.service))) { skipped++; continue }
      ready.push({ vehicle_id: veh.id, name: r.service.trim(), template_id: tpl?.id || null, interval_km: ikm, interval_months: imo, last_done_km: lkm, last_done_date: ld })
    } else if (type === 'stock') {
      if (!r.part) err(r, 'required', { col: 'part' })
      const qty = readDecimal(r.qty)
      if (qty === null) err(r, 'required', { col: 'qty' })
      else if (Number.isNaN(qty)) err(r, 'ambiguous', { col: 'qty', value: r.qty })
      else if (qty === undefined || qty <= 0 || qty > 100000) err(r, 'range', { col: 'qty', min: 0, max: 100000 })
      if (errors.length > before) continue
      const parts = ctx.items.filter((x) => x.item_type === 'part')
      const item = parts.find((x) => x.code && key(x.code) === key(r.part)) || parts.find((x) => key(x.name) === key(r.part))
      if (!item) { err(r, 'notFound', { col: 'part', value: r.part }); continue }
      if (!item.track_inventory) { err(r, 'notTracked', { value: item.name }); continue }
      if (dupInFile(r, item.id)) continue
      // Opening stock is a part's first stock entry. If it is already there with this quantity, the row was loaded
      // before (skip); any other stock history means the count is corrected with Adjust stock instead.
      const moves = ctx.stockMoves?.[item.id] || []
      if (moves.length === 1 && moves[0].reason === 'opening' && Number(moves[0].qty_change) === qty) { skipped++; continue }
      if (moves.length) { err(r, 'hasStock', { value: item.name }); continue }
      ready.push({ catalog_item_id: item.id, qty_change: qty, reason: 'opening', note: r.note || null, _name: item.name })
    }
  }
  return { rows: ready, skipped, errors }
}

// ---------------------------------------------------------------------------------------------------------------
// Loading. Inserts in batches; returns { done, error }. `onProgress(n)` is called after each batch.
// ---------------------------------------------------------------------------------------------------------------

async function inBatches(list, size, fn, onProgress) {
  let done = 0
  for (let i = 0; i < list.length; i += size) {
    const part = list.slice(i, i + size)
    const res = await fn(part)
    if (res?.error) return { done, error: res.error }
    done += part.length
    onProgress?.(done)
  }
  return { done, error: null }
}

export async function loadRows(supabase, type, rows, ctx, onProgress) {
  if (type === 'suppliers') return inBatches(rows, 100, (p) => supabase.from('suppliers').insert(p), onProgress)
  if (type === 'vehicles') return inBatches(rows, 100, (p) => supabase.from('vehicles').insert(p), onProgress)
  if (type === 'schedules') return inBatches(rows, 100, (p) => supabase.from('service_schedules').insert(p), onProgress)
  if (type === 'stock') return inBatches(rows.map(({ _name, ...r }) => r), 50, (p) => supabase.from('stock_movements').insert(p), onProgress)
  if (type === 'companies') {
    return inBatches(rows, 50, async (p) => {
      const ins = await supabase.from('customers').insert(p.map((x) => x.row)).select('id, display_name')
      if (ins.error) return ins
      const idByName = Object.fromEntries((ins.data || []).map((c) => [key(c.display_name), c.id]))
      const contacts = p.filter((x) => x.contact).map((x) => ({ ...x.contact, customer_id: idByName[key(x.row.display_name)] }))
      return contacts.length ? supabase.from('customer_contacts').insert(contacts) : {}
    }, onProgress)
  }
  if (type === 'catalog') {
    // Categories named in the file that don't exist yet are added first.
    const known = Object.fromEntries((ctx.categories || []).map((c) => [key(c.name), c.id]))
    const fresh = [...new Set(rows.map((x) => x.category).filter((c) => c && !known[key(c)]))]
    for (const name of fresh) {
      const res = await supabase.from('categories').insert({ name, applies_to: 'any' }).select('id').single()
      if (res.error) return { done: 0, error: res.error }
      known[key(name)] = res.data.id
    }
    return inBatches(rows, 100, (p) => supabase.from('catalog_items').insert(p.map((x) => ({ ...x.row, category_id: x.category ? known[key(x.category)] : null }))), onProgress)
  }
  return { done: 0, error: { message: 'Unknown import type' } }
}
