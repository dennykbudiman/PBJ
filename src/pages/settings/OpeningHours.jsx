import React from 'react'
import { Card, Toggle } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { minutesToHhmm } from '../../lib/calendar'
import { DAYS } from '../../lib/hours'

// Every half hour, 00:00 … 23:30.
const TIMES = Array.from({ length: 48 }, (_, i) => minutesToHhmm(i * 30))

export function hoursError(h, t) {
  for (const d of DAYS) if (h[d].open && h[d].start >= h[d].end) return t('hours.badDay', { day: t(`hours.day.${d}`) })
  if (!DAYS.some((d) => h[d].open)) return t('hours.noOpenDay')
  return null
}

// Open days and times. They set the calendar's hours and when bookings can be made.
export default function OpeningHours({ id, value, onChange, disabled, error }) {
  const { t, lang } = useT()
  const set = (d, k, v) => onChange({ ...value, [d]: { ...value[d], [k]: v } })
  const label = (x) => (lang === 'id' ? x.replace(':', '.') : x)
  const options = (cur) => (TIMES.includes(cur) ? TIMES : [...TIMES, cur].sort())
  const copyMon = () => onChange(Object.fromEntries(DAYS.map((d) => [d, ['tue', 'wed', 'thu', 'fri'].includes(d) ? { ...value.mon } : value[d]])))
  return (
    <Card title={t('settings.nav.hours')} id={id}>
      <div className="hint" style={{ marginTop: -6, marginBottom: 12 }}>{t('hours.hint')}</div>
      <div className="hours">
        {DAYS.map((d) => (
          <div key={d} className={`hours-row ${value[d].open ? '' : 'closed'}`}>
            <span className="hours-day">{t(`hours.day.${d}`)}</span>
            <Toggle checked={value[d].open} onChange={(v) => set(d, 'open', v)} disabled={disabled} label={value[d].open ? t('hours.open') : t('hours.closed')} />
            {value[d].open ? (
              <span className="row" style={{ gap: 6 }}>
                <select className="select" value={value[d].start} disabled={disabled} onChange={(e) => set(d, 'start', e.target.value)} aria-label={t('hours.opensOn', { day: t(`hours.day.${d}`) })}>
                  {options(value[d].start).map((x) => <option key={x} value={x}>{label(x)}</option>)}
                </select>
                <span className="muted">–</span>
                <select className="select" value={value[d].end} disabled={disabled} onChange={(e) => set(d, 'end', e.target.value)} aria-label={t('hours.closesOn', { day: t(`hours.day.${d}`) })}>
                  {[...options(value[d].end).filter((x) => x !== '00:00' && x !== '24:00'), '24:00'].map((x) => <option key={x} value={x}>{label(x)}</option>)}
                </select>
              </span>
            ) : <span className="muted small">{t('hours.closedAllDay')}</span>}
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {!disabled && <button type="button" className="linkbtn small" style={{ marginTop: 8 }} onClick={copyMon}>{t('hours.copyMon')}</button>}
    </Card>
  )
}
