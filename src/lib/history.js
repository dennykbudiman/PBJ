// Service history and vehicle lists for one vehicle or one company (printed at /print/history, or downloaded as CSV).
// A vehicle's history is every invoice for it, whoever was billed; a company's history is the invoices billed to
// that company for its vehicles. Money comes from the *_read views, so it is blank for people who may not see it.
import { supabase } from './supabase'
import { selectAll } from '../pages/customers/useCustomerData'
import { nextDue } from './schedules'
import { vehicleName } from './customers'
import { fmtDate, invoiceNo, jobNo, km } from './format'

const chunks = (ids, n = 100) => {
  const out = []
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n))
  return out
}
// Reads rows whose `col` is one of `ids`, 100 ids per request, every page.
async function byIds(table, cols, col, ids, extra = (q) => q) {
  const rows = []
  for (const part of chunks([...new Set(ids)])) {
    const r = await selectAll(() => extra(supabase.from(table).select(cols).in(col, part)).order('id'))
    if (r.error) throw r.error
    rows.push(...r.data)
  }
  return rows
}
const must = (r) => { if (r.error) throw r.error; return r.data }

// { customer, vehicles: [{ v, jobs: [{ ro, billedTo, services: [{ s, tech, items }] }], next: [{ name, km, date }] }] }
export async function loadHistory({ vehicleId, companyId, withHistory }) {
  const vehicles = vehicleId
    ? must(await supabase.from('vehicles').select('*').eq('id', vehicleId))
    : must(await selectAll(() => supabase.from('vehicles').select('*').eq('customer_id', companyId).order('plate').order('id')))
  const custId = companyId || vehicles[0]?.customer_id
  const customer = custId ? must(await supabase.from('customers').select('*').eq('id', custId).maybeSingle()) : null
  const vIds = vehicles.map((v) => v.id)
  const schedules = vIds.length ? await byIds('service_schedules', '*', 'vehicle_id', vIds, (q) => q.eq('active', true)) : []

  let jobs = []
  let services = []
  let items = []
  let names = {}
  let companies = {}
  if (withHistory && vIds.length) {
    jobs = await byIds('repair_orders', 'id, job_number, invoice_number, invoiced_at, customer_id, vehicle_id, odometer_in, odometer_out, subtotal, tax_total, total',
      'vehicle_id', vIds, (q) => (companyId ? q.eq('order_status', 'invoice').eq('customer_id', companyId) : q.eq('order_status', 'invoice')))
    jobs.sort((a, b) => String(a.invoiced_at).localeCompare(String(b.invoiced_at)))
    if (jobs.length) {
      services = await byIds('ro_services', 'id, ro_id, position, name, technician_id, approval_status, flat_price, is_flat, service_total, service_discount, service_net',
        'ro_id', jobs.map((j) => j.id), (q) => q.eq('approval_status', 'approved'))
      items = services.length ? await byIds('ro_service_items', 'id, service_id, position, item_type, name, qty, net, core_charge', 'service_id', services.map((s) => s.id)) : []
      const people = must(await supabase.from('profiles').select('id, name'))
      names = Object.fromEntries(people.map((p) => [p.id, p.name]))
      const otherCust = [...new Set(jobs.map((j) => j.customer_id))].filter((id) => id && id !== custId)
      if (otherCust.length) companies = Object.fromEntries((await byIds('customers', 'id, display_name', 'id', otherCust)).map((c) => [c.id, c.display_name]))
    }
  }
  const pos = (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
  // grouped once with maps, so a fleet with thousands of invoices stays quick
  const group = (rows, k) => rows.reduce((m, r) => { (m[r[k]] ||= []).push(r); return m }, {})
  const itemsBy = group(items, 'service_id')
  const servicesBy = group(services, 'ro_id')
  const jobsBy = group(jobs, 'vehicle_id')
  const schedBy = group(schedules, 'vehicle_id')
  return {
    customer,
    vehicles: vehicles.map((v) => ({
      v,
      next: (schedBy[v.id] || []).map((s) => ({ name: s.name, ...nextDue(s) })).filter((d) => d.km != null || d.date)
        .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999'))),
      jobs: (jobsBy[v.id] || []).map((ro) => ({
        ro,
        billedTo: ro.customer_id && ro.customer_id !== custId ? companies[ro.customer_id] || null : null,
        services: (servicesBy[ro.id] || []).sort(pos).map((s) => ({
          s, tech: names[s.technician_id] || null, items: (itemsBy[s.id] || []).sort(pos),
        })),
      })),
    })),
  }
}

// What a line brings in, as on the invoice (parts include their core charge). Blank when money is kept back.
export const itemAmount = (i) => (i.net == null ? null : Number(i.net) + Math.round(Number(i.core_charge || 0) * Number(i.qty || 0)))

const nextText = (next, lang) => next.map((d) => `${d.name} (${[d.km != null ? km(d.km) : null, d.date ? fmtDate(d.date, lang) : null].filter(Boolean).join(' / ')})`).join('; ')

// The money rows of one service, as billed: a flat-price service's price, or each line; then the service's own
// discount, if any. Blank (null) where money is kept back.
export function serviceMoney(s, items) {
  const flat = s.is_flat ?? s.flat_price != null
  const disc = s.service_discount == null ? null : Number(s.service_discount)
  return {
    flat,
    head: flat && s.service_total != null ? Number(s.service_total) : null,
    line: (i) => (flat ? null : itemAmount(i)),
    discount: disc > 0 ? -disc : null,
  }
}

// CSV rows. doc: 'list' (one row per vehicle), 'history' or 'fleet' (one row per job line; a vehicle with no invoices
// still gets a row). Labels come from t(); money columns only with prices.
export function historyCsv(data, doc, t, lang, prices, tz) {
  const vehHead = [t('fh.col.plate'), t('fh.col.make'), t('fh.col.model'), t('fh.col.year'), t('fh.col.vin')]
  const vehCells = (v) => [v.plate, v.make || '', v.model || '', v.year ?? '', v.vin || '']
  if (doc === 'list') {
    const head = [...vehHead, t('fh.col.type'), t('fh.col.fuel'), t('fh.col.km'), t('fh.col.status'), t('fh.col.next')]
    const rows = data.vehicles.map(({ v, next }) => [...vehCells(v), v.type ? t(`veh.vtype.${v.type}`) : '', v.fuel_type ? t(`veh.fuel.${v.fuel_type}`) : '',
      v.mileage_km ?? '', t(`veh.st.${v.status}`), nextText(next, lang)])
    return { head, rows }
  }
  const head = [...vehHead, t('fh.col.date'), t('fh.col.invoice'), t('fh.col.job'), t('fh.col.km'), t('fh.col.billedTo'), t('fh.col.service'), t('fh.col.tech'),
    t('fh.col.itemType'), t('fh.col.item'), t('fh.col.qty'), ...(prices ? [t('fh.col.amount'), t('fh.col.invoiceTotal')] : [])]
  const rows = []
  for (const { v, jobs } of data.vehicles) {
    if (!jobs.length) { rows.push([...vehCells(v), ...Array(head.length - vehHead.length).fill('')]); continue }
    for (const { ro, billedTo, services } of jobs) {
      const jobCells = [fmtDate(ro.invoiced_at, lang, tz), invoiceNo(ro.invoice_number), jobNo(ro.job_number), ro.odometer_out ?? ro.odometer_in ?? '', billedTo || '']
      // the invoice total goes on the invoice's first row only, so adding up the column gives the right sum
      let total = prices && ro.total != null ? Number(ro.total) : ''
      const takeTotal = () => { const x = total; total = ''; return x }
      if (!services.length) rows.push([...vehCells(v), ...jobCells, '', '', '', '', '', ...(prices ? ['', takeTotal()] : [])])
      for (const { s, tech, items } of services) {
        const m = serviceMoney(s, items)
        const list = items.length ? items : [null]
        list.forEach((i, n) => {
          const amount = !prices ? null : m.flat ? (n === 0 && m.head != null ? m.head : '') : i && m.line(i) != null ? m.line(i) : ''
          rows.push([...vehCells(v), ...jobCells, s.name, tech || '', i ? t(`fh.type.${i.item_type}`) : '', i ? i.name : '', i ? Number(i.qty) : '',
            ...(prices ? [amount, takeTotal()] : [])])
        })
        if (prices && m.discount != null) {
          rows.push([...vehCells(v), ...jobCells, s.name, tech || '', t('fh.type.discount'), t('fh.serviceDiscount'), '', m.discount, takeTotal()])
        }
      }
    }
  }
  return { head, rows }
}

export const vehicleLabel = (v) => [v.plate, vehicleName(v)].filter(Boolean).join(' · ')
