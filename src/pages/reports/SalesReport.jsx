import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Notice, PageHead } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { fmtDate, invoiceNo, jobNo, num, rp } from '../../lib/format'
import { daysBetween, monthLabel } from '../../lib/calendar'
import { downloadCsv, groupBy, sumBy } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, companiesOf, useCompany, usePeriod, useReport } from './ReportsArea'

const MONEY = ['parts', 'labor', 'sublet', 'fees', 'discounts', 'subtotal', 'tax', 'total']

// Reports → Sales: invoices issued in the period, split into parts, labor, sublet, fees and discounts.
export default function SalesReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_month')
  const [view, setView] = useState('auto')
  const [showVoids, setShowVoids] = useState(false)
  const { rows, error, loading } = useReport('report_sales', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const voids = useReport('report_voids', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const [company, setCompany] = useCompany(rows)
  const voidList = (voids.rows || []).filter((v) => !company || v.customer_id === company)
  const list = useMemo(() => (rows || []).filter((r) => !company || r.customer_id === company), [rows, company])
  const tot = sumBy(list, MONEY)
  // Long periods group by month, short ones by day.
  const by = view === 'auto' ? (daysBetween(period.from, period.to) > 62 ? 'month' : 'day') : view

  const groups = useMemo(() => {
    if (by === 'invoices') return null
    const key = by === 'day' ? (r) => r.invoiced_on : by === 'month' ? (r) => r.invoiced_on.slice(0, 7) : (r) => r.customer_id || ''
    const g = [...groupBy(list, key).entries()].map(([k, rs]) => ({ key: k, label: labelOf(k, rs), n: rs.length, ...sumBy(rs, MONEY) }))
    return by === 'company' ? g.sort((a, b) => b.total - a.total) : g.sort((a, b) => a.key.localeCompare(b.key))
    function labelOf(k, rs) {
      if (by === 'day') return fmtDate(k, lang)
      if (by === 'month') return monthLabel(`${k}-01`, lang)
      return rs[0].company || '—'
    }
  }, [list, by, lang])

  function csv() {
    const head = [t('rep.col.invoice'), t('rep.col.date'), t('rep.col.job'), t('rep.col.company'), t('rep.col.plate'), ...MONEY.map((m) => t(`rep.m.${m}`)), t('rep.col.paid'), t('rep.col.balance')]
    downloadCsv(`axle-sales-${period.from}-${period.to}.csv`, head,
      list.map((r) => [invoiceNo(r.invoice_number), r.invoiced_on, jobNo(r.job_number), r.company, r.plate, ...MONEY.map((m) => Number(r[m])), Number(r.paid), Number(r.balance)]))
  }

  return (
    <>
      <PageHead title={t('rep.sales.title')} sub={t('rep.sales.sub')} />
      <ReportBar period={period} companies={companiesOf(rows)} company={company} setCompany={setCompany} onCsv={csv} csvDisabled={!list.length || loading}>
        <select className="select chipselect" value={view} onChange={(e) => setView(e.target.value)} aria-label={t('rep.groupBy')}>
          <option value="auto">{t('rep.g.auto')}</option>
          <option value="day">{t('rep.g.day')}</option>
          <option value="month">{t('rep.g.month')}</option>
          <option value="company">{t('rep.g.company')}</option>
          <option value="invoices">{t('rep.g.invoices')}</option>
        </select>
      </ReportBar>
      <ReportError error={error} />
      {voidList.length > 0 && (
        <Notice kind="warn" style={{ marginBottom: 12 }}>
          {t('rep.sales.voids', { n: voidList.length, amount: rp(voidList.reduce((a, v) => a + Number(v.total), 0)) })}{' '}
          <button type="button" className="linkbtn" onClick={() => setShowVoids((x) => !x)} aria-expanded={showVoids}>{showVoids ? t('rep.hide') : t('rep.show')}</button>
          {showVoids && (
            <ul className="voidlist">
              {voidList.map((v) => (
                <li key={v.id}><Link to={`/jobs/${v.ro_id}`}>{invoiceNo(v.invoice_number)}</Link> · {v.company || '—'} · {rp(v.total)} · {t('rep.sales.voidedOn', { date: fmtDate(v.voided_on, lang), issued: fmtDate(v.invoiced_on, lang) })} · <i>{v.reason}</i></li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      <div className={`kpis ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 8 }}>
        <Kpi label={t('rep.sales.total')} value={rp(tot.total)} note={t('rep.sales.nInvoices', { n: list.length })} />
        <Kpi label={t('rep.m.subtotal')} value={rp(tot.subtotal)} note={t('rep.sales.beforeTax')} />
        <Kpi label={t('rep.m.tax')} value={rp(tot.tax)} />
      </div>
      <div className="posum muted" style={{ marginBottom: 14 }}>
        {['parts', 'labor', 'sublet', 'fees'].map((m) => <span key={m}>{t(`rep.m.${m}`)} <b className="ink">{rp(tot[m])}</b></span>)}
        <span>{t('rep.m.discounts')} <b className="ink">{tot.discounts ? `-${rp(tot.discounts)}` : rp(0)}</b></span>
      </div>
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="chart-bar" title={t('rep.empty')}>{t('rep.sales.emptyText')}</Empty></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            {by === 'invoices' ? (
              <>
                <thead><tr>
                  <th>{t('rep.col.invoice')}</th><th>{t('rep.col.date')}</th><th>{t('rep.col.company')}</th><th className="wide-only">{t('rep.col.plate')}</th>
                  <th className="num">{t('rep.m.subtotal')}</th><th className="num">{t('rep.m.tax')}</th><th className="num">{t('rep.m.total')}</th><th className="num">{t('rep.col.balance')}</th>
                </tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.ro_id}>
                      <td><Link className="rowlink" to={`/jobs/${r.ro_id}`}>{invoiceNo(r.invoice_number)}</Link><div className="muted small">{t('rep.jobNo', { no: jobNo(r.job_number) })}</div></td>
                      <td className="nowrap">{fmtDate(r.invoiced_on, lang)}</td>
                      <td>{r.company || '—'}</td><td className="wide-only">{r.plate || '—'}</td>
                      <td className="num">{rp(r.subtotal)}</td><td className="num">{rp(r.tax)}</td><td className="num"><b>{rp(r.total)}</b></td>
                      <td className="num">{Number(r.balance) > 0 ? rp(r.balance) : <span className="muted">{t('rep.paidUp')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead><tr>
                  <th>{t(`rep.g.${by}`)}</th><th className="num">{t('rep.col.invoices')}</th>
                  {['parts', 'labor', 'sublet', 'fees', 'discounts'].map((m) => <th key={m} className="num wide-only">{t(`rep.m.${m}`)}</th>)}
                  <th className="num">{t('rep.m.subtotal')}</th><th className="num">{t('rep.m.tax')}</th><th className="num">{t('rep.m.total')}</th>
                </tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key}>
                      <td><b>{g.label}</b></td><td className="num">{num(g.n)}</td>
                      {['parts', 'labor', 'sublet', 'fees'].map((m) => <td key={m} className="num wide-only">{rp(g[m])}</td>)}
                      <td className="num wide-only">{g.discounts ? `-${rp(g.discounts)}` : rp(0)}</td>
                      <td className="num">{rp(g.subtotal)}</td><td className="num">{rp(g.tax)}</td><td className="num"><b>{rp(g.total)}</b></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr>
                  <td><b>{t('rep.total')}</b></td><td className="num"><b>{num(list.length)}</b></td>
                  {['parts', 'labor', 'sublet', 'fees'].map((m) => <td key={m} className="num wide-only"><b>{rp(tot[m])}</b></td>)}
                  <td className="num wide-only"><b>{tot.discounts ? `-${rp(tot.discounts)}` : rp(0)}</b></td>
                  <td className="num"><b>{rp(tot.subtotal)}</b></td><td className="num"><b>{rp(tot.tax)}</b></td><td className="num"><b>{rp(tot.total)}</b></td>
                </tr></tfoot>
              </>
            )}
          </table>
        </div>
      )}
      <div className="hint">{t('rep.sales.hint')}</div>
    </>
  )
}
