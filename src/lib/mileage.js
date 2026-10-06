import { supabase } from './supabase'

// The highest reading we know for a vehicle: its odometer on file, or any earlier job's odometer in/out.
// `excludeRo` leaves out the job being edited. Returns { km, source: 'vehicle' | job number } or null.
// `ownKm` are the job's own saved readings: when the vehicle's odometer on file only came from them
// (it is raised automatically and never goes down), it isn't held against a correction of that same job.
export async function lastKnownKm(vehicleId, excludeRo, ownKm = []) {
  if (!vehicleId) return null
  const [v, jobs] = await Promise.all([
    supabase.from('vehicles').select('mileage_km').eq('id', vehicleId).maybeSingle(),
    supabase.from('repair_orders').select('id, job_number, odometer_in, odometer_out').eq('vehicle_id', vehicleId),
  ])
  const onFile = v.data?.mileage_km != null ? Number(v.data.mileage_km) : null
  let best = onFile != null && !ownKm.some((k) => k != null && Number(k) === onFile) ? { km: onFile, job: null } : null
  for (const j of jobs.data || []) {
    if (j.id === excludeRo) continue
    for (const k of [j.odometer_in, j.odometer_out]) {
      if (k != null && (!best || Number(k) > best.km)) best = { km: Number(k), job: j.job_number }
    }
  }
  return best
}

// Asks "is this right?" when a reading is lower than what we already know. Resolves true to go ahead.
export async function confirmKm({ value, vehicleId, excludeRo, ownKm, confirm, t, fmt, jobNo }) {
  if (value == null) return true
  const last = await lastKnownKm(vehicleId, excludeRo, ownKm)
  if (!last || value >= last.km) return true
  return (await confirm({
    title: t('km.lowerTitle'), yes: t('km.yes'), no: t('km.no'),
    text: t('km.lowerText', { km: fmt(value), last: fmt(last.km), where: last.job ? t('km.onJob', { no: jobNo(last.job) }) : '' }),
  })) === true
}
