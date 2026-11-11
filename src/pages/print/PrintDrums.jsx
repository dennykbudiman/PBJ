import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { useT, translate } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, num, rp } from '../../lib/format'
import { nameKey, payerBookLabel } from '../../lib/books'
import { terbilang } from '../../lib/terbilang'

// /print/drums?drum=<id>&book=<payer|book>&from=&to=&lang= (145, item 28): drum-oil statements. One statement per
// pair of books (who used the oil → whose drum it was), each on its own A4 page: every invoiced oil line in the
// period, the total, what was paid ("Tandai lunas") and what is still open, and signature boxes. The drum owner's own
// use is listed on its own page for information (nothing to pay). Also a CSV for Excel.
const key = (payer, book) => `${nameKey(payer)}|${nameKey(book)}`

export function drumStatements(drums, { drum, book, t }) {
  const out = new Map()
  for (const d of drums || []) {
    if (drum && d.id !== drum) continue
    for (const x of d.debtors || []) {
      const from = x.payer ? payerBookLabel(x.payer, x.book) : t('u142.theShop')
      if (book && key(x.payer, x.book) !== book) continue
      const k = `${x.owes ? 'owe' : 'own'}#${key(x.payer, x.book)}#${key(d.payer, d.book)}`
      let st = out.get(k)
      if (!st) out.set(k, st = { owes: x.owes, from, to: payerBookLabel(d.payer, d.book), fromKey: key(x.payer, x.book), drums: [], litres: 0, amount: 0, owed: 0, paid: 0, open: 0 })
      st.drums.push({ drum: d, debtor: x })
      st.litres += Number(x.litres) || 0
      st.amount += Number(x.amount) || 0
      st.owed += Number(x.owed_all) || 0
      st.paid += Number(x.paid) || 0
      st.open += Number(x.open) || 0
    }
  }
  return [...out.values()].sort((a, b) => Number(b.owes) - Number(a.owes) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
}

export default function PrintDrums() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const { t: tUi } = useT()
  const { settings, logoUrl, timezone } = useShop()
  const { can } = useAuth()
  const money = can('view_costs') || can('pay_supplier_bills')
  const from = params.get('from') || ''
  const to = params.get('to') || ''
  const [res, setRes] = useState(null)
  useEffect(() => {
    let live = true
    setRes(null)
    supabase.rpc('drum_statement', { p_from: from || null, p_to: to || null }).then((r) => { if (live) setRes(r) })
    return () => { live = false }
  }, [from, to])
  const setParam = (k, v) => { const p = new URLSearchParams(location.search); if (v) p.set(k, v); else p.delete(k); navigate(`${location.pathname}?${p.toString()}`, { replace: true }) }
  const lang = params.get('lang') || settings?.default_print_language || 'id'
  const t = (k, vars) => translate(lang, k, vars)
  const drums = res?.data?.drums || []
  const drum = params.get('drum') || ''
  const book = params.get('book') || ''
  const own = params.get('own') !== '0'
  const statements = useMemo(() => drumStatements(drums, { drum, book, t }).filter((s) => s.owes || own), [res, drum, book, own, lang]) // eslint-disable-line react-hooks/exhaustive-deps
  const bookChoices = useMemo(() => {
    const m = new Map()
    for (const d of drums) for (const x of d.debtors || []) m.set(key(x.payer, x.book), x.payer ? payerBookLabel(x.payer, x.book) : tUi('u142.theShop'))
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [res]) // eslint-disable-line react-hooks/exhaustive-deps
  usePageTitle(t('u145.drumDocTitle'), { alone: true })

  if (!money) return <div className="print-msg">{tUi('err.permission')}</div>
  if (!res || !settings) return <div className="print-msg">{tUi('common.loading')}</div>
  if (res.error) return <div className="print-msg">{errorText(res.error, tUi)}</div>

  const period = from || to ? `${from ? fmtDate(from, lang) : '…'} – ${to ? fmtDate(to, lang) : fmtDate(new Date().toISOString().slice(0, 10), lang)}` : t('u145.sinceOpened')
  function csv() {
    const rows = [[t('u145.csv.from'), t('u145.csv.to'), t('u145.col.oil'), t('u145.col.date'), t('inv.col.invoice'), t('u145.col.truck'), t('u142.company'), t('u142.litres'), t('u145.col.perL'), t('inv.col.amount'), t('u145.csv.toPay')]]
    for (const st of statements) for (const { drum: d, debtor: x } of st.drums) for (const l of x.lines || []) {
      rows.push([st.from, st.to, d.oil, l.day, l.invoice_no, l.plate || '', l.company || '', String(l.litres).replace('.', ','), d.cost_per_l, l.amount, st.owes ? 'ya' : 'tidak'])
    }
    const text = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
    a.download = `oli-drum-${from || 'awal'}-${to || 'sekarang'}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  return (
    <div className="print-wrap">
      <div className="print-bar no-print">
        <Link className="btn" to="/inventory/drums">← {tUi('u145.backDrums')}</Link>
        <select className="select" style={{ width: 'auto' }} value={drum} onChange={(e) => setParam('drum', e.target.value)} aria-label={tUi('u145.whichDrum')}>
          <option value="">{tUi('u145.allDrums')}</option>
          {drums.map((d) => <option key={d.id} value={d.id}>{d.oil} · {fmtDate(d.opened_on, lang)}</option>)}
        </select>
        <select className="select" style={{ width: 'auto', maxWidth: 260 }} value={book} onChange={(e) => setParam('book', e.target.value)} aria-label={tUi('u143.book')}>
          <option value="">{tUi('u143.allBooks')}</option>
          {bookChoices.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <label className="mini">{tUi('u145.from')} <input type="date" className="input" value={from} onChange={(e) => setParam('from', e.target.value)} /></label>
        <label className="mini">{tUi('u145.to')} <input type="date" className="input" value={to} onChange={(e) => setParam('to', e.target.value)} /></label>
        <label className="inlinecheck"><input type="checkbox" checked={own} onChange={(e) => setParam('own', e.target.checked ? '' : '0')} /> {tUi('u145.showOwn')}</label>
        <div className="seg">
          <button type="button" className={`seg-btn ${lang === 'id' ? 'on' : ''}`} onClick={() => setParam('lang', 'id')}>Bahasa Indonesia</button>
          <button type="button" className={`seg-btn ${lang === 'en' ? 'on' : ''}`} onClick={() => setParam('lang', 'en')}>English</button>
        </div>
        <div className="spacer" />
        <button type="button" className="btn" onClick={csv} disabled={!statements.length}>{tUi('u145.csv')}</button>
        <button type="button" className="btn primary" onClick={() => window.print()} disabled={!statements.length}>{tUi('job.print')}</button>
      </div>
      {statements.length === 0 && <div className="print-msg">{tUi('u145.noDrumUse')}</div>}
      {statements.map((st, i) => (
        <div key={i} className="doc pdoc">
          <div className="doc-head">
            <div className="doc-shop">
              {logoUrl && <img className="doc-logo" src={logoUrl} alt="" />}
              <div>
                <div className="doc-shopname">{settings.shop_name || settings.legal_name}</div>
                {settings.address && <div className="pre">{settings.address}</div>}
                <div>{[settings.phone, settings.email].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div className="doc-title">
              <h1>{st.owes ? t('u145.drumDocTitle') : t('u145.drumOwnTitle')}</h1>
              <table className="doc-meta"><tbody>
                <tr><th>{t('u145.period')}</th><td>{period}</td></tr>
                              </tbody></table>
            </div>
          </div>
          <div className="doc-parties">
            <div><div className="doc-label">{st.owes ? t('u145.debtor') : t('u145.user')}</div><b>{st.from}</b></div>
            <div><div className="doc-label">{t('u145.drumOwner')}</div><b>{st.to}</b></div>
          </div>
          {st.drums.map(({ drum: d, debtor: x }) => (
            <div key={d.id} className="doc-block">
              <div className="drum-dochead">
                <b>{d.oil}</b>
                <span className="small muted">{t('u145.drumInfo', { litres: num(d.litres, 2), date: fmtDate(d.opened_on, lang), price: rp(d.cost_per_l), unit: d.unit || 'L', left: num(d.left, 2) })}{d.estimated && ` · ${t('u143.estimate')}`}</span>
              </div>
              <table className="doc-lines">
                <thead><tr><th>{t('u145.col.date')}</th><th>{t('inv.col.invoice')}</th><th>{t('u145.col.truck')}</th><th>{t('u142.company')}</th>
                  <th className="num">{t('u142.litres')}</th><th className="num">{t('u145.col.perL')}</th><th className="num">{t('inv.col.amount')}</th></tr></thead>
                <tbody>
                  {(x.lines || []).map((l, k) => (
                    <tr key={k}><td className="nowrap">{fmtDate(l.day, lang)}</td><td className="nowrap">{l.invoice_no}</td><td className="nowrap">{l.plate}</td><td>{l.company}</td>
                      <td className="num">{num(l.litres, 2)}</td><td className="num">{rp(d.cost_per_l)}</td><td className="num">{rp(l.amount)}</td></tr>
                  ))}
                  {(x.lines || []).length === 0 && <tr><td colSpan={7} className="muted">{t('u145.noLinesPeriod')}</td></tr>}
                  <tr className="svc-total"><td colSpan={4}>{t('u145.subtotal')}</td><td className="num">{num(x.litres, 2)}</td><td /><td className="num">{rp(x.amount)}</td></tr>
                </tbody>
              </table>
              {st.owes && (x.payments || []).length > 0 && (
                <div className="small" style={{ marginTop: 4 }}>
                  {x.payments.map((p) => <div key={p.id}>{t('u145.paidLine', { date: fmtDate(p.paid_on, lang), amount: rp(p.amount), how: p.method ? t(`inv.pay.m.${p.method}`) : '', ref: p.reference || '' })}</div>)}
                </div>
              )}
            </div>
          ))}
          {st.owes ? (
            <div className="doc-bottom">
              <div className="doc-notes small">
                <div>{t('u145.drumNote')}</div>
                {st.open > 0 && <div style={{ marginTop: 4 }}><i>{t('u145.terbilang', { words: terbilang(st.open) })}</i></div>}
              </div>
              <table className="doc-totals"><tbody>
                <tr><th>{t('u145.periodTotal', { litres: num(st.litres, 2) })}</th><td>{rp(st.amount)}</td></tr>
                <tr className="rule"><th>{t('u145.owedAll')}</th><td>{rp(st.owed)}</td></tr>
                <tr><th>{t('u145.paidAll')}</th><td>-{rp(st.paid)}</td></tr>
                <tr className="grand"><th>{st.open > 0 ? t('u145.pays', { from: st.from, to: st.to }) : t('u145.paidUp')}</th><td>{rp(st.open)}</td></tr>
              </tbody></table>
            </div>
          ) : (
            <div className="doc-bottom"><div className="doc-notes small">{t('u145.ownNote', { litres: num(st.litres, 2), value: rp(st.amount) })}</div></div>
          )}
          {st.owes && (
            <div className="doc-sign">
              <div><div>{t('u145.handedBy')}</div><div className="sign-line" /><div className="sign-name">{st.to}</div></div>
              <div><div>{t('u145.receivedBy')}</div><div className="sign-line" /><div className="sign-name">{st.from}</div></div>
            </div>
          )}
          <div className="doc-pagefoot"><span className="doc-foot">{settings.shop_name}</span><span className="doc-pageno">{t('u145.statementN', { n: i + 1, of: statements.length })}</span></div>
          <PrintedBy lang={lang} timezone={timezone} />
        </div>
      ))}
    </div>
  )
}
