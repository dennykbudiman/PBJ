import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, PageHead } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { fmtDate, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { downloadCsv } from '../../lib/reports'
import { Kpi, ReportError, useReport } from './ReportsArea'

// Laporan → Stok per tanggal (151, review 25): the shelf at the end of a day (quantity, and value at today's cost),
// and whose it is now — the shop's, or PTs' leftovers from their POs, with how long the oldest has waited. Bulk oil
// is left out (drums). Month end by default.
const n = (x) => Number(x) || 0

function lastMonthEnd(today) {
  const [y, m] = today.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10)
}

export default function StockReport() {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [at, setAt] = useState(() => lastMonthEnd(today))
  const [show, setShow] = useState('all')
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(at) && at <= today && at >= '2000-01-01'
  const { rows, error, loading } = useReport('report_stock_owner', { p_to: at }, [at], valid)
  const list = useMemo(() => (rows || []).filter((r) => (show === 'pt' ? n(r.pt_qty) > 0 : show === 'old' ? r.oldest_leftover && (new Date(`${today}T00:00:00Z`) - new Date(`${r.oldest_leftover}T00:00:00Z`)) / 86400000 > 30
    : show === 'diff' ? n(r.qty_at) !== n(r.qty_now) : true)), [rows, show, today])
  const tot = (rows || []).reduce((a, r) => ({ value: a.value + n(r.value_at), now: a.now + Math.round(Math.max(n(r.qty_now), 0) * n(r.cost)), pt: a.pt + Math.round(n(r.pt_qty) * n(r.cost)) }), { value: 0, now: 0, pt: 0 })
  const age = (d) => (d ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${d}T00:00:00Z`)) / 86400000) : null)

  function csv() {
    downloadCsv(`stok-${at}.csv`, [t('rep.col.item'), t('rep.col.code'), t('rep.inv.category'), t('rep.col.unitCost'), t('u151.stk.qtyAt', { date: at }), t('u151.stk.valueAt'),
      t('u151.stk.qtyNow'), t('u151.stk.ptQty'), t('u151.stk.ptOwners'), t('u151.stk.oldest')],
    list.map((r) => [r.name, r.code || '', r.category || '', n(r.cost), n(r.qty_at), n(r.value_at), n(r.qty_now), n(r.pt_qty), r.pt_owners || '', r.oldest_leftover || '']))
  }
  return (
    <>
      <PageHead title={t('u151.stk.title')} sub={t('u151.stk.sub')} />
      <div className="filterbar repbar">
        <label className="row" style={{ gap: 6 }}>{t('u151.stk.at')} <input type="date" className="input datein" value={at} max={today} onChange={(e) => e.target.value && setAt(e.target.value)} /></label>
        <select className="select chipselect" value={show} onChange={(e) => setShow(e.target.value)} aria-label={t('u151.stk.show')}>
          {['all', 'pt', 'old', 'diff'].map((k) => <option key={k} value={k}>{t(`u151.stk.s.${k}`)}</option>)}
        </select>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => window.print()}>{t('u142.print')}</button>
        <button type="button" className="btn" onClick={csv} disabled={!list.length}>{t('rep.csv')}</button>
      </div>
      <div className="print-only print-sub">{t('u151.st.perDate', { date: fmtDate(at, lang) })}</div>
      <ReportError error={error} />
      {!valid && <div className="hint">{t('u151.rk.badDate')}</div>}
      <div className={`kpis ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('u151.stk.valueAtK', { date: fmtDate(at, lang) })} value={rp(tot.value)} note={t('u151.stk.valueNote')} />
        <Kpi label={t('u151.stk.valueNow')} value={rp(tot.now)} />
        <Kpi label={t('u151.stk.ptValue')} value={rp(tot.pt)} note={t('u151.stk.ptValueNote')} />
      </div>
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="packages" title={t('rep.empty')} /></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            <thead><tr><th>{t('rep.col.item')}</th><th className="num">{t('u151.stk.qtyAt', { date: fmtDate(at, lang) })}</th><th className="num">{t('u151.stk.valueAt')}</th>
              <th className="num wide-only">{t('u151.stk.qtyNow')}</th><th>{t('u151.stk.whose')}</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.item_id}>
                  <td><Link className="rowlink" to={`/catalog/parts/${r.item_id}`}>{r.name}</Link><div className="small muted">{[r.code, r.category].filter(Boolean).join(' · ')}</div></td>
                  <td className="num" style={n(r.qty_at) < 0 ? { color: 'var(--red)' } : undefined}>{num(r.qty_at, 2)}</td>
                  <td className="num">{rp(r.value_at)}</td>
                  <td className="num wide-only">{num(r.qty_now, 2)}</td>
                  <td className="small">{n(r.pt_qty) > 0
                    ? <>{t('u151.stk.ptPart', { n: num(r.pt_qty, 2), who: r.pt_owners })}{age(r.oldest_leftover) > 30 && <> <Badge color="amber">{t('u151.stk.daysOld', { n: age(r.oldest_leftover) })}</Badge></>}
                      {n(r.qty_now) - n(r.pt_qty) > 0 && <div className="muted">{t('u151.stk.shopPart', { n: num(n(r.qty_now) - n(r.pt_qty), 2) })}</div>}</>
                    : <span className="muted">{t('u151.stk.shopOnly')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('u151.stk.hint')}</div>
    </>
  )
}
