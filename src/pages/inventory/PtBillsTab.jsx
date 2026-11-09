import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Empty, Notice, PageHead } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, jobNo, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'

// Inventory → Tagihan PT (142, Denny Nov 9): what each PT owes its suppliers for a month, from the POs it pays
// directly (delivered that month, less returns). Suppliers bill at the end or start of the month; this is the list to
// check their bill against. The shop records nothing here: the PT pays.
export default function PtBillsTab() {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const [month, setMonth] = useState(() => shopToday(timezone).slice(0, 7))
  const [res, setRes] = useState(null)
  useEffect(() => {
    let live = true
    setRes(null)
    supabase.rpc('pt_supplier_bills', { p_month: `${month}-01` }).then((r) => { if (live) setRes(r) })
    return () => { live = false }
  }, [month])

  // payer → supplier → lines
  const groups = useMemo(() => {
    const out = []
    for (const l of res?.data?.lines || []) {
      let p = out.find((x) => x.payer === l.payer)
      if (!p) out.push(p = { payer: l.payer, total: 0, sups: [] })
      let s = p.sups.find((x) => x.supplier === l.supplier)
      if (!s) p.sups.push(s = { supplier: l.supplier, total: 0, lines: [] })
      s.lines.push(l); s.total += Number(l.amount) || 0; p.total += Number(l.amount) || 0
    }
    return out
  }, [res])
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
          {p.sups.map((s) => (
            <div key={s.supplier} style={{ marginBottom: 12 }}>
              <div className="row" style={{ gap: 8 }}><b>{s.supplier || '—'}</b><div className="spacer" /><span className="small">{rp(s.total)}</span></div>
              <div className="table compact flush">
                <table>
                  <thead><tr>
                    <th>{t('u142.received')}</th><th>{t('inv.col.po')}</th><th>{t('inv.col.part')}</th><th className="wide-only">{t('u142.forJob')}</th>
                    <th className="wide-only">{t('inv.col.invoice')}</th><th className="num">{t('inv.col.qty')}</th><th className="num">{t('inv.col.amount')}</th>
                  </tr></thead>
                  <tbody>
                    {s.lines.map((l) => (
                      <tr key={l.line_id}>
                        <td className="nowrap">{fmtDate(l.delivered_at, lang)}</td>
                        <td className="nowrap"><Link to={`/inventory/purchase-orders/${l.po_id}`}>{l.po_number}</Link></td>
                        <td>{l.name}{l.line_type === 'sublet' && <div className="small muted">{t('u141.subletNote')}</div>}</td>
                        <td className="wide-only small">{l.ro_id ? <Link to={`/jobs/${l.ro_id}`}>#{jobNo(l.job_number)}</Link> : '—'}{l.plate && ` · ${l.plate}`}{l.company && <div className="muted">{l.company}</div>}</td>
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
