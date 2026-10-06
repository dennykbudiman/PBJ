import React from 'react'
import { Badge, Button, Notice } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { num } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { SCHEDULE_COLOR, leftText, scheduleStatus } from '../../lib/schedules'
import { addBundleService } from './ServicesTab'

// The vehicle's service schedules that are due, which aren't on this job yet.
export function dueForJob(job, settings, today) {
  // Declined or deferred on this job doesn't count: it is still due, so it stays listed.
  const onJob = new Set(job.services.filter((s) => s.approval_status !== 'declined' && s.approval_status !== 'deferred').map((s) => s.service_schedule_id).filter(Boolean))
  return (job.schedules || []).filter((x) => x.active && !onJob.has(x.id))
    .map((x) => ({ x, st: scheduleStatus(x, job.vehicle?.mileage_km, settings, today) }))
    .filter(({ st }) => st.status === 'overdue' || st.status === 'due_soon')
}

// On an open estimate: "Due for this vehicle: Oil service (overdue by 1.200 km) [Add to job]".
export default function DueBanner({ job, cat, editable, run, busy }) {
  const { t } = useT()
  const { settings, timezone } = useShop()
  if (!editable) return null
  const due = dueForJob(job, settings, shopToday(timezone))
  if (!due.length) return null
  const add = (x) => {
    const tp = x.template_id ? cat.templates.find((tt) => tt.id === x.template_id) : null
    return run(() => addBundleService({ job, cat, tp, name: x.name, scheduleId: x.id }), t('job.serviceAdded', { name: tp ? tp.name : x.name }))
  }
  return (
    <Notice kind="warn" style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('sch.dueOnJob', { n: due.length })}</div>
      {due.map(({ x, st }) => (
        <div key={x.id} className="row wrap" style={{ gap: 8, padding: '3px 0' }}>
          <Badge color={SCHEDULE_COLOR[st.status]}>{t(`sch.st.${st.status}`)}</Badge>
          <b>{x.name}</b>
          <span className="small">{leftText(st, t, num)}</span>
          <div className="spacer" />
          <Button size="sm" loading={busy} onClick={() => add(x)}>{t('sch.addToJob')}</Button>
        </div>
      ))}
    </Notice>
  )
}
