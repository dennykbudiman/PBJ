import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { selectAll } from '../customers/useCustomerData'

// Rows whose id is in a long list, asked for 100 at a time so the request address stays short.
export async function selectIn(table, cols, col, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 100) {
    const r = await selectAll(() => supabase.from(table).select(cols).in(col, ids.slice(i, i + 100)).order('id'))
    if (r.error) return { data: out, error: r.error }
    out.push(...(r.data || []))
  }
  return { data: out, error: null }
}

// Everything the inventory screens show: parts and stock, suppliers, purchase orders and their lines,
// returns, cores and supplier payments, plus the jobs and vehicles they point at. A few thousand rows at most.
export function useInventoryData() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const loads = useRef(0)

  const load = useCallback(async () => {
    const n = ++loads.current
    const q = (table, order = 'id', asc = true) => selectAll(() => supabase.from(table).select('*').order(order, { ascending: asc }).order('id'))
    const [items, stock, suppliers, pos, lines, returns, cores, payments] = await Promise.all([
      selectAll(() => supabase.from('catalog_items').select('*').eq('item_type', 'part').order('name').order('id')),
      selectAll(() => supabase.from('stock_levels').select('id, qty_on_hand, qty_on_estimates, qty_on_order').order('id')),
      q('suppliers', 'name'), q('purchase_orders', 'created_at', false), q('purchase_order_items', 'created_at'),
      q('returns', 'created_at', false), q('cores', 'created_at', false), q('supplier_payments', 'created_at', false),
    ])
    // Jobs named by POs, returns and cores, with their vehicles (for "Job 100042 · B 1234 XY").
    const roIds = [...new Set([...(pos.data || []), ...(returns.data || []), ...(cores.data || [])].map((x) => x.ro_id).filter(Boolean))]
    const jobs = await selectIn('repair_orders', 'id, job_number, vehicle_id, customer_id, order_status, invoice_number, closed_at', 'id', roIds)
    const vIds = [...new Set((jobs.data || []).map((j) => j.vehicle_id).filter(Boolean))]
    const vehicles = await selectIn('vehicles', 'id, plate, make, model, year', 'id', vIds)
    if (n !== loads.current) return
    const all = { items, stock, suppliers, pos, lines, returns, cores, payments, jobs, vehicles }
    setError(Object.values(all).find((r) => r.error)?.error || null)
    const d = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.data ?? []]))
    d.version = n
    d.itemById = Object.fromEntries(d.items.map((x) => [x.id, x]))
    d.stockById = Object.fromEntries(d.stock.map((x) => [x.id, x]))
    d.supplierById = Object.fromEntries(d.suppliers.map((x) => [x.id, x]))
    d.poById = Object.fromEntries(d.pos.map((x) => [x.id, x]))
    d.lineById = Object.fromEntries(d.lines.map((x) => [x.id, x]))
    d.jobById = Object.fromEntries(d.jobs.map((x) => [x.id, x]))
    d.vehicleById = Object.fromEntries(d.vehicles.map((x) => [x.id, x]))
    d.linesByPo = {}
    for (const l of d.lines) (d.linesByPo[l.po_id] ||= []).push(l)
    setData(d)
  }, [])

  useEffect(() => { load() }, [load])
  return { data, error, reload: load }
}
