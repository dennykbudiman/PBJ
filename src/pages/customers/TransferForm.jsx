import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Notice, Select, Textarea, useConfirm } from '../../components/ui'
import { confirmKm } from '../../lib/mileage'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { jobNo, km as kmText, num, readAmount } from '../../lib/format'
import { shopToday } from '../../lib/customers'

// Moves a vehicle to another company (PT) through the database's transfer_vehicle,
// which records the ownership history and moves only jobs that aren't invoiced yet.
export default function TransferForm({ open, vehicle, customers, minDate, onClose, onDone }) {
  const { t } = useT()
  const { timezone } = useShop()
  const [f, setF] = useState({ to: '', date: '', km: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [confirm, confirmEl] = useConfirm()

  useEffect(() => {
    if (open && vehicle) {
      setMsg(null)
      setF({ to: '', date: shopToday(timezone), km: vehicle.mileage_km == null ? '' : num(vehicle.mileage_km), note: '' })
    }
  }, [open, vehicle, timezone])

  if (!vehicle) return null
  const from = customers.find((c) => c.id === vehicle.customer_id)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))

  async function submit() {
    setMsg(null)
    if (!f.to) return setMsg(t('veh.pickNewCompany'))
    if (!f.date) return setMsg(t('veh.pickDate'))
    if (f.date > shopToday(timezone)) return setMsg(t('veh.noFutureDate'))
    // Transfers happen in order: a new one can't be dated before the last one.
    if (minDate && f.date < minDate) return setMsg(t('veh.notBeforeLast', { date: minDate }))
    const km = readAmount(f.km)
    if (Number.isNaN(km) || km > 9999999) return setMsg(t('veh.kmRule'))
    // A reading lower than what's known (e.g. a back-dated transfer) is fine, but asked about first.
    if (busy) return
    setBusy(true)
    if (!(await confirmKm({ value: km, vehicleId: vehicle.id, confirm, t, fmt: kmText, jobNo }))) { setBusy(false); return }
    const { error } = await supabase.rpc('transfer_vehicle', {
      p_vehicle: vehicle.id, p_to: f.to, p_date: f.date, p_odometer: km, p_note: f.note.trim() || null,
    })
    setBusy(false)
    if (error) return setMsg(errorText(error, t))
    onDone()
  }

  return (
    <>
    <Modal open={open} onClose={onClose} title={t('veh.transferTitle', { plate: vehicle.plate })}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={submit} loading={busy}>{t('veh.transferDo')}</Button>
      </>}>
      {msg && <Notice kind="err">{msg}</Notice>}
      <div className="field"><span className="fieldlabel">{t('veh.from')}</span><div className="readonly">{from?.display_name}</div></div>
      <Select label={t('veh.to')} value={f.to} onChange={set('to')}
        options={[{ value: '', label: t('veh.pickCompany'), disabled: true }, ...customers.filter((c) => c.id !== vehicle.customer_id && c.active).map((c) => ({ value: c.id, label: c.display_name }))]} />
      <div className="grid2">
        <Input type="date" label={t('veh.transferDate')} value={f.date} onChange={set('date')} max={shopToday(timezone)} min={minDate || undefined} />
        <Input label={t('veh.odometerAtTransfer')} value={f.km} onChange={set('km')} inputMode="numeric" suffix="km" />
      </div>
      <Textarea label={t('veh.transferNote')} value={f.note} onChange={set('note')} rows={2} />
      <Notice kind="info">{t('veh.transferExplain', { from: from?.display_name || '' })}</Notice>
    </Modal>
    {confirmEl}
    </>
  )
}
