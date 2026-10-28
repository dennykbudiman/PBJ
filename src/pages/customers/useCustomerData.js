import { useCallback, useEffect, useState } from 'react'
import { supabase, errorText } from '../../lib/supabase'
import { monthStart, zonedMidnightUtc } from '../../lib/customers'
import { useAuth } from '../../context/AuthContext'

// Supabase returns at most 1000 rows per request (its "Max rows" setting), so read big tables page by page. If that
// setting is ever lowered, a page comes back shorter than asked; a round-numbered short page is then read on from
// where it ended instead of being taken as the end of the list.
export async function selectAll(build, pageSize = 1000) {
  const rows = []
  for (let from = 0; ;) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) return { data: rows.length ? rows : null, error }
    const n = data?.length ?? 0
    rows.push(...(data ?? []))
    if (n === 0 || (n < pageSize && n % 100 !== 0)) return { data: rows, error: null }
    from += n
  }
}

// Loads everything the Customers and Vehicles lists show, in a handful of queries.
// Fleets here are tens of companies and a few hundred vehicles, so filtering and
// counting happen in the browser.
export function useCustomerData(timezone) {
  // Company money (balances, sales) is only given to people who handle money (migration 129); others see "—".
  // A fleet manager sees its own companies' money (migration 133).
  const { can, isFleet } = useAuth()
  const money = can('view_reports') || can('record_payments') || isFleet
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const since = monthStart(timezone)
    const sinceUtc = zonedMidnightUtc(since, timezone)
    const [cust, contacts, vehicles, balances, jobs] = await Promise.all([
      selectAll(() => supabase.from('customers').select('*').order('display_name').order('id')),
      selectAll(() => supabase.from('customer_contacts').select('*').order('is_primary', { ascending: false }).order('name').order('id')),
      selectAll(() => supabase.from('vehicles').select('*').order('plate').order('id')),
      supabase.from('customer_balances').select('*'),
      // Open estimates (not invoiced, not closed) and this month's invoices, for the counts and sales columns.
      selectAll(() => supabase.from('repair_orders')
        .select('id, customer_id, vehicle_id, order_status, total, invoiced_at, closed_at, archived_at, workflow_status, job_number')
        .or(`and(order_status.eq.estimate,closed_at.is.null),and(order_status.eq.invoice,invoiced_at.gte."${sinceUtc}")`)
        .order('id')),
    ])
    const firstError = [cust, contacts, vehicles, balances, jobs].find((r) => r.error)?.error
    if (firstError) {
      setError(firstError)
      if (!cust.data) return
    } else setError(null)

    const byCustomer = {}
    for (const c of cust.data ?? []) {
      byCustomer[c.id] = { vehicles: 0, sold: 0, inShop: 0, notInvoiced: 0, sales: 0, invoices: 0, balance: 0, overdue: 0, openInvoices: 0, credit: 0, contacts: [] }
    }
    for (const v of vehicles.data ?? []) {
      const s = byCustomer[v.customer_id]
      if (!s) continue
      if (v.status !== 'sold') s.vehicles += 1
      else s.sold += 1
      if (v.status === 'in_shop') s.inShop += 1
    }
    for (const j of jobs.data ?? []) {
      const s = byCustomer[j.customer_id]
      if (!s) continue
      if (j.order_status === 'estimate') s.notInvoiced += 1
      else { s.sales += Number(j.total) || 0; s.invoices += 1 }
    }
    for (const b of balances.data ?? []) {
      const s = byCustomer[b.customer_id]
      if (!s) continue
      s.balance = Number(b.balance_due) || 0
      s.overdue = Number(b.overdue) || 0
      s.openInvoices = Number(b.open_invoices) || 0
      s.credit = Number(b.available_credit) || 0
    }
    if (!money) for (const s of Object.values(byCustomer)) { s.sales = null; s.balance = null; s.overdue = null; s.credit = null }
    for (const ct of contacts.data ?? []) byCustomer[ct.customer_id]?.contacts.push(ct)

    const openJobByVehicle = {}
    for (const j of jobs.data ?? []) {
      if (j.order_status === 'estimate' && !j.archived_at) openJobByVehicle[j.vehicle_id] = j
    }

    setData({
      customers: cust.data ?? [],
      customerById: Object.fromEntries((cust.data ?? []).map((c) => [c.id, c])),
      stats: byCustomer,
      vehicles: vehicles.data ?? [],
      openJobByVehicle,
      since,
    })
  }, [timezone, money])

  useEffect(() => { load() }, [load])

  return { data, error, reload: load, errorText }
}
