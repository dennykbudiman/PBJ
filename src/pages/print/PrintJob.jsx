import React, { useEffect } from 'react'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useShop } from '../../context/ShopContext'
import { useT, translate } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { fmtDate, invoiceNo, jobNo, km, num, rp } from '../../lib/format'
import { vehicleName } from '../../lib/customers'
import { lineAmount, lineDiscount, lineNet } from '../../lib/jobs'
import { useJobData, useStaff } from '../jobs/useJobData'
import { payerBookLabel } from '../../lib/books'
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

  // Tab title, also the suggested PDF file name: "Invoice 000006 · B 9240 CCI".
  const docEarly = params.get('doc') === 'invoice' && job?.ro?.order_status === 'invoice' ? 'invoice' : 'estimate'
  usePageTitle(job ? [docEarly === 'invoice' ? `${tUi('pr.invoiceUi')} ${invoiceNo(job.ro.invoice_number)}` : `${tUi('pr.estimateUi')} ${jobNo(job.ro.job_number)}`, (docEarly === 'invoice' && job.ro.bill_to_snapshot?.vehicle?.plate) || job.vehicle?.plate].filter(Boolean).join(' · ') : null, { alone: true })
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

  // An issued invoice prints what was frozen at invoicing: the shop details (incl. the tax rate, also on an estimate
  // printed from it, whose amounts are the invoiced ones) and the bill-to.
  const shop = invoiced && ro.shop_snapshot ? { ...settings, ...ro.shop_snapshot } : settings
  const snap = doc === 'invoice' ? ro.bill_to_snapshot : null
  const bill = snap || {
    display_name: job.customer?.display_name, legal_name: job.customer?.legal_name, npwp: job.customer?.npwp,
    billing_address: job.customer?.billing_address, phone: job.customer?.phone, email: job.customer?.email,
    contact: (job.contacts.find((c) => c.is_primary) || job.contacts[0])?.name,
  }
  const veh = snap?.vehicle || job.vehicle || {}
  // the paying PT and the book (143): kept with the invoice; an older invoice or an estimate uses the company's now
  const groupCo = snap?.paid_direct ?? job.customer?.paid_direct
  const payerName = snap?.payer || job.customer?.payer_name?.trim() || job.customer?.display_name || ''
  const bookName = snap?.book || job.customer?.book_name?.trim() || job.customer?.display_name || ''
  const box = doc === 'invoice' ? job.drumBox : null
  const taxRate = shop.pkp_status === 'non_pkp' ? 0 : Number(shop.tax_rate ?? 11)
  const taxName = shop.tax_name || 'PPN'
  const billed = job.services.filter((s) => (doc === 'invoice' ? s.approval_status === 'approved' : s.approval_status === 'approved' || s.approval_status === 'pending'))
  const notIncluded = job.services.filter((s) => s.approval_status === 'declined' || s.approval_status === 'deferred')
  const terms = lang === 'en' ? shop.terms_en : shop.terms_id
  const advisor = staff.find((p) => p.id === ro.service_advisor_id)?.name
  // Everyone who worked on the billed services, in order.
  const mechanics = [...new Set(billed.map((s) => s.technician_id).filter(Boolean))].map((id) => staff.find((p) => p.id === id)?.name).filter(Boolean).join(', ')
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
              <div className="doc-shopname">{shop.shop_name || shop.legal_name}</div>
              {shop.legal_name && shop.legal_name !== shop.shop_name && <div>{shop.legal_name}</div>}
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
            <b>{bill.display_name || bill.legal_name}</b>
            {bill.legal_name && bill.legal_name !== bill.display_name && <div>{bill.legal_name}</div>}
            {bill.billing_address && <div className="pre">{bill.billing_address}</div>}
            {bill.npwp && <div>NPWP {bill.npwp}</div>}
            {bill.contact && <div>{t('pr.attn', { name: bill.contact })}</div>}
            {(bill.phone || bill.email) && <div>{[bill.phone, bill.email].filter(Boolean).join(' · ')}</div>}
            {groupCo && payerName && payerName !== (bill.display_name || bill.legal_name) && <div>{t('u143.payerLine', { payer: payerName })}</div>}
            {groupCo && bookName && <div>{t('u143.book')}: <b>{bookName}</b></div>}
          </div>
          <div>
            <div className="doc-label">{t('pr.vehicle')}</div>
            <b>{veh.plate}</b> · {vehicleName(veh) || '—'}
            {veh.vin && <div>VIN {veh.vin}</div>}
            <div>{t('pr.odometer')}: {(ro.odometer_in ?? ro.odometer_out) != null ? km(ro.odometer_in ?? ro.odometer_out) : ro.km_unreadable ? t('u143.kmUnreadablePrint') : '—'}</div>
            {(ro.driver_name || ro.driver_phone) && <div>{t('pr.driver')}: {[ro.driver_name, ro.driver_phone].filter(Boolean).join(' · ')}</div>}
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
            const flat = s.is_flat ?? s.flat_price != null
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
                        <td className="num">{flat ? '' : l.item_type === 'labor' && Number(ro.labor_waived) > 0 && Number(lineNet(l)) > 0
                          ? <><span className="small">{t('u142.notCharged')}</span><div>{rp(0)}</div></> : rp(lineNet(l))}</td>
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
              {(Number(ro.labor_total) > 0 || Number(ro.labor_waived) > 0) && <tr><th>{t('pr.labor')}</th><td>{rp(ro.labor_total)}</td></tr>}
              {Number(ro.other_total) > 0 && <tr><th>{t('pr.sublet')}</th><td>{rp(ro.other_total)}</td></tr>}
              {Number(ro.service_fees_total) > 0 && <tr><th>{t('pr.fees')}</th><td>{rp(ro.service_fees_total)}</td></tr>}
              {Number(ro.service_discount_total) > 0 && <tr><th>{t('pr.serviceDiscounts')}</th><td>-{rp(ro.service_discount_total)}</td></tr>}
              {job.fees.filter((f) => Number(f.amount) > 0).map((f) => <tr key={f.id}><th>{f.is_shop_supplies ? t('pr.shopSupplies') : f.name}</th><td>{rp(f.amount)}</td></tr>)}
              {job.discounts.filter((d) => Number(d.amount) > 0).map((d) => <tr key={d.id}><th>{d.name}</th><td>-{rp(d.amount)}</td></tr>)}
              <tr className="rule"><th>{t('pr.subtotal')}</th><td>{rp(ro.subtotal)}</td></tr>
              {/* No PPN charged: the line is left out (Denny, Nov 5). */}
              {Number(ro.tax_total) !== 0 && <tr><th>{taxRate > 0 ? t('pr.tax', { tax: taxName, rate: num(taxRate, 2), base: rp(ro.taxable_base) }) : taxName}</th><td>{rp(ro.tax_total)}</td></tr>}
              <tr className="grand"><th>{t('pr.total')}</th><td>{rp(ro.total)}</td></tr>
              {/* parts and outside work the PT pays its suppliers for directly (142) */}
              {Number(ro.settled_direct) > 0 && <tr><th>{t('u142.settledRow', { payer: payerName || 'PT' })}</th><td>-{rp(ro.settled_direct)}</td></tr>}
              {Number(ro.paid_total) > 0 && <tr><th>{doc === 'invoice' ? t('pr.paid') : t('pr.deposit')}</th><td>-{rp(ro.paid_total)}</td></tr>}
              {doc === 'invoice' && <tr className="grand"><th>{t('pr.balance')}</th><td>{rp(ro.balance)}</td></tr>}
              {Number(ro.labor_waived) > 0 && <tr className="small"><th>{t('u142.labourWaivedPrint')}</th><td>{rp(ro.labor_waived)}</td></tr>}
            </tbody>
          </table>
        </section>

        {/* drum oil (143): which drum it came from and whom to pay for it */}
        {box && (box.lines || []).length > 0 && (
          <section className="doc-block doc-drums">
            <div className="doc-label">{t('u143.drumBoxTitle')}</div>
            <table className="doc-lines compact">
              <thead><tr><th>{t('pr.description')}</th><th>{t('u143.drumCol')}</th><th className="num">{t('pr.qty')}</th><th className="num">{t('u143.perLCol')}</th><th className="num">{t('pr.amount')}</th><th>{t('u143.payCol')}</th></tr></thead>
              <tbody>
                {box.lines.map((l, i) => (
                  <tr key={`${l.line_id}-${l.drum_id}-${i}`}>
                    <td>{l.name}</td>
                    <td>{payerBookLabel(l.drum_payer, l.drum_book)}<div className="small muted">{t('u143.openedOn', { date: fmtDate(l.opened_on, lang) })}</div></td>
                    <td className="num">{num(l.litres, 2)} {l.unit || 'L'}</td>
                    <td className="num">{rp(l.cost_per_l)}{l.estimated && <div className="small muted">{t('u143.estimatePrint')}</div>}</td>
                    <td className="num">{rp(l.amount)}</td>
                    <td>{l.pay ? <b>{t('u143.payTo', { who: payerBookLabel(l.drum_payer, l.drum_book) })}</b> : <span className="muted">{t('u143.ownDrum')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(box.to_pay || []).length > 0 ? (box.to_pay || []).map((x) => (
              <div key={`${x.payer}|${x.book || ''}`}><b>{t('u143.drumPayLine', { amount: rp(x.amount), who: payerBookLabel(x.payer, x.book) })}</b>{x.estimated && <span className="small muted"> {t('u143.estimatePrint')}</span>}</div>
            )) : <div className="small muted">{t('u143.drumNothingToPay')}</div>}
          </section>
        )}

        {terms && <section className="doc-terms pre">{terms}</section>}

        {doc === 'invoice' ? (
          // Invoice (Nov 4, Denny): service advisor, mechanic, driver and management sign; names printed where known.
          <section className="doc-sign four">
            {[['pr.sign.advisor', advisor], ['pr.sign.mechanic', mechanics], ['pr.sign.driver', ro.driver_name || veh.driver_name || job.vehicle?.driver_name], ['pr.sign.boss', '']].map(([k, name]) => (
              <div key={k}><div className="sign-line" />{t(k)}<div className="small muted sign-name">{name || ''}</div></div>
            ))}
          </section>
        ) : (
          <section className="doc-sign">
            <div><div className="sign-line" />{t('pr.approvedBy')}<div className="small muted">{bill.display_name || bill.legal_name}</div></div>
            <div><div className="sign-line" />{t('pr.shopSign')}<div className="small muted">{advisor ? `${advisor} · ` : ''}{shop.shop_name || shop.legal_name}</div></div>
          </section>
        )}
        <footer className="doc-foot">{doc === 'estimate' ? t('pr.estimateFoot') : t('pr.invoiceFoot')}</footer>
        <PrintedBy lang={lang} timezone={timezone} />
      </article>
    </div>
  )
}
