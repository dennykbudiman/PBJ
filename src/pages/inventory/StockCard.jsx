import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, Notice, PageHead } from '../../components/ui'
import { usePageTitle } from '../../lib/branding'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDateTime, invoiceNo, jobNo, num, qtyU } from '../../lib/format'
import { sysText } from '../../lib/jobs'
import { StockAdjust } from '../catalog/ItemsTab'

const OUT = ['used_on_job', 'return']
const IN = ['po_delivery', 'job_reversal', 'opening']

// Inventory → Stock → a part (migration 139, stock_card): what is on the shelf with its unit, what jobs used lately,
// what open estimates and POs will change, and every movement with its job, invoice or PO and the balance after it.
// Read first; changing the part or its count is one click away for the people allowed to.
export default function StockCard({ id }) {
  const { t, lang } = useT()
  const { can } = useAuth()
  const { timezone } = useShop()
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)
  const [show, setShow] = useState('all')

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('stock_card', { p_item: id })
    setD(data); setError(err)
  }, [id])
  useEffect(() => { load() }, [load])
  usePageTitle(d?.item ? t('sc.title', { name: d.item.name }) : null)

  const moves = useMemo(() => (d?.moves || []).filter((m) => (
    show === 'all' || (show === 'out' && OUT.includes(m.reason)) || (show === 'in' && IN.includes(m.reason)) || (show === 'adj' && m.reason === 'adjustment')
  )), [d, show])

  const back = <div className="no-print small" style={{ marginBottom: 6 }}><Link to="/inventory/stock">← {t('sc.back')}</Link></div>
  if (error) return <>{back}<Notice kind="err">{errorText(error, t)}</Notice></>
  if (!d) return <div className="muted">{t('common.loading')}</div>

  const it = d.item
  const u = it.unit
  const onHand = Number(it.qty_on_hand)
  const onEst = (d.on_estimates || []).reduce((a, x) => a + Number(x.qty), 0)
  const onOrder = (d.on_order || []).reduce((a, x) => a + Number(x.qty), 0)
  const jobs7 = Number(d.jobs_7d)
  const ref = (m) => {
    if (m.ro_id) return <Link to={`/jobs/${m.ro_id}`}>#{jobNo(m.job_number)}{m.invoice_number ? ` · ${invoiceNo(m.invoice_number)}` : ''}</Link>
    if (m.po_id) return <Link to={`/inventory/purchase-orders/${m.po_id}`}>PO {m.po_number}{m.supplier ? ` · ${m.supplier}` : ''}</Link>
    return <span className="muted">—</span>
  }

  return (
    <>
      {back}
      <PageHead title={t('sc.title', { name: it.name })}
        sub={[it.code, it.brand, it.supplier, u && t('sc.unit', { unit: u })].filter(Boolean).join(' · ') || null}
        actions={<div className="row wrap" style={{ gap: 6 }}>
          <Link className="btn" to={`/catalog/parts/${it.id}`}>{t('sc.edit')}</Link>
        </div>} />
      {!it.track_inventory && <Notice style={{ marginBottom: 12 }}>{t('sc.notTracked')}</Notice>}
      <div className="scgrid">
        <div className={`card dashtile ${onHand < 0 ? 'danger' : it.reorder_point != null && onHand <= Number(it.reorder_point) ? 'warn' : ''}`}>
          <div className="dashtile-head"><span>{t('sc.onHand')}</span></div>
          <div className="dashtile-value">{qtyU(onHand, u)}</div>
          <div className="dashtile-note">{onHand < 0 ? t('sc.negNote') : it.reorder_point != null ? t('sc.reorderNote', { n: qtyU(it.reorder_point, u) }) : t('sc.okNote')}</div>
        </div>
        <div className="card dashtile">
          <div className="dashtile-head"><span>{t('sc.today')}</span></div>
          <div className="dashtile-value">{qtyU(d.used_today, u)}</div>
        </div>
        <div className="card dashtile">
          <div className="dashtile-head"><span>{t('sc.week')}</span></div>
          <div className="dashtile-value">{qtyU(d.used_7d, u)}</div>
          <div className="dashtile-note">{jobs7 ? t('sc.weekNote', { n: jobs7, avg: qtyU(Math.round((Number(d.used_7d) / jobs7) * 10) / 10, u, 1) }) : t('sc.weekNone')}</div>
        </div>
        <div className="card dashtile">
          <div className="dashtile-head"><span>{t('sc.onEst')}</span></div>
          <div className="dashtile-value">{qtyU(onEst, u)}</div>
          {d.on_estimates.length > 0 && <div className="dashtile-note">{d.on_estimates.slice(0, 4).map((x, i) => (
            <span key={x.ro_id}>{i > 0 && ' · '}<Link to={`/jobs/${x.ro_id}`}>#{jobNo(x.job_number)}</Link> {qtyU(x.qty, u)}</span>
          ))}{d.on_estimates.length > 4 && ' …'}</div>}
        </div>
        <div className="card dashtile">
          <div className="dashtile-head"><span>{t('sc.onOrder')}</span></div>
          <div className="dashtile-value">{qtyU(onOrder, u)}</div>
          {d.on_order.length > 0 && <div className="dashtile-note">{d.on_order.slice(0, 3).map((x, i) => (
            <span key={`${x.po_id}-${i}`}>{i > 0 && ' · '}<Link to={`/inventory/purchase-orders/${x.po_id}`}>PO {x.po_number}</Link> {qtyU(x.qty, u)}</span>
          ))}</div>}
        </div>
      </div>
      {it.track_inventory && can('adjust_stock') && <StockAdjust key={`${it.qty_on_hand}-${d.moves_total}`} item={it} onHand={onHand} dirty={false} onDone={load} />}

      <section className="card" style={{ marginTop: 14 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <h2 className="sectionlabel" style={{ margin: 0 }}>{t('sc.history')}</h2>
          <div className="spacer" />
          <div className="seg" role="tablist" aria-label={t('sc.history')}>
            {['all', 'out', 'in', 'adj'].map((k) => (
              <button key={k} type="button" role="tab" aria-selected={show === k} className={`seg-btn ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{t(`sc.f.${k}`)}</button>
            ))}
          </div>
        </div>
        {d.moves.length === 0 && Number(d.start) === 0 ? <Empty icon="packages" title={t('sc.none')} /> : (
          <div className="table compact flush" style={{ marginTop: 8 }}>
            <table>
              <thead><tr>
                <th>{t('sc.col.when')}</th><th>{t('sc.col.what')}</th><th>{t('sc.col.ref')}</th><th className="sc-wide">{t('sc.col.vehicle')}</th>
                <th className="num">{t('sc.col.change')}</th><th className="num">{t('sc.col.balance')}</th><th className="sc-wide">{t('sc.col.who')}</th>
              </tr></thead>
              <tbody>
                {moves.map((m) => {
                  const q = Number(m.qty)
                  const note = m.note && !(m.reason === 'opening' && m.note === t('cat.openingNote')) ? sysText(m.note, t) : null
                  return (
                    <tr key={m.id}>
                      <td className="nowrap">{fmtDateTime(m.at, lang, timezone)}</td>
                      <td>{t(`cat.reason.${m.reason}`)}{note && <div className="muted small">{note}</div>}</td>
                      <td>{ref(m)}</td>
                      <td className="sc-wide nowrap">{m.plate || <span className="muted">—</span>}</td>
                      <td className="num nowrap" style={{ color: q < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 700 }}>{q > 0 ? '+' : ''}{qtyU(q, u)}</td>
                      <td className={`num nowrap ${Number(m.balance) < 0 ? 'neg' : ''}`}>{qtyU(m.balance, u)}</td>
                      <td className="sc-wide">{m.who || <span className="muted">—</span>}</td>
                    </tr>
                  )
                })}
                {show === 'all' && d.moves.length >= Number(d.moves_total) && (
                  <tr><td className="muted">—</td><td className="muted">{t('sc.start')}</td><td /><td className="sc-wide" /><td /><td className="num">{qtyU(d.start, u)}</td><td className="sc-wide" /></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {Number(d.moves_total) > d.moves.length && <div className="hint">{t('sc.latest', { n: num(d.moves_total) })}</div>}
      </section>
      {it.active === false && <div className="hint"><Badge>{t('inv.inactive')}</Badge></div>}
    </>
  )
}
