import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Empty, Notice, PageHead } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, jobNo, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { nameKey, payerBookLabel } from '../../lib/books'

// Inventory → Tagihan PT (142, Denny Nov 9): what each PT owes for a month. From the POs it pays directly (delivered
// that month, less returns), per supplier, to check against the supplier's month-end bill; a PO the driver paid first
// (talangan, 145) is owed to the driver. Since 145 also the oil its trucks took that month from another PT's or
// book's drum ("Oli dari drum", owed to the drum's owner), and on the owner's side what it will receive. The shop
// records no payment here: the PT pays.
const bkey = (payer, book) => `${nameKey(payer)}|${nameKey(book)}`

export default function PtBillsTab() {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [month, setMonth] = useState(() => shopToday(timezone).slice(0, 7))
  const [res, setRes] = useState(null)
  const [book, setBook] = useState('') // one book only (143): '' = all; "payer|book"
  useEffect(() => {
    let live = true
    setRes(null)
    setBook('')
    supabase.rpc('pt_supplier_bills', { p_month: `${month}-01` }).then((r) => { if (live) setRes(r) })
    return () => { live = false }
  }, [month])
  const lines = res?.data?.lines || []
  const oil = res?.data?.drum_oil || []

  // the books in this month's list (143), to show one book at a time (e.g. to print for its bookkeeper)
  const bookOptions = useMemo(() => {
    const m = new Map()
    for (const l of lines) if (l.book) m.set(bkey(l.payer, l.book), payerBookLabel(l.payer, l.book))
    for (const o of oil) {
      m.set(bkey(o.payer, o.book), payerBookLabel(o.payer, o.book))
      m.set(bkey(o.drum_payer, o.drum_book || o.drum_payer), payerBookLabel(o.drum_payer, o.drum_book))
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [res]) // eslint-disable-line react-hooks/exhaustive-deps
  // payer → suppliers / drivers (talangan) / drum oil to pay / drum oil to receive; per payer the total per book
  const groups = useMemo(() => {
    const out = []
    const payerOf = (payer) => {
      let p = out.find((x) => nameKey(x.payer) === nameKey(payer))
      if (!p) out.push(p = { payer, total: 0, sups: [], drivers: [], oil: [], receive: [], books: [] })
      return p
    }
    const addBook = (p, b, amount) => {
      let x = p.books.find((y) => nameKey(y.book) === nameKey(b))
      if (!x) p.books.push(x = { book: b || '', total: 0 })
      x.total += amount
    }
    for (const l of lines) {
      if (book && bkey(l.payer, l.book) !== book) continue
      const p = payerOf(l.payer)
      const a = Number(l.amount) || 0
      addBook(p, l.book, a)
      const list = l.talangan ? p.drivers : p.sups
      const name = l.talangan ? l.talangan.name : l.supplier
      let s = list.find((x) => x.name === name && (!l.talangan || x.po_id === l.po_id))
      if (!s) list.push(s = { name, total: 0, lines: [], po_id: l.po_id, talangan: l.talangan, supplier: l.supplier })
      s.lines.push(l); s.total += a; p.total += a
    }
    for (const o of oil) {
      const a = Number(o.amount) || 0
      if (!book || bkey(o.payer, o.book) === book) {
        const p = payerOf(o.payer)
        addBook(p, o.book, a)
        let s = p.oil.find((x) => bkey(x.payer, x.book) === bkey(o.drum_payer, o.drum_book))
        if (!s) p.oil.push(s = { payer: o.drum_payer, book: o.drum_book, total: 0, lines: [] })
        s.lines.push(o); s.total += a; p.total += a
      }
      if (!book || bkey(o.drum_payer, o.drum_book || o.drum_payer) === book) {
        const p = payerOf(o.drum_payer)
        let s = p.receive.find((x) => bkey(x.payer, x.book) === bkey(o.payer, o.book))
        if (!s) p.receive.push(s = { payer: o.payer, book: o.book, total: 0, litres: 0 })
        s.total += a; s.litres += Number(o.litres) || 0
      }
    }
    for (const p of out) p.books.sort((a, b) => a.book.localeCompare(b.book))
    return out.sort((a, b) => a.payer.localeCompare(b.payer))
  }, [res, book]) // eslint-disable-line react-hooks/exhaustive-deps
  const shift = (n) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(Date.UTC(y, m - 1 + n, 1))
    setMonth(d.toISOString().slice(0, 7))
  }
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-GB' : 'id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const bookLabel = book ? bookOptions.find(([k]) => k === book)?.[1] : t('u143.allBooks')

  // on paper the table head repeats on every page, with the PT and group above it (item 30)
  const capRow = (caption, cols) => <tr className="print-only print-cap"><th colSpan={cols}>{caption}</th></tr>
  const lineTable = (rows, caption) => (
    <div className="table compact flush print-table">
      <table>
        <thead>{capRow(caption, 8)}<tr>
          <th>{t('u142.received')}</th><th>{t('inv.col.po')}</th><th>{t('inv.col.part')}</th><th className="wide-only">{t('u142.forJob')}</th><th>{t('u143.book')}</th>
          <th className="wide-only">{t('inv.col.invoice')}</th><th className="num">{t('inv.col.qty')}</th><th className="num">{t('inv.col.amount')}</th>
        </tr></thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.line_id}>
              <td className="nowrap">{fmtDate(l.delivered_at, lang)}</td>
              <td className="nowrap"><Link to={`/inventory/purchase-orders/${l.po_id}`}>{l.po_number}</Link></td>
              <td>{l.name}{l.line_type === 'sublet' && <div className="small muted">{t('u141.subletNote')}</div>}</td>
              <td className="wide-only small">{l.ro_id ? <Link to={`/jobs/${l.ro_id}`}>#{jobNo(l.job_number)}</Link> : '—'}{l.plate && ` · ${l.plate}`}{l.company && <div className="muted">{l.company}</div>}</td>
              <td className="small">{l.book || <span className="muted">—</span>}</td>
              <td className="wide-only small">{l.supplier_invoice_no || <span className="muted">—</span>}</td>
              <td className="num">{num(l.qty, 2)}</td>
              <td className="num nowrap">{rp(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <>
      <div className="no-print">
        <PageHead title={t('u142.ptBillsTitle')} sub={t('u142.ptBillsSub')} actions={
          <div className="row wrap" style={{ gap: 6 }}>
            <Button size="sm" icon="chevronLeft" onClick={() => shift(-1)} aria-label={t('u142.prevMonth')} />
            <input type="month" className="input" style={{ width: 160 }} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label={t('u142.month')} />
            <Button size="sm" icon="chevronRight" onClick={() => shift(1)} aria-label={t('u142.nextMonth')} />
            {bookOptions.length > 0 && (
              <select className="select" style={{ width: 'auto', maxWidth: 260 }} value={book} onChange={(e) => setBook(e.target.value)} aria-label={t('u143.book')}>
                <option value="">{t('u143.allBooks')}</option>
                {bookOptions.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            )}
            <Button size="sm" icon="print" onClick={() => window.print()}>{t('u142.print')}</Button>
          </div>
        } />
      </div>
      {/* on paper: a title line instead of the controls (item 30) */}
      <div className="print-only print-title">
        <h1>{t('u142.ptBillsTitle')}</h1>
        <div>{monthLabel} · {bookLabel}</div>
      </div>
      {res?.error && <Notice kind="err">{errorText(res.error, t)}</Notice>}
      {!res ? <div className="muted">{t('common.loading')}</div> : groups.length === 0 ? (
        <div className="card"><Empty icon="receipt" title={t('u142.ptBillsNone')}>{t('u142.ptBillsNoneText')}</Empty></div>
      ) : groups.map((p) => (
        <section key={p.payer} className="card pt-card" style={{ marginBottom: 16 }}>
          <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{p.payer}</h2>
            <div className="spacer" />
            <b>{rp(p.total)}</b>
          </div>
          {p.books.length > 1 && (
            <div className="row wrap small" style={{ gap: '4px 16px', marginBottom: 10 }}>
              {p.books.map((b) => <span key={b.book}>{t('u143.bookTotal', { book: b.book || t('u143.noBook'), amount: rp(b.total) })}</span>)}
            </div>
          )}
          {p.sups.map((s) => (
            <div key={s.name} className="pt-group" style={{ marginBottom: 12 }}>
              <div className="row pt-grouphead" style={{ gap: 8 }}><b>{s.name || '—'}</b><div className="spacer" /><span className="small">{rp(s.total)}</span></div>
              {lineTable(s.lines, `${p.payer} · ${s.name || '—'}`)}
            </div>
          ))}
          {/* a PO the driver paid first: owed to the driver (145, item 35) */}
          {p.drivers.map((s) => (
            <div key={s.po_id} className="pt-group" style={{ marginBottom: 12 }}>
              <div className="row wrap pt-grouphead" style={{ gap: 8 }}>
                <b>{t('u145.talanganTo', { name: s.name })}</b>
                <span className="small muted">{t('u145.talanganAt', { supplier: s.supplier || '—' })}{s.talangan?.nota && ` · ${t('u145.notaNo', { no: s.talangan.nota })}`}</span>
                {s.talangan?.reimbursed_on ? <Badge color="green">{t('u145.reimbursedOn', { date: fmtDate(s.talangan.reimbursed_on, lang) })}</Badge> : <Badge color="amber">{t('u145.notReimbursed')}</Badge>}
                <div className="spacer" /><span className="small">{rp(s.total)}</span>
              </div>
              {lineTable(s.lines, `${p.payer} · ${t('u145.talanganTo', { name: s.name })}`)}
            </div>
          ))}
          {/* the month's oil from another PT's or book's drum (145, item 29) */}
          {p.oil.map((s) => (
            <div key={bkey(s.payer, s.book)} className="pt-group" style={{ marginBottom: 12 }}>
              <div className="row wrap pt-grouphead" style={{ gap: 8 }}>
                <b>{t('u145.drumOilTo', { owner: payerBookLabel(s.payer, s.book) })}</b>
                {Number(s.lines[0]?.drum_open) <= 0 ? <Badge color="green">{t('u145.drumPaidUp')}</Badge> : <span className="small muted">{t('u145.drumOpenAll', { amount: rp(s.lines[0]?.drum_open) })}</span>}
                <div className="spacer" /><span className="small">{rp(s.total)}</span>
              </div>
              <div className="table compact flush print-table">
                <table>
                  <thead>{capRow(`${p.payer} · ${t('u145.drumOilTo', { owner: payerBookLabel(s.payer, s.book) })}`, 8)}<tr><th>{t('u145.col.date')}</th><th>{t('inv.col.invoice')}</th><th>{t('u145.col.oil')}</th><th className="wide-only">{t('u145.col.truck')}</th><th>{t('u143.book')}</th>
                    <th className="num">{t('u142.litres')}</th><th className="num">{t('u145.col.perL')}</th><th className="num">{t('inv.col.amount')}</th></tr></thead>
                  <tbody>
                    {s.lines.map((o, i) => (
                      <tr key={i}>
                        <td className="nowrap">{fmtDate(o.day, lang)}</td>
                        <td className="nowrap"><Link to={`/jobs/${o.ro_id}`}>{o.invoice_no}</Link></td>
                        <td>{o.oil}</td>
                        <td className="wide-only small">{o.plate}{o.company && <div className="muted">{o.company}</div>}</td>
                        <td className="small">{o.book}</td>
                        <td className="num">{num(o.litres, 2)}</td>
                        <td className="num nowrap">{rp(o.cost_per_l)}{o.estimated && <span className="muted small"> *</span>}</td>
                        <td className="num nowrap">{rp(o.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {/* the drum owner's side: what it will receive for its drums this month */}
          {p.receive.length > 0 && (
            <div className="pt-group small" style={{ marginTop: 4 }}>
              <div className="sectionlabel" style={{ marginTop: 0 }}>{t('u145.drumReceive')}</div>
              {p.receive.map((r) => (
                <div key={bkey(r.payer, r.book)}>{t('u145.drumReceiveLine', { from: payerBookLabel(r.payer, r.book), litres: num(r.litres, 2), amount: rp(r.total) })}</div>
              ))}
              <div className="muted">{t('u145.drumReceiveHint')}</div>
            </div>
          )}
        </section>
      ))}
      <div className="hint no-print">{t('u142.ptBillsHint')} {t('u145.ptBillsHint')}</div>
    </>
  )
}
