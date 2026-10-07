import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, PageHead } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { fmtDate, jobNo, km, num } from '../../lib/format'
import { vehicleName } from '../../lib/customers'
import { daysBetween } from '../../lib/calendar'
import { downloadCsv, groupBy } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, companiesOf, pct, useCompany, useOpenRows, usePeriod, useReport } from './ReportsArea'

const VIEWS = ['company', 'attention', 'done', 'none']
const STATUS_COLOR = { overdue: 'red', due_soon: 'amber', ok: 'green' }

// Reports → Service compliance: are service schedules kept up, today and in the period.
export default function ServiceReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_year')
  const [view, setView] = useState('company')
  const [open, toggle] = useOpenRows()
  const status = useReport('report_service_status', {}, [])
  const done = useReport('report_service_done', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const [company, setCompany] = useCompany(status.rows)
  const pick = (rs) => (rs || []).filter((r) => !company || r.customer_id === company)
  const all = pick(status.rows)
  const schedules = all.filter((r) => r.schedule_id)
  const unscheduled = all.filter((r) => !r.schedule_id)
  const doneList = pick(done.rows)
  const count = (s) => schedules.filter((r) => r.status === s).length
  const k = { overdue: count('overdue'), soon: count('due_soon'), late: doneList.filter((r) => r.on_time === false).length, onTime: doneList.filter((r) => r.on_time === true).length }
  const today = period.today

  const companies = useMemo(() => [...groupBy(all, (r) => r.customer_id || '').entries()].map(([id, rs]) => {
    const sc = rs.filter((r) => r.schedule_id)
    return {
      id, name: rs[0].company || '—', rows: sc, vehicles: new Set(rs.map((r) => r.vehicle_id)).size, none: rs.filter((r) => !r.schedule_id).length,
      ok: sc.filter((r) => r.status === 'ok').length, soon: sc.filter((r) => r.status === 'due_soon').length, overdue: sc.filter((r) => r.status === 'overdue').length,
    }
  }).sort((a, b) => b.overdue - a.overdue || b.soon - a.soon || a.name.localeCompare(b.name)), [all])
  const attention = schedules.filter((r) => r.status !== 'ok')
    .sort((a, b) => (a.status === 'overdue' ? 0 : 1) - (b.status === 'overdue' ? 0 : 1) || (b.days_over || 0) - (a.days_over || 0) || (b.km_over || 0) - (a.km_over || 0))

  const dueText = (r) => [r.next_due_km != null && km(r.next_due_km), r.next_due_date && fmtDate(r.next_due_date, lang)].filter(Boolean).join(' · ') || '—'
  const overText = (r) => {
    if (r.status === 'overdue') return [r.km_over != null && t('rep.svc.kmOver', { n: num(r.km_over) }), r.days_over != null && t('rep.svc.daysOver', { n: num(r.days_over) })].filter(Boolean).join(' · ')
    return [r.next_due_km != null && r.mileage_km != null && t('rep.svc.inKm', { n: num(r.next_due_km - r.mileage_km) }),
      r.next_due_date && t('rep.svc.inDays', { n: num(daysBetween(today, r.next_due_date)) })].filter(Boolean).join(' · ')
  }
  const result = (r) => {
    if (r.on_time === true) return <Badge color="green">{t('rep.svc.onTime')}</Badge>
    if (r.on_time === false) return <><Badge color="red">{t('rep.svc.late')}</Badge> <span className="muted small">{[r.km_late != null && t('rep.svc.kmLate', { n: num(r.km_late) }), r.days_late != null && t('rep.svc.daysLate', { n: num(r.days_late) })].filter(Boolean).join(' · ')}</span></>
    if (r.due_km == null && r.due_date == null) return <Badge>{t('rep.svc.first')}</Badge>
    return <Badge>{t('rep.svc.unknown')}</Badge>
  }
  const vehicleCell = (r) => (
    <td><Link className="rowlink" to={`/customers/vehicles/${r.vehicle_id}`}>{r.plate || '—'}</Link><div className="muted small">{[vehicleName(r), !company && r.company].filter(Boolean).join(' · ')}</div></td>
  )

  function csv() {
    if (view === 'done') {
      downloadCsv(`axle-service-done-${period.from}-${period.to}.csv`,
        [t('rep.col.date'), t('rep.col.company'), t('rep.col.plate'), t('rep.svc.schedule'), t('rep.col.job'), `${t('rep.svc.dueAt')} km`, t('rep.svc.dueAt'), `${t('rep.svc.doneAt')} km`, t('rep.svc.result'), t('rep.svc.kmLateCol'), t('rep.svc.daysLateCol')],
        doneList.map((r) => [r.done_date, r.company, r.plate, r.name, jobNo(r.job_number), r.due_km, r.due_date, r.done_km,
          r.on_time === true ? t('rep.svc.onTime') : r.on_time === false ? t('rep.svc.late') : r.due_km == null && r.due_date == null ? t('rep.svc.first') : t('rep.svc.unknown'), r.km_late, r.days_late]))
      return
    }
    downloadCsv(`axle-service-status-${today}.csv`,
      [t('rep.col.company'), t('rep.col.plate'), t('rep.g.vehicle'), t('rep.svc.schedule'), t('rep.svc.status'), `${t('rep.svc.dueAt')} km`, t('rep.svc.dueAt'), t('rep.col.km'), `${t('rep.svc.over')} km`, `${t('rep.svc.over')} (${t('common.days')})`],
      all.map((r) => [r.company, r.plate, vehicleName(r), r.name || t('rep.svc.noSchedule'), r.schedule_id ? t({ ok: 'rep.svc.ok', due_soon: 'rep.svc.dueSoon', overdue: 'rep.svc.overdue' }[r.status]) : '—',
        r.next_due_km, r.next_due_date, r.mileage_km, r.km_over, r.days_over]))
  }

  const loading = status.loading || (view === 'done' && done.loading)
  const firstLoad = (status.rows === null && !status.error) || (view === 'done' && done.rows === null && !done.error)
  const empty = {
    company: !schedules.length && !unscheduled.length, attention: !attention.length, done: !doneList.length, none: !unscheduled.length,
  }[view]

  return (
    <>
      <PageHead title={t('rep.svc.title')} sub={t('rep.svc.sub')} />
      <ReportBar period={period} companies={companiesOf([...(status.rows || [])])} company={company} setCompany={setCompany} onCsv={csv}
        csvDisabled={loading || (view === 'done' ? !doneList.length : !all.length)}>
        <select className="select chipselect" value={view} onChange={(e) => setView(e.target.value)} aria-label={t('rep.inv.view')}>
          {VIEWS.map((v) => <option key={v} value={v}>{t(`rep.svc.v.${v}`)}</option>)}
        </select>
      </ReportBar>
      {view !== 'done' && <div className="hint" style={{ marginTop: -6, marginBottom: 10 }}>{t('rep.svc.periodNote')}</div>}
      <ReportError error={status.error || done.error} />
      <div className={`kpis four ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('rep.svc.compliance')} value={pct(schedules.length - k.overdue, schedules.length)} tone={k.overdue ? 'red' : undefined}
          note={t('rep.svc.complianceNote', { n: schedules.length })} />
        <Kpi label={t('rep.svc.overdue')} value={num(k.overdue)} tone={k.overdue ? 'red' : undefined} note={`${t('rep.svc.dueSoon')}: ${num(k.soon)}`} />
        <Kpi label={t('rep.svc.noSchedule')} value={num(unscheduled.length)} note={t('rep.svc.noScheduleNote')} />
        <Kpi label={t('rep.svc.doneTitle')} value={num(doneList.length)} note={t('rep.svc.doneNote', { late: k.late, onTime: k.onTime })} />
      </div>
      {status.error || (view === 'done' && done.error) ? null : firstLoad ? <div className="muted">{t('common.loading')}</div> : empty ? (
        <div className="card"><Empty icon="calendar" title={t({ company: 'rep.svc.emptySchedulesTitle', attention: 'rep.svc.allGood', done: 'rep.empty', none: 'rep.svc.emptyNoneTitle' }[view])}>
          {t({ company: 'rep.svc.emptySchedules', attention: 'rep.svc.emptyAttention', done: 'rep.svc.emptyDone', none: 'rep.svc.emptyNone' }[view])}
        </Empty></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            {view === 'company' && (
              <>
                <thead><tr>
                  <th>{t('rep.col.company')}</th><th className="num">{t('rep.svc.vehicles')}</th><th className="num">{t('rep.svc.schedules')}</th>
                  <th className="num">{t('rep.svc.ok')}</th><th className="num">{t('rep.svc.dueSoon')}</th><th className="num">{t('rep.svc.overdue')}</th>
                  <th className="num">{t('rep.svc.compliance')}</th><th className="num wide-only">{t('rep.svc.noScheduleCol')}</th>
                </tr></thead>
                <tbody>
                  {companies.map((c) => (
                    <React.Fragment key={c.id || 'none'}>
                      <tr className="clickrow" onClick={() => toggle(c.id)}>
                        <td>
                          <button type="button" className="linkbtn plainlink row" style={{ gap: 4 }} aria-expanded={open.has(c.id)} aria-label={t('rep.svc.showCompany', { name: c.name })}>
                            <Icon name={open.has(c.id) ? 'chevronDown' : 'chevronRight'} size={13} /><b>{c.name}</b>
                          </button>
                        </td>
                        <td className="num">{num(c.vehicles)}</td><td className="num">{num(c.rows.length)}</td>
                        <td className="num">{num(c.ok)}</td>
                        <td className="num" style={c.soon ? { color: 'var(--amber-ink, #9a6700)', fontWeight: 700 } : undefined}>{num(c.soon)}</td>
                        <td className="num" style={c.overdue ? { color: 'var(--red)', fontWeight: 700 } : undefined}>{num(c.overdue)}</td>
                        <td className="num"><b>{pct(c.rows.length - c.overdue, c.rows.length)}</b></td>
                        <td className="num wide-only">{c.none ? num(c.none) : <span className="muted">–</span>}</td>
                      </tr>
                      {open.has(c.id) && (c.rows.filter((r) => r.status !== 'ok').length === 0
                        ? <tr className="subrow"><td className="ind muted" colSpan={8}>{t('rep.svc.allGood')}</td></tr>
                        : c.rows.filter((r) => r.status !== 'ok').map((r) => (
                          <tr key={r.schedule_id} className="subrow">
                            <td className="ind"><Link to={`/customers/vehicles/${r.vehicle_id}`}>{r.plate}</Link><span className="muted"> · {r.name}</span></td>
                            <td colSpan={5}><Badge color={STATUS_COLOR[r.status]}>{t(r.status === 'overdue' ? 'rep.svc.overdue' : 'rep.svc.dueSoon')}</Badge> <span className="muted">{t('rep.svc.dueAt')} {dueText(r)} · {overText(r)}</span></td>
                            <td /><td className="wide-only" />
                          </tr>
                        )))}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot><tr>
                  <td><b>{t('rep.total')}</b></td><td className="num"><b>{num(new Set(all.map((r) => r.vehicle_id)).size)}</b></td><td className="num"><b>{num(schedules.length)}</b></td>
                  <td className="num"><b>{num(count('ok'))}</b></td><td className="num"><b>{num(k.soon)}</b></td><td className="num"><b>{num(k.overdue)}</b></td>
                  <td className="num"><b>{pct(schedules.length - k.overdue, schedules.length)}</b></td><td className="num wide-only"><b>{num(unscheduled.length)}</b></td>
                </tr></tfoot>
              </>
            )}
            {view === 'attention' && (
              <>
                <thead><tr><th>{t('rep.g.vehicle')}</th><th>{t('rep.svc.schedule')}</th><th>{t('rep.svc.status')}</th><th>{t('rep.svc.dueAt')}</th><th>{t('rep.col.km')}</th><th>{t('rep.svc.over')}</th></tr></thead>
                <tbody>
                  {attention.map((r) => (
                    <tr key={r.schedule_id}>
                      {vehicleCell(r)}
                      <td>{r.name}</td>
                      <td><Badge color={STATUS_COLOR[r.status]}>{t(r.status === 'overdue' ? 'rep.svc.overdue' : 'rep.svc.dueSoon')}</Badge></td>
                      <td className="nowrap">{dueText(r)}</td><td className="nowrap">{km(r.mileage_km)}</td><td>{overText(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {view === 'done' && (
              <>
                <thead><tr><th>{t('rep.col.date')}</th><th>{t('rep.g.vehicle')}</th><th>{t('rep.svc.schedule')}</th><th>{t('rep.svc.dueAt')}</th><th>{t('rep.svc.doneAt')}</th><th>{t('rep.svc.result')}</th></tr></thead>
                <tbody>
                  {doneList.map((r) => (
                    <tr key={r.ro_service_id}>
                      <td className="nowrap">{fmtDate(r.done_date, lang)}<div className="small"><Link to={`/jobs/${r.ro_id}`}>{t('rep.jobNo', { no: jobNo(r.job_number) })}</Link></div></td>
                      {vehicleCell(r)}
                      <td>{r.name}</td>
                      <td className="nowrap">{[r.due_km != null && km(r.due_km), r.due_date && fmtDate(r.due_date, lang)].filter(Boolean).join(' · ') || <span className="muted">—</span>}</td>
                      <td className="nowrap">{r.done_km != null ? km(r.done_km) : <span className="muted">—</span>}</td>
                      <td>{result(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {view === 'none' && (
              <>
                <thead><tr><th>{t('rep.g.vehicle')}</th><th>{t('rep.col.company')}</th><th>{t('rep.col.km')}</th></tr></thead>
                <tbody>
                  {unscheduled.map((r) => (
                    <tr key={r.vehicle_id}>
                      <td><Link className="rowlink" to={`/customers/vehicles/${r.vehicle_id}`}>{r.plate || '—'}</Link><div className="muted small">{vehicleName(r)}</div></td>
                      <td>{r.company || '—'}</td><td className="nowrap">{km(r.mileage_km)}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      )}
      <div className="hint">{t('rep.svc.hint')}</div>
    </>
  )
}
