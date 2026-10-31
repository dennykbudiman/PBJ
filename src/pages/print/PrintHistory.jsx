import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { useT, translate } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { fmtDate, invoiceNo, km, num, rp } from '../../lib/format'
import { shopToday, vehicleName } from '../../lib/customers'
import { downloadCsv } from '../../lib/reports'
import { historyCsv, loadHistory, serviceMoney } from '../../lib/history'

// /print/history?vehicle=<id>                 one vehicle's service history
// /print/history?company=<id>&doc=list        a company's vehicles
// /print/history?company=<id>&doc=fleet       a company's vehicles with their service history
// Optional: &lang=id|en, &prices=0. A4, printed (or saved as PDF) from the browser; "Download" gives the same as CSV.
export default function PrintHistory() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const vehicleId = params.get('vehicle')
  const companyId = params.get('company')
  const doc = vehicleId ? 'history' : params.get('doc') === 'list' ? 'list' : 'fleet'
  const { t: tUi } = useT()
  const { can, isFleet } = useAuth()
  const { settings, logoUrl, timezone } = useShop()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const mayPrice = can('view_reports') || isFleet
  const prices = mayPrice && params.get('prices') !== '0' && doc !== 'list'
  const lang = params.get('lang') || settings?.default_print_language || 'id'
  const t = (key, vars) => translate(lang, key, vars)
  const setParam = (k, v) => { const p = new URLSearchParams(location.search); p.set(k, v); navigate(`${location.pathname}?${p.toString()}`, { replace: true }) }

  useEffect(() => {
    let live = true
    setData(null); setError(null)
    loadHistory({ vehicleId, companyId, withHistory: doc !== 'list' })
      .then((d) => { if (live) setData(d) })
      .catch((e) => { if (live) setError(e) })
    return () => { live = false }
  }, [vehicleId, companyId, doc])

  if (!vehicleId && !companyId) return <div className="print-msg">{tUi('fh.nothing')}</div>
  if (error) return <div className="print-msg">{errorText(error, tUi)}</div>
  if (!data || !settings) return <div className="print-msg">{tUi('common.loading')}</div>
  if (!data.vehicles.length && vehicleId) return <div className="print-msg">{tUi('fh.noVehicle')}</div>

  const shop = settings
  const back = vehicleId ? `/customers/vehicles/${vehicleId}` : `/customers/${companyId}`
  const title = t(`fh.title.${doc}`)
  const who = data.customer?.display_name || data.customer?.legal_name || '—'
  const today = shopToday(timezone)
  const fileBase = vehicleId ? `axle-history-${(data.vehicles[0].v.plate || '').replace(/\s+/g, '')}` : `axle-${doc === 'list' ? 'vehicles' : 'fleet-history'}-${(data.customer?.display_name || 'company').replace(/[^A-Za-z0-9]+/g, '-')}`
  function csv() {
    const { head, rows } = historyCsv(data, doc, t, lang, prices, timezone)
    downloadCsv(`${fileBase}-${today}.csv`, head, rows)
  }
  const visits = data.vehicles.reduce((a, x) => a + x.jobs.length, 0)

  return (
    <div className="print-wrap">
      <div className="print-bar no-print">
        <Link className="btn" to={back}>← {tUi('fh.ui.back')}</Link>
        {companyId && (
          <div className="seg">
            <button type="button" className={`seg-btn ${doc === 'list' ? 'on' : ''}`} onClick={() => setParam('doc', 'list')}>{tUi('fh.ui.list')}</button>
            <button type="button" className={`seg-btn ${doc === 'fleet' ? 'on' : ''}`} onClick={() => setParam('doc', 'fleet')}>{tUi('fh.ui.fleet')}</button>
          </div>
        )}
        <div className="seg">
          <button type="button" className={`seg-btn ${lang === 'id' ? 'on' : ''}`} onClick={() => setParam('lang', 'id')}>Bahasa Indonesia</button>
          <button type="button" className={`seg-btn ${lang === 'en' ? 'on' : ''}`} onClick={() => setParam('lang', 'en')}>English</button>
        </div>
        {mayPrice && doc !== 'list' && (
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={prices} onChange={(e) => setParam('prices', e.target.checked ? '1' : '0')} /> {tUi('fh.ui.prices')}
          </label>
        )}
        <div className="spacer" />
        <button type="button" className="btn" onClick={csv}>{tUi('fh.ui.download')}</button>
        <button type="button" className="btn primary" onClick={() => window.print()}>{tUi('job.print')}</button>
      </div>

      <article className="doc" aria-label={title}>
        <header className="doc-head">
          <div className="doc-shop">
            {logoUrl && <img src={logoUrl} alt="" className="doc-logo" />}
            <div>
              <div className="doc-shopname">{shop.shop_name || shop.legal_name}</div>
              {shop.legal_name && shop.legal_name !== shop.shop_name && <div>{shop.legal_name}</div>}
              {shop.address && <div className="pre">{shop.address}</div>}
              <div>{[shop.phone, shop.email].filter(Boolean).join(' · ')}</div>
            </div>
          </div>
          <div className="doc-title">
            <h1>{title}</h1>
            <table className="doc-meta">
              <tbody>
                <tr><th>{t('fh.company')}</th><td><b>{who}</b></td></tr>
                <tr><th>{t('fh.printedOn')}</th><td>{fmtDate(today, lang)}</td></tr>
                {doc !== 'history' && <tr><th>{t('fh.vehicles')}</th><td>{num(data.vehicles.length)}</td></tr>}
                {doc !== 'list' && <tr><th>{t('fh.visits')}</th><td>{num(visits)}</td></tr>}
              </tbody>
            </table>
          </div>
        </header>

        {doc !== 'history' && <VehicleTable data={data} t={t} lang={lang} />}
        {doc !== 'list' && data.vehicles.map((x) => (
          <VehicleHistory key={x.v.id} x={x} t={t} lang={lang} tz={timezone} prices={prices} single={doc === 'history'} />
        ))}
        {doc !== 'list' && !visits && <div className="doc-empty">{t('fh.noVisits')}</div>}
        {doc !== 'list' && <div className="doc-terms">{t(doc === 'history' ? 'fh.footVehicle' : 'fh.footCompany')}</div>}
      </article>
    </div>
  )
}

function nextList(next, t, lang) {
  if (!next.length) return '—'
  return next.map((d) => `${d.name}: ${[d.km != null ? km(d.km) : null, d.date ? fmtDate(d.date, lang) : null].filter(Boolean).join(t('fh.or'))}`).join('; ')
}

function VehicleTable({ data, t, lang }) {
  if (!data.vehicles.length) return <div className="doc-empty">{t('fh.noVehicles')}</div>
  return (
    <table className="doc-lines" style={{ marginTop: 12 }}>
      <thead>
        <tr><th>{t('fh.col.plate')}</th><th>{t('fh.col.vehicle')}</th><th>{t('fh.col.vin')}</th><th className="num">{t('fh.col.km')}</th><th>{t('fh.col.status')}</th><th>{t('fh.col.next')}</th></tr>
      </thead>
      <tbody>
        {data.vehicles.map(({ v, next }) => (
          <tr key={v.id} className="svc-row">
            <td><b>{v.plate}</b></td>
            <td>{[vehicleName(v), v.year].filter(Boolean).join(' · ') || '—'}</td>
            <td>{v.vin || '—'}</td>
            <td className="num">{v.mileage_km != null ? km(v.mileage_km) : '—'}</td>
            <td>{t(`veh.st.${v.status}`)}</td>
            <td className="small">{nextList(next, t, lang)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function VehicleHistory({ x, t, lang, tz, prices, single }) {
  const { v, jobs, next } = x
  // the latest reading known: the vehicle's own, or a later one on an invoice
  const lastKm = Math.max(...[v.mileage_km, ...jobs.map(({ ro }) => ro.odometer_out ?? ro.odometer_in)].filter((n) => n != null).map(Number), -1)
  return (
    <section className="doc-block" style={{ marginTop: single ? 12 : 18 }}>
      <div className={single ? 'doc-parties' : ''} style={single ? undefined : { borderTop: '2px solid #111', paddingTop: 8 }}>
        <div>
          <div className="doc-label">{t('fh.vehicle')}</div>
          <b style={{ fontSize: 13 }}>{v.plate}</b> · {[vehicleName(v), v.year].filter(Boolean).join(' · ') || '—'}
          {v.vin && <div>VIN {v.vin}</div>}
          <div>{t('fh.col.km')}: {lastKm >= 0 ? km(lastKm) : '—'}</div>
        </div>
        {single && (
          <div>
            <div className="doc-label">{t('fh.nextService')}</div>
            <div className="small">{nextList(next, t, lang)}</div>
          </div>
        )}
      </div>
      {!single && next.length > 0 && <div className="small muted" style={{ marginTop: 4 }}>{t('fh.nextService')}: {nextList(next, t, lang)}</div>}
      {jobs.length === 0 ? (
        !single && <div className="doc-empty small">{t('fh.noVisitsVehicle')}</div>
      ) : (
        <table className="doc-lines">
          <thead>
            <tr><th>{t('fh.col.date')}</th><th className="num">{t('fh.col.km')}</th><th>{t('fh.col.work')}</th><th className="num">{t('fh.col.qty')}</th>{prices && <th className="num">{t('fh.col.amount')}</th>}</tr>
          </thead>
          {jobs.map(({ ro, billedTo, services }) => (
            <tbody key={ro.id} className="doc-svc">
              <tr className="svc-row">
                <td className="nowrap"><b>{fmtDate(ro.invoiced_at, lang, tz)}</b></td>
                <td className="num"><b>{(ro.odometer_out ?? ro.odometer_in) != null ? km(ro.odometer_out ?? ro.odometer_in) : '—'}</b></td>
                <td>
                  <b>{invoiceNo(ro.invoice_number)}</b>
                  {billedTo && <span className="muted"> · {t('fh.billedTo', { name: billedTo })}</span>}
                </td>
                <td />
                {prices && <td className="num"><b>{ro.total != null ? rp(ro.total) : '—'}</b></td>}
              </tr>
              {services.map(({ s, tech, items }) => {
                const m = serviceMoney(s, items)
                return (
                  <React.Fragment key={s.id}>
                    <tr>
                      <td /><td />
                      <td className="ind"><b>{s.name}</b>{tech && <span className="muted"> · {tech}</span>}</td>
                      <td />
                      {prices && <td className="num">{m.head != null ? rp(m.head) : ''}</td>}
                    </tr>
                    {items.map((i) => (
                      <tr key={i.id} className="small">
                        <td /><td />
                        <td className="ind" style={{ paddingLeft: 28 }}>{i.name} <span className="muted">({t(`fh.type.${i.item_type}`)})</span></td>
                        <td className="num">{num(i.qty, 2)}</td>
                        {prices && <td className="num">{m.line(i) != null ? rp(m.line(i)) : ''}</td>}
                      </tr>
                    ))}
                    {prices && m.discount != null && (
                      <tr className="small">
                        <td /><td />
                        <td className="ind" style={{ paddingLeft: 28 }}>{t('fh.serviceDiscount')}</td>
                        <td />
                        <td className="num">-{rp(-m.discount)}</td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          ))}
        </table>
      )}
    </section>
  )
}
