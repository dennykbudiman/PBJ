import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { selectAll } from '../customers/useCustomerData'
import { isActiveAppt } from '../../lib/calendar'

const JOB_COLS = 'id, job_number, invoice_number, customer_id, vehicle_id, order_status, workflow_status, priority, service_advisor_id, total, balance, payment_status, invoiced_at, due_date, created_at, updated_at, archived_at, closed_at'

// Runs an `.in()` query in chunks so long id lists never make an over-long URL.
async function inChunks(ids, build) {
  const out = []
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await selectAll(() => build(ids.slice(i, i + 150)))
    if (error) return { data: null, error }
    out.push(...(data || []))
  }
  return { data: out, error: null }
}

// Everything the Work board shows: jobs still in the shop (not closed, not picked up),
// with their company, vehicle, main contact, technicians, labour hours, inspections and next booking.
export function useBoardData() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const loads = useRef(0)

  const load = useCallback(async () => {
    const n = ++loads.current
    const [jobs, customers, vehicles, contacts] = await Promise.all([
      selectAll(() => supabase.from('repair_orders').select(JOB_COLS).is('archived_at', null).is('closed_at', null).order('job_number', { ascending: false }).order('id')),
      selectAll(() => supabase.from('customers').select('id, display_name, phone').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, customer_id, plate, make, model, year').order('id')),
      selectAll(() => supabase.from('customer_contacts').select('id, customer_id, name, phone, is_primary').order('is_primary', { ascending: false }).order('id')),
    ])
    const ids = (jobs.data || []).map((j) => j.id)
    const [services, inspections, appts] = await Promise.all([
      ids.length ? inChunks(ids, (c) => supabase.from('ro_services').select('id, ro_id, technician_id, approval_status, work_status').in('ro_id', c).order('id')) : { data: [] },
      ids.length ? inChunks(ids, (c) => supabase.from('ro_inspections').select('id, ro_id, technician_id').in('ro_id', c).order('id')) : { data: [] },
      ids.length ? inChunks(ids, (c) => supabase.from('appointments').select('id, ro_id, start_time, end_time, status, technician_id').in('ro_id', c).order('start_time').order('id')) : { data: [] },
    ])
    const svcIds = (services.data || []).filter((s) => s.approval_status !== 'declined' && s.approval_status !== 'deferred').map((s) => s.id)
    const labor = svcIds.length
      ? await inChunks(svcIds, (c) => supabase.from('ro_service_items').select('id, service_id, qty').eq('item_type', 'labor').in('service_id', c).order('id'))
      : { data: [] }
    if (n !== loads.current) return
    const all = [jobs, customers, vehicles, contacts, services, inspections, appts, labor]
    setError(all.find((x) => x.error)?.error || null)

    const svcJob = Object.fromEntries((services.data || []).map((s) => [s.id, s.ro_id]))
    const by = (rows, key) => {
      const m = {}
      for (const r of rows || []) (m[r[key]] ||= []).push(r)
      return m
    }
    const svcBy = by(services.data, 'ro_id')
    const inspBy = by(inspections.data, 'ro_id')
    const apptBy = by((appts.data || []).filter(isActiveAppt), 'ro_id')
    const hours = {}
    for (const it of labor.data || []) { const j = svcJob[it.service_id]; hours[j] = (hours[j] || 0) + Number(it.qty || 0) }
    const contactBy = {}
    for (const c of contacts.data || []) if (!contactBy[c.customer_id]) contactBy[c.customer_id] = c
    const now = Date.now()

    setData({
      jobs: (jobs.data || []).map((j) => {
        const svcs = svcBy[j.id] || []
        const ap = apptBy[j.id] || []
        // The booking that matters: the next one still to come, otherwise the latest one.
        const next = ap.find((a) => new Date(a.end_time).getTime() >= now) || ap[ap.length - 1] || null
        const techs = [...new Set([...svcs.map((s) => s.technician_id), ...(inspBy[j.id] || []).map((x) => x.technician_id), next?.technician_id].filter(Boolean))]
        return {
          ...j,
          services: svcs.length,
          pending: svcs.filter((s) => s.approval_status === 'pending').length,
          approved: svcs.filter((s) => s.approval_status === 'approved').length,
          done: svcs.filter((s) => s.work_status === 'completed' && s.approval_status === 'approved').length,
          inspections: (inspBy[j.id] || []).length,
          hours: Math.round((hours[j.id] || 0) * 100) / 100,
          techs,
          appt: next,
        }
      }),
      customer: Object.fromEntries((customers.data || []).map((c) => [c.id, c])),
      vehicle: Object.fromEntries((vehicles.data || []).map((v) => [v.id, v])),
      contact: contactBy,
    })
  }, [])

  useEffect(() => { load() }, [load])
  return { data, error, reload: load }
}
