import React, { useLayoutEffect, useRef, useState } from 'react'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useShop } from '../../context/ShopContext'
import { useT, translate } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { fmtDate, invoiceNo, jobNo, km, num, rp } from '../../lib/format'
import { poTotals } from '../../lib/inventory'
import LeftoverNote from '../../components/LeftoverNote'
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
  // Pages (144): the pieces are measured once at the printed width, then laid out in A4 sheets.
  const [layout, setLayout] = useState(null)
  const measureRef = useRef(null)
  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return undefined
    const key = el.dataset.key
    let gone = false
    const run = () => { if (!gone && measureRef.current === el) setLayout({ key, ...planPages(measure(el), Number(el.querySelector('[data-m="lines"]').dataset.svcs)) }) }
    const ready = document.fonts && document.fonts.ready
    if (ready) ready.then(run, run); else run()
    return () => { gone = true }
  })
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
  // item 41: the drum oil prints on its own sheet after the invoice; "part=oil" prints that sheet alone
  const hasOil = !!box && (box.lines || []).length > 0
  const oilOnly = hasOil && params.get('part') === 'oil'
  // item 42: POs of this job the driver paid first (talangan): marked on the lines and under the notes, with
  // whether the driver has been paid back ("Sudah diganti")
  const talanganPos = (job.pos || []).filter((p) => p.talangan_name && p.status !== 'cancelled')
  const talanganOf = (l) => {
    const pl = l.po_item_id && (job.poLines || []).find((x) => x.id === l.po_item_id)
    return pl ? talanganPos.find((p) => p.id === pl.po_id) : null
  }
  // what the driver paid: what came in (with PPN once per PO, 145), else what was ordered
  const talanganAmount = (p) => { const x = poTotals(p, (job.poLines || []).filter((l) => l.po_id === p.id)); return x.delivered || x.total }
  const taxRate = shop.pkp_status === 'non_pkp' ? 0 : Number(shop.tax_rate ?? 11)
  const taxName = shop.tax_name || 'PPN'
  const billed = job.services.filter((s) => (doc === 'invoice' ? s.approval_status === 'approved' : s.approval_status === 'approved' || s.approval_status === 'pending'))
  const notIncluded = job.services.filter((s) => s.approval_status === 'declined' || s.approval_status === 'deferred')
  const terms = lang === 'en' ? shop.terms_en : shop.terms_id
  const advisor = staff.find((p) => p.id === ro.service_advisor_id)?.name
  // Everyone who worked on the billed services, in order.
  const mechanics = [...new Set(billed.map((s) => s.technician_id).filter(Boolean))].map((id) => staff.find((p) => p.id === id)?.name).filter(Boolean).join(', ')
  const title = doc === 'invoice' ? t('pr.invoice') : t('pr.estimate')

  // ---- The pieces of the document; the same markup is measured (hidden) and then laid out in A4 pages (144).
  const docNo = doc === 'invoice' ? invoiceNo(ro.invoice_number) : jobNo(ro.job_number)
  // no Diskon column when nothing on the document has a line discount (145, item 34); its width goes to the others
  const showDisc = billed.some((s) => job.items.some((l) => l.service_id === s.id && Number(lineDiscount(l)) > 0))
  const nc = showDisc ? 5 : 4
  const cols = showDisc
    ? <colgroup><col /><col style={{ width: '9%' }} /><col style={{ width: '15%' }} /><col style={{ width: '11%' }} /><col style={{ width: '16%' }} /></colgroup>
    : <colgroup><col /><col style={{ width: '9%' }} /><col style={{ width: '16%' }} /><col style={{ width: '19%' }} /></colgroup>
  const thead = (
    <thead>
      <tr><th>{t('pr.description')}</th><th className="num">{t('pr.qty')}</th><th className="num">{t('pr.unitPrice')}</th>{showDisc && <th className="num">{t('pr.discount')}</th>}<th className="num">{t('pr.amount')}</th></tr>
    </thead>
  )
  const svcBody = (s) => {
    const lines = job.items.filter((l) => l.service_id === s.id)
    const flat = s.is_flat ?? s.flat_price != null
    return (
      <tbody key={s.id} className="doc-svc">
        <tr className="svc-row">
          <td colSpan={nc}>
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
                <td className="ind">{l.name}{l.description && <div className="small muted">{l.description}</div>}
                  {talanganOf(l) && <div className="small">{t('u146.byDriver', { name: talanganOf(l).talangan_name })}</div>}
                  {/* item 40 (147): taken from a part left over on another job's PO (issued invoices) */}
                  {doc === 'invoice' && job.leftover && !job.leftover.planned && <LeftoverNote leftover={job.leftover} lineId={l.id} t={t} links={false} />}</td>
                <td className="num">{hide && flat ? num(l.qty, 2) : hide ? '' : `${num(l.qty, 2)}${l.item_type === 'labor' ? ` ${t('pr.hrs')}` : ''}`}</td>
                <td className="num">{hide ? '' : rp(l.price)}</td>
                {showDisc && <td className="num">{hide || !disc ? '' : `-${rp(disc)}`}</td>}
                <td className="num">{flat ? '' : l.item_type === 'labor' && Number(ro.labor_waived) > 0 && Number(lineNet(l)) > 0
                  ? <span className="nowrap"><span className="small muted">{t('u142.notCharged')}</span> {rp(0)}</span> : rp(lineNet(l))}</td>
              </tr>
              {Number(l.core_charge) > 0 && (
                <tr><td className="ind small">{t('pr.coreCharge', { name: l.name })}</td><td className="num">{flat ? '' : num(l.qty, 2)}</td><td className="num">{flat ? '' : rp(l.core_charge)}</td>{showDisc && <td />}<td className="num">{flat ? '' : rp(Math.round(Number(l.core_charge) * Number(l.qty)))}</td></tr>
              )}
            </React.Fragment>
          )
        })}
        {Number(s.service_discount) > 0 && (
          <tr><td className="ind">{t('pr.serviceDiscount')}{Number(s.discount_pct) > 0 ? ` (${num(s.discount_pct, 2)}%)` : ''}</td><td /><td />{showDisc && <td />}<td className="num">-{rp(s.service_discount)}</td></tr>
        )}
        <tr className="svc-total"><td colSpan={nc - 1}>{flat ? t('pr.flatPrice') : t('pr.serviceTotal')}</td><td className="num"><b>{rp(s.service_net)}</b></td></tr>
      </tbody>
    )
  }
  const linesTable = (list, head = true) => (
    <table className="doc-lines fixed">{cols}{head && thead}{list.map(svcBody)}</table>
  )

  const head = (
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
  )

  const parties = (
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
  )

  const concerns = job.concerns.length > 0 && (
    <section className="doc-block">
      <div className="doc-label">{t('pr.concerns')}</div>
      <ul className="doc-list">{job.concerns.map((c) => <li key={c.id}>{c.text}</li>)}</ul>
    </section>
  )
  const empty = billed.length === 0 && <div className="doc-empty">{t('pr.noWork')}</div>

  const bottom = (
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
        {talanganPos.length > 0 && (
          <div className="doc-block doc-talangan">
            <div className="doc-label">{t('u146.talanganTitle')}</div>
            {talanganPos.map((p) => (
              <div key={p.id}>
                <b>{t('u146.talanganPo', { no: p.po_number, name: p.talangan_name })}</b>
                {p.talangan_nota && ` · ${t('u146.notaShort', { no: p.talangan_nota })}`}
                {' · '}<span className="nowrap">{rp(talanganAmount(p))}</span>
                {/* the payback is approved in person (Denny, Nov 12): no Belum/Sudah diganti on paper */}
                <div>{t('u145.reimbursedBy', { who: p.paid_by_pt ? [payerName, bookName].filter(Boolean).join(' · ') : t('u145.theShopPays') })}</div>
              </div>
            ))}
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
  )

  // drum oil (143): which drum it came from and whom to pay for it
  const drumPay = (box?.to_pay || []).map((x) => (
    <div key={`${x.payer}|${x.book || ''}`}><b>{t('u143.drumPayLine', { amount: rp(x.amount), who: payerBookLabel(x.payer, x.book) })}</b>{x.estimated && <span className="small muted"> {t('u143.estimatePrint')}</span>}</div>
  ))
  const drum = box && (box.lines || []).length > 0 && (
    <section className="doc-block doc-drums">
      <div className="doc-label">{t('u143.drumBoxTitle')}</div>
      <table className="doc-lines compact fixed">
        <colgroup><col style={{ width: '21%' }} /><col style={{ width: '21%' }} /><col style={{ width: '8%' }} /><col style={{ width: '12%' }} /><col style={{ width: '13%' }} /><col /></colgroup>
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
        <tfoot><tr className="svc-total"><td colSpan={4}>{t('pr.total')}</td><td className="num"><b>{rp(box.lines.reduce((a, l) => a + Number(l.amount || 0), 0))}</b></td><td /></tr></tfoot>
      </table>
      {drumPay.length > 0 ? drumPay : <div className="small muted">{t('u143.drumNothingToPay')}</div>}
    </section>
  )

  const termsBlock = terms && <section className="doc-terms pre">{terms}</section>

  const signs = doc === 'invoice' ? (
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
  )

  // A split document's page 1: the amounts the signatures are for (the drum oil is on its own sheet, item 41).
  const summary = (fullOn) => (
    <section className="doc-summary">
      <div className="doc-notes">
        <div className="doc-label">{t('u144.summary', { page: fullOn })}</div>
      </div>
      <table className="doc-sumtotals">
        <tbody>
          <tr><th>{t('pr.total')}</th><td>{rp(ro.total)}</td></tr>
          {Number(ro.settled_direct) > 0 && <tr><th>{t('u142.settledRow', { payer: payerName || 'PT' })}</th><td>-{rp(ro.settled_direct)}</td></tr>}
          {Number(ro.paid_total) > 0 && <tr><th>{doc === 'invoice' ? t('pr.paid') : t('pr.deposit')}</th><td>-{rp(ro.paid_total)}</td></tr>}
          {doc === 'invoice' && <tr className="grand"><th>{t('pr.balance')}</th><td>{rp(ro.balance)}</td></tr>}
        </tbody>
      </table>
    </section>
  )
  const contNote = (page, n) => <div className="doc-cont">{n > 0 ? t('u144.continued', { page, n }) : t('u144.continuedOnly', { page })}</div>
  const miniHead = (page, pages) => (
    <header className="doc-minihead">
      <div><div className="doc-shopname small-name">{shop.shop_name || shop.legal_name}</div><div className="muted">{[bill.display_name || bill.legal_name, veh.plate].filter(Boolean).join(' · ')}</div></div>
      <div className="doc-minititle"><b>{title} {docNo}</b><div className="muted">{t('u144.contHead', { page, pages })}</div></div>
    </header>
  )
  const paraf = (
    <section className="doc-paraf">
      {(doc === 'invoice' ? ['u144.parafAdvisor', 'u144.parafDriver'] : ['u144.parafCustomer', 'u144.parafShop']).map((k) => (
        <div key={k}><div className="paraf-box" /><span className="small">{t(k)}</span></div>
      ))}
      <div className="small muted paraf-note">{t('u144.signOnPage1')}</div>
    </section>
  )
  const pageFoot = (page, pages) => (
    <footer className="doc-pagefoot">
      <span className="doc-foot">{doc === 'estimate' ? t('pr.estimateFoot') : t('pr.invoiceFoot')}</span>
      <span className="doc-pageno"><b>{docNo}</b> · {t('u144.pageOf', { page, pages })}</span>
    </footer>
  )

  // item 41: the drum oil sheet, printed after the invoice (or alone)
  const oilSheet = hasOil && (
    <article className="doc sheet doc-oilsheet" aria-label={t('u146.sheetAria')}>
      <div className="sheet-in">
        <header className="doc-head">
          <div className="doc-shop">
            {logoUrl && <img src={logoUrl} alt="" className="doc-logo" />}
            <div>
              <div className="doc-shopname">{shop.shop_name || shop.legal_name}</div>
              {shop.address && <div className="pre">{shop.address}</div>}
              <div>{[shop.phone, shop.email].filter(Boolean).join(' · ')}</div>
            </div>
          </div>
          <div className="doc-title">
            <h1>{t('u146.oilTitle')}</h1>
            <div className="muted">{t('u146.oilSub', { no: docNo })}</div>
            <table className="doc-meta">
              <tbody>
                <tr><th>{t('pr.invoiceNo')}</th><td><b>{docNo}</b></td></tr>
                <tr><th>{t('pr.date')}</th><td>{fmtDate(ro.invoiced_at, lang, timezone)}</td></tr>
                <tr><th>{t('pr.jobNo')}</th><td>{jobNo(ro.job_number)}</td></tr>
              </tbody>
            </table>
          </div>
        </header>
        {parties}
        {drum}
        <div className="sheet-fill" />
        {/* item 45 (Nov 12): the mechanic signs the oil sheet too */}
        <section className="doc-sign three">
          {[['pr.sign.advisor', advisor], ['pr.sign.mechanic', mechanics], ['pr.sign.driver', ro.driver_name || veh.driver_name || job.vehicle?.driver_name]].map(([k, name]) => (
            <div key={k}><div className="sign-line" />{t(k)}<div className="small muted sign-name">{name || ''}</div></div>
          ))}
        </section>
        <footer className="doc-pagefoot">
          <span className="doc-foot" />
          <span className="doc-pageno">{t('u146.oilFoot', { no: docNo })}</span>
        </footer>
        <PrintedBy lang={lang} timezone={timezone} />
      </div>
    </article>
  )

  // What the pages depend on: when any of it changes, the pieces are measured again.
  const pageKey = JSON.stringify([doc, lang, ro.id, ro.updated_at, ro.total, ro.balance, ro.paid_total, ro.settled_direct, job.concerns.map((c) => c.text),
    billed.map((s) => [s.id, s.name, s.notes_external, s.service_net]), job.items.map((l) => [l.id, l.service_id, l.name, l.description, l.qty, l.price, l.discount_pct, l.discount_amount]),
    notIncluded.length, ro.recommendations, (box?.lines || []).length, drumPay.length, terms, !!logoUrl, advisor, mechanics, nextServices.length])
  const plan = layout?.key === pageKey ? layout : null

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
        {hasOil && (
          <div className="seg">
            <button type="button" className={`seg-btn ${!oilOnly ? 'on' : ''}`} onClick={() => setParam('part', 'all')}>{tUi('u146.withOil')}</button>
            <button type="button" className={`seg-btn ${oilOnly ? 'on' : ''}`} onClick={() => setParam('part', 'oil')}>{tUi('u146.oilOnly')}</button>
          </div>
        )}
        <div className="spacer" />
        <button type="button" className="btn primary" disabled={!plan && !oilOnly} onClick={() => window.print()}>{tUi('job.print')}</button>
      </div>

      {!plan && !oilOnly && (
        <>
          <div className="print-msg no-print">{tUi('u144.preparing')}</div>
          {/* hidden: each piece at the printed width, measured once, then removed */}
          <div className="doc doc-measure" ref={measureRef} data-key={pageKey} aria-hidden="true">
            <div data-m="page" style={{ height: SHEET_INNER }} />
            <div data-m="head" className="m-blk">{head}</div>
            <div data-m="parties" className="m-blk">{parties}</div>
            <div data-m="concerns" className="m-blk">{concerns}</div>
            <div data-m="empty" className="m-blk">{empty}</div>
            {/* the services in one table, as printed: each service is its tbody, the rest (head row, table margin) is "thead" */}
            <div data-m="lines" className="m-blk" data-svcs={billed.length}>{billed.length > 0 && linesTable(billed)}</div>
            <div data-m="bottom" className="m-blk">{bottom}</div>
            <div data-m="terms" className="m-blk">{termsBlock}</div>
            <div data-m="sign" className="m-blk">{signs}</div>
            <div data-m="cont" className="m-blk">{contNote(2, 1)}</div>
            <div data-m="summary" className="m-blk">{summary(2)}</div>
            <div data-m="mini" className="m-blk">{miniHead(2, 2)}</div>
            <div data-m="paraf" className="m-blk">{paraf}</div>
            <div data-m="foot" className="m-blk">{pageFoot(1, 2)}</div>
            <div data-m="printed" className="m-blk"><div className="doc-printedby">{translate(lang, 'pr.printedBy', { name: 'Nama Pengguna', when: '10 Nov 2026 12.00' })}</div></div>
          </div>
        </>
      )}

      {plan && !oilOnly && plan.pages.map((pg, i) => {
        const pages = plan.pages.length
        const last = i === pages - 1
        return (
          <article key={i} className="doc sheet" aria-label={pages > 1 ? `${title} · ${t('u144.pageOf', { page: i + 1, pages })}` : title}>
            <div className={`sheet-in${plan.compact ? ' compact' : ''}`}>
              {i === 0 ? (
                <>
                  {head}
                  {parties}
                  {concerns}
                  {pg.svcs.length > 0 && linesTable(pg.svcs.map((k) => billed[k]))}
                  {empty}
                  {(pages === 1 || pg.ends.includes('bottom')) && bottom}
                  {(pages === 1 || pg.ends.includes('terms')) && termsBlock}
                  {pages > 1 && contNote(2, billed.length - pg.svcs.length)}
                  <div className="sheet-fill" />
                  {/* the summary box only when services carry over (145, item 34): otherwise page 1 has the full totals */}
                  {pages > 1 && !pg.ends.includes('bottom') && summary(plan.fullOn)}
                  {signs}
                </>
              ) : (
                <>
                  {miniHead(i + 1, pages)}
                  {pg.svcs.length > 0 && linesTable(pg.svcs.map((k) => billed[k]))}
                  {pg.ends.includes('bottom') && bottom}
                  {pg.ends.includes('terms') && termsBlock}
                  <div className="sheet-fill" />
                  {paraf}
                </>
              )}
              {pageFoot(i + 1, pages)}
              {last && !hasOil && <PrintedBy lang={lang} timezone={timezone} />}
            </div>
          </article>
        )
      })}
      {(plan || oilOnly) && oilSheet}
    </div>
  )
}

// ---- Pages (144) ---------------------------------------------------------------------------------------------------
// A4 with 12 mm top/bottom and 14 mm side margins drawn by each sheet itself (@page has no margin, so the browser adds
// no header or footer). The signatures always stay at the bottom of page 1.
const SHEET_INNER = '273mm'
const COMPACT = 0.92

// Lays the measured pieces out: one page if everything fits (at 92% if needed); otherwise page 1 takes the head, the
// services that fit, a summary and the signatures, and the rest goes on numbered continuation pages.
export function planPages(h, nSvc) {
  const H = h.page - 6 // a little room for rounding
  const g = (k) => h[k] || 0
  const svc = (i) => g(`svc${i}`)
  const svcSum = Array.from({ length: nSvc }, (_, i) => svc(i)).reduce((a, b) => a + b, 0)
  const all = g('head') + g('parties') + g('concerns') + g('empty') + (nSvc ? g('thead') + svcSum : 0) + g('bottom') + g('terms') + g('sign') + g('foot') + g('printed')
  if (all <= H) return { compact: false, pages: [{ svcs: [...Array(nSvc).keys()], ends: [] }], fullOn: 1 }
  if (all * COMPACT <= H) return { compact: true, pages: [{ svcs: [...Array(nSvc).keys()], ends: [] }], fullOn: 1 }

  // every service and the full totals fit on page 1 with the signatures (at 92% if needed): only the terms that don't
  // fit go to page 2, so page 1 needs no summary (145, item 34; the drum oil has its own sheet since item 41)
  const p1 = g('head') + g('parties') + g('concerns') + g('empty') + (nSvc ? g('thead') + svcSum : 0) + g('bottom') + g('cont') + g('sign') + g('foot')
  for (const z of [1, COMPACT]) {
    if (p1 * z > H) continue
    const ends1 = ['bottom'], rest = []
    let used1 = p1
    for (const k of ['terms']) {
      if (!g(k)) continue
      if (!rest.length && (used1 + g(k)) * z <= H) { ends1.push(k); used1 += g(k) } else rest.push(k)
    }
    if (!rest.length) break // (can't happen: everything would have fitted above)
    return { compact: z !== 1, pages: [{ svcs: [...Array(nSvc).keys()], ends: ends1 }, { svcs: [], ends: rest }], fullOn: 1 }
  }

  // page 1
  const fixed1 = g('head') + g('parties') + g('concerns') + g('empty') + g('cont') + g('summary') + g('sign') + g('foot')
  let used = fixed1
  const first = []
  for (let i = 0; i < nSvc; i++) {
    const cost = svc(i) + (first.length ? 0 : g('thead'))
    if (used + cost > H) break
    first.push(i); used += cost
  }
  const pages = [{ svcs: first, ends: [] }]
  // continuation pages: a short head, services, then the totals and the terms; initials at the bottom
  const fixedN = g('mini') + g('paraf') + g('foot') + g('printed')
  let cur = { svcs: [], ends: [] }
  used = fixedN
  const push = () => { pages.push(cur); cur = { svcs: [], ends: [] }; used = fixedN }
  for (let i = first.length; i < nSvc; i++) {
    const cost = svc(i) + (cur.svcs.length ? 0 : g('thead'))
    if (used + cost > H && (cur.svcs.length || cur.ends.length)) push()
    cur.svcs.push(i); used += svc(i) + (cur.svcs.length === 1 ? g('thead') : 0)
  }
  let fullOn = 0
  for (const k of ['bottom', 'terms']) {
    if (!g(k)) continue
    if (used + g(k) > H && (cur.svcs.length || cur.ends.length)) push()
    cur.ends.push(k); used += g(k)
    if (k === 'bottom') fullOn = pages.length + 1
  }
  if (cur.svcs.length || cur.ends.length) pages.push(cur)
  return { compact: false, pages, fullOn: fullOn || pages.length }
}

function measure(el) {
  const h = {}
  for (const x of el.querySelectorAll('[data-m]')) h[x.dataset.m] = x.getBoundingClientRect().height
  const bodies = [...el.querySelectorAll('[data-m="lines"] tbody.doc-svc')].map((x) => x.getBoundingClientRect().height)
  bodies.forEach((v, i) => { h[`svc${i}`] = v })
  h.thead = bodies.length ? h.lines - bodies.reduce((a, v) => a + v, 0) : 0
  return h
}
