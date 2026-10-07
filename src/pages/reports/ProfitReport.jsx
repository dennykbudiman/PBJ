import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, Notice, PageHead } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { fmtDate, invoiceNo, jobNo, num, rp } from '../../lib/format'
import { daysBetween, monthLabel } from '../../lib/calendar'
import { downloadCsv, groupBy, sumBy } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, companiesOf, pct, useCompany, usePeriod, useReport } from './ReportsArea'

const MONEY = ['parts', 'parts_cost', 'sublet', 'sublet_cost', 'labor', 'fees', 'discounts', 'subtotal', 'no_cost_lines']
const withProfit = (x) => ({ ...x, cost: x.parts_cost + x.sublet_cost, gross: x.subtotal - x.parts_cost - x.sublet_cost })

// Reports → Profit: sales before tax minus the cost of the parts and sublet on the invoices.
export default function ProfitReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_month')
  const [view, setView] = useState('auto')
  const [onlyNoCost, setOnlyNoCost] = useState(false)
  const { rows, error, loading } = useReport('report_profit', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const [company, setCompany] = useCompany(rows)
  const list = useMemo(() => (rows || []).filter((r) => !company || r.customer_id === company).map((r) => withProfit({ ...r, ...sumBy([r], MONEY) })), [rows, company])
  const tot = withProfit(sumBy(list, MONEY))
  const missingInv = list.filter((r) => r.no_cost_lines > 0).length
  const by = view === 'auto' ? (daysBetween(period.from, period.to) > 62 ? 'month' : 'day') : view
  // the "missing costs only" tick only applies while some invoice has missing costs
  const shown = by === 'invoices' && onlyNoCost && missingInv > 0 ? list.filter((r) => r.no_cost_lines > 0) : list

  const groups = useMemo(() => {
    if (by === 'invoices') return null
    const key = by === 'day' ? (r) => r.invoiced_on : by === 'month' ? (r) => r.invoiced_on.slice(0, 7) : (r) => r.customer_id || ''
    const g = [...groupBy(list, key).entries()].map(([k, rs]) => ({
      key: k, n: rs.length, ...withProfit(sumBy(rs, MONEY)),
      label: by === 'day' ? fmtDate(k, lang) : by === 'month' ? monthLabel(`${k}-01`, lang) : rs[0].company || '—',
    }))
    return by === 'company' ? g.sort((a, b) => b.gross - a.gross) : g.sort((a, b) => a.key.localeCompare(b.key))
  }, [list, by, lang])

  function csv() {
    const head = [t('rep.col.invoice'), t('rep.col.date'), t('rep.col.job'), t('rep.col.company'), t('rep.col.plate'),
      t('rep.col.parts'), t('rep.col.partsCost'), t('rep.col.sublet'), t('rep.col.subletCost'), t('rep.m.labor'), t('rep.m.fees'), t('rep.m.discounts'),
      t('rep.m.sales'), t('rep.col.cost'), t('rep.m.gross'), `${t('rep.m.margin')} %`, t('rep.col.noCost')]
    downloadCsv(`axle-profit-${period.from}-${period.to}.csv`, head, list.map((r) => [invoiceNo(r.invoice_number), r.invoiced_on, jobNo(r.job_number), r.company, r.plate,
      r.parts, r.parts_cost, r.sublet, r.sublet_cost, r.labor, r.fees, -r.discounts, r.subtotal, r.cost, r.gross,
      r.subtotal ? Math.round((r.gross / r.subtotal) * 1000) / 10 : null, r.no_cost_lines]))
  }

  const marginCell = (x) => <td className="num" style={x.gross < 0 ? { color: 'var(--red)' } : undefined}>{pct(x.gross, x.subtotal, 1)}</td>

  return (
    <>
      <PageHead title={t('rep.profit.title')} sub={t('rep.profit.sub')} />
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
      {tot.no_cost_lines > 0 && (
        <Notice kind="warn" style={{ marginBottom: 12 }}>
          {t('rep.profit.noCost', { n: num(tot.no_cost_lines), inv: num(missingInv) })}{' '}
          <button type="button" className="linkbtn" onClick={() => { setView('invoices'); setOnlyNoCost(true) }}>{t('rep.show')}</button>
        </Notice>
      )}
      <div className={`kpis four ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 8 }}>
        <Kpi label={t('rep.m.sales')} value={rp(tot.subtotal)} note={t('rep.profit.salesNote', { n: list.length })} />
        <Kpi label={t('rep.m.cost')} value={rp(tot.cost)} note={t('rep.profit.costNote')} />
        <Kpi label={t('rep.m.gross')} value={rp(tot.gross)} tone={tot.gross < 0 ? 'red' : undefined} note={t('rep.profit.grossNote')} />
        <Kpi label={t('rep.m.margin')} value={pct(tot.gross, tot.subtotal, 1)} />
      </div>
      <div className="posum muted" style={{ marginBottom: 14 }}>
        <span>{t('rep.profit.partsMargin')} <b className="ink">{rp(tot.parts - tot.parts_cost)}</b> ({pct(tot.parts - tot.parts_cost, tot.parts)})</span>
        <span>{t('rep.profit.subletMargin')} <b className="ink">{rp(tot.sublet - tot.sublet_cost)}</b> ({pct(tot.sublet - tot.sublet_cost, tot.sublet)})</span>
        <span>{t('rep.m.labor')} <b className="ink">{rp(tot.labor)}</b></span>
        <span>{t('rep.m.fees')} <b className="ink">{rp(tot.fees)}</b></span>
        <span>{t('rep.m.discounts')} <b className="ink">{tot.discounts ? `-${rp(tot.discounts)}` : rp(0)}</b></span>
      </div>
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="chart-bar" title={t('rep.empty')}>{t('rep.profit.emptyText')}</Empty></div>
      ) : (
        <>
          {by === 'invoices' && missingInv > 0 && (
            <label className="row small" style={{ gap: 6, marginBottom: 8 }}>
              <input type="checkbox" checked={onlyNoCost} onChange={(e) => setOnlyNoCost(e.target.checked)} /> {t('rep.profit.onlyNoCost')}
            </label>
          )}
          <div className={`table ${loading ? 'stale' : ''}`}>
            <table>
              {by === 'invoices' ? (
                <>
                  <thead><tr>
                    <th>{t('rep.col.invoice')}</th><th>{t('rep.col.date')}</th><th>{t('rep.col.company')}</th>
                    <th className="num">{t('rep.m.sales')}</th><th className="num">{t('rep.col.cost')}</th><th className="num">{t('rep.m.gross')}</th><th className="num">{t('rep.m.margin')}</th>
                  </tr></thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.ro_id}>
                        <td>
                          <Link className="rowlink" to={`/jobs/${r.ro_id}`}>{invoiceNo(r.invoice_number)}</Link>
                          {r.no_cost_lines > 0 && <> <Badge color="amber">{t('rep.profit.noCostBadge', { n: r.no_cost_lines })}</Badge></>}
                          <div className="muted small">{t('rep.jobNo', { no: jobNo(r.job_number) })}{r.plate ? ` · ${r.plate}` : ''}</div>
                        </td>
                        <td className="nowrap">{fmtDate(r.invoiced_on, lang)}</td>
                        <td>{r.company || '—'}</td>
                        <td className="num">{rp(r.subtotal)}</td><td className="num">{rp(r.cost)}</td><td className="num"><b>{rp(r.gross)}</b></td>
                        {marginCell(r)}
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead><tr>
                    <th>{t(`rep.g.${by}`)}</th><th className="num">{t('rep.col.invoices')}</th>
                    <th className="num wide-only">{t('rep.profit.partsMargin')}</th><th className="num wide-only">{t('rep.m.labor')}</th>
                    <th className="num">{t('rep.m.sales')}</th><th className="num">{t('rep.col.cost')}</th><th className="num">{t('rep.m.gross')}</th><th className="num">{t('rep.m.margin')}</th>
                  </tr></thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.key}>
                        <td><b>{g.label}</b></td><td className="num">{num(g.n)}</td>
                        <td className="num wide-only">{rp(g.parts - g.parts_cost)}</td><td className="num wide-only">{rp(g.labor)}</td>
                        <td className="num">{rp(g.subtotal)}</td><td className="num">{rp(g.cost)}</td><td className="num"><b>{rp(g.gross)}</b></td>
                        {marginCell(g)}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr>
                    <td><b>{t('rep.total')}</b></td><td className="num"><b>{num(list.length)}</b></td>
                    <td className="num wide-only"><b>{rp(tot.parts - tot.parts_cost)}</b></td><td className="num wide-only"><b>{rp(tot.labor)}</b></td>
                    <td className="num"><b>{rp(tot.subtotal)}</b></td><td className="num"><b>{rp(tot.cost)}</b></td><td className="num"><b>{rp(tot.gross)}</b></td>
                    <td className="num"><b>{pct(tot.gross, tot.subtotal, 1)}</b></td>
                  </tr></tfoot>
                </>
              )}
            </table>
          </div>
        </>
      )}
      <div className="hint">{t('rep.profit.hint')}</div>
    </>
  )
}
