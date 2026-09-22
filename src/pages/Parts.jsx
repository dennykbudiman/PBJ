import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, formatRupiah, formatDate, severityPalette } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'

// Stock status badge colors follow the shared severity convention:
// out -> danger, low -> warning, in (the `default` branch) -> neutral.
const PART_STATUS_LABEL = { in: 'In Stock', low: 'Low Stock', out: 'Out of Stock' }

// Purchase-order status doesn't fit the vehicle/work-order severity words used
// elsewhere, so it gets its own small palette map (still built from the same
// design tokens as everything else).
const PO_STATUS_LABEL = {
  notordered: 'Not Ordered',
  ordered: 'Ordered',
  partial: 'Partially Received',
  received: 'Received',
}
function poStatusPalette(status) {
  if (status === 'partial') return severityPalette('low') // warn
  if (status === 'received') return { bg: colors.accentBg, color: colors.good }
  if (status === 'ordered') return { bg: colors.accentBg, color: colors.accent }
  return severityPalette('default') // notordered -> neutral
}

const EMPTY_DRAFT = {
  id: null, name: '', part_number: '', category: '',
  qty_on_hand: 0, reorder_point: 5, unit_cost: 0, supplier: '', bin_location: '',
}

function sortRows(rows, key, dir) {
  if (!key) return rows
  const factor = dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key]
    if (av == null && bv == null) return 0
    if (av == null) return -1 * factor
    if (bv == null) return 1 * factor
    if (typeof av === 'string') return av.localeCompare(bv) * factor
    return (av > bv ? 1 : av < bv ? -1 : 0) * factor
  })
}

export default function Parts() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const canDeleteParts = hasPermission('delete_parts')

  const [parts, setParts] = useState([])
  const [pos, setPos] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [partsSort, setPartsSort] = useState({ key: null, dir: 'asc' })
  const [poSort, setPoSort] = useState({ key: null, dir: 'asc' })
  const [banner, setBanner] = useState(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addDraft, setAddDraft] = useState(null) // "Add Part" modal

  const [receiveOpen, setReceiveOpen] = useState(false)
  const [receivePo, setReceivePo] = useState(null) // full po row
  const [receiveLines, setReceiveLines] = useState([])

  const [editorOpen, setEditorOpen] = useState(false)
  const [editorPoId, setEditorPoId] = useState(null)
  const [editorDraft, setEditorDraft] = useState(null) // { supplier, items: [{rowId, partId, partQuery, qtyOrdered, unitCost}] }
  const [editorSearchRow, setEditorSearchRow] = useState(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: partRows }, { data: poRows }] = await Promise.all([
      supabase.from('parts_with_status').select('*').order('name', { ascending: true }),
      supabase
        .from('purchase_orders')
        .select('*, purchase_order_items(id, part_id, qty_ordered, qty_received, unit_cost, parts(name, part_number, supplier))')
        .order('created_at', { ascending: false }),
    ])
    setParts(partRows ?? [])
    setPos(poRows ?? [])
    setLoading(false)
  }

  // ---------- Parts list ----------
  const counts = {
    all: parts.length,
    in: parts.filter((p) => p.stock_status === 'in').length,
    low: parts.filter((p) => p.stock_status === 'low').length,
    out: parts.filter((p) => p.stock_status === 'out').length,
  }
  const q = search.trim().toLowerCase()
  const filteredParts = parts
    .filter((p) => filter === 'all' || p.stock_status === filter)
    .filter((p) => q === '' || p.name.toLowerCase().includes(q) || (p.part_number || '').toLowerCase().includes(q))
  const visibleParts = sortRows(filteredParts, partsSort.key, partsSort.dir)

  function toggleSort(setter, current, key) {
    setter({ key, dir: current.key === key && current.dir === 'asc' ? 'desc' : 'asc' })
  }

  function openEditPart(p) {
    navigate(`/parts/${p.id}`)
  }
  function openAddPart() {
    setAddDraft({ ...EMPTY_DRAFT })
    setAddOpen(true)
  }
  function updateAddDraft(field, isNumber) {
    return (e) => {
      const raw = e.target.value
      setAddDraft((d) => ({ ...d, [field]: isNumber ? Number(raw) || 0 : raw }))
    }
  }

  async function saveNewPart(e) {
    e.preventDefault()
    if (!addDraft) return
    const payload = {
      name: addDraft.name, part_number: addDraft.part_number || null, category: addDraft.category || null,
      qty_on_hand: addDraft.qty_on_hand, reorder_point: addDraft.reorder_point, unit_cost: addDraft.unit_cost,
      supplier: addDraft.supplier || null, bin_location: addDraft.bin_location || null,
    }
    const { data, error } = await supabase.from('parts').insert(payload).select().single()
    setAddOpen(false)
    setAddDraft(null)
    if (!error && data) {
      navigate(`/parts/${data.id}`)
    } else {
      load()
    }
  }

  // ---------- Reorder -> draft PO ----------
  async function reorderPart(p) {
    const qtyToOrder = Math.max(p.reorder_point * 2 - p.qty_on_hand, p.reorder_point, 1)
    const { count } = await supabase.from('purchase_orders').select('id', { count: 'exact', head: true })
    const poNumber = `PO-${1001 + (count ?? 0)}`
    const { data: newPo } = await supabase
      .from('purchase_orders')
      .insert({ po_number: poNumber, supplier: p.supplier, status: 'notordered' })
      .select()
      .single()
    if (newPo) {
      await supabase.from('purchase_order_items').insert({
        purchase_order_id: newPo.id, part_id: p.id, qty_ordered: qtyToOrder, qty_received: 0, unit_cost: p.unit_cost,
      })
      setBanner({ type: 'po', poNumber, partName: p.name, qty: qtyToOrder })
      load()
    }
  }

  // ---------- Receiving ----------
  const openPOs = pos.filter((po) => po.status === 'ordered' || po.status === 'partial')

  function openReceive(po) {
    setReceivePo(po)
    setReceiveLines(
      (po.purchase_order_items ?? []).map((it) => ({
        ...it,
        receiveQty: Math.max(0, it.qty_ordered - it.qty_received),
      }))
    )
    setReceiveOpen(true)
  }
  function closeReceive() {
    setReceiveOpen(false)
    setReceivePo(null)
    setReceiveLines([])
  }
  function updateReceiveQty(itemId, remaining) {
    return (e) => {
      const raw = Number(e.target.value) || 0
      const clamped = Math.max(0, Math.min(raw, remaining))
      setReceiveLines((lines) => lines.map((l) => (l.id === itemId ? { ...l, receiveQty: clamped } : l)))
    }
  }
  const canConfirmReceive = !!receivePo && receiveLines.some((l) => (Number(l.receiveQty) || 0) > 0)

  async function confirmReceive() {
    if (!receivePo) return
    let totalReceivedNow = 0
    for (const line of receiveLines) {
      const addQty = Number(line.receiveQty) || 0
      if (addQty <= 0) continue
      totalReceivedNow += addQty
      const newReceived = Math.min(line.qty_ordered, line.qty_received + addQty)
      await supabase.from('purchase_order_items').update({ qty_received: newReceived }).eq('id', line.id)
      const part = parts.find((p) => p.id === line.part_id)
      if (part) {
        await supabase.from('parts').update({ qty_on_hand: part.qty_on_hand + addQty }).eq('id', part.id)
      }
    }
    const allReceived = receiveLines.every((l) => Math.min(l.qty_ordered, l.qty_received + (Number(l.receiveQty) || 0)) >= l.qty_ordered)
    const anyReceived = receiveLines.some((l) => l.qty_received + (Number(l.receiveQty) || 0) > 0)
    const newStatus = allReceived ? 'received' : anyReceived ? 'partial' : receivePo.status
    await supabase.from('purchase_orders').update({ status: newStatus }).eq('id', receivePo.id)
    setBanner({ type: 'received', poNumber: receivePo.po_number, qty: totalReceivedNow, date: formatDate(new Date()) })
    closeReceive()
    load()
  }

  // ---------- Draft PO editor (status = notordered) ----------
  function openEditor(po) {
    setEditorPoId(po.id)
    setEditorDraft({
      supplier: po.supplier || '',
      items: (po.purchase_order_items ?? []).map((it) => ({
        rowId: it.id,
        itemId: it.id,
        partId: it.part_id,
        partQuery: it.parts?.name || '',
        qtyOrdered: it.qty_ordered,
        unitCost: it.unit_cost,
      })),
    })
    setEditorSearchRow(null)
    setEditorOpen(true)
  }
  function closeEditor() {
    setEditorOpen(false)
    setEditorPoId(null)
    setEditorDraft(null)
    setEditorSearchRow(null)
  }
  function addEditorItem() {
    setEditorDraft((d) => ({
      ...d,
      items: [...d.items, { rowId: 'new-' + Date.now() + Math.random(), itemId: null, partId: '', partQuery: '', qtyOrdered: 1, unitCost: 0 }],
    }))
  }
  function removeEditorItem(rowId) {
    setEditorDraft((d) => ({ ...d, items: d.items.filter((it) => it.rowId !== rowId) }))
  }
  function updateEditorField(rowId, field, isNumber) {
    return (e) => {
      const raw = e.target.value
      setEditorDraft((d) => ({
        ...d,
        items: d.items.map((it) => (it.rowId === rowId ? { ...it, [field]: isNumber ? Number(raw) || 0 : raw } : it)),
      }))
    }
  }
  function pickEditorPart(rowId, part) {
    setEditorDraft((d) => ({
      ...d,
      supplier: d.supplier || part.supplier || '',
      items: d.items.map((it) => (it.rowId === rowId ? { ...it, partId: part.id, partQuery: part.name, unitCost: part.unit_cost } : it)),
    }))
    setEditorSearchRow(null)
  }

  const editorLockedSupplier = editorDraft && editorDraft.items.find((it) => it.partId)
    ? parts.find((p) => p.id === editorDraft.items.find((it) => it.partId).partId)?.supplier || null
    : null

  const editorTotal = editorDraft
    ? editorDraft.items.reduce((s, it) => s + (Number(it.qtyOrdered) || 0) * (Number(it.unitCost) || 0), 0)
    : 0
  const canMarkOrdered = !!editorDraft && editorDraft.items.length > 0 && editorDraft.items.every((it) => it.partId && Number(it.qtyOrdered) > 0)

  async function persistEditorItems() {
    const draft = editorDraft
    const keepIds = []
    for (const it of draft.items) {
      if (!it.partId) continue
      const row = { purchase_order_id: editorPoId, part_id: it.partId, qty_ordered: Math.max(1, Number(it.qtyOrdered) || 0), unit_cost: Number(it.unitCost) || 0 }
      if (it.itemId) {
        await supabase.from('purchase_order_items').update(row).eq('id', it.itemId)
        keepIds.push(it.itemId)
      } else {
        const { data } = await supabase.from('purchase_order_items').insert({ ...row, qty_received: 0 }).select().single()
        if (data) keepIds.push(data.id)
      }
    }
    // Remove any items dropped from the draft.
    const originalIds = (pos.find((p) => p.id === editorPoId)?.purchase_order_items ?? []).map((it) => it.id)
    const toDelete = originalIds.filter((id) => !keepIds.includes(id))
    for (const id of toDelete) await supabase.from('purchase_order_items').delete().eq('id', id)
    await supabase.from('purchase_orders').update({ supplier: draft.supplier }).eq('id', editorPoId)
  }

  async function saveDraftPO() {
    await persistEditorItems()
    closeEditor()
    load()
  }

  async function markAsOrdered() {
    await persistEditorItems()
    const po = pos.find((p) => p.id === editorPoId)
    await supabase.from('purchase_orders').update({ status: 'ordered', ordered_date: new Date().toISOString().slice(0, 10) }).eq('id', editorPoId)
    setBanner({ type: 'ordered', poNumber: po?.po_number })
    closeEditor()
    load()
  }

  async function deleteDraftPO() {
    await supabase.from('purchase_order_items').delete().eq('purchase_order_id', editorPoId)
    await supabase.from('purchase_orders').delete().eq('id', editorPoId)
    closeEditor()
    load()
  }

  const poRows = sortRows(
    pos.map((po) => {
      const items = po.purchase_order_items ?? []
      const totalOrdered = items.reduce((s, it) => s + it.qty_ordered, 0)
      const totalReceived = items.reduce((s, it) => s + it.qty_received, 0)
      return { ...po, itemsCount: items.length, totalOrdered, totalReceived }
    }),
    poSort.key,
    poSort.dir
  )

  if (loading) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading parts…</main>
  }

  return (
    <>
      <PageHeader title="Parts Stocking">
        <div style={{ flex: '1 1 auto', maxWidth: 360, display: 'flex', alignItems: 'center', gap: 8, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            type="text"
            placeholder="Search by part name or number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ border: 'none', background: 'transparent', outline: 'none', fontFamily: 'inherit', fontSize: 13, width: '100%', color: colors.ink }}
          />
        </div>
        <SecondaryButton onClick={() => { setReceivePo(null); setReceiveLines([]); setReceiveOpen(true) }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10m0 0l3.5-3.5M12 13L8.5 9.5" /><path d="M4.5 13v5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" /></svg>
          Receive Parts
        </SecondaryButton>
        <PrimaryButton onClick={openAddPart}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          Add Part
        </PrimaryButton>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {banner && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.accentBg, border: `1px solid rgba(20,107,105,0.18)`, borderRadius: 10, padding: '12px 16px', fontSize: 13, color: colors.ink }}>
            {banner.type === 'received' && <span>Received <strong>{banner.qty} units</strong> against <strong>{banner.poNumber}</strong> on {banner.date} — stock levels updated below.</span>}
            {banner.type === 'po' && <span><strong>{banner.poNumber}</strong> drafted for {banner.qty} × {banner.partName} — status "Not Ordered". Edit its items or mark it ordered from Purchase Orders below.</span>}
            {banner.type === 'ordered' && <span><strong>{banner.poNumber}</strong> marked as Ordered — it can now be received against once the supplier ships.</span>}
            <button type="button" onClick={() => setBanner(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 16, lineHeight: 1 }}>×</button>
          </div>
        )}

        <div role="group" aria-label="Filter parts by stock status" style={{ display: 'flex', gap: 8 }}>
          {['all', 'in', 'low', 'out'].map((key) => {
            const isOn = filter === key
            const label = key === 'all' ? 'All' : key === 'in' ? 'In stock' : key === 'low' ? 'Low stock' : 'Out of stock'
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                style={{
                  borderRadius: 999, border: `1px solid ${isOn ? colors.accent : colors.borderStrong}`,
                  background: isOn ? colors.accent : colors.white, color: isOn ? colors.white : colors.text2,
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
                }}
              >
                {label} · {counts[key]}
              </button>
            )
          })}
        </div>

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 1000, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <SortTh label="Part" k="name" sort={partsSort} onClick={() => toggleSort(setPartsSort, partsSort, 'name')} />
                  <SortTh label="Category" k="category" sort={partsSort} onClick={() => toggleSort(setPartsSort, partsSort, 'category')} />
                  <SortTh label="On hand" k="qty_on_hand" sort={partsSort} onClick={() => toggleSort(setPartsSort, partsSort, 'qty_on_hand')} />
                  <SortTh label="Status" k="stock_status" sort={partsSort} onClick={() => toggleSort(setPartsSort, partsSort, 'stock_status')} />
                  <SortTh label="Unit cost" k="unit_cost" sort={partsSort} onClick={() => toggleSort(setPartsSort, partsSort, 'unit_cost')} />
                  <SortTh label="Supplier" k="supplier" sort={partsSort} onClick={() => toggleSort(setPartsSort, partsSort, 'supplier')} />
                  <SortTh label="Bin" k="bin_location" sort={partsSort} onClick={() => toggleSort(setPartsSort, partsSort, 'bin_location')} />
                  <th style={{ padding: '12px 20px' }}></th>
                </tr>
              </thead>
              <tbody>
                {visibleParts.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No parts match.</td></tr>
                )}
                {visibleParts.map((p) => {
                  const pal = severityPalette(p.stock_status === 'out' ? 'out' : p.stock_status === 'low' ? 'low' : 'default')
                  return (
                    <tr key={p.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '14px 20px' }}>
                        <button type="button" onClick={() => openEditPart(p)} style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: colors.accent, whiteSpace: 'nowrap' }}>{p.name}</span>
                          <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, fontFamily: fontMono, marginTop: 1 }}>{p.part_number}</span>
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{p.category || '—'}</td>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 700, fontFamily: fontMono, color: p.stock_status === 'out' ? colors.danger : p.stock_status === 'low' ? colors.warn : colors.ink }}>{p.qty_on_hand}</span>
                        <span style={{ color: colors.mutedLight }}> / {p.reorder_point} reorder pt.</span>
                      </td>
                      <td style={tdStyle}><Badge bg={pal.bg} color={pal.color}>{PART_STATUS_LABEL[p.stock_status]}</Badge></td>
                      <td style={{ ...tdStyle, fontWeight: 600, fontFamily: fontMono }}>{formatRupiah(p.unit_cost)}</td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{p.supplier || '—'}</td>
                      <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{p.bin_location || '—'}</td>
                      <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                        <button
                          type="button"
                          onClick={() => reorderPart(p)}
                          style={{
                            border: `1px solid ${p.stock_status === 'out' ? colors.danger : colors.borderStrong}`,
                            background: p.stock_status === 'out' ? colors.danger : colors.white,
                            color: p.stock_status === 'out' ? colors.white : colors.ink,
                            borderRadius: 7, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          Reorder
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Purchase Orders</h2>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <SortTh label="PO #" k="po_number" sort={poSort} onClick={() => toggleSort(setPoSort, poSort, 'po_number')} />
                  <SortTh label="Supplier" k="supplier" sort={poSort} onClick={() => toggleSort(setPoSort, poSort, 'supplier')} />
                  <SortTh label="Ordered" k="ordered_date" sort={poSort} onClick={() => toggleSort(setPoSort, poSort, 'ordered_date')} />
                  <SortTh label="Items" k="itemsCount" sort={poSort} onClick={() => toggleSort(setPoSort, poSort, 'itemsCount')} />
                  <SortTh label="Received" k="totalReceived" sort={poSort} onClick={() => toggleSort(setPoSort, poSort, 'totalReceived')} />
                  <SortTh label="Status" k="status" sort={poSort} onClick={() => toggleSort(setPoSort, poSort, 'status')} />
                </tr>
              </thead>
              <tbody>
                {poRows.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No purchase orders yet.</td></tr>
                )}
                {poRows.map((po) => {
                  const pal = poStatusPalette(po.status)
                  return (
                    <tr key={po.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '14px 20px' }}>
                        <button
                          type="button"
                          onClick={() => (po.status === 'notordered' ? openEditor(po) : openReceive(po))}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: fontMono, fontSize: 13, fontWeight: 700, color: colors.accent, whiteSpace: 'nowrap' }}
                        >
                          {po.po_number}
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{po.supplier || '—'}</td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{po.ordered_date ? formatDate(po.ordered_date) : '—'}</td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{po.itemsCount === 1 ? '1 line item' : `${po.itemsCount} line items`}</td>
                      <td style={{ ...tdStyle, fontFamily: fontMono }}>{po.totalReceived}/{po.totalOrdered} units</td>
                      <td style={tdStyle}><Badge bg={pal.bg} color={pal.color}>{PO_STATUS_LABEL[po.status]}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Add part modal — a centered quick-create form, matching Add Vehicle/Driver/Owner.
          Viewing or editing an existing part opens its own full page instead. */}
      {addOpen && addDraft && (
        <Modal title="Add Part" onClose={() => setAddOpen(false)} width={440}>
          <form onSubmit={saveNewPart} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Field label="Part name"><input required type="text" value={addDraft.name} onChange={updateAddDraft('name')} style={inputStyle} /></Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Part number"><input type="text" value={addDraft.part_number || ''} onChange={updateAddDraft('part_number')} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
              <Field label="Category"><input type="text" value={addDraft.category || ''} onChange={updateAddDraft('category')} style={inputStyle} /></Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="On hand"><input type="number" min="0" step="1" value={addDraft.qty_on_hand} onChange={updateAddDraft('qty_on_hand', true)} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
              <Field label="Reorder point"><input type="number" min="0" step="1" value={addDraft.reorder_point} onChange={updateAddDraft('reorder_point', true)} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
            </div>
            <Field label="Unit cost (Rp)"><input type="number" min="0" step="1000" value={addDraft.unit_cost} onChange={updateAddDraft('unit_cost', true)} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
            <Field label="Supplier"><input type="text" value={addDraft.supplier || ''} onChange={updateAddDraft('supplier')} style={inputStyle} /></Field>
            <Field label="Bin location"><input type="text" value={addDraft.bin_location || ''} onChange={updateAddDraft('bin_location')} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <SecondaryButton type="button" onClick={() => setAddOpen(false)}>Cancel</SecondaryButton>
              <PrimaryButton type="submit">Add Part</PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

      {/* Receive parts modal */}
      {receiveOpen && (
        <Modal title="Receive Parts" onClose={closeReceive} width={640}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Open purchase orders</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
              {openPOs.length === 0 && <div style={{ fontSize: 13, color: colors.mutedLight }}>No open purchase orders match.</div>}
              {openPOs.map((po) => {
                const pal = poStatusPalette(po.status)
                const active = receivePo?.id === po.id
                return (
                  <button
                    key={po.id}
                    type="button"
                    onClick={() => openReceive(po)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left',
                      background: active ? colors.bg : colors.white, border: `1px solid ${active ? colors.accent : colors.border}`, borderRadius: 8, padding: '9px 11px', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    <span>
                      <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ink, fontFamily: fontMono }}>{po.po_number}</span>
                      <span style={{ display: 'block', fontSize: 11, color: colors.mutedLight, marginTop: 1 }}>{po.supplier}</span>
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: pal.color }}>{PO_STATUS_LABEL[po.status]}</span>
                  </button>
                )
              })}
            </div>

            {receivePo && (
              <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{receivePo.supplier}</div>
                    <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>Ordered {receivePo.ordered_date ? formatDate(receivePo.ordered_date) : '—'}</div>
                  </div>
                </div>
                <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, overflowX: 'auto' }}>
                  <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                        <th style={thStyleSmall}>Part</th>
                        <th style={thStyleSmall}>Remaining</th>
                        <th style={thStyleSmall}>Receiving now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiveLines.map((line) => {
                        const remaining = line.qty_ordered - line.qty_received
                        const done = remaining <= 0
                        return (
                          <tr key={line.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                            <td style={{ padding: '10px 12px' }}>
                              <div style={{ fontSize: 12, fontWeight: 700 }}>{line.parts?.name}</div>
                              <div style={{ fontSize: 11, color: colors.mutedLight, fontFamily: fontMono, marginTop: 1 }}>{line.parts?.part_number}</div>
                            </td>
                            <td style={{ padding: '10px 8px', fontSize: 12, color: colors.text2 }}>{remaining} of {line.qty_ordered}</td>
                            <td style={{ padding: '10px 8px' }}>
                              <input
                                type="number" min="0" value={line.receiveQty} disabled={done}
                                onChange={updateReceiveQty(line.id, remaining)}
                                style={{ width: 80, border: `1px solid ${colors.borderStrong}`, borderRadius: 6, padding: '6px 8px', fontFamily: fontMono, fontSize: 12, color: colors.ink, background: done ? colors.bg : colors.white }}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
          <div style={{ padding: '16px 24px', borderTop: `1px solid ${colors.border}`, display: 'flex', gap: 8, flexShrink: 0, margin: '0 -24px -24px -24px' }}>
            <SecondaryButton onClick={closeReceive} style={{ flex: '1 1 0', justifyContent: 'center' }}>Cancel</SecondaryButton>
            <PrimaryButton onClick={confirmReceive} disabled={!canConfirmReceive} style={{ flex: '1 1 0', justifyContent: 'center', opacity: canConfirmReceive ? 1 : 0.4, cursor: canConfirmReceive ? 'pointer' : 'not-allowed' }}>Receive</PrimaryButton>
          </div>
        </Modal>
      )}

      {/* Draft PO editor */}
      {editorOpen && editorDraft && (
        <Modal title={pos.find((p) => p.id === editorPoId)?.po_number || ''} subtitle="Not Ordered — items can be added or removed until this PO is marked ordered." onClose={closeEditor} width={720}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Field label="Supplier">
              <input
                type="text" value={editorDraft.supplier} disabled={!!editorLockedSupplier}
                onChange={(e) => setEditorDraft((d) => ({ ...d, supplier: e.target.value }))}
                style={{ ...inputStyle, background: editorLockedSupplier ? colors.bg : colors.white }}
              />
              {editorLockedSupplier && <div style={{ fontSize: 11, color: colors.mutedLight, marginTop: 5 }}>A PO can only hold parts from one supplier — set by the first part added.</div>}
            </Field>

            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10 }}>
              <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                    <th style={thStyleSmall}>Part</th>
                    <th style={thStyleSmall}>Qty</th>
                    <th style={thStyleSmall}>Unit cost</th>
                    <th style={thStyleSmall}>Amount</th>
                    <th style={{ padding: '9px 12px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {editorDraft.items.map((item) => {
                    const isOpen = editorSearchRow === item.rowId
                    const qq = (item.partQuery || '').trim().toLowerCase()
                    const matches = isOpen
                      ? parts
                          .filter((p) => !editorLockedSupplier || p.supplier === editorLockedSupplier)
                          .filter((p) => qq === '' || p.name.toLowerCase().includes(qq) || (p.part_number || '').toLowerCase().includes(qq))
                          .slice(0, 6)
                      : []
                    const amount = (Number(item.qtyOrdered) || 0) * (Number(item.unitCost) || 0)
                    return (
                      <tr key={item.rowId} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                        <td style={{ padding: '8px 12px', position: 'relative', minWidth: 220 }}>
                          <input
                            type="text" autoComplete="off" placeholder="Search parts…"
                            value={item.partQuery}
                            onChange={(e) => { updateEditorField(item.rowId, 'partQuery')(e); setEditorSearchRow(item.rowId) }}
                            onFocus={() => setEditorSearchRow(item.rowId)}
                            onBlur={() => setTimeout(() => setEditorSearchRow((r) => (r === item.rowId ? null : r)), 120)}
                            style={{ width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 7, padding: '8px 10px', fontFamily: 'inherit', fontSize: 12.5, color: colors.ink }}
                          />
                          {isOpen && (
                            <div style={{ position: 'absolute', top: '100%', left: 10, right: 10, marginTop: 4, border: `1px solid ${colors.borderStrong}`, borderRadius: 8, background: colors.white, boxShadow: '0 10px 24px rgba(20,20,20,0.18)', maxHeight: 220, overflowY: 'auto', zIndex: 50 }}>
                              {matches.map((p) => (
                                <button
                                  key={p.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickEditorPart(item.rowId, p)}
                                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid rgba(28,30,34,0.06)', padding: '9px 11px', cursor: 'pointer', fontFamily: 'inherit' }}
                                >
                                  <span>
                                    <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ink }}>{p.name}</span>
                                    <span style={{ display: 'block', fontSize: 11, color: colors.mutedLight, fontFamily: fontMono, marginTop: 1 }}>{p.part_number}</span>
                                  </span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: colors.accent, whiteSpace: 'nowrap' }}>{formatRupiah(p.unit_cost)}</span>
                                </button>
                              ))}
                              {matches.length === 0 && <div style={{ padding: 10, fontSize: 12, color: colors.mutedLight }}>{editorLockedSupplier ? `No parts from ${editorLockedSupplier} match.` : 'No parts match.'}</div>}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          <input type="number" min="1" step="1" value={item.qtyOrdered} onChange={updateEditorField(item.rowId, 'qtyOrdered', true)} style={{ width: 70, border: `1px solid ${colors.border}`, borderRadius: 6, padding: '6px 8px', fontFamily: fontMono, fontSize: 12, color: colors.ink }} />
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          <input type="number" min="0" step="1000" value={item.unitCost} onChange={updateEditorField(item.rowId, 'unitCost', true)} style={{ width: 100, border: `1px solid ${colors.border}`, borderRadius: 6, padding: '6px 8px', fontFamily: fontMono, fontSize: 12, color: colors.ink }} />
                        </td>
                        <td style={{ padding: '8px 8px', fontSize: 12, fontWeight: 700, fontFamily: fontMono, whiteSpace: 'nowrap' }}>{formatRupiah(amount)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                          <button type="button" onClick={() => removeEditorItem(item.rowId)} aria-label="Remove line item" style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${colors.borderStrong}`, background: colors.white, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={colors.danger} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <button type="button" onClick={addEditorItem} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: '1px dashed rgba(28,30,34,0.24)', color: colors.accent, borderRadius: 8, padding: '8px 14px', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              Add Part
            </button>

            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8, borderTop: `1px solid ${colors.border}` }}>
              <div style={{ fontSize: 13, color: colors.text2 }}>PO total: <strong style={{ fontWeight: 700, color: colors.ink, fontFamily: fontMono }}>{formatRupiah(editorTotal)}</strong></div>
            </div>
          </div>
          <div style={{ padding: '16px 24px', borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, margin: '16px -24px -24px -24px' }}>
            <button type="button" onClick={deleteDraftPO} style={{ background: colors.white, color: colors.danger, border: `1px solid rgba(192,57,43,0.35)`, borderRadius: 8, padding: '11px 14px', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Delete Draft</button>
            <div style={{ flex: '1 1 auto' }} />
            <SecondaryButton onClick={closeEditor}>Cancel</SecondaryButton>
            <button type="button" onClick={saveDraftPO} style={{ background: colors.white, color: colors.accent, border: `1px solid ${colors.accent}`, borderRadius: 8, padding: '11px 16px', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Save Draft</button>
            <button type="button" onClick={markAsOrdered} disabled={!canMarkOrdered} style={{ background: canMarkOrdered ? colors.accent : colors.white, color: canMarkOrdered ? colors.white : colors.mutedLight, border: 'none', borderRadius: 8, padding: '11px 16px', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: canMarkOrdered ? 'pointer' : 'not-allowed' }}>Mark as Ordered</button>
          </div>
        </Modal>
      )}
    </>
  )
}

function SortTh({ label, k, sort, onClick }) {
  const arrow = sort.key === k ? (sort.dir === 'desc' ? '↓' : '↑') : ''
  return (
    <th scope="col" style={{ padding: '12px 16px' }}>
      <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {label} {arrow}
      </button>
    </th>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  )
}

function Modal({ title, subtitle, onClose, width, children }) {
  return (
    <>
      <button type="button" onClick={onClose} aria-label="Close" style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,20,0.45)', border: 'none', padding: 0, cursor: 'default', zIndex: 49 }} />
      <div role="dialog" aria-modal="true" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width, maxWidth: 'calc(100vw - 48px)', maxHeight: '85vh', background: colors.white, borderRadius: 14, boxShadow: '0 24px 64px rgba(20,20,20,0.30)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{title}</h2>
            {subtitle && <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={closeBtnStyle}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={colors.text3} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: 24 }}>{children}</div>
      </div>
    </>
  )
}

const tdStyle = { padding: '14px 12px', fontSize: 13, whiteSpace: 'nowrap' }
const thStyleSmall = { padding: '9px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const inputStyle = { width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 11px', fontFamily: 'inherit', fontSize: 13, color: colors.ink }
const closeBtnStyle = { width: 30, height: 30, borderRadius: 8, border: 'none', background: '#F7F6F2', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }
