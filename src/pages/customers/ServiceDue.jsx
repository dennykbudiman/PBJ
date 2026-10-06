import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Empty, Notice, PageHead } from '../../components/ui'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, km, num } from '../../lib/format'
import { shopToday, vehicleName } from '../../lib/customers'
import { SCHEDULE_COLOR, SCHEDULE_ORDER, intervalText, leftText, scheduleStatus } from '../../lib/schedules'
import { shopParts } from '../../lib/calendar'

// Lower = sooner: km left counts as is, a day as about 50 km of driving.
const urgency = (st) => (st.kmLeft != null ? st.kmLeft : st.daysLeft != null ? st.daysLeft * 50 : 0)
import { selectAll } from './useCustomerData'
import AppointmentModal from '../calendar/AppointmentModal'

// Customers → Service due: every vehicle's schedules that are overdue or coming up, most urgent first,
// with the fleet contact to call and a way to book or start the job.
export default function ServiceDueList() {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { settings, timezone } = useShop()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [show, setShow] = useState('due')
  const [q, setQ] = useState('')
  const [booking, setBooking] = useState(null)
  const [n, setN] = useState(0) // bump to reload
  const today = shopToday(timezone)
  const canJob = can('edit_jobs')

  useEffect(() => {
    Promise.all([
      selectAll(() => supabase.from('service_schedules').select('*').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, customer_id, plate, make, model, year, status, mileage_km').order('id')),
      selectAll(() => supabase.from('customers').select('id, display_name, phone').order('id')),
      selectAll(() => supabase.from('customer_contacts').select('id, customer_id, name, phone, is_primary').order('is_primary', { ascending: false }).order('id')),
      // A schedule already booked shows the booking instead of a "Book" button.
      selectAll(() => supabase.from('appointments').select('id, vehicle_id, start_time, status').gt('end_time', new Date().toISOString()).order('start_time').order('id')),
    ]).then(([s, v, c, ct, a]) => {
      const contact = {}
      for (const x of ct.data || []) if (!contact[x.customer_id]) contact[x.customer_id] = x
      const booked = {}
      for (const x of a.data || []) if (!booked[x.vehicle_id] && ['requested', 'scheduled', 'confirmed'].includes(x.status)) booked[x.vehicle_id] = x
      setData({
        schedules: s.data || [],
        vehicle: Object.fromEntries((v.data || []).map((x) => [x.id, x])),
        customer: Object.fromEntries((c.data || []).map((x) => [x.id, x])),
        contact, booked,
      })
      setError(s.error || v.error || c.error || ct.error || a.error || null)
    })
  }, [n])

  const rows = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    return data.schedules.map((s) => {
      const v = data.vehicle[s.vehicle_id]
      return { s, v, c: v && data.customer[v.customer_id], st: scheduleStatus(s, v?.mileage_km, settings, today) }
    }).filter(({ s, v, c, st }) => {
      if (!v || v.status === 'sold' || v.status === 'inactive') return false
      if (show === 'due' && st.status !== 'overdue' && st.status !== 'due_soon') return false
      if (show === 'overdue' && st.status !== 'overdue') return false
      if (show === 'never' && st.status !== 'never') return false
      if (show === 'all' && st.status === 'off') return false
      if (!needle) return true
      return [s.name, v.plate, v.plate?.replace(/\s/g, ''), vehicleName(v), c?.display_name].filter(Boolean).join(' ').toLowerCase().includes(needle)
    }).sort((a, b) => SCHEDULE_ORDER[a.st.status] - SCHEDULE_ORDER[b.st.status] || urgency(a.st) - urgency(b.st) || a.s.name.localeCompare(b.s.name))
  }, [data, show, q, settings, today])

  const counts = useMemo(() => {
    const out = { overdue: 0, due_soon: 0 }
    for (const s of data?.schedules || []) {
      const v = data.vehicle[s.vehicle_id]
      if (!v || v.status === 'sold' || v.status === 'inactive') continue
      const st = scheduleStatus(s, v.mileage_km, settings, today).status
      if (st in out) out[st]++
    }
    return out
  }, [data, settings, today])

  return (
    <>
      <PageHead title={t('cust.area.service-due')} sub={t('sch.dueSub', { km: num(settings?.due_soon_km ?? 1000), days: settings?.due_soon_days ?? 14 })} />
      {data && (
        <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
          <Badge color="red">{t('sch.countOverdue', { n: counts.overdue })}</Badge>
          <Badge color="amber">{t('sch.countSoon', { n: counts.due_soon })}</Badge>
        </div>
      )}
      <div className="filterbar">
        <div className="searchbox">
          <Icon name="search" size={14} color="var(--muted)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sch.search')} aria-label={t('sch.search')} />
        </div>
        <select className="select chipselect" value={show} onChange={(e) => setShow(e.target.value)} aria-label={t('cat.status')}>
          <option value="due">{t('sch.f.due')}</option>
          <option value="overdue">{t('sch.st.overdue')}</option>
          <option value="never">{t('sch.st.never')}</option>
          <option value="all">{t('sch.f.all')}</option>
        </select>
      </div>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!data ? <div className="muted">{t('common.loading')}</div> : rows.length === 0 ? (
        <div className="card"><Empty icon="clock" title={data.schedules.length ? t('sch.nothingDue') : t('sch.noSchedules')}>{data.schedules.length ? t('sch.nothingDueText') : t('sch.noSchedulesText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr>
              <th>{t('sch.col.status')}</th><th>{t('job.vehicle')}</th><th>{t('job.company')}</th><th>{t('sch.col.service')}</th>
              <th>{t('sch.nextDue')}</th><th className="wide-only">{t('sch.lastDone')}</th><th className="wide-only">{t('sch.col.contact')}</th><th aria-label={t('def.actions')} />
            </tr></thead>
            <tbody>
              {rows.map(({ s, v, c, st }) => {
                const ct = data.contact[v.customer_id]
                const booked = data.booked[v.id]
                return (
                  <tr key={s.id}>
                    <td><Badge color={SCHEDULE_COLOR[st.status]}>{t(`sch.st.${st.status}`)}</Badge><div className={`small ${st.status === 'overdue' ? 'text-red' : 'muted'}`}>{leftText(st, t, num)}</div></td>
                    <td><Link className="rowlink" to={`/customers/vehicles/${v.id}`}>{v.plate}</Link><div className="muted small">{vehicleName(v)}{v.mileage_km != null ? ` · ${km(v.mileage_km)}` : ''}</div></td>
                    <td>{c?.display_name || '—'}</td>
                    <td><b>{s.name}</b><div className="muted small">{intervalText(s, t, num)}</div></td>
                    <td className="nowrap">{[st.km != null ? km(st.km) : null, st.date ? fmtDate(st.date, lang) : null].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="wide-only muted small">{[s.last_done_km != null ? km(s.last_done_km) : null, s.last_done_date ? fmtDate(s.last_done_date, lang) : null].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="wide-only small">{ct ? <>{ct.name}{ct.phone && <div className="muted">{ct.phone}</div>}</> : c?.phone || <span className="muted">—</span>}</td>
                    <td className="num">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {booked ? <Link className="small" to={`/calendar?v=day&d=${shopParts(booked.start_time, timezone).date}`}>{t('sch.booked', { when: fmtDate(booked.start_time, lang, timezone) })}</Link>
                          : canJob && <Button size="sm" onClick={() => setBooking({ s, v })}>{t('board.book')}</Button>}
                        {canJob && <Button size="sm" variant="primary" onClick={() => navigate(`/jobs/new?vehicle=${v.id}&schedule=${s.id}`)}>{t('sch.startJob')}</Button>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <AppointmentModal open={!!booking} onClose={() => setBooking(null)}
        defaults={booking ? { customer_id: booking.v.customer_id, vehicle_id: booking.v.id, title: booking.s.name } : null}
        onSaved={() => { setBooking(null); setN((x) => x + 1) }} />
    </>
  )
}
