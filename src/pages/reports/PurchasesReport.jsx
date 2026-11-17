import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, PageHead } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { fmtDate, jobNo, num, rp } from '../../lib/format'
import { downloadCsv } from '../../lib/reports'
import { payerBookLabel } from '../../lib/books'
import { Kpi, ReportBar, ReportError, useOpenRows, usePeriod, useReport } from './ReportsArea'

// Laporan → Pembelian (151, review 23): what came in from each supplier in the period (by delivered date), less
// returns, who paid (shop / PT / driver first), days from order to delivery, and parts whose price changed.
const n = (x) => Number(x) || 0
const days = (a, b) => (a && b ? Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) : null)

export default function PurchasesReport() {
  const { t, lang } = useT()
  const period = usePeriod('last_month')
  const [view, setView] = useState('supplier')
  const [open, toggle] = useOpenRows()
  const { rows, error, loading } = useReport('report_purchases', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const list = rows || []

  const sups = useMemo(() => {
    const m = new Map()
    for (const r of list) {
      const k = r.supplier_id || '—'
      let s = m.get(k)
      if (!s) m.set(k, s = { id: k, name: r.supplier || '—', lines: [], pos: new Set(), amount: 0, returned: 0, shop: 0, pt: 0, talangan: 0, lead: [] })
      const back = Math.round(n(r.cost) * n(r.returned))
      s.lines.push(r); s.pos.add(r.po_id); s.amount += n(r.amount); s.returned += back; s[r.payer_kind] += n(r.amount)
      const d = days(r.ordered_on, r.delivered_on)
      if (d != null && d >= 0) s.lead.push(d)
    }
    for (const s of m.values()) s.avgLead = s.lead.length ? s.lead.reduce((a, x) => a + x, 0) / s.lead.length : null
    return [...m.values()].sort((a, b) => b.amount - a.amount)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  // the same part bought at more than one price in the period
  const prices = useMemo(() => {
    const m = new Map()
    for (const r of list) {
      const k = r.catalog_item_id || `n:${String(r.name || '').trim().toLowerCase()}`
      let p = m.get(k)
      if (!p) m.set(k, p = { k, name: r.name, part: r.part_number, buys: [] })
      p.buys.push(r)
    }
    return [...m.values()].map((p) => {
      p.buys.sort((a, b) => String(a.delivered_on).localeCompare(String(b.delivered_on)))
      const cs = p.buys.map((b) => n(b.cost))
      p.min = Math.min(...cs); p.max = Math.max(...cs); p.first = cs[0]; p.last = cs[cs.length - 1]
      return p
    }).filter((p) => p.max - p.min >= 1).sort((a, b) => (b.last - b.first) / (b.first || 1) - (a.last - a.first) / (a.first || 1))
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const tot = sups.reduce((a, s) => ({ amount: a.amount + s.amount, returned: a.returned + s.returned, shop: a.shop + s.shop, pt: a.pt + s.pt, talangan: a.talangan + s.talangan }),
    { amount: 0, returned: 0, shop: 0, pt: 0, talangan: 0 })
  const who = (r) => (r.payer_kind === 'shop' ? t('u151.pur.shop') : r.payer_kind === 'talangan' ? t('u151.pur.driver', { name: r.payer || '—' }) : payerBookLabel(r.payer, r.book))

  function csv() {
    downloadCsv(`pembelian-${period.from}-${period.to}.csv`, [t('rep.col.supplier'), 'PO', t('rep.col.item'), t('rep.col.code'), t('u151.pur.ordered'), t('u151.pur.delivered'),
      t('u151.pur.lead'), t('u151.pur.qty'), t('u151.pur.returned'), t('rep.col.unitCost'), t('u151.pur.amount'), t('u151.pur.paidBy'), t('rep.col.job')],
    list.map((r) => [r.supplier, r.po_number, r.name, r.part_number || '', r.ordered_on, r.delivered_on, days(r.ordered_on, r.delivered_on), n(r.qty), n(r.returned), n(r.cost), n(r.amount),
      who(r), r.job_number ? jobNo(r.job_number) : '']))
  }

  return (
    <>
      <PageHead title={t('u151.pur.title')} sub={t('u151.pur.sub')} />
      <ReportBar period={period} onCsv={csv} csvDisabled={!list.length || loading}>
        <select className="select chipselect" value={view} onChange={(e) => setView(e.target.value)} aria-label={t('rep.groupBy')}>
          <option value="supplier">{t('u151.pur.bySupplier')}</option>
          <option value="prices">{t('u151.pur.priceChanges', { n: prices.length })}</option>
        </select>
      </ReportBar>
      <ReportError error={error} />
      <div className={`kpis four ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('u151.pur.total')} value={rp(tot.amount)} note={t('u151.pur.totalNote', { n: list.length })} />
        <Kpi label={t('u151.pur.byShop')} value={rp(tot.shop)} />
        <Kpi label={t('u151.pur.byPt')} value={rp(tot.pt + tot.talangan)} note={tot.talangan ? t('u151.pur.talNote', { amount: rp(tot.talangan) }) : null} />
        <Kpi label={t('u151.pur.returnedValue')} value={rp(tot.returned)} />
      </div>
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="truck" title={t('rep.empty')}>{t('u151.pur.empty')}</Empty></div>
      ) : view === 'supplier' ? (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            <thead><tr><th>{t('rep.col.supplier')}</th><th className="num">PO</th><th className="num">{t('u151.pur.amount')}</th><th className="num wide-only">{t('u151.pur.byShop')}</th>
              <th className="num wide-only">{t('u151.pur.byPt')}</th><th className="num wide-only">{t('u151.pur.returnedValue')}</th><th className="num">{t('u151.pur.avgLead')}</th></tr></thead>
            <tbody>
              {sups.map((s) => (
                <React.Fragment key={s.id}>
                  <tr className="clickrow" onClick={() => toggle(s.id)}>
                    <td><button type="button" className="linkbtn plainlink row" style={{ gap: 4 }} aria-expanded={open.has(s.id)}>
                      <Icon name={open.has(s.id) ? 'chevronDown' : 'chevronRight'} size={13} /><b>{s.name}</b></button></td>
                    <td className="num">{num(s.pos.size)}</td><td className="num"><b>{rp(s.amount)}</b></td>
                    <td className="num wide-only">{rp(s.shop)}</td><td className="num wide-only">{rp(s.pt + s.talangan)}</td><td className="num wide-only">{s.returned ? rp(s.returned) : '–'}</td>
                    <td className="num">{s.avgLead != null ? t('u151.pur.daysN', { n: num(s.avgLead, 1) }) : '–'}</td>
                  </tr>
                  {open.has(s.id) && s.lines.map((r) => (
                    <tr key={r.line_id} className="subrow">
                      <td className="ind small">{fmtDate(r.delivered_on, lang)} · <Link to={`/inventory/purchase-orders/${r.po_id}`}>PO {r.po_number}</Link> · {r.name}{r.part_number && <span className="muted"> · {r.part_number}</span>}
                        {r.job_number && <span className="muted"> · <Link to={`/jobs/${r.ro_id}`}>#{jobNo(r.job_number)}</Link></span>}</td>
                      <td className="num small">{num(r.qty, 2)}{n(r.returned) > 0 && <div className="muted">−{num(r.returned, 2)}</div>}</td>
                      <td className="num small">{rp(r.amount)}</td>
                      <td className="small wide-only" colSpan={3}>{who(r)}</td>
                      <td className="num small">{days(r.ordered_on, r.delivered_on) ?? '–'}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : prices.length === 0 ? (
        <div className="card"><Empty icon="check" title={t('u151.pur.noChanges')} /></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            <thead><tr><th>{t('rep.col.item')}</th><th className="num">{t('u151.pur.first')}</th><th className="num">{t('u151.pur.last')}</th><th className="num">{t('u151.pur.change')}</th><th className="wide-only">{t('u151.pur.buys')}</th></tr></thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.k}>
                  <td><b>{p.name}</b>{p.part && <span className="muted small"> · {p.part}</span>}</td>
                  <td className="num">{rp(p.first)}</td><td className="num">{rp(p.last)}</td>
                  <td className="num">{p.first ? <Badge color={p.last > p.first ? 'red' : 'green'}>{p.last > p.first ? '+' : ''}{num(((p.last - p.first) / p.first) * 100, 1)}%</Badge> : '–'}</td>
                  <td className="wide-only small">{p.buys.map((b) => `${fmtDate(b.delivered_on, lang)} ${b.supplier || ''} ${rp(b.cost)}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('u151.pur.hint')}</div>
    </>
  )
}
