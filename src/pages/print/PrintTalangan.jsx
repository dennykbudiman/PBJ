import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { useT, translate } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, jobNo, invoiceNo, num, rp } from '../../lib/format'
import { amountsTotal, poAmounts } from '../../lib/inventory'
import { payerBookLabel } from '../../lib/books'
import { terbilang } from '../../lib/terbilang'

// /print/talangan/<po id>?lang= (145, item 35): "Bukti penggantian biaya" for a driver who paid the supplier first.
// The shop's header, number PG/<PO>, the driver, the truck and job, where it was paid, the lines and the total in
// figures and words, who pays him back and how, a receipt statement and three signature boxes.
export default function PrintTalangan() {
  const location = useLocation()
  const navigate = useNavigate()
  const id = location.pathname.split('/').filter(Boolean)[2]
  const params = new URLSearchParams(location.search)
  const { t: tUi } = useT()
  const { settings, logoUrl, timezone } = useShop()
  const { can } = useAuth()
  const money = can('view_costs') || can('pay_supplier_bills')
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
        supabase.from('suppliers').select('id, name').eq('id', po.data.supplier_id).maybeSingle(),
        po.data.ro_id ? supabase.from('repair_orders').select('id, job_number, invoice_number, vehicle_id, customer_id, odometer_in').eq('id', po.data.ro_id).maybeSingle() : { data: null },
      ])
      const [veh, co] = await Promise.all([
        job.data ? supabase.from('vehicles').select('plate').eq('id', job.data.vehicle_id).maybeSingle() : { data: null },
        job.data ? supabase.from('customers').select('display_name, payer_name, book_name').eq('id', job.data.customer_id).maybeSingle() : { data: null },
      ])
      if (!live) return
      setError(lines.error || sup.error || job.error || null)
      setD({ po: po.data, lines: (lines.data || []).filter((l) => Number(l.qty_delivered) > 0), sup: sup.data, job: job.data, veh: veh.data, co: co.data })
    })()
    return () => { live = false }
  }, [id])
  usePageTitle(d ? `PG/${d.po.po_number}` : null, { alone: true })
  if (error === 'missing') return <div className="print-msg">{tUi('inv.po.notFound')}</div>
  if (!d || !settings) return <div className="print-msg">{error ? errorText(error, tUi) : tUi('common.loading')}</div>
  if (!d.po.talangan_name) return <div className="print-msg">{tUi('u145.notTalangan')} · <Link to={`/inventory/purchase-orders/${d.po.id}`}>{tUi('inv.po.back')}</Link></div>
  if (!money) return <div className="print-msg">{tUi('err.permission')}</div>

  const { po, lines, sup, job, veh, co } = d
  const lang = params.get('lang') || settings.default_print_language || 'id'
  const t = (k, vars) => translate(lang, k, vars)
  const setLang = (v) => { const p = new URLSearchParams(location.search); p.set('lang', v); navigate(`${location.pathname}?${p.toString()}`, { replace: true }) }
  const amounts = poAmounts(lines.map((l) => ({ l, po })), 'delivered')
  const total = amountsTotal(amounts)
  const tax = [...amounts.values()].reduce((a, x) => a + x.tax, 0)
  const payer = po.paid_by_pt ? payerBookLabel(co?.payer_name || co?.display_name, co?.book_name?.trim() || co?.display_name) : (settings.shop_name || settings.legal_name)
  const shop = settings
  const day = lines.map((l) => l.delivered_at).filter(Boolean).sort().pop()

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
      <article className="doc pdoc slip">
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
            <h1>{t('u145.slipTitle')}</h1>
            <table className="doc-meta"><tbody>
              <tr><th>{t('u145.slipNo')}</th><td><b>PG/{po.po_number}</b></td></tr>
              <tr><th>{t('pr.date')}</th><td>{fmtDate(po.reimbursed_on || new Date().toISOString().slice(0, 10), lang, timezone)}</td></tr>
              {job && <tr><th>{t('pr.jobNo')}</th><td>{jobNo(job.job_number)}{job.invoice_number ? ` · ${invoiceNo(job.invoice_number)}` : ''}</td></tr>}
              <tr><th>PO</th><td>{po.po_number}</td></tr>
            </tbody></table>
          </div>
        </header>
        <section className="doc-parties">
          <div><div className="doc-label">{t('u145.paidTo')}</div><b>{po.talangan_name}</b> ({t('u145.driverWord')}){po.talangan_phone && <div>{po.talangan_phone}</div>}</div>
          <div><div className="doc-label">{t('u145.vehicle')}</div><b>{veh?.plate || '—'}</b>{co?.display_name && ` · ${co.display_name}`}{job?.odometer_in != null && <div>{t('u145.odometer', { km: num(job.odometer_in) })}</div>}</div>
        </section>
        <div className="doc-parties one">
          <div><div className="doc-label">{t('u145.paidFirstAt')}</div>{sup?.name || '—'}{day && ` · ${fmtDate(day, lang)}`} · {t('u145.notaNo', { no: po.talangan_nota || '________________' })}</div>
        </div>
        <table className="doc-lines">
          <thead><tr><th style={{ width: 34 }}>No.</th><th>{t('pr.description')}</th><th className="num">{t('pr.qty')}</th><th className="num">{t('pr.unitPrice')}</th><th className="num">{t('pr.amount')}</th></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const a = amounts.get(l.id)
              return <tr key={l.id}><td>{i + 1}</td><td>{l.name}{l.line_type === 'sublet' && <span className="small muted"> · {t('u141.subletNote')}</span>}</td><td className="num">{num(a?.qty, 2)}</td><td className="num">{rp(l.cost)}</td><td className="num">{rp(a?.base)}</td></tr>
            })}
            {tax > 0 && <tr><td /><td>{t('u145.ppn', { rate: num(po.tax_rate, 2) })}</td><td /><td /><td className="num">{rp(tax)}</td></tr>}
            <tr className="slip-total"><td /><td><b>{t('pr.total')}</b></td><td /><td /><td className="num"><b>{rp(total)}</b></td></tr>
          </tbody>
        </table>
        <div className="small" style={{ marginTop: 4 }}><i>{t('u145.terbilang', { words: terbilang(total) })}</i></div>
        <div className="slip-pay">
          <div>{t('u145.reimbursedBy', { who: payer })}</div>
          <div>{t('u145.howPaid')} <span className="chk">{po.reimbursed_method === 'cash' ? '✓' : ''}</span> {t('inv.pay.m.cash')} &nbsp; <span className="chk">{po.reimbursed_method === 'transfer' ? '✓' : ''}</span> {t('u145.transferTo')} <span className="line-fill" /> {t('u145.inName')} <span className="line-fill short" /></div>
          {po.reimbursed_on && <div className="small">{t('u145.reimbursedOn', { date: fmtDate(po.reimbursed_on, lang) })}{po.reimbursed_reference ? ` · ${po.reimbursed_reference}` : ''}</div>}
        </div>
        <p className="small">{t('u145.slipStatement', { amount: rp(total), supplier: sup?.name || '—' })}</p>
        <section className="doc-sign three">
          {[['u145.signReceived', po.talangan_name, t('u145.driverWord')], ['u145.signChecked', '', t('u145.advisorWord')], ['u145.signApproved', '', payer]].map(([k, name, who]) => (
            <div key={k}><div>{t(k)}</div><div className="sign-line" /><b>{name || ' '}</b><div className="small muted">{who}</div><div className="small muted">{t('u145.dateLine')}</div></div>
          ))}
        </section>
        <div className="doc-pagefoot"><span className="doc-foot">{t('u145.slipFoot', { supplier: sup?.name || '—' })}</span><span className="doc-pageno">PG/{po.po_number}</span></div>
        <PrintedBy lang={lang} timezone={timezone} />
      </article>
    </div>
  )
}
