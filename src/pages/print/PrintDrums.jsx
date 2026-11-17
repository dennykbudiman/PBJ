import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { usePageTitle } from '../../lib/branding'
import PrintedBy from '../../components/PrintedBy'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { useT, translate } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, km as fmtKm, num, rp } from '../../lib/format'
import { nameKey, payerBookLabel } from '../../lib/books'
import { terbilang } from '../../lib/terbilang'

// /print/drums?drum=<id>&book=<payer|book>&from=&to=&lang= (145, item 28): drum-oil statements. One statement per
// pair of books (who used the oil → whose drum it was), each on its own A4 page: every invoiced oil line in the
// period, the total, what was paid ("Tandai lunas") and what is still open, and signature boxes. The drum owner's own
// use is listed on its own page for information (nothing to pay). Also a CSV for Excel.
const key = (payer, book) => `${nameKey(payer)}|${nameKey(book)}`

// The one-time old-oil bill (150, `old`): only the oil changes from before the app ("sebelum aplikasi") are billed,
// up to 1 Nov 2026, and the total is just those lines. Oil on invoices (from 2 Nov) belongs on the monthly statement.
export const OLD_OIL_TO = '2026-11-01'
const preappOnly = (x) => {
  const lines = (x.lines || []).filter((l) => l.preapp)
  if (!lines.length) return null
  const litres = lines.reduce((a, l) => a + (Number(l.litres) || 0), 0)
  const amount = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0)
  return { ...x, lines, litres, amount, owed_all: amount, paid: 0, open: x.owes ? amount : 0, payments: [] }
}

// A bill for a period (150c, Denny 17 Nov): only the oil on invoices in the period, and the total is that oil.
// Books with nothing in the period get no page. Payments ("Tandai lunas") are kept per drum, not per month, so they
// are never taken off here: what was paid and is still open on the drum since it was opened is shown for information.
const periodOnly = (x) => {
  const lines = (x.lines || []).filter((l) => !l.preapp)
  if (!lines.length) return null
  const litres = lines.reduce((a, l) => a + (Number(l.litres) || 0), 0)
  const amount = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0)
  return { ...x, lines, litres, amount }
}

export function drumStatements(drums, { drum, book, t, old = false, period = false }) {
  const out = new Map()
  for (const d of drums || []) {
    if (drum && d.id !== drum) continue
    for (const x0 of d.debtors || []) {
      const x = old ? preappOnly(x0) : period ? periodOnly(x0) : x0
      if (!x) continue
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
  const old = params.get('old') === '1'
  const from = old ? '' : params.get('from') || ''
  const to = old ? OLD_OIL_TO : params.get('to') || ''
  const byPeriod = !old && !!(from || to)
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
  const statements = useMemo(() => drumStatements(drums, { drum, book, t, old, period: byPeriod }).filter((s) => s.owes || own), [res, drum, book, own, lang, old, byPeriod]) // eslint-disable-line react-hooks/exhaustive-deps
  const bookChoices = useMemo(() => {
    const m = new Map()
    for (const d of drums) for (const x of d.debtors || []) m.set(key(x.payer, x.book), x.payer ? payerBookLabel(x.payer, x.book) : tUi('u142.theShop'))
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [res]) // eslint-disable-line react-hooks/exhaustive-deps
  usePageTitle(t('u145.drumDocTitle'), { alone: true })

  if (!money) return <div className="print-msg">{tUi('err.permission')}</div>
  if (!res || !settings) return <div className="print-msg">{tUi('common.loading')}</div>
  if (res.error) return <div className="print-msg">{errorText(res.error, tUi)}</div>

  const period = old ? t('u150.oldPeriod', { date: fmtDate('2026-11-02', lang) }) : from || to ? `${from ? fmtDate(from, lang) : '…'} – ${to ? fmtDate(to, lang) : fmtDate(new Date().toISOString().slice(0, 10), lang)}` : t('u145.sinceOpened')
  function csv() {
    const rows = [[t('u145.csv.from'), t('u145.csv.to'), t('u145.col.oil'), t('u145.col.date'), t('inv.col.invoice'), t('u145.col.truck'), t('u142.company'), t('u142.litres'), t('u145.col.perL'), t('inv.col.amount'), t('u145.csv.toPay')]]
    for (const st of statements) for (const { drum: d, debtor: x } of st.drums) for (const l of x.lines || []) {
      rows.push([st.from, st.to, d.oil, l.day, l.preapp ? t('u149.preappCsv', { km: l.km ?? '' }) : l.invoice_no, l.plate || '', l.company || '', String(l.litres).replace('.', ','), d.cost_per_l, l.amount, st.owes ? 'ya' : 'tidak'])
    }
    const text = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
    a.download = old ? 'oli-drum-lama-sebelum-aplikasi.csv' : `oli-drum-${from || 'awal'}-${to || 'sekarang'}.csv`
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
        {old ? (
          <span className="small"><b>{tUi('u150.oldOil')}</b> · {tUi('u150.oldBar')} <button type="button" className="linkbtn small" onClick={() => setParam('old', '')}>{tUi('u150.oldToNormal')}</button></span>
        ) : (<>
          <label className="mini">{tUi('u145.from')} <input type="date" className="input" value={from} onChange={(e) => setParam('from', e.target.value)} /></label>
          <label className="mini">{tUi('u145.to')} <input type="date" className="input" value={to} onChange={(e) => setParam('to', e.target.value)} /></label>
        </>)}
        <label className="inlinecheck"><input type="checkbox" checked={own} onChange={(e) => setParam('own', e.target.checked ? '' : '0')} /> {tUi('u145.showOwn')}</label>
        <div className="seg">
          <button type="button" className={`seg-btn ${lang === 'id' ? 'on' : ''}`} onClick={() => setParam('lang', 'id')}>Bahasa Indonesia</button>
          <button type="button" className={`seg-btn ${lang === 'en' ? 'on' : ''}`} onClick={() => setParam('lang', 'en')}>English</button>
        </div>
        <div className="spacer" />
        <button type="button" className="btn" onClick={csv} disabled={!statements.length}>{tUi('u145.csv')}</button>
        <button type="button" className="btn primary" onClick={() => window.print()} disabled={!statements.length}>{tUi('job.print')}</button>
      </div>
      {statements.length === 0 && <div className="print-msg">{tUi(old ? 'u150.oldNone' : 'u145.noDrumUse')}</div>}
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
              <h1>{old ? (st.owes ? t('u150.oldTitle') : t('u150.oldOwnTitle')) : st.owes ? t('u145.drumDocTitle') : t('u145.drumOwnTitle')}</h1>
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
                <span className="small muted">{t('u145.drumInfo', { litres: num(d.litres, 2), date: fmtDate(d.opened_on, lang), price: rp(d.cost_per_l), unit: d.unit || 'L', left: num(d.left, 2) })}{d.estimated && ` · ${t('u143.estimate')}`}{d.emptied_on && ` · ${t('u149.emptied', { date: fmtDate(d.emptied_on, lang) })}`}</span>
              </div>
              <table className="doc-lines">
                <thead><tr><th>{t('u145.col.date')}</th><th>{t('inv.col.invoice')}</th><th>{t('u145.col.truck')}</th><th>{t('u142.company')}</th>
                  <th className="num">{t('u142.litres')}</th><th className="num">{t('u145.col.perL')}</th><th className="num">{t('inv.col.amount')}</th></tr></thead>
                <tbody>
                  {(x.lines || []).map((l, k) => (
                    <tr key={k}><td className="nowrap">{fmtDate(l.day, lang)}</td><td className="nowrap">{l.preapp ? <i>{t('u149.preappDoc')}{l.km != null ? <span className="muted"> · {fmtKm(l.km)}</span> : null}</i> : l.invoice_no}</td><td className="nowrap">{l.plate}</td><td>{l.company}</td>
                      <td className="num">{num(l.litres, 2)}</td><td className="num">{rp(d.cost_per_l)}</td><td className="num">{rp(l.amount)}</td></tr>
                  ))}
                  {(x.lines || []).length === 0 && <tr><td colSpan={7} className="muted">{t('u145.noLinesPeriod')}</td></tr>}
                  <tr className="svc-total"><td colSpan={4}>{t('u145.subtotal')}</td><td className="num">{num(x.litres, 2)}</td><td /><td className="num">{rp(x.amount)}</td></tr>
                </tbody>
              </table>
              {st.owes && !byPeriod && (x.payments || []).length > 0 && (
                <div className="small" style={{ marginTop: 4 }}>
                  {x.payments.map((p) => <div key={p.id}>{t('u145.paidLine', { date: fmtDate(p.paid_on, lang), amount: rp(p.amount), how: p.method ? t(`inv.pay.m.${p.method}`) : '', ref: p.reference || '' })}</div>)}
                </div>
              )}
            </div>
          ))}
          {st.owes && old ? (
            <div className="old-bottom">
              {/* the total on its own full-width line, the note and the amount in words under it */}
              <table className="doc-totals old-total"><tbody>
                <tr className="grand"><th>{t('u150.oldPays', { from: st.from, to: st.to, litres: num(st.litres, 2) })}</th><td>{rp(st.amount)}</td></tr>
              </tbody></table>
              <div className="doc-notes small old-note">
                <div>{t('u150.oldNote')}</div>
                {st.amount > 0 && <div style={{ marginTop: 2 }}><i>{t('u145.terbilang', { words: terbilang(st.amount) })}</i></div>}
              </div>
            </div>
          ) : st.owes && byPeriod ? (
            <div className="old-bottom per-bottom">
              {/* a period: the bill is the period's oil; the drum's whole account only for information */}
              <table className="doc-totals old-total"><tbody>
                <tr className="grand"><th>{t('u150.perPays', { from: st.from, to: st.to, litres: num(st.litres, 2) })}</th><td>{rp(st.amount)}</td></tr>
              </tbody></table>
              <div className="doc-notes small old-note">
                <div>{t('u150.perNote')}</div>
                {st.amount > 0 && <div style={{ marginTop: 2 }}><i>{t('u145.terbilang', { words: terbilang(st.amount) })}</i></div>}
                <div className="muted per-info" style={{ marginTop: 4 }}>{t(st.drums.length > 1 ? 'u150.perInfoN' : 'u150.perInfo1', { owed: rp(st.owed), paid: rp(st.paid), open: rp(st.open) })}</div>
              </div>
            </div>
          ) : st.owes ? (
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
