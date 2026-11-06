import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useT } from '../lib/i18n'
import { useShop } from '../context/ShopContext'
import { fmtDate, invoiceNo, km } from '../lib/format'

// The vehicle's last invoiced visit: date, km and the work done (Denny, Nov 5). Answers "kapan terakhir ganti oli?"
// without opening the history. `excludeRo` leaves out the job being looked at; `showNone` says so when there is none.
export default function LastService({ vehicleId, excludeRo, showNone = false, style }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [last, setLast] = useState(undefined)

  useEffect(() => {
    let gone = false
    setLast(undefined)
    ;(async () => {
      let q = supabase.from('repair_orders').select('id, invoice_number, invoiced_at, odometer_in, odometer_out')
        .eq('vehicle_id', vehicleId).eq('order_status', 'invoice').order('invoiced_at', { ascending: false }).limit(1)
      if (excludeRo) q = q.neq('id', excludeRo)
      const { data } = await q
      const ro = data?.[0]
      if (!ro) { if (!gone) setLast(null); return }
      const { data: svcs } = await supabase.from('ro_services').select('name, position').eq('ro_id', ro.id).eq('approval_status', 'approved').order('position')
      if (!gone) setLast({ ...ro, services: (svcs || []).map((s) => s.name) })
    })()
    return () => { gone = true }
  }, [vehicleId, excludeRo])

  if (last === undefined) return null
  if (last === null) return showNone ? <div className="muted small" style={style}>{t('last.none')}</div> : null
  const reading = last.odometer_out ?? last.odometer_in
  return (
    <div className="small lastservice" style={style}>
      <span className="muted">{t('last.label')}:</span>{' '}
      <b>{fmtDate(last.invoiced_at, lang, timezone)}</b>
      {reading != null && <> · {km(reading)}</>}
      {last.services.length > 0 && <> · {last.services.join(', ')}</>}
      {' '}<Link to={`/jobs/${last.id}`} className="muted">({invoiceNo(last.invoice_number)})</Link>
    </div>
  )
}
