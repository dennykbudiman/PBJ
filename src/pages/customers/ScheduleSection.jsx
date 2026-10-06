import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Input, Modal, Notice, Select, Toggle, useConfirm, useToast } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, fmtDateTime, km, num, readAmount } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { SCHEDULE_COLOR, SCHEDULE_ORDER, intervalText, leftText, nextDue, scheduleStatus } from '../../lib/schedules'
import { MoreMenu } from '../jobs/common'
import AppointmentModal from '../calendar/AppointmentModal'

// A vehicle's service schedules, on its panel: what's due, and add / edit / book / start a job.
export default function ScheduleSection({ vehicle }) {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const toast = useToast()
  const { can } = useAuth()
  const { settings, timezone } = useShop()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(undefined) // undefined closed · null new · row edit
  const [booking, setBooking] = useState(null)
  const [history, setHistory] = useState(null) // { id, rows }
  const [confirm, confirmEl] = useConfirm()
  const canEdit = can('edit_customers')
  const canJob = can('edit_jobs')
  const today = shopToday(timezone)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from('service_schedules').select('*').eq('vehicle_id', vehicle.id).order('name').order('id')
    setRows(data || [])
    setError(err || null)
  }, [vehicle.id])
  useEffect(() => { setRows(null); setHistory(null); load() }, [load])

  const list = (rows || []).map((s) => ({ s, st: scheduleStatus(s, vehicle.mileage_km, settings, today) }))
    .sort((a, b) => SCHEDULE_ORDER[a.st.status] - SCHEDULE_ORDER[b.st.status] || a.s.name.localeCompare(b.s.name))

  async function toggle(s) {
    const { error: err } = await supabase.from('service_schedules').update({ active: !s.active }).eq('id', s.id)
    if (err) toast(err.code === '23505' ? t('sch.dupBundle') : errorText(err, t), 'err')
    else toast(s.active ? t('sch.switchedOff', { name: s.name }) : t('sch.switchedOn', { name: s.name }))
    load()
  }
  async function remove(s) {
    if (await confirm({ title: t('sch.deleteTitle', { name: s.name }), text: t('sch.deleteText'), yes: t('sch.deleteYes'), danger: true }) !== true) return
    const { error: err } = await supabase.from('service_schedules').delete().eq('id', s.id)
    if (err) toast(errorText(err, t), 'err')
    else toast(t('sch.deleted', { name: s.name }))
    load()
  }
  async function showHistory(s) {
    const [log, people] = await Promise.all([
      supabase.from('activity_log').select('*').eq('entity_type', 'service_schedules').eq('entity_id', s.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('profiles').select('id, name'),
    ])
    const who = Object.fromEntries((people.data || []).map((p) => [p.id, p.name]))
    setHistory({ id: s.id, rows: (log.data || []).map((r) => ({ ...r, who: who[r.user_id] })) })
  }

  const histValue = (k, v) => {
    if (v == null || v === '') return '—'
    if (k === 'last_done_km' || k === 'interval_km') return km(v)
    if (k === 'last_done_date') return fmtDate(v, lang)
    if (k === 'active') return v ? t('sch.on') : t('sch.off')
    if (k === 'interval_months') return t('sch.months', { n: v })
    return String(v)
  }

  return (
    <div className="schedules">
      <div className="row" style={{ marginTop: 14 }}>
        <div className="sectionlabel" style={{ margin: 0 }}>{t('veh.schedule')}</div>
        <div className="spacer" />
        {canEdit && <Button size="sm" icon="plus" onClick={() => setForm(null)}>{t('sch.add')}</Button>}
      </div>
      {error && <div className="error">{errorText(error, t)}</div>}
      {!rows ? <div className="muted small" style={{ padding: '8px 0' }}>{t('common.loading')}</div>
        : list.length === 0 ? <div className="muted small" style={{ padding: '6px 0' }}>{t('sch.none')}</div> : (
          <div className="schlist">
            {list.map(({ s, st }) => (
              <div key={s.id} className={`schrow s-${st.status}`}>
                <div className="schrow-main">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <b>{s.name}</b>
                    <Badge color={SCHEDULE_COLOR[st.status]}>{t(`sch.st.${st.status}`)}</Badge>
                  </div>
                  <div className="muted small">{intervalText(s, t, num)}</div>
                  <div className="small">
                    {st.status !== 'never' && st.status !== 'off' && (
                      <span>{t('sch.nextDue')}: <b>{[st.km != null ? km(st.km) : null, st.date ? fmtDate(st.date, lang) : null].filter(Boolean).join(t('sch.or'))}</b> · </span>
                    )}
                    <span className={st.status === 'overdue' ? 'text-red' : ''}>{leftText(st, t, num)}</span>
                  </div>
                  <div className="muted small">{t('sch.lastDone')}: {s.last_done_km != null || s.last_done_date ? [s.last_done_km != null ? km(s.last_done_km) : null, s.last_done_date ? fmtDate(s.last_done_date, lang) : null].filter(Boolean).join(' · ') : '—'}</div>
                  {history?.id === s.id && (
                    <ol className="hist" style={{ marginTop: 8 }}>
                      {history.rows.length === 0 && <li><div className="hist-body muted">{t('cat.hist.none')}</div></li>}
                      {history.rows.map((r) => (
                        <li key={r.id}>
                          <div className="hist-meta">{r.who || t('cat.hist.system')} · {fmtDateTime(r.created_at, lang, timezone)}</div>
                          <div className="hist-body">{r.action === 'create' ? t('sch.histCreated') : Object.entries(r.changes || {}).filter(([k]) => !['updated_at', 'next_due_km', 'next_due_date'].includes(k)).map(([k, [a, b]]) => (
                            <div key={k} className="hist-change"><span className="muted">{t(`sch.f.${k}`)}:</span> {histValue(k, a)} → <b>{histValue(k, b)}</b></div>
                          ))}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div className="row" style={{ gap: 6, alignSelf: 'flex-start' }}>
                  {canJob && s.active && vehicle.status !== 'sold' && (st.status === 'overdue' || st.status === 'due_soon') && (
                    <Button size="sm" onClick={() => setBooking(s)}>{t('board.book')}</Button>
                  )}
                  <MoreMenu label={t('sch.menu', { name: s.name })} items={[
                    canJob && s.active && vehicle.status !== 'sold' && { label: t('board.book'), icon: 'calendar', onClick: () => setBooking(s) },
                    canJob && s.active && vehicle.status !== 'sold' && { label: t('sch.startJob'), icon: 'wrench', onClick: () => navigate(`/jobs/new?vehicle=${vehicle.id}&schedule=${s.id}`) },
                    canEdit && { label: t('common.edit'), icon: 'edit', onClick: () => setForm(s) },
                    canEdit && { label: s.active ? t('sch.switchOff') : t('sch.switchOn'), icon: 'clock', onClick: () => toggle(s) },
                    { label: history?.id === s.id ? t('cat.hist.hide') : t('cat.hist.show'), icon: 'clock', onClick: () => (history?.id === s.id ? setHistory(null) : showHistory(s)) },
                    canEdit && { label: t('sch.delete'), icon: 'trash', danger: true, onClick: () => remove(s) },
                  ]} />
                </div>
              </div>
            ))}
          </div>
        )}
      <ScheduleForm open={form !== undefined} schedule={form} vehicle={vehicle} onClose={() => setForm(undefined)} onSaved={() => { setForm(undefined); load() }} />
      <AppointmentModal open={!!booking} onClose={() => setBooking(null)}
        defaults={booking ? { customer_id: vehicle.customer_id, vehicle_id: vehicle.id, title: booking.name } : null}
        onSaved={() => setBooking(null)} />
      {confirmEl}
    </div>
  )
}

const EMPTY = { template_id: '', name: '', interval_km: '', interval_months: '', last_done_km: '', last_done_date: '', active: true }

// Add or edit one schedule. Picking a service bundle fills in its name and suggested interval.
export function ScheduleForm({ open, schedule, vehicle, onClose, onSaved }) {
  const { t, lang } = useT()
  const toast = useToast()
  const { timezone } = useShop()
  const [f, setF] = useState(EMPTY)
  const [templates, setTemplates] = useState([])
  const [errors, setErrors] = useState({})
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const editing = Boolean(schedule)

  useEffect(() => {
    if (!open) return
    setErrors({}); setMsg(null)
    setF(schedule ? {
      template_id: schedule.template_id || '', name: schedule.name,
      interval_km: schedule.interval_km != null ? num(schedule.interval_km) : '', interval_months: schedule.interval_months != null ? String(schedule.interval_months) : '',
      last_done_km: schedule.last_done_km != null ? num(schedule.last_done_km) : '', last_done_date: schedule.last_done_date || '', active: schedule.active,
    } : { ...EMPTY, last_done_km: vehicle.mileage_km != null ? num(vehicle.mileage_km) : '' })
    supabase.from('service_templates').select('id, name, default_interval_km, default_interval_months, active').order('name').then(({ data }) => setTemplates(data || []))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  function pickTemplate(e) {
    const tp = templates.find((x) => x.id === e.target.value)
    setF((x) => ({
      ...x, template_id: e.target.value,
      name: tp && (!x.name.trim() || templates.some((o) => o.name === x.name)) ? tp.name : x.name,
      interval_km: tp && tp.default_interval_km != null ? num(tp.default_interval_km) : x.interval_km,
      interval_months: tp && tp.default_interval_months != null ? String(tp.default_interval_months) : x.interval_months,
    }))
  }

  const ikm = readAmount(f.interval_km)
  const imo = f.interval_months.trim() === '' ? null : Number(f.interval_months)
  const lkm = readAmount(f.last_done_km)
  const preview = nextDue({ interval_km: Number.isNaN(ikm) ? null : ikm, interval_months: Number.isInteger(imo) ? imo : null, last_done_km: Number.isNaN(lkm) ? null : lkm, last_done_date: f.last_done_date || null })

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    else if (f.name.trim().length > 120) e.name = t('sch.nameLong')
    if (Number.isNaN(ikm) || (ikm != null && (ikm < 100 || ikm > 1000000))) e.interval_km = t('sch.kmRule')
    if (imo != null && (!Number.isInteger(imo) || imo < 1 || imo > 120)) e.interval_months = t('sch.monthsRule')
    if (!e.interval_km && !e.interval_months && ikm == null && imo == null) e.interval_km = t('sch.needInterval')
    if (Number.isNaN(lkm) || (lkm != null && lkm > 9999999)) e.last_done_km = t('veh.kmRule')
    if (f.last_done_date && f.last_done_date > shopToday(timezone)) e.last_done_date = t('sch.noFuture')
    setErrors(e)
    if (Object.keys(e).length) return
    const row = {
      template_id: f.template_id || null, name: f.name.trim(), interval_km: ikm, interval_months: imo,
      last_done_km: lkm, last_done_date: f.last_done_date || null, active: f.active,
    }
    setBusy(true); setMsg(null)
    const res = editing
      ? await supabase.from('service_schedules').update(row).eq('id', schedule.id)
      : await supabase.from('service_schedules').insert({ ...row, vehicle_id: vehicle.id })
    setBusy(false)
    if (res.error) return setMsg(res.error.code === '23505' ? t('sch.dupBundle') : errorText(res.error, t))
    toast(editing ? t('sch.saved') : t('sch.added', { name: row.name }))
    onSaved()
  }

  return (
    <Modal open={open} title={editing ? t('sch.editTitle', { plate: vehicle.plate }) : t('sch.newTitle', { plate: vehicle.plate })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? t('common.save') : t('sch.add')}</Button></>}>
      {msg && <Notice kind="err" style={{ marginBottom: 12 }}>{msg}</Notice>}
      <div className="grid2">
        <Select fieldClass="span2" label={t('sch.bundle')} value={f.template_id} onChange={pickTemplate} hint={t('sch.bundleHint')}
          options={[{ value: '', label: t('sch.noBundle') }, ...templates.filter((x) => x.active || x.id === f.template_id).map((x) => ({ value: x.id, label: x.name }))]} />
        <Input fieldClass="span2" label={t('sch.name')} value={f.name} onChange={set('name')} error={errors.name} maxLength={120} placeholder={t('sch.nameHint')} />
        <Input label={t('sch.everyKm')} value={f.interval_km} onChange={set('interval_km')} inputMode="numeric" suffix="km" error={errors.interval_km} placeholder="10.000" />
        <Input label={t('sch.everyMonths')} value={f.interval_months} onChange={set('interval_months')} inputMode="numeric" error={errors.interval_months} placeholder="6" />
        <Input label={t('sch.lastDoneKm')} value={f.last_done_km} onChange={set('last_done_km')} inputMode="numeric" suffix="km" error={errors.last_done_km} />
        <Input type="date" label={t('sch.lastDoneDate')} value={f.last_done_date} onChange={set('last_done_date')} max={shopToday(timezone)} error={errors.last_done_date} />
      </div>
      <div className="hint">{preview.km != null || preview.date ? t('sch.preview', { when: [preview.km != null ? km(preview.km) : null, preview.date ? fmtDate(preview.date, lang) : null].filter(Boolean).join(t('sch.or')) }) : t('sch.previewNone')}</div>
      {editing && <div style={{ marginTop: 10 }}><Toggle checked={f.active} onChange={set('active')} label={f.active ? t('sch.activeOn') : t('sch.activeOff')} /></div>}
    </Modal>
  )
}
