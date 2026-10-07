import React, { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Empty, PageHead } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { fmtDate, invoiceNo, jobNo, num, rp } from '../../lib/format'
import { downloadCsv } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, companiesOf, pct, useCompany, useOpenRows, usePeriod, useReport } from './ReportsArea'

const n = (x) => Number(x) || 0
const hrs = (x) => num(x, 2)

// Reports → Technicians: labor sold and hours per technician, from the services on the period's invoices.
export default function TechniciansReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_month')
  const [open, toggle] = useOpenRows()
  const { rows, error, loading } = useReport('report_technicians', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const [company, setCompany] = useCompany(rows)
  const list = useMemo(() => (rows || []).filter((r) => !company || r.customer_id === company), [rows, company])

  const techs = useMemo(() => {
    const m = new Map()
    for (const r of list) {
      const id = r.technician_id || ''
      const x = m.get(id) || { id, name: r.technician || t('rep.tech.unassigned'), rows: [], jobs: new Set(), sold: 0, worked: 0, timed: 0, labor: 0 }
      x.rows.push(r); x.jobs.add(r.ro_id)
      x.sold += n(r.hours_sold); x.worked += n(r.hours_worked); x.timed += n(r.hours_sold_timed); x.labor += n(r.labor)
      m.set(id, x)
    }
    // biggest labor first; "No technician" last
    return [...m.values()].sort((a, b) => (a.id === '') - (b.id === '') || b.labor - a.labor)
  }, [list, t])
  const tot = techs.reduce((a, x) => ({ sold: a.sold + x.sold, worked: a.worked + x.worked, timed: a.timed + x.timed, labor: a.labor + x.labor }), { sold: 0, worked: 0, timed: 0, labor: 0 })
  const jobCount = new Set(list.map((r) => r.ro_id)).size
  const eff = (x) => (x.worked > 0 ? pct(x.timed, x.worked) : '—')

  function csv() {
    const head = [t('rep.col.invoice'), t('rep.col.date'), t('rep.col.job'), t('rep.col.company'), t('rep.col.plate'), t('rep.tech.service'), t('rep.tech.col'),
      t('rep.tech.hoursSold'), t('rep.tech.hoursWorked'), t('rep.tech.labor')]
    downloadCsv(`axle-technicians-${period.from}-${period.to}.csv`, head, list.map((r) => [invoiceNo(r.invoice_number), r.invoiced_on, jobNo(r.job_number), r.company, r.plate,
      r.service_name, r.technician || t('rep.tech.unassigned'), n(r.hours_sold), r.hours_worked == null ? null : n(r.hours_worked), n(r.labor)]))
  }

  return (
    <>
      <PageHead title={t('rep.tech.title')} sub={t('rep.tech.sub')} />
      <ReportBar period={period} companies={companiesOf(rows)} company={company} setCompany={setCompany} onCsv={csv} csvDisabled={!list.length || loading} />
      <ReportError error={error} />
      <div className={`kpis four ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('rep.tech.labor')} value={rp(tot.labor)} note={t('rep.tech.laborNote', { n: list.length, jobs: jobCount })} />
        <Kpi label={t('rep.tech.hoursSold')} value={hrs(tot.sold)} />
        <Kpi label={t('rep.tech.hoursWorked')} value={tot.worked ? hrs(tot.worked) : '—'} note={t('rep.tech.workedNote')} />
        <Kpi label={t('rep.tech.efficiency')} value={eff(tot)} note={tot.worked ? t('rep.tech.effNote') : t('rep.tech.effNone')} />
      </div>
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : techs.length === 0 ? (
        <div className="card"><Empty icon="wrench" title={t('rep.empty')}>{t('rep.tech.emptyText')}</Empty></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            <thead><tr>
              <th>{t('rep.tech.col')}</th><th className="num">{t('rep.tech.jobs')}</th><th className="num wide-only">{t('rep.tech.services')}</th>
              <th className="num">{t('rep.tech.hoursSold')}</th><th className="num">{t('rep.tech.hoursWorked')}</th><th className="num">{t('rep.tech.efficiency')}</th>
              <th className="num">{t('rep.tech.labor')}</th><th className="num wide-only">{t('rep.tech.perHour')}</th>
            </tr></thead>
            <tbody>
              {techs.map((x) => (
                <React.Fragment key={x.id || 'none'}>
                  <tr className="clickrow" onClick={(e) => { if (!e.target.closest('a')) toggle(x.id) }}>
                    <td>
                      <button type="button" className="linkbtn plainlink row" style={{ gap: 4 }} aria-expanded={open.has(x.id)} aria-label={t('rep.tech.show', { name: x.name })}>
                        <Icon name={open.has(x.id) ? 'chevronDown' : 'chevronRight'} size={13} /><b className={x.id ? '' : 'muted'}>{x.name}</b>
                      </button>
                    </td>
                    <td className="num">{num(x.jobs.size)}</td><td className="num wide-only">{num(x.rows.length)}</td>
                    <td className="num">{hrs(x.sold)}</td><td className="num">{x.worked ? hrs(x.worked) : <span className="muted">–</span>}</td>
                    <td className="num">{eff(x)}</td><td className="num"><b>{rp(x.labor)}</b></td>
                    <td className="num wide-only">{x.sold ? rp(x.labor / x.sold) : <span className="muted">–</span>}</td>
                  </tr>
                  {open.has(x.id) && x.rows.map((r) => (
                    <tr key={r.service_id} className="subrow">
                      <td className="ind">
                        <Link to={`/jobs/${r.ro_id}`}>{t('rep.jobNo', { no: jobNo(r.job_number) })}</Link>
                        <span className="muted"> · {r.service_name}</span>
                        <div className="muted">{fmtDate(r.invoiced_on, lang)}{r.plate ? ` · ${r.plate}` : ''}{r.company ? ` · ${r.company}` : ''}</div>
                      </td>
                      <td /><td className="wide-only" />
                      <td className="num">{hrs(r.hours_sold)}</td><td className="num">{r.hours_worked == null ? <span className="muted">–</span> : hrs(r.hours_worked)}</td>
                      <td className="num">{n(r.hours_worked) > 0 ? pct(n(r.hours_sold_timed), n(r.hours_worked)) : ''}</td>
                      <td className="num">{rp(r.labor)}</td><td className="wide-only" />
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot><tr>
              <td><b>{t('rep.total')}</b></td><td className="num"><b>{num(jobCount)}</b></td><td className="num wide-only"><b>{num(list.length)}</b></td>
              <td className="num"><b>{hrs(tot.sold)}</b></td><td className="num"><b>{tot.worked ? hrs(tot.worked) : '–'}</b></td>
              <td className="num"><b>{eff(tot)}</b></td><td className="num"><b>{rp(tot.labor)}</b></td>
              <td className="num wide-only"><b>{tot.sold ? rp(tot.labor / tot.sold) : '–'}</b></td>
            </tr></tfoot>
          </table>
        </div>
      )}
      <div className="hint">{t('rep.tech.hint')}</div>
    </>
  )
}
