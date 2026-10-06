import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../../components/Layout'
import { Button, Card, Empty, Input, Notice, PageHead, Select, Textarea, useToast } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { selectAll } from '../customers/useCustomerData'
import { jobNo, km } from '../../lib/format'
import { vehicleName } from '../../lib/customers'
import { PRIORITIES } from '../../lib/jobs'
import { useStaff } from './useJobData'

// New job: pick the company and vehicle, the odometer reading and what the driver reported.
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
  const [f, setF] = useState({ customer_id: params.get('customer') || '', vehicle_id: params.get('vehicle') || '', odometer: '', concern: '', priority: 'medium', advisor: '' })
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))

  useEffect(() => {
    Promise.all([
      selectAll(() => supabase.from('customers').select('id, display_name, legal_name, active').order('display_name').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, customer_id, plate, make, model, year, status, mileage_km').order('plate').order('id')),
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
    const { data, error } = await supabase.from('repair_orders').insert({
      customer_id: f.customer_id, vehicle_id: f.vehicle_id, odometer_in: odo, priority: f.priority, service_advisor_id: f.advisor || null,
    }).select().single()
    if (error) { setBusy(false); return setMsg(errorText(error, t)) }
    if (f.concern.trim()) {
      const c = await supabase.from('ro_concerns').insert({ ro_id: data.id, position: 0, text: f.concern.trim() })
      if (c.error) toast(errorText(c.error, t), 'err')
    }
    toast(t('job.created', { no: jobNo(data.job_number) }))
    navigate(`/jobs/${data.id}`, { replace: true })
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
                <input id="nj-search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('job.searchCompany')} autoFocus={!f.customer_id} />
                <select className={`select ${errors.customer_id ? 'invalid' : ''}`} size={Math.min(6, Math.max(3, shown.length))} value={f.customer_id}
                  onChange={set('customer_id')} aria-label={t('job.company')} style={{ marginTop: 6, height: 'auto' }}>
                  {shown.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
                </select>
                {errors.customer_id && <div className="error">{errors.customer_id}</div>}
              </div>
              <div className="span2">
                <Select label={t('job.vehicle')} value={f.vehicle_id} onChange={set('vehicle_id')} error={errors.vehicle_id} disabled={!f.customer_id}
                  options={[{ value: '', label: f.customer_id ? (custVehicles.length ? t('job.pickVehicle') : t('job.noVehicles')) : t('job.pickCompanyFirst') },
                    ...custVehicles.map((v) => ({ value: v.id, label: `${v.plate} · ${vehicleName(v) || '—'}` }))]} />
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
              <Input label={t('job.odometerIn')} value={f.odometer} onChange={set('odometer')} inputMode="numeric" suffix="km" error={errors.odometer}
                hint={vehicle?.mileage_km != null ? (lowKm ? t('job.lowerThanLast', { km: km(vehicle.mileage_km) }) : t('job.lastKnown', { km: km(vehicle.mileage_km) })) : null} />
              <Select label={t('job.priority')} value={f.priority} onChange={set('priority')} options={PRIORITIES.map((p) => ({ value: p, label: t(`job.pri.${p}`) }))} />
              <Select fieldClass="span2" label={t('job.advisor')} value={f.advisor} onChange={set('advisor')}
                options={[{ value: '', label: '—' }, ...staff.filter((s) => s.roles?.name !== 'Technician').map((s) => ({ value: s.id, label: s.name }))]} />
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
    </Page>
  )
}
