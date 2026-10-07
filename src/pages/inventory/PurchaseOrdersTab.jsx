import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Button, Empty, Input, Modal, Notice, PageHead, Select, Textarea } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, num, rp } from '../../lib/format'
import { openQty, poTotals } from '../../lib/inventory'
import { SearchBox } from '../catalog/common'
import { JobRef, PayBadge, PoBadge } from './bits'

const OPEN = ['draft', 'ordered', 'partially_delivered']

// Inventory → Purchase orders: open ones first, with what's still to come and what they cost.
export default function PurchaseOrdersTab({ data, reload, go, canEdit, showCost }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const part = params.get('part')
  const [q, setQ] = useState('')
  const [show, setShow] = useState('open')
  const [sup, setSup] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  // "New purchase order" from the + menu arrives as ?new=1.
  useEffect(() => {
    if (params.get('new') && canEdit) { setNewOpen(true); navigate('/inventory/purchase-orders', { replace: true }) }
  }, [location.search]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s/g, '')
    return data.pos.map((po) => {
      const lines = data.linesByPo[po.id] || []
      return { po, lines, tot: poTotals(po, lines), sup: data.supplierById[po.supplier_id] }
    }).filter(({ po, lines, sup: s }) => {
      if (show === 'open' && !OPEN.includes(po.status)) return false
      if (show === 'unpaid' && !(po.payment_status !== 'paid' && lines.some((l) => Number(l.qty_delivered) > Number(l.qty_paid || 0)))) return false
      if (show !== 'all' && show !== 'open' && show !== 'unpaid' && po.status !== show) return false
      if (sup && po.supplier_id !== sup) return false
      if (part && !lines.some((l) => l.catalog_item_id === part && openQty(l) > 0)) return false
      if (!needle) return true
      const j = po.ro_id && data.jobById[po.ro_id]
      const v = j && data.vehicleById[j.vehicle_id]
      return [po.po_number, s?.name, j?.job_number, v?.plate, ...lines.map((l) => `${l.name} ${l.part_number || ''} ${l.supplier_invoice_no || ''}`)]
        .filter(Boolean).join(' ').toLowerCase().replace(/\s/g, '').includes(needle)
    }).sort((a, b) => (OPEN.includes(a.po.status) ? 0 : 1) - (OPEN.includes(b.po.status) ? 0 : 1))
  }, [data, q, show, sup, part])

  return (
    <>
      <PageHead title={t('inv.po.title')} sub={t('inv.po.sub')}
        actions={canEdit && <Button variant="primary" icon="plus" onClick={() => setNewOpen(true)}>{t('inv.po.new')}</Button>} />
      {part && data.itemById[part] && (
        <Notice kind="info" style={{ marginBottom: 12 }}>
          {t('inv.po.forPart', { name: data.itemById[part].name })} <Link to="/inventory/purchase-orders">{t('inv.showAll')}</Link>
        </Notice>
      )}
      <div className="filterbar">
        <SearchBox value={q} onChange={setQ} placeholder={t('inv.po.search')} />
        <select className="select chipselect" value={show} onChange={(e) => setShow(e.target.value)} aria-label={t('inv.show')}>
          <option value="open">{t('inv.po.f.open')}</option>
          <option value="draft">{t('inv.po.st.draft')}</option>
          <option value="ordered">{t('inv.po.st.ordered')}</option>
          <option value="partially_delivered">{t('inv.po.st.partially_delivered')}</option>
          <option value="delivered">{t('inv.po.st.delivered')}</option>
          <option value="cancelled">{t('inv.po.st.cancelled')}</option>
          {showCost && <option value="unpaid">{t('inv.po.f.unpaid')}</option>}
          <option value="all">{t('inv.po.f.all')}</option>
        </select>
        <select className="select chipselect" value={sup} onChange={(e) => setSup(e.target.value)} aria-label={t('inv.col.supplier')}>
          <option value="">{t('inv.allSuppliers')}</option>
          {data.suppliers.filter((s) => s.type !== 'sublet').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="card"><Empty icon="packages" title={data.pos.length ? t('inv.nothingFound') : t('inv.po.noneTitle')}>{data.pos.length ? t('inv.nothingFoundText') : t('inv.po.noneText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr>
              <th>{t('inv.col.po')}</th><th>{t('inv.col.supplier')}</th><th className="wide-only">{t('inv.col.for')}</th><th>{t('inv.col.status')}</th>
              <th className="wide-only">{t('inv.col.ordered')}</th><th className="num">{t('inv.col.received')}</th>
              {showCost && <th className="num">{t('inv.col.total')}</th>}{showCost && <th className="wide-only">{t('inv.col.payment')}</th>}
            </tr></thead>
            <tbody>
              {rows.map(({ po, lines, tot, sup: s }) => {
                const ordered = lines.reduce((a, l) => a + Number(l.qty_ordered) - Number(l.qty_cancelled), 0)
                const got = lines.reduce((a, l) => a + Number(l.qty_delivered), 0)
                return (
                  <tr key={po.id} className="clickrow" onClick={(e) => { if (!e.target.closest('a')) go(`/inventory/purchase-orders/${po.id}`) }}>
                    <td><Link className="rowlink" to={`/inventory/purchase-orders/${po.id}`}>{po.po_number}</Link><div className="muted small">{t(lines.length === 1 ? 'inv.po.nLine' : 'inv.po.nLines', { n: lines.length })}</div></td>
                    <td>{s?.name || '—'}</td>
                    <td className="wide-only"><JobRef data={data} roId={po.ro_id} /></td>
                    <td><PoBadge status={po.status} /></td>
                    <td className="wide-only nowrap">{po.ordered_at ? fmtDate(po.ordered_at, lang, timezone) : <span className="muted">—</span>}</td>
                    <td className="num nowrap">{num(got, 2)} / {num(ordered, 2)}</td>
                    {showCost && <td className="num nowrap">{rp(tot.total)}</td>}
                    {showCost && <td className="wide-only">{got > 0 ? <PayBadge status={po.payment_status} /> : <span className="muted small">—</span>}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <NewPoModal open={newOpen} onClose={() => setNewOpen(false)} data={data}
        onDone={(po) => { setNewOpen(false); reload(); go(`/inventory/purchase-orders/${po.id}`) }} />
    </>
  )
}

// A blank stock PO: supplier, terms and a note. Parts are added on the PO page.
function NewPoModal({ open, onClose, data, onDone }) {
  const { t } = useT()
  const [f, setF] = useState({ supplier_id: '', terms: '', notes: '' })
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setF({ supplier_id: '', terms: '', notes: '' }); setErr({}); setFail(null) } }, [open])
  const sups = data.suppliers.filter((s) => s.active !== false && s.type !== 'sublet')
  const pickSup = (id) => setF((x) => ({ ...x, supplier_id: id, terms: data.supplierById[id]?.payment_terms_days == null ? '' : String(data.supplierById[id].payment_terms_days) }))
  async function save() {
    const e = {}
    if (!f.supplier_id) e.supplier_id = t('inv.err.supplier')
    const terms = f.terms.trim() === '' ? null : Number(f.terms)
    if (terms != null && (!Number.isInteger(terms) || terms < 0 || terms > 365)) e.terms = t('inv.err.terms')
    setErr(e)
    if (Object.keys(e).length || busy) return
    setBusy(true)
    const { data: po, error } = await supabase.from('purchase_orders').insert({ supplier_id: f.supplier_id, payment_terms_days: terms, notes: f.notes.trim() || null, status: 'draft' }).select().single()
    setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone(po)
  }
  return (
    <Modal open={open} title={t('inv.po.newTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('inv.po.create')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      {sups.length === 0 ? <Notice kind="warn">{t('inv.po.noSuppliers')} <Link to="/catalog/suppliers/new">{t('inv.po.addSupplier')}</Link></Notice> : (
        <>
          <Select label={t('inv.col.supplier')} value={f.supplier_id} onChange={(e) => pickSup(e.target.value)} error={err.supplier_id}
            options={[{ value: '', label: t('inv.order.chooseSupplier') }, ...sups.map((s) => ({ value: s.id, label: s.name }))]} />
          {f.supplier_id && data.supplierById[f.supplier_id]?.pinned_notes && <Notice kind="warn" style={{ marginBottom: 10 }}>{data.supplierById[f.supplier_id].pinned_notes}</Notice>}
          <Input label={t('inv.po.terms')} value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} inputMode="numeric" suffix={t('common.days')} error={err.terms} hint={t('inv.po.termsHint')} />
          <Textarea label={t('inv.po.notes')} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} maxLength={2000} />
          <div className="hint">{t('inv.po.newHint')}</div>
        </>
      )}
    </Modal>
  )
}
