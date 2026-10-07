import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, PageHead } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { fmtDate, invoiceNo, jobNo, num, rp } from '../../lib/format'
import { daysBetween, monthLabel } from '../../lib/calendar'
import { downloadCsv, groupBy } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, companiesOf, useCompany, usePeriod, useReport } from './ReportsArea'

const METHODS = ['transfer', 'cash', 'card', 'giro', 'other']
const KIND_COLOR = { payment: 'green', refund: 'amber', credit_refund: 'amber' }
const signed = (r) => (r.kind === 'payment' ? 1 : -1) * Number(r.amount)

// Reports → Payments received: money in (payments) and out (refunds, credit paid back) in the period.
export default function PaymentsReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_month')
  const [method, setMethod] = useState('')
  const [view, setView] = useState('auto')
  const { rows, error, loading } = useReport('report_payments', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const [company, setCompany] = useCompany(rows)
  const list = useMemo(() => (rows || []).filter((r) => (!company || r.customer_id === company) && (!method || r.method === method)), [rows, company, method])
  const inn = list.filter((r) => r.kind === 'payment').reduce((a, r) => a + Number(r.amount), 0)
  const out = list.filter((r) => r.kind !== 'payment').reduce((a, r) => a + Number(r.amount), 0)
  const by = view === 'auto' ? (daysBetween(period.from, period.to) > 62 ? 'month' : 'day') : view

  const groups = useMemo(() => {
    if (by === 'list') return null
    const key = { day: (r) => r.paid_on, month: (r) => r.paid_on.slice(0, 7), method: (r) => r.method, company: (r) => r.customer_id || '' }[by]
    const g = [...groupBy(list, key).entries()].map(([k, rs]) => ({
      key: k,
      label: by === 'day' ? fmtDate(k, lang) : by === 'month' ? monthLabel(`${k}-01`, lang) : by === 'method' ? t(`job.pay.${k}`) : rs[0].company || '—',
      n: rs.length,
      inn: rs.filter((r) => r.kind === 'payment').reduce((a, r) => a + Number(r.amount), 0),
      out: rs.filter((r) => r.kind !== 'payment').reduce((a, r) => a + Number(r.amount), 0),
    }))
    return by === 'method' || by === 'company' ? g.sort((a, b) => (b.inn - b.out) - (a.inn - a.out)) : g.sort((a, b) => a.key.localeCompare(b.key))
  }, [list, by, lang, t])

  function csv() {
    const head = [t('rep.col.date'), t('rep.col.kind'), t('rep.col.company'), t('rep.col.invoice'), t('rep.col.job'), t('rep.col.method'), t('rep.col.reference'), t('rep.col.amount')]
    downloadCsv(`axle-payments-${period.from}-${period.to}.csv`, head,
      list.map((r) => [r.paid_on, t(`rep.kind.${r.kind}`), r.company, r.invoice_number ? invoiceNo(r.invoice_number) : '', r.job_number ? jobNo(r.job_number) : '', t(`job.pay.${r.method}`), r.reference || '', signed(r)]))
  }

  return (
    <>
      <PageHead title={t('rep.pay.title')} sub={t('rep.pay.sub')} />
      <ReportBar period={period} companies={companiesOf(rows)} company={company} setCompany={setCompany} onCsv={csv} csvDisabled={!list.length || loading}>
        <select className="select chipselect" value={method} onChange={(e) => setMethod(e.target.value)} aria-label={t('rep.col.method')}>
          <option value="">{t('rep.pay.allMethods')}</option>
          {METHODS.map((m) => <option key={m} value={m}>{t(`job.pay.${m}`)}</option>)}
        </select>
        <select className="select chipselect" value={view} onChange={(e) => setView(e.target.value)} aria-label={t('rep.groupBy')}>
          <option value="auto">{t('rep.g.auto')}</option>
          <option value="day">{t('rep.g.day')}</option>
          <option value="month">{t('rep.g.month')}</option>
          <option value="method">{t('rep.g.method')}</option>
          <option value="company">{t('rep.g.company')}</option>
          <option value="list">{t('rep.g.list')}</option>
        </select>
      </ReportBar>
      <ReportError error={error} />
      <div className={`kpis ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('rep.pay.net')} value={rp(inn - out)} note={t('rep.pay.nEntries', { n: list.length })} />
        <Kpi label={t('rep.pay.in')} value={rp(inn)} />
        <Kpi label={t('rep.pay.out')} value={out ? `-${rp(out)}` : rp(0)} note={t('rep.pay.outNote')} />
      </div>
      {rows === null && !error ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="chart-bar" title={t('rep.empty')}>{t('rep.pay.emptyText')}</Empty></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            {by === 'list' ? (
              <>
                <thead><tr>
                  <th>{t('rep.col.date')}</th><th>{t('rep.col.kind')}</th><th>{t('rep.col.company')}</th><th className="wide-only">{t('rep.col.invoice')}</th>
                  <th>{t('rep.col.method')}</th><th className="wide-only">{t('rep.col.reference')}</th><th className="num">{t('rep.col.amount')}</th>
                </tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={`${r.kind}-${r.id}`}>
                      <td className="nowrap">{fmtDate(r.paid_on, lang)}</td>
                      <td><Badge color={KIND_COLOR[r.kind]}>{t(`rep.kind.${r.kind}`)}</Badge></td>
                      <td>{r.company || '—'}</td>
                      <td className="wide-only">{r.ro_id ? <Link to={`/jobs/${r.ro_id}`}>{r.invoice_number ? invoiceNo(r.invoice_number) : t('rep.jobNo', { no: jobNo(r.job_number) })}</Link> : <span className="muted">{t('rep.pay.fromCredit')}</span>}</td>
                      <td>{t(`job.pay.${r.method}`)}</td>
                      <td className="wide-only small">{r.reference || <span className="muted">—</span>}</td>
                      <td className="num" style={r.kind !== 'payment' ? { color: 'var(--red)' } : undefined}><b>{signed(r) < 0 ? `-${rp(-signed(r))}` : rp(signed(r))}</b></td>
                    </tr>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead><tr>
                  <th>{t(`rep.g.${by}`)}</th><th className="num">{t('rep.col.entries')}</th><th className="num">{t('rep.pay.in')}</th><th className="num">{t('rep.pay.out')}</th><th className="num">{t('rep.pay.net')}</th>
                </tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key}>
                      <td><b>{g.label}</b></td><td className="num">{num(g.n)}</td><td className="num">{rp(g.inn)}</td>
                      <td className="num">{g.out ? `-${rp(g.out)}` : <span className="muted">–</span>}</td><td className="num"><b>{rp(g.inn - g.out)}</b></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr>
                  <td><b>{t('rep.total')}</b></td><td className="num"><b>{num(list.length)}</b></td><td className="num"><b>{rp(inn)}</b></td>
                  <td className="num"><b>{out ? `-${rp(out)}` : rp(0)}</b></td><td className="num"><b>{rp(inn - out)}</b></td>
                </tr></tfoot>
              </>
            )}
          </table>
        </div>
      )}
      <div className="hint">{t('rep.pay.hint')}</div>
    </>
  )
}
