import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Notice, Select, Textarea } from '../../components/ui'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { num, readAmount } from '../../lib/format'
import { FUEL_TYPES, VEHICLE_TYPES, formatPlate, normalizePlate, normalizeVin } from '../../lib/customers'

const EMPTY = { customer_id: '', plate: '', year: '', make: '', model: '', vin: '', type: '', fuel_type: '', mileage_km: '', status: 'active', notes: '' }

// Add or edit a vehicle. The owning company is chosen when adding; after that it
// only changes through "Transfer to another PT", which keeps the ownership history.
export default function VehicleForm({ open, vehicle, customers, vehicles, defaultCustomerId, onClose, onSaved }) {
  const { t } = useT()
  const [f, setF] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const editing = Boolean(vehicle)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setMsg(null)
    setF(vehicle ? {
      customer_id: vehicle.customer_id, plate: vehicle.plate || '', year: vehicle.year ? String(vehicle.year) : '', make: vehicle.make || '',
      model: vehicle.model || '', vin: vehicle.vin || '', type: vehicle.type || '', fuel_type: vehicle.fuel_type || '',
      mileage_km: vehicle.mileage_km == null ? '' : num(vehicle.mileage_km), status: vehicle.status, notes: vehicle.notes || '',
    } : { ...EMPTY, customer_id: defaultCustomerId || '' })
  }, [open, vehicle, defaultCustomerId])

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  const companyName = (id) => customers.find((c) => c.id === id)?.display_name || ''

  async function save() {
    const errs = {}
    const plate = formatPlate(f.plate)
    if (!f.customer_id) errs.customer_id = t('settings.required')
    if (!normalizePlate(plate)) errs.plate = t('settings.required')
    else {
      const dup = vehicles.find((v) => v.id !== vehicle?.id && normalizePlate(v.plate) === normalizePlate(plate))
      if (dup) errs.plate = t('veh.plateTaken', { company: companyName(dup.customer_id) })
    }
    const vin = normalizeVin(f.vin)
    if (vin) {
      const dup = vehicles.find((v) => v.id !== vehicle?.id && normalizeVin(v.vin) === vin)
      if (dup) errs.vin = t('veh.vinTaken', { plate: dup.plate })
    }
    const thisYear = new Date().getFullYear()
    const year = f.year.trim() === '' ? null : Number(f.year)
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > thisYear + 1)) errs.year = t('veh.yearRule', { max: thisYear + 1 })
    const km = readAmount(f.mileage_km)
    if (Number.isNaN(km) || km > 9999999) errs.mileage_km = t('veh.kmRule')
    setErrors(errs)
    if (Object.keys(errs).length) return

    const row = {
      plate, year, make: f.make.trim() || null, model: f.model.trim() || null, vin: vin || null,
      type: f.type || null, fuel_type: f.fuel_type || null, mileage_km: km, status: f.status, notes: f.notes.trim() || null,
    }
    setBusy(true)
    setMsg(null)
    const res = editing
      ? await supabase.from('vehicles').update(row).eq('id', vehicle.id).select().single()
      : await supabase.from('vehicles').insert({ ...row, customer_id: f.customer_id }).select().single()
    setBusy(false)
    if (res.error) return setMsg(errorText(res.error, t))
    onSaved(res.data)
  }

  const lowered = editing && vehicle.mileage_km != null && readAmount(f.mileage_km) !== null && readAmount(f.mileage_km) < vehicle.mileage_km
  const activeCustomers = customers.filter((c) => c.active || c.id === f.customer_id)

  return (
    <Modal open={open} onClose={onClose} wide title={editing ? t('veh.editTitle') : t('veh.newTitle')}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={save} loading={busy}>{editing ? t('common.save') : t('veh.create')}</Button>
      </>}>
      {msg && <Notice kind="err">{msg}</Notice>}
      <div className="grid2">
        {editing ? (
          <div className="field"><span className="fieldlabel">{t('veh.company')}</span><div className="readonly">{companyName(f.customer_id)}</div><div className="hint" style={{ marginTop: 0 }}>{t('veh.companyLocked')}</div></div>
        ) : (
          <Select label={t('veh.company')} value={f.customer_id} onChange={set('customer_id')} error={errors.customer_id}
            options={[{ value: '', label: t('veh.pickCompany'), disabled: true }, ...activeCustomers.map((c) => ({ value: c.id, label: c.display_name }))]} />
        )}
        <Input label={t('veh.plate')} value={f.plate} onChange={set('plate')} onBlur={() => setF((x) => ({ ...x, plate: formatPlate(x.plate) }))}
          error={errors.plate} autoFocus={!editing} placeholder="B 1188 GH" style={{ textTransform: 'uppercase', fontWeight: 700 }} />
        <div className="grid3 span2">
          <Input label={t('veh.year')} value={f.year} onChange={set('year')} inputMode="numeric" error={errors.year} placeholder="2021" />
          <Input label={t('veh.make')} value={f.make} onChange={set('make')} placeholder="Toyota" />
          <Input label={t('veh.model')} value={f.model} onChange={set('model')} placeholder="Fortuner 2.4 VRZ" />
        </div>
        <Input label="VIN" value={f.vin} onChange={set('vin')} onBlur={() => setF((x) => ({ ...x, vin: normalizeVin(x.vin) }))} error={errors.vin}
          hint={normalizeVin(f.vin) && normalizeVin(f.vin).length !== 17 ? t('veh.vinLength', { n: normalizeVin(f.vin).length }) : null} style={{ textTransform: 'uppercase' }} />
        <Input label={t('veh.odometer')} value={f.mileage_km} onChange={set('mileage_km')} inputMode="numeric" suffix="km" error={errors.mileage_km}
          hint={lowered ? t('veh.odometerLower') : (editing ? t('veh.odometerHint') : null)} />
        <Select label={t('veh.type')} value={f.type} onChange={set('type')}
          options={[{ value: '', label: '—' }, ...VEHICLE_TYPES.map((x) => ({ value: x, label: t(`veh.vtype.${x}`) })), ...(f.type && !VEHICLE_TYPES.includes(f.type) ? [{ value: f.type, label: f.type }] : [])]} />
        <Select label={t('veh.fuel')} value={f.fuel_type} onChange={set('fuel_type')}
          options={[{ value: '', label: '—' }, ...FUEL_TYPES.map((x) => ({ value: x, label: t(`veh.fuel.${x}`) })), ...(f.fuel_type && !FUEL_TYPES.includes(f.fuel_type) ? [{ value: f.fuel_type, label: f.fuel_type }] : [])]} />
        {editing && (
          <Select label={t('veh.status')} value={f.status} onChange={set('status')} hint={f.status === 'in_shop' ? t('veh.inShopHint') : null}
            options={[
              { value: 'active', label: t('veh.st.active') },
              { value: 'in_shop', label: t('veh.st.in_shop'), disabled: vehicle.status !== 'in_shop' },
              { value: 'inactive', label: t('veh.st.inactive') },
              { value: 'sold', label: t('veh.st.sold') },
            ]} />
        )}
        <Textarea fieldClass={editing ? '' : 'span2'} label={t('veh.notes')} value={f.notes} onChange={set('notes')} rows={2} />
      </div>
    </Modal>
  )
}
