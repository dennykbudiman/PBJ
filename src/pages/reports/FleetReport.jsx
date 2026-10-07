import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, PageHead } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { fmtDate, invoiceNo, jobNo, km, num, rp } from '../../lib/format'
import { vehicleName } from '../../lib/customers'
import { downloadCsv, groupBy, sumBy } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, companiesOf, useCompany, useOpenRows, usePeriod, useReport } from './ReportsArea'

const MONEY = ['parts', 'labor', 'sublet', 'fees', 'discounts', 'subtotal', 'tax', 'total']
const other = (x) => x.sublet + x.fees - x.discounts

// Km between the first and last visit with a reading (by date), and what was spent after the first visit per km driven.
export function kmStats(visits) {
  const read = visits.filter((v) => v.km != null).sort((a, b) => a.invoiced_on.localeCompare(b.invoiced_on) || a.km - b.km)
  if (read.length < 2) return { driven: null, perKm: null }
  const driven = read[read.length - 1].km - read[0].km
  if (driven <= 0) return { driven: null, perKm: null }
  const after = read.slice(1).reduce((a, v) => a + Number(v.subtotal), 0)
  return { driven, perKm: after / driven }
}

// Reports → Fleet spend: maintenance cost per vehicle and per company.
export default function FleetReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_year')
  const [view, setView] = useState('vehicle')
  const [open, toggle] = useOpenRows()
  const { rows, error, loading } = useReport('report_fleet', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const [company, setCompany] = useCompany(rows)
  const list = useMemo(() => (rows || []).filter((r) => !company || r.customer_id === company), [rows, company])
  const tot = sumBy(list, MONEY)

  const vehicles = useMemo(() => [...groupBy(list, (r) => r.vehicle_id).entries()].map(([id, rs]) => ({
    id, rows: rs, plate: rs[0].plate || '—', name: vehicleName(rs[0]), company: rs[0].company || '—', customer_id: rs[0].customer_id,
    ...sumBy(rs, MONEY), ...kmStats(rs),
  })).sort((a, b) => b.total - a.total), [list])
  const companies = useMemo(() => [...groupBy(list, (r) => r.customer_id || '').entries()].map(([id, rs]) => ({
    id, name: rs[0].company || '—', n: rs.length, vehicles: new Set(rs.map((r) => r.vehicle_id)).size, ...sumBy(rs, MONEY),
  })).sort((a, b) => b.total - a.total), [list])

  function csv() {
    const head = [t('rep.col.company'), t('rep.col.plate'), t('rep.g.vehicle'), t('rep.col.invoice'), t('rep.col.date'), t('rep.col.job'), t('rep.col.km'),
      ...MONEY.map((m) => t(`rep.m.${m}`))]
    downloadCsv(`axle-fleet-${period.from}-${period.to}.csv`, head, list.map((r) => [r.company, r.plate, vehicleName(r), invoiceNo(r.invoice_number), r.invoiced_on,
      jobNo(r.job_number), r.km, ...MONEY.map((m) => (m === 'discounts' ? -Number(r[m]) : Number(r[m])))]))
  }

  return (
    <>
      <PageHead title={t('rep.fleet.title')} sub={t('rep.fleet.sub')} />
      <ReportBar period={period} companies={companiesOf(rows)} company={company} setCompany={setCompany} onCsv={csv} csvDisabled={!list.length || loading}>
        <select className="select chipselect" value={view} onChange={(e) => setView(e.target.value)} aria-label={t('rep.groupBy')}>
          <option value="vehicle">{t('rep.g.vehicle')}</option>
          <option value="company">{t('rep.g.company')}</option>
        </select>
      </ReportBar>
      <ReportError error={error} />
      <div className={`kpis four ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('rep.fleet.spent')} value={rp(tot.total)} note={t('rep.fleet.spentNote', { n: list.length })} />
        <Kpi label={t('rep.m.subtotal')} value={rp(tot.subtotal)} />
        <Kpi label={t('rep.fleet.vehicles')} value={num(vehicles.length)} />
        <Kpi label={t('rep.fleet.perVehicle')} value={vehicles.length ? rp(tot.subtotal / vehicles.length) : '—'} note={t('rep.fleet.perVehicleNote')} />
      </div>
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="truck" title={t('rep.empty')}>{t('rep.fleet.emptyText')}</Empty></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            {view === 'vehicle' ? (
              <>
                <thead><tr>
                  <th>{t('rep.g.vehicle')}</th><th className="num">{t('rep.fleet.visits')}</th>
                  <th className="num wide-only">{t('rep.m.parts')}</th><th className="num wide-only">{t('rep.m.labor')}</th><th className="num wide-only" title={t('rep.fleet.otherNote')}>{t('rep.fleet.other')}</th>
                  <th className="num">{t('rep.m.subtotal')}</th><th className="num">{t('rep.m.total')}</th>
                  <th className="num">{t('rep.fleet.kmDriven')}</th><th className="num">{t('rep.fleet.perKm')}</th>
                </tr></thead>
                <tbody>
                  {vehicles.map((v) => (
                    <React.Fragment key={v.id}>
                      <tr className="clickrow" onClick={(e) => { if (!e.target.closest('a')) toggle(v.id) }}>
                        <td>
                          <button type="button" className="linkbtn plainlink row" style={{ gap: 4 }} aria-expanded={open.has(v.id)} aria-label={t('rep.fleet.show', { plate: v.plate })}>
                            <Icon name={open.has(v.id) ? 'chevronDown' : 'chevronRight'} size={13} /><b>{v.plate}</b>
                          </button>
                          <div className="muted small">{[v.name, v.company].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className="num">{num(v.rows.length)}</td>
                        <td className="num wide-only">{rp(v.parts)}</td><td className="num wide-only">{rp(v.labor)}</td><td className="num wide-only">{rp(other(v))}</td>
                        <td className="num">{rp(v.subtotal)}</td><td className="num"><b>{rp(v.total)}</b></td>
                        <td className="num">{v.driven ? km(v.driven) : <span className="muted">–</span>}</td>
                        <td className="num">{v.perKm != null ? rp(v.perKm) : <span className="muted">–</span>}</td>
                      </tr>
                      {open.has(v.id) && (
                        <>
                          {v.rows.map((r) => (
                            <tr key={r.ro_id} className="subrow">
                              <td className="ind"><Link to={`/jobs/${r.ro_id}`}>{invoiceNo(r.invoice_number)}</Link><span className="muted"> · {fmtDate(r.invoiced_on, lang)}</span></td>
                              <td />
                              <td className="num wide-only">{rp(r.parts)}</td><td className="num wide-only">{rp(r.labor)}</td><td className="num wide-only">{rp(other(r))}</td>
                              <td className="num">{rp(r.subtotal)}</td><td className="num">{rp(r.total)}</td>
                              <td className="num">{r.km != null ? km(r.km) : <span className="muted">–</span>}</td><td />
                            </tr>
                          ))}
                          <tr className="subrow"><td className="ind" colSpan={9}><Link to={`/customers/vehicles/${v.id}`}>{t('rep.fleet.openVehicle', { plate: v.plate })}</Link></td></tr>
                        </>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead><tr>
                  <th>{t('rep.col.company')}</th><th className="num">{t('rep.svc.vehicles')}</th><th className="num">{t('rep.col.invoices')}</th>
                  <th className="num wide-only">{t('rep.m.parts')}</th><th className="num wide-only">{t('rep.m.labor')}</th><th className="num wide-only" title={t('rep.fleet.otherNote')}>{t('rep.fleet.other')}</th>
                  <th className="num">{t('rep.m.subtotal')}</th><th className="num">{t('rep.m.total')}</th>
                </tr></thead>
                <tbody>
                  {companies.map((c) => (
                    <tr key={c.id}>
                      <td>{c.id ? <Link className="rowlink" to={`/customers/${c.id}`}>{c.name}</Link> : c.name}</td>
                      <td className="num">{num(c.vehicles)}</td><td className="num">{num(c.n)}</td>
                      <td className="num wide-only">{rp(c.parts)}</td><td className="num wide-only">{rp(c.labor)}</td><td className="num wide-only">{rp(other(c))}</td>
                      <td className="num">{rp(c.subtotal)}</td><td className="num"><b>{rp(c.total)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            <tfoot><tr>
              <td><b>{t('rep.total')}</b></td>
              {view === 'company' && <td className="num"><b>{num(vehicles.length)}</b></td>}
              <td className="num"><b>{num(list.length)}</b></td>
              <td className="num wide-only"><b>{rp(tot.parts)}</b></td><td className="num wide-only"><b>{rp(tot.labor)}</b></td><td className="num wide-only"><b>{rp(other(tot))}</b></td>
              <td className="num"><b>{rp(tot.subtotal)}</b></td><td className="num"><b>{rp(tot.total)}</b></td>
              {view === 'vehicle' && <><td /><td /></>}
            </tr></tfoot>
          </table>
        </div>
      )}
      <div className="hint">{t('rep.fleet.hint')}</div>
    </>
  )
}
