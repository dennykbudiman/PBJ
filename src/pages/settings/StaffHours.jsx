import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, Empty, Input, Modal, Select, Toggle, useToast } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { fmtDateTime } from '../../lib/format'
import { DAYS, normHours } from '../../lib/hours'
import { hhmmToMinutes, minutesToHhmm, shopTimeToIso } from '../../lib/calendar'
import { shopToday } from '../../lib/customers'

// Staff app hours (migration 138, Nov 4, Denny): advisors, cashiers, technicians and viewers can use the app from
// 1 hour before opening to 1 hour after closing; Owner and Admin are never limited. Here the Owner or Admin switches
// it on or off, lets someone work overtime, and sees who tried to use the app outside the hours.
const LIMITED = ['Service advisor', 'Cashier', 'Technician', 'Viewer']

// "Mon–Sat 07:00–18:00 · Sun closed": the opening hours widened by one hour, days with the same window grouped.
export function staffWindowText(hours, t, lang) {
  const h = normHours(hours)
  const fmt = (m) => { const x = minutesToHhmm(Math.max(0, Math.min(m, 1440 - 1))); return lang === 'id' ? x.replace(':', '.') : x }
  const win = (d) => (h[d].open ? `${fmt(hhmmToMinutes(h[d].start) - 60)}–${h[d].end >= '23:00' ? (lang === 'id' ? '24.00' : '24:00') : fmt(hhmmToMinutes(h[d].end) + 60)}` : t('hours.closed'))
  const groups = []
  for (const d of DAYS) {
    const w = win(d)
    const last = groups[groups.length - 1]
    if (last && last.w === w) last.to = d
    else groups.push({ from: d, to: d, w })
  }
  return groups.map((g) => `${t(`hours.day.${g.from}`)}${g.to !== g.from ? `–${t(`hours.day.${g.to}`)}` : ''} ${g.w}`).join(' · ')
}

export default function StaffHours({ id }) {
  const { t, lang } = useT()
  const toast = useToast()
  const { settings, setSettings, timezone } = useShop()
  const { can } = useAuth()
  const canSettings = can('edit_settings')
  const [people, setPeople] = useState([])
  const [grants, setGrants] = useState([])
  const [log, setLog] = useState(null)
  const [form, setForm] = useState(null) // { user, date, time, note }
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const now = new Date().toISOString()
    const [p, g, l] = await Promise.all([
      supabase.from('profiles').select('id, name, status, roles(name)').order('name'),
      supabase.from('overtime_grants').select('id, user_id, until, note, granted_by, created_at').gt('until', now).order('until'),
      supabase.from('staff_access_log').select('id, user_id, at, ip').order('at', { ascending: false }).limit(50),
    ])
    setPeople(p.data || [])
    setGrants(g.data || [])
    setLog(l.data || [])
  }, [])
  useEffect(() => { load() }, [load])

  const nameOf = useMemo(() => Object.fromEntries(people.map((x) => [x.id, x.name])), [people])
  const limited = people.filter((x) => x.status === 'active' && LIMITED.includes(x.roles?.name))
  const on = Boolean(settings?.staff_hours_limit)

  async function toggle(v) {
    const { data, error } = await supabase.from('shop_settings').update({ staff_hours_limit: v }).eq('id', true).select().single()
    if (error) return toast(errorText(error, t), 'err')
    setSettings(data)
  }
  async function grant() {
    const mins = hhmmToMinutes(form.time)
    if (!form.user || mins == null || !form.date) return toast(t('hrs.pickPersonTime'), 'err')
    const until = shopTimeToIso(form.date, mins, timezone)
    if (new Date(until).getTime() <= Date.now()) return toast(t('hrs.pastTime'), 'err')
    setBusy(true)
    const { error } = await supabase.rpc('grant_overtime', { p_user: form.user, p_until: until, p_note: form.note || null })
    setBusy(false)
    if (error) return toast(errorText(error, t), 'err')
    toast(t('hrs.granted', { name: nameOf[form.user], until: fmtDateTime(until, lang, timezone) }))
    setForm(null)
    load()
  }
  async function end(g) {
    const { error } = await supabase.rpc('end_overtime', { p_user: g.user_id })
    if (error) return toast(errorText(error, t), 'err')
    toast(t('hrs.ended', { name: nameOf[g.user_id] }))
    load()
  }

  return (
    <Card id={id} title={t('hrs.title')}
      actions={on && limited.length > 0 && <Button size="sm" icon="clock" onClick={() => setForm({ user: '', date: shopToday(timezone), time: '21:00', note: '' })}>{t('hrs.allowOvertime')}</Button>}>
      <Toggle checked={on} onChange={toggle} disabled={!canSettings} label={t('hrs.limit')} />
      <div className="hint">{on ? t('hrs.limitOn', { window: staffWindowText(settings?.opening_hours, t, lang) }) : t('hrs.limitOff')}</div>

      {on && grants.length > 0 && (
        <>
          <div className="sectionlabel">{t('hrs.activeOvertime')}</div>
          {grants.map((g) => (
            <div key={g.id} className="row" style={{ gap: 8, padding: '4px 0' }}>
              <b>{nameOf[g.user_id] || '—'}</b>
              <span className="muted small">{t('hrs.until', { until: fmtDateTime(g.until, lang, timezone) })}{g.note ? ` · ${g.note}` : ''}{g.granted_by ? ` · ${t('hrs.by', { name: nameOf[g.granted_by] || '—' })}` : ''}</span>
              <div className="spacer" />
              <button type="button" className="linkbtn small" onClick={() => end(g)}>{t('hrs.end')}</button>
            </div>
          ))}
        </>
      )}

      <div className="sectionlabel">{t('hrs.logTitle')}</div>
      {log === null ? <div className="muted small">{t('common.loading')}</div> : log.length === 0 ? (
        <Empty icon="clock" title={t('hrs.logEmpty')} />
      ) : (
        <div className="table" style={{ maxHeight: 280, overflow: 'auto' }}>
          <table>
            <thead><tr><th>{t('users.person')}</th><th>{t('hrs.when')}</th><th className="wide-only">{t('hrs.network')}</th></tr></thead>
            <tbody>{log.map((x) => <tr key={x.id}><td>{nameOf[x.user_id] || '—'}</td><td>{fmtDateTime(x.at, lang, timezone)}</td><td className="wide-only muted">{x.ip || '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('hrs.logHint')}</div>

      <Modal open={!!form} onClose={() => setForm(null)} title={t('hrs.allowOvertime')}
        footer={<><Button onClick={() => setForm(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={grant}>{t('hrs.allow')}</Button></>}>
        {form && (
          <div className="grid2">
            <Select fieldClass="span2" label={t('users.person')} value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })}
              options={[{ value: '', label: t('hrs.pickPerson'), disabled: true }, ...limited.map((x) => ({ value: x.id, label: `${x.name} · ${t(`role.${x.roles?.name}`)}` }))]} />
            <Input label={t('hrs.untilDate')} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <Input label={t('hrs.untilTime')} type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
            <Input fieldClass="span2" label={t('hrs.note')} value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('hrs.notePlaceholder')} />
            <div className="hint span2">{t('hrs.overtimeHint')}</div>
          </div>
        )}
      </Modal>
    </Card>
  )
}
