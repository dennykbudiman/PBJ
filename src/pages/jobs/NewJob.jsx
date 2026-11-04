import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../../components/Layout'
import { Button, Card, Empty, Input, Notice, PageHead, Select, Textarea, useConfirm, useToast } from '../../components/ui'
import { confirmKm } from '../../lib/mileage'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText, writeRow } from '../../lib/supabase'
import { selectAll } from '../customers/useCustomerData'
import { jobNo, km } from '../../lib/format'
import { plateDriver, vehicleName } from '../../lib/customers'
import { PRIORITIES, splitConcerns } from '../../lib/jobs'
import { runsJobs, useStaff } from './useJobData'

// New job: pick the company and vehicle, the odometer reading, who brought it in and what the driver reported.
// Typing a plate (or a driver's name) lists the matching vehicles: one click picks the vehicle and its company (Nov 3).
export default function NewJob() {
  const { t } = useT()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const { can, profile, roleName } = useAuth()
  const staff = useStaff()
  const [customers, setCustomers] = useState(null)
  const [vehicles, setVehicles] = useState([])
  const [openJobs, setOpenJobs] = useState([])
  const [q, setQ] = useState('')
  const [f, setF] = useState({ customer_id: params.get('customer') || '', vehicle_id: params.get('vehicle') || '', odometer: '', concern: '', priority: 'medium', advisor: '', driver_name: '', driver_phone: '', save_driver: false })
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [confirm, confirmEl] = useConfirm()
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))

  useEffect(() => {
    Promise.all([
      selectAll(() => supabase.from('customers').select('id, display_name, legal_name, active').order('display_name').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, customer_id, plate, make, model, year, status, mileage_km, driver_name, driver_phone').order('plate').order('id')),
    ]).then(([c, v]) => {
      setCustomers(c.data || [])
      setVehicles(v.data || [])
      // Opened from a vehicle: fill in its company.
      const pre = (v.data || []).find((x) => x.id === params.get('vehicle'))
      if (pre) setF((x) => ({ ...x, customer_id: pre.customer_id, vehicle_id: pre.id }))
      if (c.error || v.error) setMsg(errorText(c.error || v.error, t))
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The service advisor defaults to the person creating the job, unless they are a technician.
  useEffect(() => {
    if (!f.advisor && profile?.id && roleName !== 'Technician' && staff.some((s) => s.id === profile.id)) setF((x) => ({ ...x, advisor: profile.id }))
  }, [staff, profile?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const custVehicles = vehicles.filter((v) => v.customer_id === f.customer_id && v.status !== 'sold')
  const vehicle = vehicles.find((v) => v.id === f.vehicle_id)
  // Pick the only vehicle automatically.
  useEffect(() => {
    if (f.customer_id && !custVehicles.some((v) => v.id === f.vehicle_id)) setF((x) => ({ ...x, vehicle_id: custVehicles.length === 1 ? custVehicles[0].id : '' }))
  }, [f.customer_id, vehicles.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Who brought it in: the vehicle's driver, editable. A different driver typed here is saved on the vehicle too, unless
  // the tick is cleared for a one-off substitute (Nov 4, Denny: drivers typed on jobs should update the vehicle).
  useEffect(() => {
    const v = vehicles.find((x) => x.id === f.vehicle_id)
    setF((x) => ({ ...x, driver_name: v?.driver_name || '', driver_phone: v?.driver_phone || '', save_driver: Boolean(v) }))
  }, [f.vehicle_id, vehicles.length]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setOpenJobs([])
    if (!f.vehicle_id) return
    supabase.from('repair_orders').select('id, job_number, workflow_status').eq('vehicle_id', f.vehicle_id).eq('order_status', 'estimate')
      .is('closed_at', null).then(({ data }) => setOpenJobs(data || []))
  }, [f.vehicle_id])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = (customers || []).filter((c) => c.active !== false || c.id === f.customer_id)
    if (!needle) return list
    const plateHits = new Set(vehicles.filter((v) => (v.plate || '').toLowerCase().replace(/\s/g, '').includes(needle.replace(/\s/g, ''))).map((v) => v.customer_id))
    return list.filter((c) => c.id === f.customer_id || [c.display_name, c.legal_name].filter(Boolean).join(' ').toLowerCase().includes(needle) || plateHits.has(c.id))
  }, [customers, vehicles, q, f.customer_id])

  // Vehicles whose plate (spaces ignored) or driver matches what was typed.
  const vehHits = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const flat = needle.replace(/\s/g, '')
    if (flat.length < 2) return []
    const active = new Set((customers || []).filter((c) => c.active !== false).map((c) => c.id))
    return vehicles.filter((v) => v.status !== 'sold' && active.has(v.customer_id)
      && ((v.plate || '').toLowerCase().replace(/\s/g, '').includes(flat) || (needle.length >= 3 && (v.driver_name || '').toLowerCase().includes(needle))))
      .slice(0, 8)
  }, [customers, vehicles, q])
  const nameOfCustomer = (id) => (customers || []).find((c) => c.id === id)?.display_name || ''
  const pickVehicle = (v) => { setF((x) => ({ ...x, customer_id: v.customer_id, vehicle_id: v.id })); setErrors({}) }

  if (!can('edit_jobs')) {
    return <Page><Card><Empty icon="lock" title={t('err.permission')} /></Card></Page>
  }

  async function create() {
    const e = {}
    if (!f.customer_id) e.customer_id = t('settings.required')
    if (!f.vehicle_id) e.vehicle_id = t('settings.required')
    const odo = f.odometer.trim() ? Number(f.odometer.replace(/[.\s]/g, '')) : null
    if (odo !== null && (!Number.isInteger(odo) || odo < 0 || odo > 9999999)) e.odometer = t('veh.kmRule')
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    setMsg(null)
    if (!(await confirmKm({ value: odo, vehicleId: f.vehicle_id, confirm, t, fmt: km, jobNo }))) { setBusy(false); return }
    const driver = { driver_name: f.driver_name.trim() || null, driver_phone: f.driver_phone.trim() || null }
    const { data, error } = await writeRow('repair_orders', {
      customer_id: f.customer_id, vehicle_id: f.vehicle_id, odometer_in: odo, priority: f.priority, service_advisor_id: f.advisor || null, ...driver,
    })
    if (error) { setBusy(false); return setMsg(errorText(error, t)) }
    const v = vehicles.find((x) => x.id === f.vehicle_id)
    const changed = v && ((driver.driver_name || '') !== (v.driver_name || '') || (driver.driver_phone || '') !== (v.driver_phone || ''))
    if (f.save_driver && changed && (driver.driver_name || driver.driver_phone)) {
      // empty fields don't clear the vehicle's
      const d = await supabase.from('vehicles').update(Object.fromEntries(Object.entries(driver).filter(([, x]) => x))).eq('id', f.vehicle_id)
      if (d.error) toast(errorText(d.error, t), 'err')
    }
    const concerns = splitConcerns(f.concern) // one concern per line
    if (concerns.length) {
      const c = await supabase.from('ro_concerns').insert(concerns.map((text, position) => ({ ro_id: data.id, position, text })))
      if (c.error) toast(errorText(c.error, t), 'err')
    }
    toast(t('job.created', { no: jobNo(data.job_number) }))
    // From a service schedule ("Start job"): the job page adds that service.
    // (only when the vehicle is still the one the schedule belongs to)
    const sched = f.vehicle_id === params.get('vehicle') ? params.get('schedule') : null
    navigate(sched ? `/jobs/${data.id}?addSchedule=${encodeURIComponent(sched)}` : `/jobs/${data.id}`, { replace: true })
  }

  const lowKm = vehicle?.mileage_km != null && f.odometer.trim() && Number(f.odometer.replace(/[.\s]/g, '')) < Number(vehicle.mileage_km)

  return (
    <Page>
      <PageHead title={t('job.newTitle')} sub={t('job.newSub')} />
      <div className="card" style={{ maxWidth: 760 }}>
        {msg && <Notice kind="err" style={{ marginBottom: 12 }}>{msg}</Notice>}
        {!customers ? <div className="muted">{t('common.loading')}</div> : customers.length === 0 ? (
          <Empty icon="users" title={t('job.noCustomers')} action={<Link className="btn primary" to="/customers?new=1">{t('create.customer')}</Link>}>{t('job.noCustomersText')}</Empty>
        ) : (
          <>
            <div className="grid2">
              <div className="field span2">
                <label htmlFor="nj-search">{t('job.company')}</label>
                <input id="nj-search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('nj.search')} autoFocus={!f.customer_id} />
                {vehHits.length > 0 && (
                  <div className="vehhits" role="list" aria-label={t('nj.vehicleHits')}>
                    {vehHits.map((v) => (
                      <button key={v.id} type="button" role="listitem" className={`vehhit ${f.vehicle_id === v.id ? 'on' : ''}`} onClick={() => pickVehicle(v)}>
                        <b>{plateDriver(v)}</b> · {vehicleName(v) || '—'} <span className="muted">— {nameOfCustomer(v.customer_id)}</span>
                        {v.driver_name && <span className="muted small"> · {t('drv.driver')}: {v.driver_name}</span>}
                      </button>
                    ))}
                  </div>
                )}
                <select className={`select ${errors.customer_id ? 'invalid' : ''}`} size={Math.min(6, Math.max(3, shown.length))} value={f.customer_id}
                  onChange={set('customer_id')} aria-label={t('job.company')} style={{ marginTop: 6, height: 'auto' }}>
                  {shown.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
                </select>
                {errors.customer_id && <div className="error">{errors.customer_id}</div>}
              </div>
              <div className="span2">
                <Select label={t('job.vehicle')} value={f.vehicle_id} onChange={set('vehicle_id')} error={errors.vehicle_id} disabled={!f.customer_id}
                  options={[{ value: '', label: f.customer_id ? (custVehicles.length ? t('job.pickVehicle') : t('job.noVehicles')) : t('job.pickCompanyFirst') },
                    ...custVehicles.map((v) => ({ value: v.id, label: `${plateDriver(v)} · ${vehicleName(v) || '—'}` }))]} />
                {f.customer_id && custVehicles.length === 0 && (
                  <div className="hint"><Link to={`/customers/${f.customer_id}`}>{t('job.addVehicleFirst')}</Link></div>
                )}
              </div>
              {openJobs.length > 0 && (
                <Notice kind="warn" style={{ gridColumn: '1 / -1' }}>
                  {t('job.alreadyOpen')}{' '}
                  {openJobs.map((j, i) => <React.Fragment key={j.id}>{i > 0 && ', '}<Link to={`/jobs/${j.id}`}>#{jobNo(j.job_number)}</Link></React.Fragment>)}
                </Notice>
              )}
              <Input label={t('drv.broughtBy')} value={f.driver_name} onChange={set('driver_name')} maxLength={120} disabled={!f.vehicle_id} />
              <Input label={t('drv.phone')} value={f.driver_phone} onChange={set('driver_phone')} maxLength={40} inputMode="tel" disabled={!f.vehicle_id} />
              {vehicle && (f.driver_name.trim() || f.driver_phone.trim()) && (f.driver_name.trim() !== (vehicle.driver_name || '') || f.driver_phone.trim() !== (vehicle.driver_phone || '')) && (
                <label className="inlinecheck span2">
                  <input type="checkbox" checked={f.save_driver} onChange={(e) => setF((x) => ({ ...x, save_driver: e.target.checked }))} />
                  <span>{vehicle.driver_name || vehicle.driver_phone ? t('drv138.keepOnVehicle', { plate: vehicle.plate }) : t('drv.saveOnVehicle', { plate: vehicle.plate })}</span>
                </label>
              )}
              <Input label={t('job.odometerIn')} value={f.odometer} onChange={set('odometer')} inputMode="numeric" suffix="km" error={errors.odometer}
                hint={vehicle?.mileage_km != null ? (lowKm ? t('job.lowerThanLast', { km: km(vehicle.mileage_km) }) : t('job.lastKnown', { km: km(vehicle.mileage_km) })) : null} />
              <Select label={t('job.priority')} value={f.priority} onChange={set('priority')} options={PRIORITIES.map((p) => ({ value: p, label: t(`job.pri.${p}`) }))} />
              <Select fieldClass="span2" label={t('job.advisor')} value={f.advisor} onChange={set('advisor')}
                options={[{ value: '', label: '—' }, ...staff.filter(runsJobs).map((s) => ({ value: s.id, label: s.name }))]} />
              <Textarea fieldClass="span2" label={t('job.concern')} value={f.concern} onChange={set('concern')} rows={3} placeholder={t('job.concernExample')} hint={t('job.concernHint')} />
            </div>
            <div className="row" style={{ marginTop: 16 }}>
              <div className="spacer" />
              <Button onClick={() => navigate(-1)}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={create} loading={busy}>{t('job.create')}</Button>
            </div>
          </>
        )}
      </div>
      {confirmEl}
    </Page>
  )
}
