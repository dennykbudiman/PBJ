import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Badge, Empty, Notice, PageHead } from '../components/ui'
import Icon from '../components/Icon'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useT } from '../lib/i18n'
import { supabase, errorText } from '../lib/supabase'
import { fmtDate, invoiceNo, jobNo, km, num, rp } from '../lib/format'
import { shopToday, vehicleName } from '../lib/customers'
import { WORKFLOW_COLOR } from '../lib/jobs'

// Home for a customer's fleet manager (migration 133): only the companies linked to the login. What is waiting for
// their decision comes first, then what is in the shop, unpaid invoices and service that is due.
export default function FleetDashboard() {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { profile, fleetCompanies } = useAuth()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)
  const first = (profile?.name || '').split(' ')[0]

  useEffect(() => {
    let live = true
    Promise.all([
      supabase.from('customers').select('id, display_name').order('display_name'),
      supabase.from('vehicles').select('id, customer_id, plate, make, model, year'),
      supabase.from('repair_orders').select('id, job_number, invoice_number, customer_id, vehicle_id, order_status, workflow_status, closed_at, archived_at, created_at, invoiced_at, due_date, total, balance')
        .or('order_status.eq.estimate,balance.gt.0').order('job_number', { ascending: false }),
      supabase.from('ro_services').select('id, ro_id, name, approval_status, service_net').eq('approval_status', 'pending'),
      supabase.from('service_due').select('id, vehicle_id, name, next_due_km, next_due_date, due_status, km_left, days_left').in('due_status', ['overdue', 'due_soon']),
    ]).then((res) => {
      if (!live) return
      const bad = res.find((r) => r.error)
      if (bad) { setError(bad.error); return }
      const [c, v, j, s, due] = res.map((r) => r.data || [])
      setD({
        companies: c,
        company: Object.fromEntries(c.map((x) => [x.id, x])),
        vehicle: Object.fromEntries(v.map((x) => [x.id, x])),
        jobs: j, pending: s, due,
      })
    })
    return () => { live = false }
  }, [])

  if (!fleetCompanies.length) {
    return (
      <Page>
        <PageHead title={t('dash.hello', { name: first })} />
        <div className="card"><Empty icon="info" title={t('fleet.noLinkTitle')}>{t('fleet.noLinkText')}</Empty></div>
      </Page>
    )
  }

  const open = (d?.jobs || []).filter((j) => j.order_status === 'estimate' && !j.closed_at)
  const pendingBy = {}
  for (const s of d?.pending || []) (pendingBy[s.ro_id] ||= []).push(s)
  const waiting = open.filter((j) => pendingBy[j.id]?.length)
  const unpaid = (d?.jobs || []).filter((j) => j.order_status === 'invoice' && Number(j.balance) > 0)
  const owed = unpaid.reduce((a, j) => a + Number(j.balance || 0), 0)
  const overdue = unpaid.filter((j) => j.due_date && j.due_date < today)
  const veh = (id) => d?.vehicle[id]
  const company = (id) => d?.company[id]?.display_name || '—'
  const go = (j) => navigate(`/jobs/${j.id}`)

  return (
    <Page>
      <PageHead title={t('dash.hello', { name: first })} sub={d ? d.companies.map((c) => c.display_name).join(' · ') : t('common.loading')} />
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!d ? !error && <div className="muted">{t('common.loading')}</div> : (
        <>
          <div className="dashgrid">
            <Tile href="#fleet-waiting" icon="check" label={t('fleet.waitingTile')} value={num(waiting.length)}
              note={waiting.length ? t('fleet.waitingNote', { n: d.pending.length }) : t('fleet.nothingWaiting')} warn={waiting.length > 0} />
            <Tile to="/customers/repair-orders" icon="wrench" label={t('fleet.inShop')} value={num(open.length)} note={t('fleet.inShopNote')} />
            <Tile to="/customers/invoices" icon="receipt" label={t('fleet.owed')} value={rp(owed)}
              note={overdue.length ? t('fleet.overdueNote', { n: overdue.length }) : t('fleet.unpaidNote', { n: unpaid.length })} danger={overdue.length > 0} />
            <Tile to="/customers/service-due" icon="calendar" label={t('fleet.due')} value={num(d.due.length)}
              note={t('fleet.dueNote', { n: d.due.filter((x) => x.due_status === 'overdue').length })} warn={d.due.some((x) => x.due_status === 'overdue')} />
          </div>

          <h2 className="dash-h" id="fleet-waiting">{t('fleet.waitingTitle')}</h2>
          {waiting.length === 0 ? <div className="card"><Empty icon="check" title={t('fleet.nothingWaiting')}>{t('fleet.nothingWaitingText')}</Empty></div> : (
            <div className="table">
              <table>
                <thead><tr><th>{t('jobs.col.job')}</th><th>{t('job.vehicle')}</th><th>{t('job.company')}</th><th>{t('fleet.col.waiting')}</th><th className="num">{t('fleet.col.value')}</th><th /></tr></thead>
                <tbody>
                  {waiting.map((j) => {
                    const ss = pendingBy[j.id]
                    const v = veh(j.vehicle_id)
                    return (
                      <tr key={j.id} className="click" onClick={() => go(j)}>
                        <td><Link className="rowlink" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>#{jobNo(j.job_number)}</Link></td>
                        <td><b>{v?.plate}</b> <span className="muted small">{v ? vehicleName(v) : ''}</span></td>
                        <td>{company(j.customer_id)}</td>
                        <td>{ss.map((s) => s.name).join(', ')}</td>
                        <td className="num">{rp(ss.reduce((a, s) => a + Number(s.service_net || 0), 0))}</td>
                        <td className="num"><Link className="btn sm primary" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>{t('fleet.review')}</Link></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="dash-h">{t('fleet.inShopTitle')}</h2>
          {open.length === 0 ? <div className="card"><Empty icon="wrench" title={t('fleet.nothingInShop')} /></div> : (
            <div className="table">
              <table>
                <thead><tr><th>{t('jobs.col.job')}</th><th>{t('job.vehicle')}</th><th>{t('job.company')}</th><th className="wide-only">{t('jobs.col.created')}</th><th>{t('job.workflow')}</th><th className="num">{t('job.total')}</th></tr></thead>
                <tbody>
                  {open.map((j) => {
                    const v = veh(j.vehicle_id)
                    return (
                      <tr key={j.id} className="click" onClick={() => go(j)}>
                        <td><Link className="rowlink" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>#{jobNo(j.job_number)}</Link></td>
                        <td><b>{v?.plate}</b> <span className="muted small">{v ? vehicleName(v) : ''}</span></td>
                        <td>{company(j.customer_id)}</td>
                        <td className="wide-only muted">{fmtDate(j.created_at, lang, timezone)}</td>
                        <td><Badge color={WORKFLOW_COLOR[j.workflow_status]}>{t(`job.wf.${j.workflow_status}`)}</Badge></td>
                        <td className="num">{rp(j.total)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {unpaid.length > 0 && (
            <>
              <h2 className="dash-h">{t('fleet.unpaidTitle')}</h2>
              <div className="table">
                <table>
                  <thead><tr><th>{t('jobs.col.invoice')}</th><th>{t('job.vehicle')}</th><th>{t('job.company')}</th><th>{t('fleet.col.due')}</th><th className="num">{t('fleet.col.balance')}</th></tr></thead>
                  <tbody>
                    {unpaid.map((j) => {
                      const v = veh(j.vehicle_id)
                      const late = j.due_date && j.due_date < today
                      return (
                        <tr key={j.id} className="click" onClick={() => go(j)}>
                          <td><Link className="rowlink" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>{invoiceNo(j.invoice_number)}</Link></td>
                          <td><b>{v?.plate}</b></td>
                          <td>{company(j.customer_id)}</td>
                          <td>{fmtDate(j.due_date, lang)} {late && <Badge color="red">{t('fleet.overdue')}</Badge>}</td>
                          <td className="num"><b>{rp(j.balance)}</b></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {d.due.length > 0 && (
            <>
              <h2 className="dash-h">{t('fleet.dueTitle')}</h2>
              <div className="table">
                <table>
                  <thead><tr><th>{t('job.vehicle')}</th><th>{t('fleet.col.service')}</th><th>{t('fleet.col.dueAt')}</th><th>{t('fleet.col.status')}</th></tr></thead>
                  <tbody>
                    {d.due.map((x) => {
                      const v = veh(x.vehicle_id)
                      return (
                        <tr key={x.id} className="click" onClick={() => navigate(`/customers/vehicles/${x.vehicle_id}`)}>
                          <td><b>{v?.plate}</b> <span className="muted small">{v ? vehicleName(v) : ''}</span></td>
                          <td>{x.name}</td>
                          <td>{[x.next_due_km != null ? km(x.next_due_km) : null, x.next_due_date ? fmtDate(x.next_due_date, lang) : null].filter(Boolean).join(' · ') || '—'}</td>
                          <td><Badge color={x.due_status === 'overdue' ? 'red' : 'amber'}>{t(x.due_status === 'overdue' ? 'fleet.overdue' : 'fleet.soon')}</Badge></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="hint">{t('fleet.dueHint')}</div>
            </>
          )}
        </>
      )}
    </Page>
  )
}

function Tile({ to, href, icon, label, value, note, warn, danger }) {
  const body = (
    <>
      <div className="dashtile-head"><Icon name={icon} size={15} /><span>{label}</span></div>
      <div className="dashtile-value">{value}</div>
      {note && <div className="dashtile-note">{note}</div>}
    </>
  )
  const cls = `card dashtile ${danger ? 'danger' : warn ? 'warn' : ''}`
  return href ? <a href={href} className={cls}>{body}</a> : <Link to={to} className={cls}>{body}</Link>
}
