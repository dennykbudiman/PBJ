import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Notice, PageHead } from '../components/ui'
import Icon from '../components/Icon'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useT } from '../lib/i18n'
import { supabase, errorText } from '../lib/supabase'
import { num, rp } from '../lib/format'
import { rpShort } from '../lib/customers'
import { dayLabel } from '../lib/calendar'

// Chart colours: categorical slots 1 and 2 (checked for colour-blind separation and contrast on white).
const C_INVOICED = '#2a78d6'
const C_RECEIVED = '#eb6834'

// The home screen: today's work for everyone; money for people who can see reports; supplier bills for people who see costs.
export default function Dashboard() {
  const { t, lang } = useT()
  const { profile, can } = useAuth()
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)
  const first = (profile?.name || '').split(' ')[0]

  useEffect(() => {
    let live = true
    supabase.rpc('dashboard_summary').then(({ data, error: err }) => { if (live) { setD(data); setError(err) } })
    return () => { live = false }
  }, [])

  const inShop = d?.in_shop || {}
  const shopCount = ['scheduled', 'arrived', 'in_progress', 'waiting_parts', 'completed'].reduce((a, k) => a + (Number(inShop[k]) || 0), 0)
  const m = d?.money
  const change = m && Number(m.invoiced_prev) > 0 ? Math.round(((Number(m.invoiced_mtd) - Number(m.invoiced_prev)) / Number(m.invoiced_prev)) * 100) : null

  return (
    <Page>
      <PageHead title={t('dash.hello', { name: first })} sub={d ? dayLabel(d.today, lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : t('dash.sub')} />
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!d ? !error && <div className="muted">{t('common.loading')}</div> : (
        <>
          <h2 className="dash-h">{t('dash.today')}</h2>
          <div className="dashgrid">
            <Tile to="/calendar?v=day" icon="calendar" label={t('dash.bookings')} value={num(d.bookings_today)}
              note={Number(d.requests) ? t('dash.requests', { n: d.requests }) : t('dash.noRequests')} warn={Number(d.requests) > 0} />
            <Tile to="/board" icon="layout-kanban" label={t('dash.inShop')} value={num(shopCount)}
              note={['arrived', 'in_progress', 'waiting_parts'].filter((k) => Number(inShop[k])).map((k) => `${t(`job.wf.${k}`)} ${inShop[k]}`).join(' · ') || t('dash.nothingInShop')} />
            <Tile to="/board" icon="packages" label={t('dash.waitingParts')} value={num(d.waiting_parts)} note={t('dash.waitingPartsNote')} warn={Number(d.waiting_parts) > 0} />
            <Tile to="/board" icon="check" label={t('dash.readyInv')} value={num(inShop.completed || 0)} note={t('dash.readyNote')} />
          </div>

          {m && (
            <>
              <h2 className="dash-h">{t('dash.money')}</h2>
              <div className="dashgrid money">
                <Tile to="/reports/sales" icon="receipt" label={t('dash.invoicedMtd')} value={rp(m.invoiced_mtd)}
                  note={change == null ? t('dash.nInvoices', { n: m.invoices_mtd }) : t('dash.vsLast', { pct: `${change > 0 ? '+' : ''}${change}%`, amount: rp(m.invoiced_prev) })} />
                <Tile to="/reports/payments" icon="dollar" label={t('dash.receivedMtd')} value={rp(m.received_mtd)} note={t('dash.receivedNote')} />
                <Tile to="/reports/aging" icon="users" label={t('dash.owed')} value={rp(m.outstanding)} note={t('dash.openInvoices', { n: m.open_invoices })} />
                <Tile to="/reports/aging" icon="clock" label={t('dash.overdue')} value={rp(m.overdue)} danger={Number(m.overdue) > 0}
                  note={Number(m.overdue) ? t('dash.overdueNote', { n: m.overdue_invoices, amount: rp(m.overdue_90) }) : t('dash.noneOverdue')} />
              </div>
              {d.series && <MonthChart series={d.series} />}
            </>
          )}

          <h2 className="dash-h">{t('dash.attention')}</h2>
          <div className="card attn">
            <Attn to="/customers/service-due" icon="clock" label={t('dash.service')} count={Number(d.service_overdue) + Number(d.service_due_soon)}
              detail={t('dash.serviceDetail', { over: d.service_overdue, soon: d.service_due_soon })} danger={Number(d.service_overdue) > 0} />
            <Attn to="/inventory/stock" icon="packages" label={t('dash.lowStock')} count={Number(d.low_stock)} detail={t('dash.lowStockDetail')} />
            {d.bills && can('view_costs') && (
              <Attn to="/inventory/bills" icon="wallet" label={t('dash.bills')} count={Number(d.bills.owed) > 0 ? 1 : 0} value={rp(d.bills.owed)}
                detail={t('dash.billsDetail', { overdue: rp(d.bills.overdue), soon: rp(d.bills.due_7) })} danger={Number(d.bills.overdue) > 0} />
            )}
            <Attn to="/inventory/cores" icon="layers" label={t('dash.cores')} count={Number(d.cores_to_retrieve) + Number(d.cores_to_return)}
              detail={t('dash.coresDetail', { take: d.cores_to_retrieve, send: d.cores_to_return })} />
            <Attn to="/inventory/returns" icon="undo" label={t('dash.returns')} count={Number(d.returns_open)} detail={t('dash.returnsDetail')} />
            <Attn to="/board" icon="wrench" label={t('dash.estimates')} count={Number(d.open_estimates)} detail={t('dash.estimatesDetail')} />
          </div>
        </>
      )}
    </Page>
  )
}

function Tile({ to, icon, label, value, note, warn, danger }) {
  return (
    <Link to={to} className={`card dashtile ${danger ? 'danger' : warn ? 'warn' : ''}`}>
      <div className="dashtile-head"><Icon name={icon} size={15} /><span>{label}</span></div>
      <div className="dashtile-value">{value}</div>
      {note && <div className="dashtile-note">{note}</div>}
    </Link>
  )
}

// One "needs attention" row; rows with nothing to do are shown quietly.
function Attn({ to, icon, label, count, value, detail, danger }) {
  const { t } = useT()
  const idle = !count
  return (
    <Link to={to} className={`attn-row ${idle ? 'idle' : ''} ${danger ? 'danger' : ''}`}>
      <Icon name={icon} size={16} />
      <span className="attn-label">{label}</span>
      <span className="attn-detail">{idle ? t('dash.allClear') : detail}</span>
      <span className="attn-count">{value || (idle ? '' : num(count))}</span>
      <Icon name="chevronRight" size={14} />
    </Link>
  )
}

// Invoiced vs received, last six months: paired bars on one Rupiah axis, hover for the figures, table underneath.
function MonthChart({ series }) {
  const { t, lang } = useT()
  const [hover, setHover] = useState(null)
  const [showTable, setShowTable] = useState(false)
  const wrap = useRef(null)
  // Drawn at the real width so the labels stay at their normal size.
  const [W, setW] = useState(640)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const set = () => setW(Math.max(280, Math.round(el.clientWidth)))
    set()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = 220, L = 58, R = 8, T = 10, B = 26
  const max = Math.max(1, ...series.flatMap((s) => [Number(s.invoiced), Number(s.received)]))
  const step = niceStep(max / 4)
  const top = Math.ceil(max / step) * step
  const y = (v) => T + (H - T - B) * (1 - Math.max(v, 0) / top)
  const gw = (W - L - R) / series.length
  const bw = Math.max(6, Math.min(26, (gw - 18) / 2))
  const label = (s) => new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(`${s.month}-01T00:00:00Z`))
  const bar = (x, v, color, key) => {
    const h = Math.max(H - B - y(v), 0)
    if (h <= 0) return null
    const r = Math.min(4, h, bw / 2)
    const top0 = H - B - h
    return <path key={key} fill={color} d={`M${x},${H - B}V${top0 + r}Q${x},${top0} ${x + r},${top0}H${x + bw - r}Q${x + bw},${top0} ${x + bw},${top0 + r}V${H - B}Z`} />
  }
  const ticks = []
  for (let v = 0; v <= top + 0.5; v += step) ticks.push(v)
  const hs = hover != null ? series[hover] : null
  // Tapping outside the chart (phones have no mouse-leave) closes the figures.
  useEffect(() => {
    if (hover == null) return
    const off = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setHover(null) }
    document.addEventListener('pointerdown', off)
    return () => document.removeEventListener('pointerdown', off)
  }, [hover])
  const empty = series.every((s) => !Number(s.invoiced) && !Number(s.received))
  const tipX = hs ? Math.min(Math.max(L + hover * gw + gw / 2, 95), W - 95) : 0

  return (
    <section className="card chartcard">
      <div className="row wrap" style={{ gap: 12, marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>{t('dash.chartTitle')}</h2>
        <div className="legend">
          <span><i style={{ background: C_INVOICED }} />{t('dash.invoiced')}</span>
          <span><i style={{ background: C_RECEIVED }} />{t('dash.received')}</span>
        </div>
        <div className="spacer" />
        <button type="button" className="linkbtn small" onClick={() => setShowTable((x) => !x)} aria-expanded={showTable}>{showTable ? t('dash.hideTable') : t('dash.showTable')}</button>
      </div>
      {empty && <div className="muted small" style={{ margin: '4px 0 8px' }}>{t('dash.chartEmpty')}</div>}
      <div className="chartwrap" ref={wrap} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={t('dash.chartTitle')} className="chart">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis' : 'grid'} />
              <text x={L - 8} y={y(v) + 4} textAnchor="end" className="tick">{v === 0 ? '0' : rpShort(v, lang).replace(/^Rp\s?/, '')}</text>
            </g>
          ))}
          {series.map((s, i) => {
            const x0 = L + i * gw + (gw - (bw * 2 + 2)) / 2
            return (
              <g key={s.month}>
                {hover === i && <rect x={L + i * gw + 2} y={T} width={gw - 4} height={H - T - B} className="hoverband" />}
                {bar(x0, Number(s.invoiced), C_INVOICED, 'a')}
                {bar(x0 + bw + 2, Number(s.received), C_RECEIVED, 'b')}
                <text x={L + i * gw + gw / 2} y={H - 8} textAnchor="middle" className="tick">{label(s)}</text>
                <rect x={L + i * gw} y={0} width={gw} height={H} fill="transparent" tabIndex={0} aria-label={`${label(s)}: ${t('dash.invoiced')} ${rp(s.invoiced)}, ${t('dash.received')} ${rp(s.received)}`}
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
              </g>
            )
          })}
        </svg>
        {hs && (
          <div className="charttip" style={{ left: tipX }}>
            <div className="charttip-head">{label(hs)} {hs.month.slice(0, 4)}</div>
            <div><i style={{ background: C_INVOICED }} /><b>{rp(hs.invoiced)}</b> {t('dash.invoiced')}</div>
            <div><i style={{ background: C_RECEIVED }} /><b>{rp(hs.received)}</b> {t('dash.received')}</div>
          </div>
        )}
      </div>
      {showTable && (
        <div className="table compact flush" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>{t('dash.month')}</th><th className="num">{t('dash.invoiced')}</th><th className="num">{t('dash.received')}</th></tr></thead>
            <tbody>{series.map((s) => <tr key={s.month}><td>{label(s)} {s.month.slice(0, 4)}</td><td className="num">{rp(s.invoiced)}</td><td className="num">{rp(s.received)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('dash.chartHint')}</div>
    </section>
  )
}

// 1, 2 or 5 × a power of ten, at least the rough step.
function niceStep(rough) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))))
  for (const k of [1, 2, 5, 10]) if (k * p >= rough) return k * p
  return 10 * p
}
