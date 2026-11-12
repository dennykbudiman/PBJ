import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { useT, translate } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { fmtDate, km as fmtKm, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { PERIODS, downloadCsv, periodRange } from '../../lib/reports'
import { fetchAllRows } from '../reports/ReportsArea'

// Item 43 (Nov 12, 2026): "Rekap servis" — what each company's vehicles had done in a period, with prices.
// /print/rekap?from=&to=&payer=&book=&company=&vehicle=&view=sum|inv|lines&kinds=part,labor,sublet,oil,other&page=1&cost=1&lang=
// Laporan → Rekap servis shows the same page inside the app (embedded); "Cetak" opens this page and prints it.
// Rows: report_rekap (146), one per invoiced job line. Staff with view_reports and fleet managers (their companies);
// cost only for Pemilik/Admin.
export const KINDS = ['part', 'labor', 'sublet', 'oil', 'other']
const VIEWS = ['sum', 'inv', 'lines']
const n = (x) => Number(x || 0)

// group rows: company → vehicle → invoice → service → lines; "other" per invoice = invoice total − every line billed
export function buildRekap(rows) {
  const cos = new Map()
  const invs = new Map()
  for (const r of rows) {
    let c = cos.get(r.customer_id)
    if (!c) cos.set(r.customer_id, c = { id: r.customer_id, name: r.company || '—', payer: r.payer, book: r.book, vehicles: new Map() })
    let v = c.vehicles.get(r.vehicle_id)
    if (!v) c.vehicles.set(r.vehicle_id, v = { id: r.vehicle_id, plate: r.plate || '—', name: [r.make, r.model, r.year].filter(Boolean).join(' '), invoices: new Map() })
    let i = v.invoices.get(r.ro_id)
    if (!i) {
      v.invoices.set(r.ro_id, i = { id: r.ro_id, no: r.invoice_no || String(r.invoice_number || ''), date: r.invoiced_on, km: r.km_unreadable ? null : r.km,
        total: n(r.inv_total), services: new Map(), lineSum: 0 })
      invs.set(r.ro_id, i)
    }
    let s = i.services.get(r.service_id)
    if (!s) i.services.set(r.service_id, s = { id: r.service_id, name: r.service_name, pos: r.service_pos, lines: [] })
    s.lines.push(r)
    i.lineSum += n(r.billed)
  }
  for (const i of invs.values()) i.other = Math.round(i.total - i.lineSum)
  return [...cos.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// the money of some invoices for the kinds chosen
function money(invoices, kinds, withCost) {
  const m = { part: 0, labor: 0, laborValue: 0, sublet: 0, oil: 0, other: 0, total: 0, cost: withCost ? 0 : null }
  for (const i of invoices) {
    for (const s of i.services.values()) for (const l of s.lines) {
      const k = l.kind === 'other' ? 'other' : l.kind
      if (!kinds.includes(k)) continue
      if (k !== 'other') m[k] += n(l.billed); else m.other += n(l.billed)
      if (k === 'labor') m.laborValue += n(l.value)
      if (withCost && l.cost != null) m.cost += n(l.cost)
    }
    if (kinds.includes('other')) m.other += i.other
  }
  m.total = m.part + m.labor + m.sublet + m.oil + m.other
  return m
}

export default function PrintRekap({ embedded = false }) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const { t: tUi } = useT()
  const { can, isFleet, roleName } = useAuth()
  const { settings, logoUrl, timezone } = useShop()
  const today = shopToday(timezone)
  const lang = params.get('lang') || settings?.default_print_language || 'id'
  const t = (key, vars) => translate(lang, key, vars)
  const mayCost = !isFleet && (roleName === 'Owner' || roleName === 'Admin')
  const allowed = can('view_reports') || isFleet

  const preset = params.get('period') || (params.get('from') ? 'custom' : 'this_month')
  const range = periodRange(preset, today, { from: params.get('from') || undefined, to: params.get('to') || undefined })
  const valid = [range.from, range.to].every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && x >= '2000-01-01' && x <= '2100-12-31')
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : 'sum'
  const picked = (params.get('kinds') || KINDS.join(',')).split(',')
  const kinds = KINDS.filter((k) => picked.includes(k))   // always in the same order, however they were ticked
  const perPage = params.get('page') === '1'
  const withCost = mayCost && params.get('cost') === '1'
  const f = { payer: params.get('payer') || '', book: params.get('book') || '', company: params.get('company') || '', vehicle: params.get('vehicle') || '' }

  const setParams = (obj) => {
    const p = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(obj)) { if (v == null || v === '') p.delete(k); else p.set(k, v) }
    navigate(`${location.pathname}?${p.toString()}`, { replace: true })
  }

  const [state, setState] = useState({ rows: null, error: null })
  const seq = useRef(0)
  useEffect(() => {
    if (!allowed || !valid) return
    const k = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    fetchAllRows('report_rekap', { p_from: range.from, p_to: range.to }).then(({ data, error }) => {
      if (k === seq.current) setState({ rows: data, error, loading: false })
    })
  }, [range.from, range.to, allowed, valid]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = state.rows || []
  // choices for the filters, each narrowed by the ones before it
  const opts = useMemo(() => {
    const uniq = (list, key, label) => [...new Map(list.map((r) => [r[key], label(r)])).entries()].filter(([k]) => k).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    const r1 = rows.filter((r) => !f.payer || r.payer === f.payer)
    const r2 = r1.filter((r) => !f.book || r.book === f.book)
    const r3 = r2.filter((r) => !f.company || r.customer_id === f.company)
    return { payers: uniq(rows, 'payer', (r) => r.payer), books: uniq(r1, 'book', (r) => r.book), companies: uniq(r2, 'customer_id', (r) => r.company || '—'), vehicles: uniq(r3, 'vehicle_id', (r) => r.plate || '—') }
  }, [rows, f.payer, f.book, f.company]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => rows.filter((r) => (!f.payer || r.payer === f.payer) && (!f.book || r.book === f.book)
    && (!f.company || r.customer_id === f.company) && (!f.vehicle || r.vehicle_id === f.vehicle)), [rows, f.payer, f.book, f.company, f.vehicle])
  const companies = useMemo(() => buildRekap(list), [list])

  // the print page prints by itself when opened from the Laporan tab's "Cetak"
  const printed = useRef(false)
  useEffect(() => {
    if (!embedded && params.get('print') === '1' && state.rows && !printed.current) {
      printed.current = true
      setParams({ print: null })
      setTimeout(() => window.print(), 400)
    }
  }, [state.rows]) // eslint-disable-line react-hooks/exhaustive-deps

  const companyName = opts.companies.find(([id]) => id === f.company)?.[1]
  usePageTitle(embedded ? null : [tUi('u146.rk.title'), companyName].filter(Boolean).join(' · '), { alone: true })
  if (!allowed) return <div className="print-msg">{tUi('rep.noAccessText')}</div>
  if (!settings) return <div className="print-msg">{tUi('common.loading')}</div>

  const showOther = kinds.includes('other') && companies.some((c) => [...c.vehicles.values()].some((v) => [...v.invoices.values()].some((i) => i.other !== 0 || [...i.services.values()].some((s) => s.lines.some((l) => l.kind === 'other')))))
  const cols = kinds.filter((k) => k !== 'other' || showOther)
  const grand = money(companies.flatMap((c) => [...c.vehicles.values()].flatMap((v) => [...v.invoices.values()])), kinds, withCost)
  const filtLabel = [f.payer, f.book, companyName, opts.vehicles.find(([id]) => id === f.vehicle)?.[1]].filter(Boolean).join(' · ')
  const back = params.get('back') || (isFleet ? '/customers' : '/reports/rekap')

  function csv() {
    const head = [t('u146.rk.col.company'), t('u146.rk.col.payer'), t('u146.rk.col.book'), t('u146.rk.col.plate'), t('u146.rk.col.date'), t('u146.rk.col.invoice'), t('u146.rk.col.km'),
      t('u146.rk.col.service'), t('u146.rk.col.line'), t('u146.rk.col.kind'), t('u146.rk.col.qty'), t('u146.rk.col.unit'), t('u146.rk.col.price'), t('u146.rk.col.value'), t('u146.rk.col.billed'),
      ...(withCost ? [t('u146.rk.col.cost')] : [])]
    const out = list.filter((r) => kinds.includes(r.kind)).map((r) => [r.company, r.payer, r.book, r.plate, r.invoiced_on, r.invoice_no, r.km_unreadable ? '' : r.km,
      r.service_name, r.name, t(`u146.rk.k.${r.kind}`), n(r.qty), r.unit || '', n(r.price), n(r.value), n(r.billed), ...(withCost ? [r.cost == null ? '' : n(r.cost)] : [])])
    downloadCsv(`rekap-servis-${range.from}-${range.to}.csv`, head, out)
  }
  const printNow = () => {
    if (!embedded) { window.print(); return }
    const p = new URLSearchParams(location.search); p.set('print', '1'); p.set('back', `${location.pathname}?${location.search.replace(/^\?/, '')}`)
    navigate(`/print/rekap?${p.toString()}`)
  }

  const bar = (
    <div className={embedded ? 'filterbar repbar rekap-bar' : 'print-bar no-print rekap-bar'}>
      {!embedded && <Link className="btn" to={back}>← {tUi('u146.rk.back')}</Link>}
      <select className="select chipselect" value={preset} aria-label={tUi('rep.period')}
        onChange={(e) => setParams(e.target.value === 'custom' ? { period: 'custom', from: range.from, to: range.to } : { period: e.target.value, from: null, to: null })}>
        {PERIODS.map((p) => <option key={p} value={p}>{tUi(`rep.p.${p}`)}</option>)}
      </select>
      {preset === 'custom' && (
        <span className="row" style={{ gap: 6 }}>
          <input type="date" className="input datein" value={range.from} aria-label={tUi('rep.from')} onChange={(e) => e.target.value && setParams({ period: 'custom', from: e.target.value, to: range.to })} />
          <span className="muted">–</span>
          <input type="date" className="input datein" value={range.to} aria-label={tUi('rep.to')} onChange={(e) => e.target.value && setParams({ period: 'custom', from: range.from, to: e.target.value })} />
        </span>
      )}
      <select className="select chipselect" value={f.payer} aria-label={tUi('u146.rk.payer')} onChange={(e) => setParams({ payer: e.target.value, book: null, company: null, vehicle: null })}>
        <option value="">{tUi('u146.rk.allPayers')}</option>{opts.payers.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <select className="select chipselect" value={f.book} aria-label={tUi('u146.rk.book')} onChange={(e) => setParams({ book: e.target.value, company: null, vehicle: null })}>
        <option value="">{tUi('u146.rk.allBooks')}</option>{opts.books.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <select className="select chipselect" value={f.company} aria-label={tUi('rep.company')} onChange={(e) => setParams({ company: e.target.value, vehicle: null })}>
        <option value="">{tUi('rep.allCompanies')}</option>{opts.companies.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        {f.company && !opts.companies.some(([k]) => k === f.company) && <option value={f.company}>{tUi('u146.rk.chosenCompany')}</option>}
      </select>
      <select className="select chipselect" value={f.vehicle} aria-label={tUi('u146.rk.vehicle')} onChange={(e) => setParams({ vehicle: e.target.value })}>
        <option value="">{tUi('u146.rk.allVehicles')}</option>{opts.vehicles.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <div className="seg" role="group" aria-label={tUi('u146.rk.view')}>
        {VIEWS.map((v) => <button key={v} type="button" className={`seg-btn ${view === v ? 'on' : ''}`} onClick={() => setParams({ view: v })}>{tUi(`u146.rk.v.${v}`)}</button>)}
      </div>
      <span className="row wrap" style={{ gap: 10, fontSize: 13 }}>
        {KINDS.map((k) => (
          <label key={k} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setParams({ kinds: (e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k)).filter((x, i, a) => a.indexOf(x) === i).join(',') || 'none' })} /> {tUi(`u146.rk.k.${k}`)}
          </label>
        ))}
        <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={perPage} onChange={(e) => setParams({ page: e.target.checked ? '1' : null })} /> {tUi('u146.rk.perPage')}</label>
        {mayCost && <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={withCost} onChange={(e) => setParams({ cost: e.target.checked ? '1' : null })} /> {tUi('u146.rk.showCost')}</label>}
      </span>
      {!embedded && (
        <div className="seg">
          <button type="button" className={`seg-btn ${lang === 'id' ? 'on' : ''}`} onClick={() => setParams({ lang: 'id' })}>Bahasa Indonesia</button>
          <button type="button" className={`seg-btn ${lang === 'en' ? 'on' : ''}`} onClick={() => setParams({ lang: 'en' })}>English</button>
        </div>
      )}
      <div className="spacer" />
      <button type="button" className="btn" onClick={csv} disabled={!list.length}>{tUi('rep.csv')}</button>
      <button type="button" className="btn primary" onClick={printNow} disabled={!state.rows}>{tUi('job.print')}</button>
    </div>
  )

  const shop = settings
  const doc = (
    <article className={`doc rekap-doc ${embedded ? 'embedded' : ''}`} aria-label={t('u146.rk.title')}>
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
          <h1>{t('u146.rk.title')}</h1>
          <div>{fmtDate(range.from, lang)} – {fmtDate(range.to, lang)}</div>
          <div className="small muted">{filtLabel || t('u146.rk.allCompaniesDoc')}{kinds.length < KINDS.length ? ` · ${t('u146.rk.only', { kinds: kinds.map((k) => t(`u146.rk.k.${k}`)).join(', ') || '—' })}` : ''}</div>
          {withCost && <div className="small"><b>{t('u146.rk.internal')}</b></div>}
        </div>
      </header>
      {state.error ? <div className="doc-empty">{errorText(state.error, tUi)}</div>
        : !state.rows ? <div className="doc-empty">{tUi('common.loading')}</div>
        : companies.length === 0 ? <div className="doc-empty">{t('u146.rk.empty')}</div>
        : companies.map((c, ci) => (
          <section key={c.id || ci} className={`rekap-co ${perPage && ci > 0 ? 'pagebreak' : ''}`}>
            <div className="rekap-cohead"><b>{c.name}</b><span className="small muted">{[c.payer !== c.name ? c.payer : null, c.book && c.book !== c.payer && c.book !== c.name ? `${t('u143.book')}: ${c.book}` : null].filter(Boolean).join(' · ')}</span></div>
            {view === 'sum' ? <SumTable c={c} t={t} lang={lang} kinds={kinds} cols={cols} withCost={withCost} />
              : <DetailTable c={c} t={t} lang={lang} kinds={kinds} lines={view === 'lines'} withCost={withCost} />}
          </section>
        ))}
      {state.rows && companies.length > 0 && (
        <table className="doc-totals rekap-grand">
          <tbody>
            {cols.map((k) => (
              <tr key={k}><th>{t(`u146.rk.k.${k}`)}{k === 'labor' && grand.laborValue > grand.labor ? <span className="small muted"> {t('u146.rk.notCharged', { amount: rp(grand.laborValue - grand.labor) })}</span> : null}</th><td>{rp(grand[k])}</td></tr>
            ))}
            <tr className="grand"><th>{companies.length > 1 ? t('u146.rk.totalCos', { n: companies.length }) : t('pr.total')}</th><td>{rp(grand.total)}</td></tr>
            {withCost && <tr><th>{t('u146.rk.col.cost')}</th><td>{rp(grand.cost)}</td></tr>}
            {withCost && <tr><th>{t('u146.rk.margin')}</th><td>{rp(grand.total - grand.cost)}</td></tr>}
          </tbody>
        </table>
      )}
      <div className="doc-terms small muted">{t('u146.rk.foot')}</div>
      <PrintedBy lang={lang} timezone={timezone} />
    </article>
  )

  if (embedded) return <div className="rekap-embed">{bar}{doc}</div>
  return <div className="print-wrap">{bar}{doc}</div>
}

// Ringkas: one row per vehicle; under the plate the km driven, cost per km and the last visit
function SumTable({ c, t, lang, kinds, cols, withCost }) {
  const vs = [...c.vehicles.values()]
  const coM = money(vs.flatMap((v) => [...v.invoices.values()]), kinds, withCost)
  return (
    <table className="doc-lines rekap-sum">
      <thead><tr>
        <th style={{ width: withCost ? '26%' : '32%' }}>{t('u146.rk.col.vehicle')}</th><th className="num">{t('u146.rk.col.visits')}</th>
        {cols.map((k) => <th key={k} className="num">{t(`u146.rk.k.${k}`)}</th>)}
        <th className="num">{t('pr.total')}</th>
        {withCost && <><th className="num">{t('u146.rk.col.cost')}</th><th className="num">{t('u146.rk.margin')}</th></>}
      </tr></thead>
      <tbody>
        {vs.map((v) => {
          const invs = [...v.invoices.values()].sort((a, b) => a.date.localeCompare(b.date))
          const m = money(invs, kinds, withCost)
          const read = invs.filter((i) => i.km != null)
          const driven = read.length > 1 ? read[read.length - 1].km - read[0].km : null
          const after = driven > 0 ? money(invs.filter((i) => i.date > read[0].date || (i.date === read[0].date && i !== read[0])), kinds, false).total : null
          const last = invs[invs.length - 1]
          return (
            <tr key={v.id}>
              <td>
                <b>{v.plate}</b>{v.name && <span className="small muted"> · {v.name}</span>}
                <div className="small muted">
                  {t('u146.rk.last', { date: fmtDate(last.date, lang), km: last.km != null ? fmtKm(last.km) : '—' })}
                  {driven > 0 && ` · ${t('u146.rk.driven', { km: fmtKm(driven), perKm: rp(after / driven) })}`}
                </div>
              </td>
              <td className="num">{num(invs.length)}</td>
              {cols.map((k) => (
                <td key={k} className="num">{rp(m[k])}{k === 'labor' && m.laborValue > m.labor && <div className="small muted">{t('u146.rk.notChargedShort', { amount: rp(m.laborValue - m.labor) })}</div>}</td>
              ))}
              <td className="num"><b>{rp(m.total)}</b></td>
              {withCost && <><td className="num">{rp(m.cost)}</td><td className="num">{rp(m.total - m.cost)}</td></>}
            </tr>
          )
        })}
        <tr className="rekap-sub">
          <td>{t('u146.rk.totalOf', { name: c.name })}</td><td className="num">{num(vs.reduce((a, v) => a + v.invoices.size, 0))}</td>
          {cols.map((k) => <td key={k} className="num">{rp(coM[k])}</td>)}
          <td className="num">{rp(coM.total)}</td>
          {withCost && <><td className="num">{rp(coM.cost)}</td><td className="num">{rp(coM.total - coM.cost)}</td></>}
        </tr>
      </tbody>
    </table>
  )
}

// Per invoice (each visit: date, number, km, the work, total) or Rinci (every service and line)
function DetailTable({ c, t, lang, kinds, lines, withCost }) {
  const vs = [...c.vehicles.values()]
  const all = vs.flatMap((v) => [...v.invoices.values()])
  const coM = money(all, kinds, withCost)
  const span = lines ? 4 + (withCost ? 1 : 0) : 2 + (withCost ? 1 : 0)
  return (
    <table className="doc-lines rekap-detail">
      <thead><tr>
        <th>{lines ? t('pr.description') : t('u146.rk.col.visit')}</th>
        {lines && <><th className="num">{t('pr.qty')}</th><th className="num">{t('u146.rk.col.price')}</th></>}
        {withCost && <th className="num">{t('u146.rk.col.cost')}</th>}
        <th className="num">{t('pr.amount')}</th>
      </tr></thead>
      {vs.map((v) => {
        const invs = [...v.invoices.values()].sort((a, b) => a.date.localeCompare(b.date))
        const vm = money(invs, kinds, withCost)
        return (
          <tbody key={v.id} className="rekap-veh">
            <tr className="rekap-vrow"><td colSpan={span - 1}><b>{v.plate}</b>{v.name && <span className="small muted"> · {v.name}</span>}<span className="small muted"> · {t('u146.rk.visits', { n: invs.length })}</span></td><td className="num"><b>{rp(vm.total)}</b></td></tr>
            {invs.map((i) => {
              const im = money([i], kinds, withCost)
              const svcs = [...i.services.values()].sort((a, b) => a.pos - b.pos)
              if (!lines) {
                return (
                  <tr key={i.id}>
                    <td><b>{fmtDate(i.date, lang)}</b> · {i.no} · {i.km != null ? fmtKm(i.km) : t('u146.rk.noKm')}<div className="small">{svcs.map((s) => s.name).join(', ')}</div></td>
                    {withCost && <td className="num">{rp(im.cost)}</td>}
                    <td className="num">{rp(im.total)}</td>
                  </tr>
                )
              }
              return (
                <React.Fragment key={i.id}>
                  <tr className="rekap-irow"><td colSpan={span - 1}><b>{fmtDate(i.date, lang)} · {i.no}</b><span className="small muted"> · {i.km != null ? fmtKm(i.km) : t('u146.rk.noKm')}</span></td><td className="num"><b>{rp(im.total)}</b></td></tr>
                  {svcs.map((s) => {
                    const ls = s.lines.filter((l) => kinds.includes(l.kind))
                    if (!ls.length) return null
                    return (
                      <React.Fragment key={s.id}>
                        <tr className="rekap-srow"><td colSpan={span}>{s.name}</td></tr>
                        {ls.map((l) => (
                          <tr key={l.line_id} className="rekap-lrow">
                            <td>{l.name}{(l.kind === 'oil' || l.kind === 'sublet') && <span className="small muted"> · {t(`u146.rk.k.${l.kind}`)}</span>}</td>
                            <td className="num">{num(l.qty, 2)}{l.unit ? ` ${l.unit}` : l.kind === 'labor' ? ` ${t('pr.hrs')}` : ''}</td>
                            <td className="num">{rp(l.price)}</td>
                            {withCost && <td className="num">{l.cost != null ? rp(l.cost) : ''}</td>}
                            <td className="num">{rp(l.billed)}{n(l.value) > n(l.billed) && <div className="small muted">{t('u146.rk.notChargedShort', { amount: rp(n(l.value) - n(l.billed)) })}</div>}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    )
                  })}
                  {kinds.includes('other') && i.other !== 0 && (
                    <tr className="rekap-lrow"><td colSpan={span - 1}>{t('u146.rk.otherLine')}</td><td className="num">{rp(i.other)}</td></tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        )
      })}
      <tbody>
        <tr className="rekap-sub"><td colSpan={span - 1 - (withCost ? 1 : 0)}>{t('u146.rk.totalOfInv', { name: c.name, n: all.length })}</td>{withCost && <td className="num">{rp(coM.cost)}</td>}<td className="num">{rp(coM.total)}</td></tr>
      </tbody>
    </table>
  )
}
