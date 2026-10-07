import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, Notice, PageHead } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { fmtDate, num, rp } from '../../lib/format'
import { daysBetween } from '../../lib/calendar'
import { downloadCsv } from '../../lib/reports'
import { Kpi, ReportBar, ReportError, usePeriod, useReport } from './ReportsArea'

const n = (x) => Number(x) || 0
const SLOW_DAYS = 90
const VIEWS = ['value', 'used', 'slow', 'reorder']

// Reports → Inventory: stock value now, what was used in the period, slow movers and what to reorder.
export default function InventoryReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_month')
  const [view, setView] = useState('value')
  const [category, setCategory] = useState('')
  const { rows, error, loading } = useReport('report_inventory', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const today = period.today
  // On the shelf and neither used nor restocked for 90 days (new stock isn't "slow" yet).
  const idle = (r) => { const d = [r.last_used, r.last_stocked].filter(Boolean).sort().pop(); return n(r.qty_on_hand) > 0 && (!d || daysBetween(d, today) >= SLOW_DAYS) }
  const low = (r) => r.reorder_point != null && n(r.qty_on_hand) <= n(r.reorder_point) && r.active

  const all = rows || []
  const categories = useMemo(() => [...new Set(all.map((r) => r.category || ''))].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b)), [all])
  // a category that is no longer in the list stops filtering
  useEffect(() => { if (category && rows && !categories.includes(category === '\u0000' ? '' : category)) setCategory('') }, [categories]) // eslint-disable-line react-hooks/exhaustive-deps
  const inCat = all.filter((r) => category === '' || (category === '\u0000' ? !r.category : r.category === category))
  const kpi = {
    value: inCat.reduce((a, r) => a + n(r.value), 0),
    inStock: inCat.filter((r) => n(r.qty_on_hand) > 0).length,
    low: inCat.filter(low).length,
    used: inCat.reduce((a, r) => a + n(r.used_value), 0),
    usedItems: inCat.filter((r) => n(r.used_qty) > 0).length,
  }
  const slow = inCat.filter(idle)
  const slowValue = slow.reduce((a, r) => a + n(r.value), 0)

  const list = useMemo(() => {
    if (view === 'used') return inCat.filter((r) => n(r.used_qty) !== 0).sort((a, b) => n(b.used_value) - n(a.used_value))
    if (view === 'slow') return slow.slice().sort((a, b) => n(b.value) - n(a.value))
    if (view === 'reorder') return inCat.filter(low).sort((a, b) => (n(a.qty_on_hand) - n(a.reorder_point)) - (n(b.qty_on_hand) - n(b.reorder_point)) || a.name.localeCompare(b.name))
    return inCat.filter((r) => n(r.qty_on_hand) > 0).sort((a, b) => n(b.value) - n(a.value))
  }, [view, inCat, slow]) // eslint-disable-line react-hooks/exhaustive-deps
  const listValue = list.reduce((a, r) => a + n(r.value), 0)
  const listUsed = list.reduce((a, r) => a + n(r.used_value), 0)

  const lastUsed = (r) => (r.last_used ? <span title={fmtDate(r.last_used, lang)}>{t('rep.inv.daysAgo', { n: num(daysBetween(r.last_used, today)) })}</span> : <span className="muted">{t('rep.inv.never')}</span>)

  function csv() {
    const head = [t('rep.col.item'), t('rep.col.code'), t('rep.col.brand'), t('rep.inv.category'), t('rep.col.supplier'), t('rep.col.onHand'), t('rep.col.reorderAt'), t('rep.col.unitCost'), t('rep.col.value'),
      t('rep.col.usedQty'), t('rep.col.usedValue'), t('rep.col.received'), t('rep.col.lastUsed')]
    downloadCsv(`axle-inventory-${view}-${today}.csv`, head, list.map((r) => [r.name, r.code, r.brand, r.category, r.supplier, n(r.qty_on_hand), r.reorder_point == null ? null : n(r.reorder_point),
      n(r.cost), n(r.value), n(r.used_qty), n(r.used_value), n(r.received_qty), r.last_used]))
  }

  return (
    <>
      <PageHead title={t('rep.inv.title')} sub={t('rep.inv.sub')} />
      <ReportBar period={period} onCsv={csv} csvDisabled={!list.length || loading}>
        <select className="select chipselect" value={view} onChange={(e) => setView(e.target.value)} aria-label={t('rep.inv.view')}>
          {VIEWS.map((v) => <option key={v} value={v}>{t(`rep.inv.v.${v}`)}</option>)}
        </select>
        {categories.length > 1 && (
          <select className="select chipselect" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('rep.inv.category')}>
            <option value="">{t('rep.inv.allCategories')}</option>
            {categories.map((c) => <option key={c || 'none'} value={c || '\u0000'}>{c || t('rep.inv.noCategory')}</option>)}
          </select>
        )}
      </ReportBar>
      <ReportError error={error} />
      <div className={`kpis four ${loading ? 'stale' : ''}`} style={{ marginTop: 0, marginBottom: 14 }}>
        <Kpi label={t('rep.inv.value')} value={rp(kpi.value)} note={t('rep.inv.valueNote')} />
        <Kpi label={t('rep.inv.inStock')} value={num(kpi.inStock)} note={t('rep.inv.inStockNote', { n: inCat.length })} />
        <Kpi label={t('rep.inv.low')} value={num(kpi.low)} tone={kpi.low ? 'red' : undefined} note={t('rep.inv.lowNote')} />
        <Kpi label={t('rep.inv.used')} value={rp(kpi.used)} note={t('rep.inv.usedNote', { n: kpi.usedItems })} />
      </div>
      {slowValue > 0 && view !== 'slow' && (
        <Notice kind="info" style={{ marginBottom: 12 }}>
          {t('rep.inv.slowValue', { amount: rp(slowValue), n: slow.length })}{' '}
          <button type="button" className="linkbtn" onClick={() => setView('slow')}>{t('rep.show')}</button>
        </Notice>
      )}
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="packages" title={t('rep.empty')}>{t({ value: 'rep.inv.emptyValue', used: 'rep.inv.emptyUsed', slow: 'rep.inv.emptySlow', reorder: 'rep.inv.emptyReorder' }[view])}</Empty></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            <thead><tr>
              <th>{t('rep.col.item')}</th><th className="wide-only">{t('rep.inv.category')}</th>
              <th className="num">{t('rep.col.onHand')}</th>
              {view === 'reorder' && <th className="num">{t('rep.col.reorderAt')}</th>}
              <th className="num wide-only">{t('rep.col.unitCost')}</th><th className="num">{t('rep.col.value')}</th>
              <th className="num">{t('rep.col.usedQty')}</th>{view === 'used' && <th className="num">{t('rep.col.usedValue')}</th>}
              <th className="num wide-only">{t('rep.col.received')}</th><th>{t('rep.col.lastUsed')}</th>
            </tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.item_id}>
                  <td>
                    <Link className="rowlink" to={`/catalog/parts/${r.item_id}`}>{r.name}</Link>{!r.active && <> <Badge>{t('rep.inv.inactive')}</Badge></>}
                    <div className="muted small">{[r.code, r.brand, r.supplier].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="wide-only">{r.category || <span className="muted">—</span>}</td>
                  <td className="num" style={low(r) ? { color: 'var(--red)', fontWeight: 700 } : undefined}>{num(r.qty_on_hand, 2)}</td>
                  {view === 'reorder' && <td className="num">{num(r.reorder_point, 2)}</td>}
                  <td className="num wide-only">{rp(r.cost)}</td><td className="num"><b>{rp(r.value)}</b></td>
                  <td className="num">{n(r.used_qty) ? num(r.used_qty, 2) : <span className="muted">–</span>}</td>
                  {view === 'used' && <td className="num">{rp(r.used_value)}</td>}
                  <td className="num wide-only">{n(r.received_qty) ? num(r.received_qty, 2) : <span className="muted">–</span>}</td>
                  <td className="nowrap">{lastUsed(r)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <td><b>{t('rep.total')}</b> <span className="muted small">({num(list.length)})</span></td><td className="wide-only" /><td />
              {view === 'reorder' && <td />}
              <td className="wide-only" /><td className="num"><b>{rp(listValue)}</b></td><td />
              {view === 'used' && <td className="num"><b>{rp(listUsed)}</b></td>}
              <td className="wide-only" /><td />
            </tr></tfoot>
          </table>
        </div>
      )}
      <div className="hint">{t('rep.inv.hint')}</div>
    </>
  )
}
