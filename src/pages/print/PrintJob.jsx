import React, { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useShop } from '../../context/ShopContext'
import { useT, translate } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { fmtDate, invoiceNo, jobNo, km, num, rp } from '../../lib/format'
import { vehicleName } from '../../lib/customers'
import { lineAmount, lineDiscount, lineNet } from '../../lib/jobs'
import { useJobData, useStaff } from '../jobs/useJobData'
import { nextDue } from '../../lib/schedules'

// /print/jobs/<id>?doc=estimate|invoice&lang=id|en : a printable A4 estimate or invoice.
// Labels follow the print language; names, notes and concerns print exactly as entered.
export default function PrintJob() {
  const location = useLocation()
  const navigate = useNavigate()
  const id = location.pathname.split('/').filter(Boolean)[2]
  const params = new URLSearchParams(location.search)
  const { t: tUi } = useT()
  const { settings, logoUrl, timezone } = useShop()
  const { job, error, missing } = useJobData(id)
  const staff = useStaff()

  useEffect(() => { document.title = 'Axle' }, [])
  if (missing) return <div className="print-msg">{tUi('job.notFound')} · <Link to="/customers/repair-orders">{tUi('job.backToList')}</Link></div>
  if (!job || !settings) return <div className="print-msg">{error ? errorText(error, tUi) : tUi('common.loading')}</div>

  const ro = job.ro
  const invoiced = ro.order_status === 'invoice'
  // The vehicle's next services (from its service schedules), printed on the invoice for the fleet.
  const nextServices = (job.schedules || []).filter((x) => x.active).map((x) => ({ x, due: nextDue(x) })).filter(({ due }) => due.km != null || due.date)
  const doc = params.get('doc') === 'invoice' && invoiced ? 'invoice' : 'estimate'
  const lang = params.get('lang') || ro.print_language || settings.default_print_language || 'id'
  const t = (key, vars) => translate(lang, key, vars)
  const setParam = (k, v) => { const p = new URLSearchParams(location.search); p.set(k, v); navigate(`${location.pathname}?${p.toString()}`, { replace: true }) }

  // An issued invoice prints what was frozen at invoicing: the shop details and the bill-to.
  const shop = doc === 'invoice' && ro.shop_snapshot ? { ...settings, ...ro.shop_snapshot } : settings
  const snap = doc === 'invoice' ? ro.bill_to_snapshot : null
  const bill = snap || {
    display_name: job.customer?.display_name, legal_name: job.customer?.legal_name, npwp: job.customer?.npwp,
    billing_address: job.customer?.billing_address, phone: job.customer?.phone, email: job.customer?.email,
    contact: (job.contacts.find((c) => c.is_primary) || job.contacts[0])?.name,
  }
  const veh = snap?.vehicle || job.vehicle || {}
  const taxRate = shop.pkp_status === 'non_pkp' ? 0 : Number(shop.tax_rate ?? 11)
  const taxName = shop.tax_name || 'PPN'
  const billed = job.services.filter((s) => (doc === 'invoice' ? s.approval_status === 'approved' : s.approval_status === 'approved' || s.approval_status === 'pending'))
  const notIncluded = job.services.filter((s) => s.approval_status === 'declined' || s.approval_status === 'deferred')
  const terms = lang === 'en' ? shop.terms_en : shop.terms_id
  const advisor = staff.find((p) => p.id === ro.service_advisor_id)?.name
  const title = doc === 'invoice' ? t('pr.invoice') : t('pr.estimate')

  return (
    <div className="print-wrap">
      <div className="print-bar no-print">
        <Link className="btn" to={`/jobs/${ro.id}`}>← {tUi('pr.back')}</Link>
        <div className="seg">
          <button type="button" className={`seg-btn ${doc === 'estimate' ? 'on' : ''}`} onClick={() => setParam('doc', 'estimate')}>{tUi('pr.estimateUi')}</button>
          <button type="button" className={`seg-btn ${doc === 'invoice' ? 'on' : ''}`} disabled={!invoiced} title={!invoiced ? tUi('pr.notInvoiced') : undefined} onClick={() => setParam('doc', 'invoice')}>{tUi('pr.invoiceUi')}</button>
        </div>
        <div className="seg">
          <button type="button" className={`seg-btn ${lang === 'id' ? 'on' : ''}`} onClick={() => setParam('lang', 'id')}>Bahasa Indonesia</button>
          <button type="button" className={`seg-btn ${lang === 'en' ? 'on' : ''}`} onClick={() => setParam('lang', 'en')}>English</button>
        </div>
        <div className="spacer" />
        <button type="button" className="btn primary" onClick={() => window.print()}>{tUi('job.print')}</button>
      </div>

      <article className="doc" aria-label={title}>
        <header className="doc-head">
          <div className="doc-shop">
            {logoUrl && <img src={logoUrl} alt="" className="doc-logo" />}
            <div>
              <div className="doc-shopname">{shop.legal_name || shop.shop_name || 'Axle'}</div>
              {shop.address && <div className="pre">{shop.address}</div>}
              <div>{[shop.phone, shop.email].filter(Boolean).join(' · ')}</div>
              {shop.npwp && <div>NPWP {shop.npwp}</div>}
            </div>
          </div>
          <div className="doc-title">
            <h1>{title}</h1>
            <table className="doc-meta">
              <tbody>
                {doc === 'invoice' ? (
                  <>
                    <tr><th>{t('pr.invoiceNo')}</th><td><b>{invoiceNo(ro.invoice_number)}</b></td></tr>
                    <tr><th>{t('pr.date')}</th><td>{fmtDate(ro.invoiced_at, lang, timezone)}</td></tr>
                    <tr><th>{t('pr.due')}</th><td><b>{fmtDate(ro.due_date, lang)}</b></td></tr>
                    <tr><th>{t('pr.jobNo')}</th><td>{jobNo(ro.job_number)}</td></tr>
                    {ro.faktur_pajak_number && <tr><th>{t('pr.faktur')}</th><td>{ro.faktur_pajak_number}</td></tr>}
                  </>
                ) : (
                  <>
                    <tr><th>{t('pr.estimateNo')}</th><td><b>{jobNo(ro.job_number)}</b></td></tr>
                    <tr><th>{t('pr.date')}</th><td>{fmtDate(new Date().toISOString(), lang, timezone)}</td></tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </header>

        <section className="doc-parties">
          <div>
            <div className="doc-label">{doc === 'invoice' ? t('pr.billTo') : t('pr.customer')}</div>
            <b>{bill.legal_name || bill.display_name}</b>
            {bill.billing_address && <div className="pre">{bill.billing_address}</div>}
            {bill.npwp && <div>NPWP {bill.npwp}</div>}
            {bill.contact && <div>{t('pr.attn', { name: bill.contact })}</div>}
            {(bill.phone || bill.email) && <div>{[bill.phone, bill.email].filter(Boolean).join(' · ')}</div>}
          </div>
          <div>
            <div className="doc-label">{t('pr.vehicle')}</div>
            <b>{veh.plate}</b> · {vehicleName(veh) || '—'}
            {veh.vin && <div>VIN {veh.vin}</div>}
            <div>{t('pr.odometer')}: {ro.odometer_in != null ? km(ro.odometer_in) : '—'}{ro.odometer_out != null ? ` → ${km(ro.odometer_out)}` : ''}</div>
          </div>
        </section>

        {job.concerns.length > 0 && (
          <section className="doc-block">
            <div className="doc-label">{t('pr.concerns')}</div>
            <ul className="doc-list">{job.concerns.map((c) => <li key={c.id}>{c.text}</li>)}</ul>
          </section>
        )}

        <table className="doc-lines">
          <thead>
            <tr><th>{t('pr.description')}</th><th className="num">{t('pr.qty')}</th><th className="num">{t('pr.unitPrice')}</th><th className="num">{t('pr.discount')}</th><th className="num">{t('pr.amount')}</th></tr>
          </thead>
          {billed.map((s) => {
            const lines = job.items.filter((l) => l.service_id === s.id)
            const flat = s.flat_price != null
            return (
              <tbody key={s.id} className="doc-svc">
                <tr className="svc-row">
                  <td colSpan={5}>
                    <b>{s.name}</b>
                    {doc === 'estimate' && s.approval_status === 'pending' && <span className="doc-tag">{t('pr.awaiting')}</span>}
                    {s.notes_external && <div className="pre small">{s.notes_external}</div>}
                  </td>
                </tr>
                {lines.map((l) => {
                  const hide = flat || l.show_qty_price === false
                  const disc = lineDiscount(l)
                  return (
                    <React.Fragment key={l.id}>
                      <tr>
                        <td className="ind">{l.name}{l.description && <div className="small muted">{l.description}</div>}</td>
                        <td className="num">{hide && flat ? num(l.qty, 2) : hide ? '' : `${num(l.qty, 2)}${l.item_type === 'labor' ? ` ${t('pr.hrs')}` : ''}`}</td>
                        <td className="num">{hide ? '' : rp(l.price)}</td>
                        <td className="num">{hide || !disc ? '' : `-${rp(disc)}`}</td>
                        <td className="num">{flat ? '' : rp(lineNet(l))}</td>
                      </tr>
                      {Number(l.core_charge) > 0 && (
                        <tr><td className="ind small">{t('pr.coreCharge', { name: l.name })}</td><td className="num">{flat ? '' : num(l.qty, 2)}</td><td className="num">{flat ? '' : rp(l.core_charge)}</td><td /><td className="num">{flat ? '' : rp(Math.round(Number(l.core_charge) * Number(l.qty)))}</td></tr>
                      )}
                    </React.Fragment>
                  )
                })}
                {Number(s.service_discount) > 0 && (
                  <tr><td className="ind">{t('pr.serviceDiscount')}{Number(s.discount_pct) > 0 ? ` (${num(s.discount_pct, 2)}%)` : ''}</td><td /><td /><td /><td className="num">-{rp(s.service_discount)}</td></tr>
                )}
                <tr className="svc-total"><td colSpan={4}>{flat ? t('pr.flatPrice') : t('pr.serviceTotal')}</td><td className="num"><b>{rp(s.service_net)}</b></td></tr>
              </tbody>
            )
          })}
        </table>
        {billed.length === 0 && <div className="doc-empty">{t('pr.noWork')}</div>}

        <section className="doc-bottom">
          <div className="doc-notes">
            {(notIncluded.length > 0 || ro.recommendations) && (
              <div className="doc-block">
                <div className="doc-label">{doc === 'invoice' ? t('pr.recommendations') : t('pr.notIncluded')}</div>
                {notIncluded.length > 0 && (
                  <ul className="doc-list">
                    {notIncluded.map((s) => <li key={s.id}>{s.name} — {rp(s.service_total)} <span className="muted">({t(`pr.st.${s.approval_status}`)})</span></li>)}
                  </ul>
                )}
                {ro.recommendations && <div className="pre">{ro.recommendations}</div>}
              </div>
            )}
            {doc === 'invoice' && nextServices.length > 0 && (
              <div className="doc-block">
                <div className="doc-label">{t('pr.nextService')}</div>
                <ul className="doc-list">
                  {nextServices.map(({ x, due }) => (
                    <li key={x.id}>{x.name} — {[due.km != null ? km(due.km) : null, due.date ? fmtDate(due.date, lang) : null].filter(Boolean).join(t('sch.or'))}</li>
                  ))}
                </ul>
              </div>
            )}
            {shop.bank_details && (
              <div className="doc-block">
                <div className="doc-label">{t('pr.payTo')}</div>
                <div className="pre">{shop.bank_details}</div>
              </div>
            )}
            {shop.pkp_status === 'non_pkp' && <div className="small muted">{t('pr.nonPkp')}</div>}
          </div>
          <table className="doc-totals">
            <tbody>
              {Number(ro.parts_total) > 0 && <tr><th>{t('pr.parts')}</th><td>{rp(ro.parts_total)}</td></tr>}
              {Number(ro.labor_total) > 0 && <tr><th>{t('pr.labor')}</th><td>{rp(ro.labor_total)}</td></tr>}
              {Number(ro.other_total) > 0 && <tr><th>{t('pr.sublet')}</th><td>{rp(ro.other_total)}</td></tr>}
              {Number(ro.service_fees_total) > 0 && <tr><th>{t('pr.fees')}</th><td>{rp(ro.service_fees_total)}</td></tr>}
              {Number(ro.service_discount_total) > 0 && <tr><th>{t('pr.serviceDiscounts')}</th><td>-{rp(ro.service_discount_total)}</td></tr>}
              {job.fees.filter((f) => Number(f.amount) > 0).map((f) => <tr key={f.id}><th>{f.is_shop_supplies ? t('pr.shopSupplies') : f.name}</th><td>{rp(f.amount)}</td></tr>)}
              {job.discounts.filter((d) => Number(d.amount) > 0).map((d) => <tr key={d.id}><th>{d.name}</th><td>-{rp(d.amount)}</td></tr>)}
              <tr className="rule"><th>{t('pr.subtotal')}</th><td>{rp(ro.subtotal)}</td></tr>
              <tr><th>{taxRate > 0 ? t('pr.tax', { tax: taxName, rate: num(taxRate, 2), base: rp(ro.taxable_base) }) : taxName}</th><td>{rp(ro.tax_total)}</td></tr>
              <tr className="grand"><th>{t('pr.total')}</th><td>{rp(ro.total)}</td></tr>
              {Number(ro.paid_total) > 0 && <tr><th>{doc === 'invoice' ? t('pr.paid') : t('pr.deposit')}</th><td>-{rp(ro.paid_total)}</td></tr>}
              {doc === 'invoice' && <tr className="grand"><th>{t('pr.balance')}</th><td>{rp(ro.balance)}</td></tr>}
            </tbody>
          </table>
        </section>

        {terms && <section className="doc-terms pre">{terms}</section>}

        <section className="doc-sign">
          <div><div className="sign-line" />{doc === 'invoice' ? t('pr.receivedBy') : t('pr.approvedBy')}<div className="small muted">{bill.legal_name || bill.display_name}</div></div>
          <div><div className="sign-line" />{t('pr.shopSign')}<div className="small muted">{advisor ? `${advisor} · ` : ''}{shop.shop_name || shop.legal_name}</div></div>
        </section>
        <footer className="doc-foot">{doc === 'estimate' ? t('pr.estimateFoot') : t('pr.invoiceFoot')}</footer>
      </article>
    </div>
  )
}
