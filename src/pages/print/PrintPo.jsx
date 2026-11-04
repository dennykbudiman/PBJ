import React, { useEffect, useState } from 'react'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { useT, translate } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, jobNo, num, rp } from '../../lib/format'
import { lineAmount, poTotals } from '../../lib/inventory'
import { vehicleName } from '../../lib/customers'

// /print/po/<id>?lang=id|en : a printable A4 purchase order to send to the supplier.
export default function PrintPo() {
  const location = useLocation()
  const navigate = useNavigate()
  const id = location.pathname.split('/').filter(Boolean)[2]
  const params = new URLSearchParams(location.search)
  const { t: tUi } = useT()
  const { settings, logoUrl, timezone } = useShop()
  const { can } = useAuth()
  const money = can('view_costs') || can('pay_supplier_bills')   // prices for people who see costs or pay supplier bills
  const [d, setD] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    ;(async () => {
      const po = await supabase.from('purchase_orders').select('*').eq('id', id).maybeSingle()
      if (!live) return
      if (po.error || !po.data) { setError(po.error || 'missing'); return }
      const [lines, sup, job] = await Promise.all([
        supabase.from('purchase_order_items').select('*').eq('po_id', id).order('created_at').order('id'),
        supabase.from('suppliers').select('*').eq('id', po.data.supplier_id).maybeSingle(),
        po.data.ro_id ? supabase.from('repair_orders').select('id, job_number, vehicle_id, driver_name, service_advisor_id').eq('id', po.data.ro_id).maybeSingle() : { data: null },
      ])
      const [veh, svcs] = await Promise.all([
        job.data ? supabase.from('vehicles').select('plate, year, make, model, driver_name').eq('id', job.data.vehicle_id).maybeSingle() : { data: null },
        job.data ? supabase.from('ro_services').select('technician_id, position').eq('ro_id', job.data.id).order('position') : { data: [] },
      ])
      // Names for the signature boxes: the job's advisor (a stock PO: whoever made it) and the job's mechanics.
      const advisorId = job.data ? job.data.service_advisor_id : po.data.created_by
      const techIds = [...new Set((svcs.data || []).map((s) => s.technician_id).filter(Boolean))]
      const ids = [...new Set([advisorId, ...techIds].filter(Boolean))]
      const people = ids.length ? await supabase.from('profiles').select('id, name').in('id', ids) : { data: [] }
      if (!live) return
      const nameOf = (pid) => (people.data || []).find((x) => x.id === pid)?.name || ''
      setError(lines.error || sup.error || job.error || null)
      setD({ po: po.data, lines: (lines.data || []).filter((l) => Number(l.qty_ordered) > Number(l.qty_cancelled)), sup: sup.data, job: job.data, veh: veh.data,
        advisor: nameOf(advisorId), mechanics: techIds.map(nameOf).filter(Boolean).join(', ') })
    })()
    return () => { live = false }
  }, [id])

  usePageTitle(d ? ['PO ' + d.po.po_number, d.sup?.name].filter(Boolean).join(' · ') : null, { alone: true })
  if (error === 'missing') return <div className="print-msg">{tUi('inv.po.notFound')} · <Link to="/inventory/purchase-orders">{tUi('inv.po.back')}</Link></div>
  if (!d || !settings) return <div className="print-msg">{error ? errorText(error, tUi) : tUi('common.loading')}</div>

  const { po, lines, sup, job, veh, advisor, mechanics } = d
  const lang = params.get('lang') || settings.default_print_language || 'id'
  const t = (key, vars) => translate(lang, key, vars)
  const setLang = (v) => { const p = new URLSearchParams(location.search); p.set('lang', v); navigate(`${location.pathname}?${p.toString()}`, { replace: true }) }
  const shop = settings
  const tot = poTotals(po, lines)
  // A job's PO names the vehicle and its driver (Nov 4, Denny): who brought it in on the job, else the vehicle's driver.
  const driver = job?.driver_name || veh?.driver_name

  return (
    <div className="print-wrap">
      <div className="print-bar no-print">
        <Link className="btn" to={`/inventory/purchase-orders/${po.id}`}>← {tUi('inv.po.back')}</Link>
        <div className="seg">
          <button type="button" className={`seg-btn ${lang === 'id' ? 'on' : ''}`} onClick={() => setLang('id')}>Bahasa Indonesia</button>
          <button type="button" className={`seg-btn ${lang === 'en' ? 'on' : ''}`} onClick={() => setLang('en')}>English</button>
        </div>
        <div className="spacer" />
        <button type="button" className="btn primary" onClick={() => window.print()}>{tUi('job.print')}</button>
      </div>

      <article className="doc" aria-label={t('pr.po.title')}>
        <header className="doc-head">
          <div className="doc-shop">
            {logoUrl && <img src={logoUrl} alt="" className="doc-logo" />}
            <div>
              <div className="doc-shopname">{shop.shop_name || shop.legal_name}</div>
              {shop.legal_name && shop.legal_name !== shop.shop_name && <div>{shop.legal_name}</div>}
              {shop.address && <div className="pre">{shop.address}</div>}
              <div>{[shop.phone, shop.email].filter(Boolean).join(' · ')}</div>
              {shop.npwp && <div>NPWP {shop.npwp}</div>}
            </div>
          </div>
          <div className="doc-title">
            <h1>{t('pr.po.title')}</h1>
            <table className="doc-meta">
              <tbody>
                <tr><th>{t('pr.po.no')}</th><td><b>{po.po_number}</b></td></tr>
                <tr><th>{t('pr.date')}</th><td>{fmtDate(po.ordered_at || po.created_at, lang, timezone)}</td></tr>
                {po.payment_terms_days != null && <tr><th>{t('pr.po.terms')}</th><td>{t('pr.po.termsDays', { n: po.payment_terms_days })}</td></tr>}
                {job && <tr><th>{t('pr.jobNo')}</th><td>{jobNo(job.job_number)}{veh ? ` · ${veh.plate}` : ''}</td></tr>}
              </tbody>
            </table>
          </div>
        </header>

        <section className={`doc-parties ${veh ? 'three' : ''}`}>
          <div>
            <div className="doc-label">{t('pr.po.supplier')}</div>
            <b>{sup?.name}</b>
            {sup?.address && <div className="pre">{sup.address}</div>}
            {sup?.contact_name && <div>{t('pr.attn', { name: sup.contact_name })}</div>}
            {(sup?.phone || sup?.email) && <div>{[sup.phone, sup.email].filter(Boolean).join(' · ')}</div>}
            {sup?.account_number && <div>{t('pr.po.account', { no: sup.account_number })}</div>}
          </div>
          <div>
            <div className="doc-label">{t('pr.po.deliverTo')}</div>
            <b>{shop.shop_name || shop.legal_name}</b>
            {shop.address && <div className="pre">{shop.address}</div>}
            {shop.phone && <div>{shop.phone}</div>}
          </div>
          {veh && (
            <div>
              <div className="doc-label">{t('pr.vehicle')}</div>
              <b>{veh.plate}</b>
              {vehicleName(veh) && <div>{vehicleName(veh)}</div>}
              {driver && <div>{t('pr.driver')}: {driver}</div>}
            </div>
          )}
        </section>

        <table className="doc-lines">
          <thead>
            <tr><th>{t('pr.description')}</th><th>{t('pr.po.partNo')}</th><th className="num">{t('pr.qty')}</th>{money && <th className="num">{t('pr.po.unitCost')}</th>}{money && <th className="num">{t('pr.amount')}</th>}</tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const q = Number(l.qty_ordered) - Number(l.qty_cancelled)
              return (
                <React.Fragment key={l.id}>
                  <tr>
                    <td>{l.name}</td><td>{l.part_number || ''}</td><td className="num">{num(q, 2)}</td>
                    {money && <td className="num">{rp(l.cost)}</td>}{money && <td className="num">{rp(lineAmount(l.cost, 0, q, false, 0))}</td>}
                  </tr>
                  {money && Number(l.core_cost) > 0 && <tr><td className="ind small">{t('pr.coreCharge', { name: l.name })}</td><td /><td className="num">{num(q, 2)}</td><td className="num">{rp(l.core_cost)}</td><td className="num">{rp(lineAmount(0, l.core_cost, q, false, 0))}</td></tr>}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
        {lines.length === 0 && <div className="doc-empty">{t('pr.po.noLines')}</div>}

        <section className="doc-bottom">
          <div className="doc-notes">
            {po.notes && <div className="doc-block"><div className="doc-label">{t('pr.po.notes')}</div><div className="pre">{po.notes}</div></div>}
            <div className="small muted">{t('pr.po.quote', { no: po.po_number })}</div>
          </div>
          {money && <table className="doc-totals">
            <tbody>
              <tr><th>{t('pr.parts')}</th><td>{rp(tot.parts)}</td></tr>
              {tot.core > 0 && <tr><th>{t('pr.po.cores')}</th><td>{rp(tot.core)}</td></tr>}
              <tr><th>{t('pr.po.tax', { tax: shop.tax_name || 'PPN', rate: num(po.tax_rate, 2) })}</th><td>{rp(tot.tax)}</td></tr>
              <tr className="grand"><th>{t('pr.total')}</th><td>{rp(tot.total)}</td></tr>
            </tbody>
          </table>}
        </section>

        {/* Nov 4, Denny: service advisor, mechanic, whoever picks the parts up, and the supplier sign. */}
        <section className="doc-sign four">
          {[['pr.sign.advisor', advisor], ['pr.sign.mechanic', mechanics], ['pr.sign.pickup', ''], ['pr.sign.supplier', sup?.name]].map(([k, name]) => (
            <div key={k}><div className="sign-line" />{t(k)}<div className="small muted sign-name">{name || ''}</div></div>
          ))}
        </section>
        <PrintedBy lang={lang} timezone={timezone} />
      </article>
    </div>
  )
}
