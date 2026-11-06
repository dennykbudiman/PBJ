import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Badge, Button, Notice, PageHead } from '../components/ui'
import Icon from '../components/Icon'
import { WaitingTag } from '../components/Waiting'
import { useShop } from '../context/ShopContext'
import { useT } from '../lib/i18n'
import { supabase, errorText } from '../lib/supabase'
import { invoiceNo, jobNo, num, qtyU, rp, sumOf } from '../lib/format'
import { WORKFLOW_COLOR } from '../lib/jobs'
import { addDays, clock, dayLabel, shopParts } from '../lib/calendar'

// A real calendar day from 2000 on: a year still being typed ("0002-11-06") or "2026-02-30" isn't one.
const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '') || s < '2000-01-01') return false
  const t = new Date(`${s}T12:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s
}

// Hari ini (migration 139, day_summary): one day in the shop on one page. Trucks still here (today only), invoices,
// money in, parts used from stock and parts received; money for people who see reports, part values and supplier bills
// for people who see costs. Earlier days through the arrows or the date box; printable.
export default function TodayPage() {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const navigate = useNavigate()
  const { search } = useLocation()
  const asked = new URLSearchParams(search).get('d')
  const [d, setD] = useState(null) // the day on screen; kept while the next one loads so the toolbar stays put
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    let live = true
    setLoading(true); setError(null)
    supabase.rpc('day_summary', { p_day: isDay(asked) ? asked : null }).then(({ data, error: err }) => {
      if (!live) return
      if (data) { setD(data); setTyped(data.day) }
      setError(err); setLoading(false)
    })
    return () => { live = false }
  }, [asked])

  const go = (day) => navigate(day && d && day !== d.today ? `/today?d=${day}` : '/today')
  // The date box moves only on Enter or leaving it, so typing a year doesn't jump around.
  const pickTyped = () => { if (d && isDay(typed) && typed !== d.day) go(typed > d.today ? d.today : typed) }
  const isToday = d && d.day === d.today
  const time = (ts) => clock(shopParts(ts, timezone).minutes, lang)
  const label = d ? dayLabel(d.day, lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''
  const shop = d?.in_shop || []
  const byStatus = {}
  for (const j of shop) byStatus[j.status] = (byStatus[j.status] || 0) + 1
  const bills = d?.bills

  return (
    <Page>
      <div className="today-page">
        <PageHead title={isToday || !d ? t('day.title') : label} sub={isToday ? label : t('day.title')}
          actions={<div className="row wrap no-print" style={{ gap: 6 }}>
            {d && <>
              <Button icon="chevronLeft" disabled={loading} onClick={() => go(addDays(d.day, -1))}>{t('day.prev')}</Button>
              <input type="date" className="input" style={{ width: 150 }} value={typed} max={d.today} aria-label={t('day.pick')}
                onChange={(e) => setTyped(e.target.value)} onBlur={pickTyped} onKeyDown={(e) => { if (e.key === 'Enter') pickTyped() }} />
              {!isToday && <Button disabled={loading} onClick={() => go(addDays(d.day, 1))}>{t('day.next')} <Icon name="chevronRight" size={14} /></Button>}
            </>}
            {(!isToday || error) && <Button onClick={() => go(null)}>{t('day.backToday')}</Button>}
            {d && <Button icon="print" onClick={() => window.print()}>{t('day.print')}</Button>}
          </div>} />
        {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
        {!d ? !error && <div className="muted">{t('common.loading')}</div> : (
          <>
            <div className="daygrid">
              <Tile label={t('day.opened')} value={num(d.opened.length)}
                note={d.opened.length ? d.opened.map((j) => `#${jobNo(j.job_number)}`).join(' · ') : t('day.none')} />
              <Tile label={t('day.invoiced')} value={num(d.invoices.length)} note={d.money ? rp(d.invoiced_total) : null} />
              {d.money && <Tile label={t('day.received')} value={rp(d.received)} note={t('day.receivedNote')} />}
              {isToday && <Tile label={t('day.inShop')} value={num(shop.length)} warn={shop.length > 0}
                note={Object.entries(byStatus).map(([k, n]) => `${t(`job.wf.${k}`)} ${n}`).join(' · ') || t('day.none')} />}
              {bills && <Tile label={t('day.bills')} value={rp(bills.due_7)} danger={Number(bills.overdue) > 0}
                note={[Number(bills.overdue) > 0 && t('day.billsOverdue', { amount: rp(bills.overdue) }),
                  bills.next_due ? t('day.billsNext', { date: dayLabel(bills.next_due, lang, { day: 'numeric', month: 'short' }), amount: rp(bills.next_amount) }) : t('day.billsNone')]
                  .filter(Boolean).join(' · ')} />}
            </div>

            <div className="daytwo">
              <div>
                {isToday && (
                  <section className="card daycard">
                    <h2 className="sectionlabel" style={{ marginTop: 0 }}>{t('day.inShop')}</h2>
                    {shop.length === 0 ? <div className="muted small">{t('day.shopNone')}</div> : (
                      <div className="table compact flush">
                        <table>
                          <thead><tr><th>{t('day.col.job')}</th><th>{t('day.col.vehicle')}</th><th>{t('day.col.status')}</th><th>{t('wait.col')}</th></tr></thead>
                          <tbody>{shop.map((j) => (
                            <tr key={j.id}>
                              <td><Link className="rowlink" to={`/jobs/${j.id}`}>#{jobNo(j.job_number)}</Link></td>
                              <td><b>{j.plate || '—'}</b>{j.vehicle && <span className="muted small"> · {j.vehicle}</span>}<div className="muted small">{j.company}</div></td>
                              <td><Badge color={WORKFLOW_COLOR[j.status]}>{t(`job.wf.${j.status}`)}</Badge></td>
                              <td className="waitcell"><WaitingTag kind={j.kind} info={j.info} /></td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    )}
                  </section>
                )}
                <section className="card daycard">
                  <h2 className="sectionlabel" style={{ marginTop: 0 }}>{t('day.invTitle')}</h2>
                  {d.invoices.length === 0 ? <div className="muted small">{t('day.noInvoices')}</div> : (
                    <div className="table compact flush">
                      <table>
                        <thead><tr><th>{t('day.col.invoice')}</th><th>{t('day.col.time')}</th><th>{t('day.col.vehicle')}</th><th>{t('day.col.company')}</th>
                          {d.money && <th className="num">{t('day.col.total')}</th>}</tr></thead>
                        <tbody>
                          {d.invoices.map((r) => (
                            <tr key={r.id}>
                              <td><Link className="rowlink" to={`/jobs/${r.id}`}>{invoiceNo(r.invoice_number)}</Link></td>
                              <td className="nowrap">{time(r.at)}</td>
                              <td className="nowrap">{r.plate || '—'}</td>
                              <td>{r.company || '—'}</td>
                              {d.money && <td className="num">{rp(r.total)}</td>}
                            </tr>
                          ))}
                          {d.money && <tr className="totalrow"><td colSpan={4}><b>{t('day.total')}</b></td><td className="num"><b>{rp(d.invoiced_total)}</b></td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
              <div>
                <section className="card daycard">
                  <h2 className="sectionlabel" style={{ marginTop: 0 }}>{t('day.outTitle')}</h2>
                  {d.parts_out.length === 0 ? <div className="muted small">{t('day.outNone')}</div> : (
                    <div className="table compact flush">
                      <table>
                        <thead><tr><th>{t('day.col.part')}</th><th className="num">{t('day.col.out')}</th><th className="num">{t('day.col.onHand')}</th></tr></thead>
                        <tbody>{d.parts_out.map((p) => (
                          <tr key={p.id}>
                            <td><Link className="rowlink" to={`/inventory/stock/${p.id}`}>{p.name}</Link></td>
                            <td className="num">{qtyU(p.qty, p.unit)}</td>
                            <td className={`num ${Number(p.on_hand) < 0 ? 'neg' : ''}`}>{qtyU(p.on_hand, p.unit)}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                  <div className="hint">{t('day.outHint')}</div>
                </section>
                <section className="card daycard">
                  <h2 className="sectionlabel" style={{ marginTop: 0 }}>{t('day.inTitle')}</h2>
                  {d.parts_in.length === 0 ? <div className="muted small">{t('day.inNone')}</div> : (
                    <div className="table compact flush">
                      <table>
                        <thead><tr><th>{t('day.col.po')}</th><th>{t('day.col.supplier')}</th><th>{t('day.col.part')}</th><th className="num">{t('day.col.qty')}</th>
                          {d.costs && <th className="num">{t('day.col.value')}</th>}</tr></thead>
                        <tbody>
                          {d.parts_in.map((p, i) => (
                            <tr key={`${p.po_id}-${i}`}>
                              <td className="nowrap"><Link className="rowlink" to={`/inventory/purchase-orders/${p.po_id}`}>{p.po_number}</Link>
                                {p.job_number && <div className="muted small">#{jobNo(p.job_number)}</div>}</td>
                              <td>{p.supplier || '—'}</td>
                              <td>{p.name}</td>
                              <td className="num">{qtyU(p.qty, p.unit)}</td>
                              {d.costs && <td className="num">{rp(p.value)}</td>}
                            </tr>
                          ))}
                          {d.costs && d.parts_in.length > 1 && <tr className="totalrow"><td colSpan={4}><b>{t('day.total')}</b></td><td className="num"><b>{rp(sumOf(d.parts_in, (p) => p.value))}</b></td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </div>
    </Page>
  )
}

function Tile({ label, value, note, warn, danger }) {
  return (
    <div className={`card dashtile ${danger ? 'danger' : warn ? 'warn' : ''}`}>
      <div className="dashtile-head"><span>{label}</span></div>
      <div className="dashtile-value">{value}</div>
      {note && <div className="dashtile-note">{note}</div>}
    </div>
  )
}
