import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Empty, Notice, PageHead } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, jobNo, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { payerBookLabel } from '../../lib/books'

// Inventory → Tagihan PT (142, Denny Nov 9): what each PT owes its suppliers for a month, from the POs it pays
// directly (delivered that month, less returns). Suppliers bill at the end or start of the month; this is the list to
// check their bill against. The shop records nothing here: the PT pays.
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

  // the books in this month's list (143), to show one book at a time (e.g. to print for its bookkeeper)
  const bookKey = (l) => `${l.payer || ''}|${l.book || ''}`
  const bookOptions = useMemo(() => {
    const m = new Map()
    for (const l of res?.data?.lines || []) if (l.book) m.set(bookKey(l), payerBookLabel(l.payer, l.book))
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [res])
  // payer → supplier → lines; per payer also the total per book
  const groups = useMemo(() => {
    const out = []
    for (const l of res?.data?.lines || []) {
      if (book && bookKey(l) !== book) continue
      let p = out.find((x) => x.payer === l.payer)
      if (!p) out.push(p = { payer: l.payer, total: 0, sups: [], books: [] })
      let b = p.books.find((x) => x.book === (l.book || ''))
      if (!b) p.books.push(b = { book: l.book || '', total: 0 })
      b.total += Number(l.amount) || 0
      let s = p.sups.find((x) => x.supplier === l.supplier)
      if (!s) p.sups.push(s = { supplier: l.supplier, total: 0, lines: [] })
      s.lines.push(l); s.total += Number(l.amount) || 0; p.total += Number(l.amount) || 0
    }
    for (const p of out) p.books.sort((a, b) => a.book.localeCompare(b.book))
    return out
  }, [res, book])
  const shift = (n) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(Date.UTC(y, m - 1 + n, 1))
    setMonth(d.toISOString().slice(0, 7))
  }

  return (
    <>
      <PageHead title={t('u142.ptBillsTitle')} sub={t('u142.ptBillsSub')} actions={
        <div className="row" style={{ gap: 6 }}>
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
      {res?.error && <Notice kind="err">{errorText(res.error, t)}</Notice>}
      {!res ? <div className="muted">{t('common.loading')}</div> : groups.length === 0 ? (
        <div className="card"><Empty icon="receipt" title={t('u142.ptBillsNone')}>{t('u142.ptBillsNoneText')}</Empty></div>
      ) : groups.map((p) => (
        <section key={p.payer} className="card" style={{ marginBottom: 16 }}>
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
            <div key={s.supplier} style={{ marginBottom: 12 }}>
              <div className="row" style={{ gap: 8 }}><b>{s.supplier || '—'}</b><div className="spacer" /><span className="small">{rp(s.total)}</span></div>
              <div className="table compact flush">
                <table>
                  <thead><tr>
                    <th>{t('u142.received')}</th><th>{t('inv.col.po')}</th><th>{t('inv.col.part')}</th><th className="wide-only">{t('u142.forJob')}</th><th>{t('u143.book')}</th>
                    <th className="wide-only">{t('inv.col.invoice')}</th><th className="num">{t('inv.col.qty')}</th><th className="num">{t('inv.col.amount')}</th>
                  </tr></thead>
                  <tbody>
                    {s.lines.map((l) => (
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
            </div>
          ))}
        </section>
      ))}
      <div className="hint">{t('u142.ptBillsHint')}</div>
    </>
  )
}
