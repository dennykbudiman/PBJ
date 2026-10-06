import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

// Everything the job page shows for one job. Totals are worked out by the database after each change,
// so after any write the page simply loads the job again.
export function useJobData(id) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)
  const [missing, setMissing] = useState(false)
  const loads = useRef(0)

  const load = useCallback(async () => {
    const n = ++loads.current
    const ro = await supabase.from('repair_orders').select('*').eq('id', id).maybeSingle()
    if (n !== loads.current) return
    if (ro.error) { setError(ro.error); return }
    if (!ro.data) { setMissing(true); setJob(null); return }
    const r = ro.data
    const [customer, vehicle, contacts, concerns, services, fees, discounts, approvals, payments, credits, inspections, voids, appts] = await Promise.all([
      supabase.from('customers').select('*').eq('id', r.customer_id).maybeSingle(),
      supabase.from('vehicles').select('*').eq('id', r.vehicle_id).maybeSingle(),
      supabase.from('customer_contacts').select('*').eq('customer_id', r.customer_id).order('is_primary', { ascending: false }).order('name'),
      supabase.from('ro_concerns').select('*').eq('ro_id', id).order('position').order('id'),
      supabase.from('ro_services').select('*').eq('ro_id', id).order('position').order('created_at'),
      supabase.from('ro_job_fees').select('*').eq('ro_id', id).order('is_shop_supplies', { ascending: false }).order('name').order('id'),
      supabase.from('ro_job_discounts').select('*').eq('ro_id', id).order('name').order('id'),
      supabase.from('approvals').select('*').eq('ro_id', id).order('decided_at', { ascending: false }).order('id'),
      supabase.from('payments').select('*').eq('ro_id', id).order('paid_at', { ascending: false }).order('id'),
      // Credits applied to this job, and the company's unused credits that could be.
      supabase.from('credit_memos').select('*').eq('customer_id', r.customer_id).order('created_at').order('id'),
      supabase.from('ro_inspections').select('*').eq('ro_id', id).order('created_at').order('id'),
      supabase.from('invoice_voids').select('*').eq('ro_id', id).order('voided_at', { ascending: false }),
      supabase.from('appointments').select('*').eq('ro_id', id).order('start_time').order('id'),
    ])
    const svcIds = (services.data || []).map((s) => s.id)
    const inspIds = (inspections.data || []).map((x) => x.id)
    const [items, results] = await Promise.all([
      svcIds.length ? supabase.from('ro_service_items').select('*').in('service_id', svcIds).order('position').order('created_at') : { data: [] },
      inspIds.length ? supabase.from('ro_inspection_results').select('*').in('inspection_id', inspIds).order('id') : { data: [] },
    ])
    if (n !== loads.current) return
    const all = [customer, vehicle, contacts, concerns, services, fees, discounts, approvals, payments, credits, inspections, voids, appts, items, results]
    const firstError = all.find((x) => x.error)?.error
    setError(firstError || null)
    setMissing(false)
    const allCredits = credits.data || []
    setJob({
      ro: r,
      customer: customer.data,
      vehicle: vehicle.data,
      contacts: contacts.data || [],
      concerns: concerns.data || [],
      services: services.data || [],
      items: items.data || [],
      fees: fees.data || [],
      discounts: discounts.data || [],
      approvals: approvals.data || [],
      payments: payments.data || [],
      appliedCredits: allCredits.filter((c) => c.applied_ro_id === id),
      availableCredits: allCredits.filter((c) => !c.applied_ro_id && !c.refunded_at),
      inspections: inspections.data || [],
      results: results.data || [],
      voids: voids.data || [],
      appointments: appts.data || [],
      version: n,
    })
  }, [id])

  useEffect(() => { setJob(null); setMissing(false); load() }, [load])
  return { job, error, missing, reload: load }
}

// Active staff who can be picked as technician or service advisor.
export function useStaff() {
  const [staff, setStaff] = useState([])
  useEffect(() => {
    let live = true
    supabase.from('profiles').select('id, name, status, role_id, roles(name)').order('name').then(({ data }) => {
      if (live) setStaff((data || []).filter((p) => p.status === 'active' && p.roles?.name !== 'Fleet manager'))
    })
    return () => { live = false }
  }, [])
  return staff
}
