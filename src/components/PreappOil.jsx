import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useT } from '../lib/i18n'
import { fmtDate, km, num } from '../lib/format'

// Item 48 (migration 149): oil changes done before the app, on the vehicle panel. Read-only; nothing shows when there
// are none. Staff and the company's own fleet manager can see them.
export default function PreappOil({ vehicleId, style }) {
  const { t, lang } = useT()
  const [rows, setRows] = useState([])
  useEffect(() => {
    let live = true
    supabase.from('oil_preapp').select('id, oil_name, done_on, km, litres, note').eq('vehicle_id', vehicleId).order('done_on', { ascending: false }).order('id')
      .then(({ data }) => { if (live) setRows(data || []) })
    return () => { live = false }
  }, [vehicleId])
  if (!rows.length) return null
  return (
    <div className="preapp-box" style={style}>
      <div className="sectionlabel" style={{ margin: 0 }}>{t('u149.panelTitle')}</div>
      <div className="small muted" style={{ marginBottom: 4 }}>{t('u149.panelHint')}</div>
      <ul className="plain small" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {rows.map((r) => (
          <li key={r.id} style={{ padding: '2px 0' }}>
            <b>{fmtDate(r.done_on, lang)}</b> · {r.km != null ? km(r.km) : t('u146.rk.noKm')} · {r.oil_name} {num(r.litres, 2)} L{r.note ? <span className="muted"> · {r.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
