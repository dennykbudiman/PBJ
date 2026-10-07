import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, PageHead } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { shopToday } from '../../lib/customers'
import { fmtDate, invoiceNo, num, rp } from '../../lib/format'
import { AGING_BUCKETS, agingBucket, downloadCsv } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, companiesOf, useReport } from './ReportsArea'

const BUCKET_COLOR = { current: 'gray', d1_30: 'amber', d31_60: 'amber', d61_90: 'red', d90: 'red' }

// Reports → Receivables aging: what each company still owes today, by how long it is past due.
export default function AgingReport() {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [company, setCompany] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const aging = useReport('report_aging', {}, [])
  const credits = useReport('report_open_credits', {}, [])
  const list = useMemo(() => (aging.rows || []).filter((r) => !company || r.customer_id === company), [aging.rows, company])
  const creditOf = useMemo(() => Object.fromEntries((credits.rows || []).map((c) => [c.customer_id, Number(c.credit)])), [credits.rows])

  const companies = useMemo(() => {
    const m = new Map()
    for (const r of list) {
      const c = m.get(r.customer_id) || { id: r.customer_id, name: r.company || '—', rows: [], total: 0, ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) }
      c.rows.push(r)
      c.total += Number(r.balance)
      c[agingBucket(r.days_overdue)] += Number(r.balance)
      m.set(r.customer_id, c)
    }
    // Companies with unused credit but nothing owed are listed too, so the credit column adds up.
    for (const c of credits.rows || []) {
      if (m.has(c.customer_id) || (company && c.customer_id !== company)) continue
      m.set(c.customer_id, { id: c.customer_id, name: c.company || '—', rows: [], total: 0, ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) })
    }
    // Most overdue money first.
    return [...m.values()].sort((a, b) => (b.d90 + b.d61_90 + b.d31_60 + b.d1_30) - (a.d90 + a.d61_90 + a.d31_60 + a.d1_30) || b.total - a.total)
  }, [list, credits.rows, company])
  const tot = companies.reduce((a, c) => { for (const k of ['total', ...AGING_BUCKETS]) a[k] += c[k]; return a }, Object.fromEntries(['total', ...AGING_BUCKETS].map((k) => [k, 0])))
  const overdue = tot.total - tot.current
  const credit = company ? creditOf[company] || 0 : Object.values(creditOf).reduce((a, x) => a + x, 0)
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  function csv() {
    const head = [t('rep.col.company'), t('rep.col.invoice'), t('rep.col.date'), t('rep.col.due'), t('rep.col.daysOverdue'), t('rep.col.bucket'), t('rep.m.total'), t('rep.col.paid'), t('rep.col.balance')]
    downloadCsv(`axle-aging-${shopToday(timezone)}.csv`, head,
      list.map((r) => [r.company, invoiceNo(r.invoice_number), r.invoiced_on, r.due_date, r.days_overdue, t(`rep.b.${agingBucket(r.days_overdue)}`), Number(r.total), Number(r.paid), Number(r.balance)]))
  }

  return (
    <>
      <PageHead title={t('rep.aging.title')} sub={t('rep.aging.sub')} />
      <ReportBar noPeriod companies={companiesOf(aging.rows)} company={company} setCompany={setCompany} onCsv={csv} csvDisabled={!list.length} />
      <ReportError error={aging.error || credits.error} />
      <div className="kpis four" style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('rep.aging.owed')} value={rp(tot.total)} note={t('rep.aging.nInvoices', { n: list.length })} />
        <Kpi label={t('rep.aging.overdue')} value={rp(overdue)} tone={overdue ? 'red' : undefined} note={tot.total ? t('rep.aging.share', { pct: num((overdue / tot.total) * 100) }) : null} />
        <Kpi label={t('rep.b.d90')} value={rp(tot.d90)} tone={tot.d90 ? 'red' : undefined} />
        <Kpi label={t('rep.aging.credit')} value={rp(credit)} note={t('rep.aging.creditNote')} />
      </div>
      {aging.error || credits.error ? null : aging.rows === null ? <div className="muted">{t('common.loading')}</div> : companies.length === 0 ? (
        <div className="card"><Empty icon="chart-bar" title={t('rep.aging.noneTitle')}>{t('rep.aging.noneText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr>
              <th>{t('rep.col.company')}</th>
              {AGING_BUCKETS.map((b) => <th key={b} className="num">{t(`rep.b.${b}`)}</th>)}
              <th className="num">{t('rep.col.owed')}</th><th className="num wide-only">{t('rep.aging.credit')}</th>
            </tr></thead>
            <tbody>
              {companies.map((c) => (
                <React.Fragment key={c.id}>
                  <tr className="clickrow" onClick={(e) => { if (!e.target.closest('a')) toggle(c.id) }}>
                    <td>
                      <button type="button" className="linkbtn plainlink row" style={{ gap: 4 }} aria-expanded={open.has(c.id)} aria-label={t('rep.aging.showInvoices', { name: c.name })}>
                        <Icon name={open.has(c.id) ? 'chevronDown' : 'chevronRight'} size={13} /><b>{c.name}</b>
                      </button>
                      <div className="muted small">{c.rows.length ? t('rep.aging.nInvoices', { n: c.rows.length }) : t('rep.aging.creditOnly')}</div>
                    </td>
                    {AGING_BUCKETS.map((b) => <td key={b} className="num" style={c[b] && b !== 'current' ? { color: b === 'd61_90' || b === 'd90' ? 'var(--red)' : undefined, fontWeight: 700 } : undefined}>{c[b] ? rp(c[b]) : <span className="muted">–</span>}</td>)}
                    <td className="num"><b>{rp(c.total)}</b></td>
                    <td className="num wide-only">{creditOf[c.id] ? rp(creditOf[c.id]) : <span className="muted">–</span>}</td>
                  </tr>
                  {open.has(c.id) && c.rows.map((r) => (
                    <tr key={r.ro_id} className="subrow">
                      <td className="ind">
                        <Link to={`/jobs/${r.ro_id}`}>{invoiceNo(r.invoice_number)}</Link>
                        <span className="muted small"> · {fmtDate(r.invoiced_on, lang)}{r.plate ? ` · ${r.plate}` : ''}</span>
                      </td>
                      <td colSpan={AGING_BUCKETS.length} className="small">
                        <Badge color={BUCKET_COLOR[agingBucket(r.days_overdue)]}>{r.days_overdue > 0 ? t('rep.aging.daysOver', { n: r.days_overdue }) : t('rep.b.current')}</Badge>
                        <span className="muted"> {t('rep.aging.dueOn', { date: fmtDate(r.due_date, lang) })} · {t('rep.aging.ofTotal', { total: rp(r.total) })}</span>
                      </td>
                      <td className="num">{rp(r.balance)}</td><td className="wide-only" />
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot><tr>
              <td><b>{t('rep.total')}</b></td>
              {AGING_BUCKETS.map((b) => <td key={b} className="num"><b>{rp(tot[b])}</b></td>)}
              <td className="num"><b>{rp(tot.total)}</b></td><td className="num wide-only"><b>{rp(credit)}</b></td>
            </tr></tfoot>
          </table>
        </div>
      )}
      <div className="hint">{t('rep.aging.hint')}</div>
    </>
  )
}
