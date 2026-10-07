import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Empty, PageHead, useConfirm, useToast } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { fmtDate, num, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'
import { addDays } from '../../lib/calendar'
import { lineDue, lineOwed, owedQty } from '../../lib/inventory'
import { useRun } from '../jobs/common'
import { Tick } from './bits'
import { PayModal } from './PoModals'

// Inventory → Supplier bills: delivered parts not paid for yet, by supplier and due date, and recent payments.
export default function BillsTab({ data, reload, canEdit }) {
  const { t, lang } = useT()
  const toast = useToast()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const soon = addDays(today, 7)
  const { run } = useRun(reload)
  const [confirm, confirmEl] = useConfirm()
  const [sel, setSel] = useState(() => new Set())
  const [paying, setPaying] = useState(null) // supplier id

  const groups = useMemo(() => {
    const g = {}
    for (const l of data.lines) {
      if (owedQty(l) <= 0) continue
      const po = data.poById[l.po_id]
      if (!po) continue
      const sup = data.supplierById[po.supplier_id]
      const due = lineDue(l, po, sup)
      const amount = lineOwed(l, po)
      const x = (g[po.supplier_id] ||= { sup, rows: [], total: 0, overdue: 0 })
      x.rows.push({ l, po, due, amount })
      x.total += amount
      if (due && due < today) x.overdue += amount
    }
    const list = Object.values(g)
    for (const x of list) x.rows.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
    return list.sort((a, b) => b.overdue - a.overdue || b.total - a.total)
  }, [data, today])

  const sum = groups.reduce((a, x) => ({
    total: a.total + x.total, overdue: a.overdue + x.overdue,
    soon: a.soon + x.rows.filter((r) => r.due && r.due >= today && r.due <= soon).reduce((s, r) => s + r.amount, 0),
  }), { total: 0, overdue: 0, soon: 0 })

  const toggle = (id, on) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const recent = data.payments.slice(0, 15)
  async function undo(p) {
    const ok = await confirm({ title: t('inv.pay.undoTitle'), text: t('inv.pay.undoText', { amount: rp(p.amount), date: fmtDate(p.paid_at, lang) }), yes: t('inv.pay.undoYes'), no: t('inv.keep'), danger: true })
    if (ok === true) run(() => supabase.rpc('undo_supplier_payment', { p_payment: p.id }), t('inv.pay.undone'))
  }
  const payGroup = paying && groups.find((x) => x.sup?.id === paying)
  const payItems = payGroup ? payGroup.rows.filter((r) => sel.has(r.l.id)).map((r) => ({ line: r.l, po: r.po })) : []

  return (
    <>
      <PageHead title={t('inv.bills.title')} sub={t('inv.bills.sub')} />
      <div className="kpis" style={{ marginTop: 0, marginBottom: 16 }}>
        <div className="kpi card"><div className="kpi-label">{t('inv.bills.owed')}</div><div className="kpi-value">{rp(sum.total)}</div></div>
        <div className="kpi card"><div className="kpi-label">{t('inv.bills.overdue')}</div><div className="kpi-value" style={{ color: sum.overdue ? 'var(--red)' : undefined }}>{rp(sum.overdue)}</div></div>
        <div className="kpi card"><div className="kpi-label">{t('inv.bills.soon')}</div><div className="kpi-value">{rp(sum.soon)}</div></div>
      </div>
      {groups.length === 0 ? (
        <div className="card"><Empty icon="receipt" title={t('inv.bills.noneTitle')}>{t('inv.bills.noneText')}</Empty></div>
      ) : groups.map((x) => {
        const mine = x.rows.filter((r) => sel.has(r.l.id))
        return (
          <section key={x.sup?.id || 'none'} className="card" style={{ marginBottom: 16 }}>
            <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>{x.sup?.name || '—'}</h2>
              <span className="muted small">{t('inv.bills.supTotal', { amount: rp(x.total) })}</span>
              {x.overdue > 0 && <Badge color="red">{t('inv.bills.supOverdue', { amount: rp(x.overdue) })}</Badge>}
              <div className="spacer" />
              {canEdit && <Button size="sm" variant={mine.length ? 'primary' : undefined} disabled={!mine.length} onClick={() => setPaying(x.sup.id)}>
                {mine.length ? t('inv.bills.paySelected', { n: mine.length }) : t('inv.bills.pickToPay')}</Button>}
            </div>
            {x.sup?.account_number && <div className="small muted" style={{ marginTop: -6, marginBottom: 8 }}>{t('inv.po.account', { no: x.sup.account_number })}</div>}
            <div className="table compact flush">
              <table>
                <thead><tr>
                  {canEdit && <th style={{ width: 28 }}><Tick checked={x.rows.every((r) => sel.has(r.l.id))} onChange={(v) => setSel((s) => { const n = new Set(s); for (const r of x.rows) { if (v) n.add(r.l.id); else n.delete(r.l.id) } return n })} label={t('inv.bills.selectSupplier', { name: x.sup?.name || '' })} /></th>}
                  <th>{t('inv.col.po')}</th><th>{t('inv.col.part')}</th><th className="wide-only">{t('inv.col.invoice')}</th><th className="num">{t('inv.col.qty')}</th><th>{t('inv.col.due')}</th><th className="num">{t('inv.col.amount')}</th>
                </tr></thead>
                <tbody>
                  {x.rows.map(({ l, po, due, amount }) => (
                    <tr key={l.id}>
                      {canEdit && <td><Tick checked={sel.has(l.id)} onChange={(v) => toggle(l.id, v)} label={t('inv.order.pick', { name: l.name })} /></td>}
                      <td className="nowrap"><Link to={`/inventory/purchase-orders/${po.id}`}>{po.po_number}</Link></td>
                      <td>{l.name}</td>
                      <td className="wide-only small">{l.supplier_invoice_no || <span className="muted">—</span>}{l.delivered_at && <div className="muted">{t('inv.line.receivedOn', { date: fmtDate(l.delivered_at, lang) })}</div>}</td>
                      <td className="num">{num(owedQty(l), 2)}</td>
                      <td className="nowrap">{due ? <span className={due < today ? 'text-red' : ''} style={{ fontWeight: due < today ? 700 : undefined }}>{fmtDate(due, lang)}</span> : '—'}{due && due < today && <div className="small text-red">{t('inv.line.overdue')}</div>}</td>
                      <td className="num nowrap">{rp(amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}

      <section className="card">
        <h2>{t('inv.bills.recent')}</h2>
        {recent.length === 0 ? <div className="muted small">{t('inv.bills.noPayments')}</div> : (
          <div className="table compact flush">
            <table>
              <thead><tr><th>{t('inv.pay.date')}</th><th>{t('inv.col.supplier')}</th><th className="wide-only">{t('inv.pay.method')}</th><th className="wide-only">{t('inv.pay.reference')}</th><th className="num">{t('inv.col.amount')}</th><th aria-label={t('inv.more')} /></tr></thead>
              <tbody>
                {recent.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">{fmtDate(p.paid_at, lang)}</td>
                    <td>{data.supplierById[p.supplier_id]?.name || '—'}<div className="muted small">{t((p.po_item_ids || []).length === 1 ? 'inv.bills.nLine' : 'inv.bills.nLines', { n: (p.po_item_ids || []).length })}</div></td>
                    <td className="wide-only">{t(`inv.pay.m.${p.method || 'other'}`)}</td>
                    <td className="wide-only small">{p.reference || <span className="muted">—</span>}</td>
                    <td className="num nowrap"><b>{rp(p.amount)}</b></td>
                    <td className="num">{canEdit && <button type="button" className="linkbtn small" onClick={() => undo(p)}>{t('inv.pay.undo')}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="hint">{t('inv.bills.hint')}</div>
      {confirmEl}
      <PayModal open={!!paying} onClose={() => setPaying(null)} supplier={payGroup?.sup} items={payItems}
        onDone={(amount) => { const name = payGroup?.sup?.name || ''; setPaying(null); setSel(new Set()); reload(); toast(t('inv.pay.done', { amount: rp(amount), name })) }} />
    </>
  )
}
