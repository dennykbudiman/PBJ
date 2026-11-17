import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { useT, translate } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, num, rp, safeBack } from '../../lib/format'
import { payerBookLabel } from '../../lib/books'
import { shopToday } from '../../lib/customers'
import { downloadCsv } from '../../lib/reports'

// /print/statement?payer=&book=&from=&to=&mode=month|drum[&all=1][&lang=] (update 150, item 53): the monthly statement
// of one book (or every book, each starting on a new page) for the PT's cashier to check: page 1 the summary
// (invoices, what the book pays each supplier, drum oil both ways, talangan, totals, signatures), then every line, each
// with an empty tick box. Oil from before the app is never on it (its own one-time bill).
const n = (x) => Number(x) || 0
const sum = (xs, f) => xs.reduce((a, x) => a + n(f(x)), 0)
const Tick = () => <span className="st-tick" aria-hidden="true" />
const short = (oil) => String(oil || '').replace(/^Oli (mesin|perseneling|gardan) bulk /i, '')

export function buildStatement(s) {
  const lines = s.lines || []
  const po = lines.filter((l) => !l.talangan)
  const tal = lines.filter((l) => l.talangan)
  const bySup = new Map()
  for (const l of po) {
    const k = l.supplier || '—'
    const g = bySup.get(k) || { name: k, lines: [], pos: new Set(), amount: 0 }
    g.lines.push(l); g.pos.add(l.po_number); g.amount += n(l.amount)
    bySup.set(k, g)
  }
  const byDriver = new Map()
  for (const l of tal) {
    const k = l.talangan?.name || '—'
    const g = byDriver.get(k) || { name: k, lines: [], amount: 0 }
    g.lines.push(l); g.amount += n(l.amount)
    byDriver.set(k, g)
  }
  const drum = s.drum_oil || []
  const owes = new Map(), owed = new Map()
  for (const d of drum) {
    if (d.direction === 'owes') {
      const k = `${d.oil}|${d.drum_payer}|${d.drum_book}`
      const g = owes.get(k) || { oil: d.oil, who: payerBookLabel(d.drum_payer, d.drum_book), litres: 0, amount: 0 }
      g.litres += n(d.litres); g.amount += n(d.amount)
      owes.set(k, g)
    } else {
      // oil a shop-billed customer took: the shop pays it (151, review 7)
      const k = d.shop ? 'shop' : `${d.payer}|${d.book}`
      const g = owed.get(k) || { who: d.shop ? null : payerBookLabel(d.payer, d.book), shop: !!d.shop, oils: new Map(), amount: 0 }
      g.oils.set(d.oil, (g.oils.get(d.oil) || 0) + n(d.litres)); g.amount += n(d.amount)
      owed.set(k, g)
    }
  }
  const inv = s.invoices || []
  const older = s.older || []
  const t = {
    invoices: inv.length, vehicles: new Set(inv.map((i) => i.plate).filter(Boolean)).size,
    total: sum(inv, (i) => i.total), settled: sum(inv, (i) => i.settled_direct), waived: sum(inv, (i) => i.labor_waived), balance: sum(inv, (i) => i.balance),
    suppliers: sum(po, (l) => l.amount), owes: sum([...owes.values()], (g) => g.amount), owed: sum([...owed.values()], (g) => g.amount), talangan: sum(tal, (l) => l.amount),
    older: sum(older, (i) => i.balance),
  }
  // the book pays the drivers back for talangan too, as on Tagihan PT (151, review 5); and older unpaid invoices (15)
  t.pays = t.suppliers + t.owes + t.talangan + t.balance + t.older
  return { inv, older, po, tal, suppliers: [...bySup.values()], drivers: [...byDriver.values()], owes: [...owes.values()], owed: [...owed.values()], drum, t,
    estimated: drum.some((d) => d.estimated), empty: !inv.length && !lines.length && !drum.length && !older.length }
}

function StatementDoc({ s, t, lang, shop, logoUrl, timezone, printedBy, n: no, of, today }) {
  const b = useMemo(() => buildStatement(s), [s])
  // a PT's stock POs and drums with no book: the whole PT (151, review 2)
  const who = s.book ? payerBookLabel(s.payer, s.book) : `${s.payer} · ${t('u151.wholePt')}`
  const owedWho = (g) => (g.shop ? t('u151.st.shopUser') : g.who)
  const mode = s.drum_mode
  return (
    <article className="doc pdoc st-doc" aria-label={`${t('u150.st.title')} ${who}`}>
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
          <h1>{t('u150.st.title')}</h1>
          <table className="doc-meta"><tbody>
            <tr><th>{t('u143.book')}</th><td><b>{who}</b></td></tr>
            <tr><th>{t('u150.st.period')}</th><td>{fmtDate(s.from, lang)} – {fmtDate(s.to, lang)}</td></tr>
            <tr><th>{t('u150.st.drumMode')}</th><td>{t(`u150.st.mode.${mode}`)}</td></tr>
          </tbody></table>
        </div>
      </header>

      <div className="st-sumlabel">{t('u150.st.sumLabel')}</div>
      {/* 1 · invoices */}
      <table className="doc-lines st-tab st-keep"><thead><tr><th colSpan={2}>{t('u150.st.s1')}</th><th className="num" /><th className="st-t">✓</th></tr></thead><tbody>
        <tr><td>{t('u150.st.invCount')}</td><td className="muted">{t('u150.st.invVehicles', { n: b.t.invoices, v: b.t.vehicles })}</td><td className="num">{b.t.invoices}</td><td className="st-t"><Tick /></td></tr>
        <tr><td>{t('u150.st.invTotal')}</td><td className="muted">{t('u150.st.invTotalHint')}</td><td className="num">{rp(b.t.total)}</td><td className="st-t"><Tick /></td></tr>
        <tr><td className="ind">{t('u150.st.settled')}</td><td className="muted">{t('u150.st.settledHint')}</td><td className="num">{rp(b.t.settled)}</td><td /></tr>
        {b.t.waived > 0 && <tr><td>{t('u150.st.waived')}</td><td className="muted">{t('u150.st.waivedHint')}</td><td className="num muted">({rp(b.t.waived)})</td><td /></tr>}
        <tr className="rule"><td><b>{t('u150.st.balance')}</b></td><td className="muted">{t('u151.st.perDate', { date: fmtDate(today, lang) })}</td><td className="num"><b>{rp(b.t.balance)}</b></td><td className="st-t"><Tick /></td></tr>
        {b.older.length > 0 && <tr><td>{t('u151.st.older')}</td><td className="muted">{t('u151.st.olderHint', { n: b.older.length, date: fmtDate(s.from, lang) })}</td><td className="num">{rp(b.t.older)}</td><td className="st-t"><Tick /></td></tr>}
      </tbody></table>

      {/* 2 · suppliers */}
      <table className="doc-lines st-tab st-keep"><thead><tr><th>{t('u150.st.s2')}</th><th>{t('u150.st.lines')}</th><th className="num">{t('u150.st.amount')}</th><th className="st-t">✓</th></tr></thead><tbody>
        {b.suppliers.length === 0 && <tr><td colSpan={4} className="muted">{t('u150.st.none')}</td></tr>}
        {b.suppliers.map((g) => (
          <tr key={g.name}><td>{g.name}</td><td className="muted">{t('u150.st.supLines', { n: g.lines.length, p: g.pos.size })}</td><td className="num">{rp(g.amount)}</td><td className="st-t"><Tick /></td></tr>
        ))}
        {b.suppliers.length > 0 && <tr className="rule"><td><b>{t('u150.st.supTotal')}</b></td><td /><td className="num"><b>{rp(b.t.suppliers)}</b></td><td /></tr>}
      </tbody></table>

      {/* 3 · drum oil */}
      <table className="doc-lines st-tab st-keep"><thead><tr><th>{t(`u150.st.s3.${mode}`)}</th><th>{t('u150.st.oil')}</th><th className="num">{t('u150.st.amount')}</th><th className="st-t">✓</th></tr></thead><tbody>
        <tr className="st-sub"><td colSpan={4}>{t('u150.st.owesHead')}</td></tr>
        {b.owes.length === 0 && <tr><td colSpan={4} className="muted ind">{t('u150.st.none')}</td></tr>}
        {b.owes.map((g, i) => (
          <tr key={i}><td className="ind">{g.who}</td><td>{short(g.oil)} {num(g.litres, 2)} L</td><td className="num">{rp(g.amount)}</td><td className="st-t"><Tick /></td></tr>
        ))}
        <tr className="st-sub"><td colSpan={4}>{t('u150.st.owedHead')}</td></tr>
        {b.owed.length === 0 && <tr><td colSpan={4} className="muted ind">{t('u150.st.noneOwed')}</td></tr>}
        {b.owed.map((g, i) => (
          <tr key={i}><td className="ind">{owedWho(g)}</td><td>{[...g.oils.entries()].map(([o, l]) => `${short(o)} ${num(l, 2)} L`).join(' · ')}</td><td className="num">{rp(g.amount)}</td><td className="st-t"><Tick /></td></tr>
        ))}
        {mode === 'drum' && (s.open_drums || []).length > 0 && (
          <tr><td colSpan={4} className="small muted">{t('u150.st.openDrums', { list: s.open_drums.map((d) => `${short(d.oil)} (${payerBookLabel(d.drum_payer, d.drum_book)}, ${fmtDate(d.opened_on, lang)})`).join('; ') })}</td></tr>
        )}
      </tbody></table>

      {/* 4 · talangan */}
      <table className="doc-lines st-tab st-keep"><thead><tr><th>{t('u150.st.s4')}</th><th>{t('u150.st.talNote')}</th><th className="num">{t('u150.st.amount')}</th><th className="st-t">✓</th></tr></thead><tbody>
        {b.drivers.length === 0 && <tr><td colSpan={4} className="muted">{t('u150.st.noTal')}</td></tr>}
        {b.drivers.map((g) => (
          <tr key={g.name}><td>{g.name}</td><td className="muted">{t('u150.st.talLines', { n: g.lines.length })}</td><td className="num">{rp(g.amount)}</td><td className="st-t"><Tick /></td></tr>
        ))}
      </tbody></table>

      {/* totals and signatures stay together (never alone on a page) */}
      <div className="st-end">
        <div className={`st-boxes ${b.t.owed > 0 ? 'two' : ''}`}>
          <table className="doc-totals st-box"><tbody>
            <tr><th colSpan={2} className="st-boxhead">{t('u150.st.pays')}</th></tr>
            <tr><th>{t('u150.st.paySup')}</th><td>{rp(b.t.suppliers)}</td></tr>
            <tr><th>{t('u150.st.payDrum')}</th><td>{rp(b.t.owes)}</td></tr>
            {b.t.talangan > 0 && <tr><th>{t('u151.st.payTal')}</th><td>{rp(b.t.talangan)}</td></tr>}
            <tr><th>{t('u150.st.payShop')}</th><td>{rp(b.t.balance)}</td></tr>
            {b.t.older > 0 && <tr><th>{t('u151.st.payOlder')}</th><td>{rp(b.t.older)}</td></tr>}
            <tr className="grand"><th>{t('pr.total')}</th><td>{rp(b.t.pays)}</td></tr>
            <tr><th colSpan={2} className="small muted" style={{ textAlign: 'left' }}>{t('u151.st.shopPerDate', { date: fmtDate(today, lang) })}</th></tr>
          </tbody></table>
          {b.t.owed > 0 && (
            <table className="doc-totals st-box"><tbody>
              <tr><th colSpan={2} className="st-boxhead">{t('u150.st.gets')}</th></tr>
              <tr><th>{t('u150.st.getDrum')}</th><td>{rp(b.t.owed)}</td></tr>
              <tr className="grand"><th>{t('pr.total')}</th><td>{rp(b.t.owed)}</td></tr>
            </tbody></table>
          )}
        </div>
        {s.old_oil && <div className="small muted" style={{ marginTop: 6 }}>{t('u150.st.oldOil')}</div>}
        {b.estimated && <div className="small muted">{t('u151.estimatedNote')}</div>}
        <section className="doc-sign">
          <div><div>{t('u150.st.preparedBy')}</div><div className="sign-line" /><div className="sign-name">{printedBy || ''}</div></div>
          <div><div>{t('u150.st.checkedBy')}</div><div className="sign-line" /><div className="sign-name" /></div>
        </section>
        <div className="small muted st-foot">{t('u150.st.foot')}</div>
      </div>

      {/* details, from a new page */}
      {!b.empty && (
        <div className="st-details">
          <h2 className="st-h2">{t('u150.st.details')} · {who}</h2>
          {b.inv.length > 0 && (
            <table className="doc-lines st-tab st-lines"><thead>
              <tr><th colSpan={8} className="st-cap">{t('u150.st.s1')}</th></tr>
              <tr><th>{t('u150.st.c.invoice')}</th><th>{t('u150.st.c.date')}</th><th>{t('u150.st.c.vehicle')}</th><th className="num">{t('u150.st.c.total')}</th><th className="num">{t('u150.st.c.settled')}</th><th className="num">{t('u150.st.c.waived')}</th><th className="num">{t('u150.st.c.balance')}</th><th className="st-t">✓</th></tr>
            </thead><tbody>
              {b.inv.map((i) => (
                <tr key={i.ro_id}><td className="nowrap">{i.invoice_no}</td><td className="nowrap">{fmtDate(i.day, lang)}</td><td>{[i.plate, i.model].filter(Boolean).join(' · ')}</td>
                  <td className="num">{rp(i.total)}</td><td className="num">{rp(i.settled_direct)}</td><td className="num muted">{n(i.labor_waived) ? rp(i.labor_waived) : '—'}</td><td className="num">{rp(i.balance)}</td><td className="st-t"><Tick /></td></tr>
              ))}
              <tr className="rule"><td colSpan={3}><b>{t('u150.st.invSum', { n: b.inv.length })}</b></td><td className="num"><b>{rp(b.t.total)}</b></td><td className="num"><b>{rp(b.t.settled)}</b></td><td className="num"><b>{rp(b.t.waived)}</b></td><td className="num"><b>{rp(b.t.balance)}</b></td><td /></tr>
            </tbody></table>
          )}
          {b.older.length > 0 && (
            <table className="doc-lines st-tab st-lines"><thead>
              <tr><th colSpan={6} className="st-cap">{t('u151.st.older')}</th></tr>
              <tr><th>{t('u150.st.c.invoice')}</th><th>{t('u150.st.c.date')}</th><th>{t('u150.st.c.vehicle')}</th><th className="num">{t('u150.st.c.total')}</th><th className="num">{t('u151.st.c.balanceToday')}</th><th className="st-t">✓</th></tr>
            </thead><tbody>
              {b.older.map((i) => (
                <tr key={i.ro_id}><td className="nowrap">{i.invoice_no}</td><td className="nowrap">{fmtDate(i.day, lang)}</td><td>{i.plate || '—'}</td>
                  <td className="num">{rp(i.total)}</td><td className="num">{rp(i.balance)}</td><td className="st-t"><Tick /></td></tr>
              ))}
            </tbody></table>
          )}
          {b.suppliers.length > 0 && (
            <table className="doc-lines st-tab st-lines"><thead>
              <tr><th colSpan={7} className="st-cap">{t('u150.st.s2Detail')}</th></tr>
              <tr><th>{t('u150.st.c.received')}</th><th>PO</th><th>{t('u150.st.c.part')}</th><th>{t('u150.st.c.vehicle')}</th><th className="num">{t('u150.st.c.qty')}</th><th className="num">{t('u150.st.amount')}</th><th className="st-t">✓</th></tr>
            </thead>
              {b.suppliers.map((g) => (
                <tbody key={g.name}>
                  <tr className="st-sub"><td colSpan={7}>{g.name}</td></tr>
                  {g.lines.map((l, i) => (
                    <tr key={i}><td className="nowrap">{fmtDate(l.delivered_at, lang)}</td><td className="nowrap">{l.po_number}</td>
                      <td>{l.name}{l.part_number && <span className="muted"> · {l.part_number}</span>}</td><td className="nowrap">{l.plate || '—'}</td>
                      <td className="num">{num(l.qty, 2)}</td><td className="num">{rp(l.amount)}</td><td className="st-t"><Tick /></td></tr>
                  ))}
                  <tr className="st-subtotal"><td colSpan={5}>{t('u150.st.subtotal', { name: g.name })}</td><td className="num"><b>{rp(g.amount)}</b></td><td /></tr>
                </tbody>
              ))}
            </table>
          )}
          {b.drum.length > 0 && (
            <table className="doc-lines st-tab st-lines"><thead>
              <tr><th colSpan={7} className="st-cap">{t(`u150.st.s3.${mode}`)}</th></tr>
              <tr><th>{t('u150.st.c.date')}</th><th>{t('u150.st.c.drum')}</th><th>{t('u150.st.c.whom')}</th><th>{t('u150.st.c.vehicleInv')}</th><th className="num">L</th><th className="num">{t('u150.st.amount')}</th><th className="st-t">✓</th></tr>
            </thead><tbody>
              {b.drum.map((d, i) => (
                <tr key={i}><td className="nowrap">{fmtDate(d.day, lang)}</td><td>{short(d.oil)}</td>
                  <td>{d.direction === 'owes' ? t('u150.st.toOwner', { who: payerBookLabel(d.drum_payer, d.drum_book) }) : t('u150.st.fromUser', { who: d.shop ? t('u151.st.shopUser') : payerBookLabel(d.payer, d.book) })}</td>
                  <td className="nowrap">{[d.plate, d.invoice_no].filter(Boolean).join(' · ')}</td><td className="num">{num(d.litres, 2)}</td><td className="num">{rp(d.amount)}{d.estimated && ' *'}</td><td className="st-t"><Tick /></td></tr>
              ))}
            </tbody></table>
          )}
          {b.tal.length > 0 && (
            <table className="doc-lines st-tab st-lines"><thead>
              <tr><th colSpan={6} className="st-cap">{t('u150.st.s4Detail')}</th></tr>
              <tr><th>{t('u150.st.c.received')}</th><th>{t('u150.st.c.driver')}</th><th>{t('u150.st.c.poPart')}</th><th>{t('u150.st.c.vehicleJob')}</th><th className="num">{t('u150.st.amount')}</th><th className="st-t">✓</th></tr>
            </thead><tbody>
              {b.tal.map((l, i) => (
                <tr key={i}><td className="nowrap">{fmtDate(l.delivered_at, lang)}</td><td>{l.talangan?.name}</td><td>{l.po_number} · {l.name}</td>
                  <td className="nowrap">{[l.plate, l.job_number ? `#${l.job_number}` : null].filter(Boolean).join(' · ')}</td><td className="num">{rp(l.amount)}</td><td className="st-t"><Tick /></td></tr>
              ))}
            </tbody></table>
          )}
        </div>
      )}
      <div className="doc-pagefoot"><span className="doc-foot">{shop.shop_name}</span><span className="doc-pageno">{of > 1 ? `${who} · ${t('u150.st.bookN', { n: no, of })}` : who}</span></div>
      <PrintedBy lang={lang} timezone={timezone} />
    </article>
  )
}

export default function PrintStatement() {
  const { t: tUi } = useT()
  const { settings, logoUrl, timezone } = useShop()
  const { profile, isStaff } = useAuth()
  const today = shopToday(timezone)
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const lang = params.get('lang') || settings?.default_print_language || 'id'
  const t = (key, vars) => translate(lang, key, vars)
  const from = params.get('from'), to = params.get('to')
  const mode = params.get('mode') || settings?.statement_drum_mode || 'month'
  const all = params.get('all') === '1'
  const payer = params.get('payer') || null, book = params.get('book') || null
  const [state, setState] = useState({ list: null, error: null })
  useEffect(() => {
    if (!from || !to || !settings) return
    let live = true
    setState({ list: null, error: null });
    (async () => {
      let books = [{ payer, book }]
      if (all) {
        const r = await supabase.rpc('statement_books', { p_from: from, p_to: to })
        if (r.error) { if (live) setState({ list: null, error: r.error }); return }
        books = r.data || []
      }
      const out = []
      for (const x of books) {
        const [r, o] = await Promise.all([
          supabase.rpc('book_statement', { p_payer: x.payer, p_book: x.book, p_from: from, p_to: to, p_drum_mode: mode }),
          supabase.rpc('book_older_unpaid', { p_payer: x.payer, p_book: x.book, p_before: from }),
        ])
        const err = r.error || o.error
        if (err) { if (live) setState({ list: null, error: err }); return }
        const st = { ...r.data, older: o.data || [] }
        if (!all || !buildStatement(st).empty) out.push(st)
      }
      if (live) setState({ list: out, error: null })
    })()
    return () => { live = false }
  }, [from, to, mode, all, payer, book, !!settings]) // eslint-disable-line react-hooks/exhaustive-deps

  const printed = useRef(false)
  useEffect(() => {
    if (params.get('print') === '1' && state.list && !printed.current) {
      printed.current = true
      setTimeout(() => window.print(), 400)
    }
  }, [state.list]) // eslint-disable-line react-hooks/exhaustive-deps
  usePageTitle([tUi('u150.st.title'), all ? tUi('u150.st.allBooks') : payerBookLabel(payer, book)].filter(Boolean).join(' · '), { alone: true })
  // every line of the statement(s), for Excel (151, review 18)
  function csv() {
    const head = [t('u143.book'), t('u151.csv.kind'), t('u151.csv.toWhom'), t('u150.st.c.date'), t('u151.csv.doc'), t('u150.st.c.part'), t('u150.st.c.vehicle'),
      t('u150.st.c.qty'), t('u150.st.amount'), t('u150.st.c.settled'), t('u150.st.c.balance')]
    const rows = []
    for (const s of state.list || []) {
      const b = buildStatement(s)
      const who = s.book ? payerBookLabel(s.payer, s.book) : `${s.payer} · ${t('u151.wholePt')}`
      for (const i of b.inv) rows.push([who, t('u151.csv.invoice'), t('u150.st.payShop'), i.day, i.invoice_no, '', i.plate || '', null, n(i.total), n(i.settled_direct), n(i.balance)])
      for (const i of b.older) rows.push([who, t('u151.st.older'), t('u150.st.payShop'), i.day, i.invoice_no, '', i.plate || '', null, n(i.total), n(i.settled_direct), n(i.balance)])
      for (const l of b.po) rows.push([who, t('u151.csv.supplier'), l.supplier || '', l.delivered_at, l.po_number, l.name, l.plate || '', n(l.qty), n(l.amount), null, null])
      for (const l of b.tal) rows.push([who, t('u151.csv.talangan'), l.talangan?.name || '', l.delivered_at, l.po_number, l.name, l.plate || '', n(l.qty), n(l.amount), null, null])
      for (const d of b.drum) rows.push([who, d.direction === 'owes' ? t('u151.csv.drumOil') : t('u151.csv.drumOilIn'),
        d.direction === 'owes' ? payerBookLabel(d.drum_payer, d.drum_book) : d.shop ? t('u151.st.shopUser') : payerBookLabel(d.payer, d.book),
        d.day, d.invoice_no, short(d.oil) + (d.estimated ? ' *' : ''), d.plate || '', n(d.litres), n(d.amount), null, null])
    }
    downloadCsv(`tagihan-bulanan-${from}-${to}.csv`, head, rows)
  }
  const setParam = (k, v) => { const p = new URLSearchParams(location.search); if (v == null) p.delete(k); else p.set(k, v); p.delete('print'); navigate(`/print/statement?${p.toString()}`, { replace: true }) }
  if (!settings) return <div className="print-msg">{tUi('common.loading')}</div>
  if (!from || !to) return <div className="print-msg">{tUi('u150.st.noPeriod')}</div>
  return (
    <div className={`print-wrap ${all ? 'st-all' : ''}`}>
      <div className="print-bar no-print">
        <Link className="btn" to={safeBack(params.get('back'))}>← {tUi('u150.st.back')}</Link>
        <div className="seg" role="group" aria-label={tUi('u150.st.drumMode')}>
          {['month', 'drum'].map((m) => <button key={m} type="button" className={`seg-btn ${mode === m ? 'on' : ''}`} onClick={() => setParam('mode', m)}>{tUi(`u150.st.mode.${m}`)}</button>)}
        </div>
        <div className="seg">
          <button type="button" className={`seg-btn ${lang === 'id' ? 'on' : ''}`} onClick={() => setParam('lang', 'id')}>Bahasa Indonesia</button>
          <button type="button" className={`seg-btn ${lang === 'en' ? 'on' : ''}`} onClick={() => setParam('lang', 'en')}>English</button>
        </div>
        <div className="spacer" />
        {state.list && <span className="small muted">{tUi('u150.st.count', { n: state.list.length })}</span>}
        <button type="button" className="btn" onClick={csv} disabled={!state.list?.length}>{tUi('u145.csv')}</button>
        <button type="button" className="btn primary" onClick={() => window.print()} disabled={!state.list?.length}>{tUi('job.print')}</button>
      </div>
      {state.error ? <div className="print-msg">{errorText(state.error, tUi)}</div>
        : !state.list ? <div className="print-msg">{tUi('common.loading')}</div>
        : state.list.length === 0 ? <div className="print-msg">{tUi('u150.st.nothing')}</div>
        : state.list.map((s, i) => <StatementDoc key={`${s.payer}|${s.book}`} s={s} t={t} lang={lang} shop={settings} logoUrl={logoUrl} timezone={timezone}
            printedBy={isStaff ? profile?.name : ''} n={i + 1} of={state.list.length} today={today} />)}
    </div>
  )
}
