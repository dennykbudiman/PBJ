import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, formatRupiah, formatDate } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import ConfirmModal from '../components/ConfirmModal'
import DetailHeader from '../components/DetailHeader'
import { TabBar, TabButton } from '../components/Tabs'
import { createReorderPO } from '../lib/purchaseOrders'

// Status / priority / line-item-type palettes, ported 1:1 from the
// WorkOrders.dc.html prototype's statusMeta / priorityMeta / typeMeta maps.
// (severityPalette() in theme.js maps 'low' to warn, which is right for
// parts stock but not for work-order priority, so these stay local.)
const STATUS_META = {
  open: { label: 'Open', bg: colors.neutralBg, color: colors.neutral },
  inprogress: { label: 'In Progress', bg: colors.accentBg, color: colors.accent },
  onhold: { label: 'On Hold', bg: colors.warnBg, color: colors.warn },
  completed: { label: 'Completed', bg: '#E6F5EA', color: '#227A3E' },
}
const PRIORITY_META = {
  urgent: { label: 'Urgent', bg: colors.dangerBg, color: colors.danger },
  high: { label: 'High', bg: colors.warnBg, color: colors.warn },
  medium: { label: 'Medium', bg: colors.neutralBg, color: colors.neutral },
  low: { label: 'Low', bg: colors.neutralBg, color: colors.neutral },
}
const TYPE_META = {
  labor: { label: 'Labor', bg: colors.accentBg, color: colors.accent },
  part: { label: 'Part', bg: colors.neutralBg, color: colors.neutral },
}
const PO_STATUS_META = {
  notordered: { label: 'Not Ordered', bg: colors.neutralBg, color: colors.neutral },
  ordered: { label: 'Ordered', bg: colors.accentBg, color: colors.accent },
  partial: { label: 'Partially Received', bg: colors.warnBg, color: colors.warn },
  received: { label: 'Received', bg: colors.accentBg, color: colors.good },
}
function partStockStatus(part) {
  if (!part) return null
  if (part.qty_on_hand === 0) return { label: 'Out of stock', bg: colors.dangerBg, color: colors.danger, low: true }
  if (part.qty_on_hand <= part.reorder_point) return { label: `Low stock · ${part.qty_on_hand} left`, bg: colors.warnBg, color: colors.warn, low: true }
  return { label: `${part.qty_on_hand} in stock`, bg: colors.neutralBg, color: colors.neutral, low: false }
}
const UNIT_OPTIONS = ['hr', 'set', 'L', 'unit', 'kit']
const STATUS_OPTIONS = ['open', 'inprogress', 'onhold', 'completed']
const PRIORITY_OPTIONS = ['urgent', 'high', 'medium', 'low']
const TAX_RATE = 0.11 // PPN, matches the prototype's `subtotal * 0.11`

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'inprogress', label: 'In progress' },
  { key: 'onhold', label: 'On hold' },
  { key: 'completed', label: 'Completed' },
]

function lineItemTotal(items) {
  return (items || []).reduce((s, li) => s + (Number(li.qty) || 0) * (Number(li.rate) || 0), 0)
}

function computeTotals(items) {
  const laborTotal = (items || []).filter((li) => li.type === 'labor').reduce((s, li) => s + (Number(li.qty) || 0) * (Number(li.rate) || 0), 0)
  const partsTotal = (items || []).filter((li) => li.type === 'part').reduce((s, li) => s + (Number(li.qty) || 0) * (Number(li.rate) || 0), 0)
  const subtotal = laborTotal + partsTotal
  const tax = subtotal * TAX_RATE
  const total = subtotal + tax
  return { laborTotal, partsTotal, subtotal, tax, total }
}

async function nextWoNumber() {
  const { data } = await supabase.from('work_orders').select('wo_number')
  let max = 1000
  for (const w of data ?? []) {
    const m = /^WO-(\d+)$/.exec(w.wo_number || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `WO-${max + 1}`
}

async function nextInvoiceNumber() {
  const { data } = await supabase.from('invoices').select('invoice_number')
  let max = 5000
  for (const inv of data ?? []) {
    const m = /^INV-(\d+)$/.exec(inv.invoice_number || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `INV-${max + 1}`
}

async function logHistory(workOrderId, action, detail, performedBy) {
  await supabase.from('audit_log').insert({
    entity_type: 'work_order',
    entity_id: workOrderId,
    action,
    detail,
    performed_by: performedBy || null,
  })
}

// Bumping a vehicle's odometer from a work-order reading never moves it
// backwards — a technician mistyping a lower number shouldn't erase a
// higher reading that's already on file.
async function bumpVehicleOdometer(vehicleId, odometerKm, currentVehicles) {
  if (!vehicleId || odometerKm === '' || odometerKm === null || odometerKm === undefined) return
  const reading = Number(odometerKm)
  if (!Number.isFinite(reading)) return
  const vehicle = currentVehicles.find((v) => v.id === vehicleId)
  if (vehicle && vehicle.mileage_km != null && Number(vehicle.mileage_km) >= reading) return
  await supabase.from('vehicles').update({ mileage_km: reading }).eq('id', vehicleId)
}

export default function WorkOrders() {
  const { user, hasPermission } = useAuth()
  const canDelete = hasPermission('delete_work_orders')
  const navigate = useNavigate()
  const location = useLocation()
  const { id: routeId } = useParams()
  const isNewRoute = location.pathname.endsWith('/new')

  const [filter, setFilter] = useState('all')
  const [rows, setRows] = useState([])
  const [loadingRows, setLoadingRows] = useState(true)
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  const [vehicles, setVehicles] = useState([])
  const [technicians, setTechnicians] = useState([])
  const [parts, setParts] = useState([])

  const [draft, setDraft] = useState(null) // editable copy of the selected work order
  const [original, setOriginal] = useState(null) // snapshot for diffing on save
  const [historyRows, setHistoryRows] = useState([])
  const [invoiceInfo, setInvoiceInfo] = useState(null) // { id, invoice_number, status } for this work order, if any
  const [linkedPOs, setLinkedPOs] = useState([]) // purchase_orders created/reordered because of this work order
  const [reorderingItemId, setReorderingItemId] = useState(null)
  const [detailTab, setDetailTab] = useState('items')
  const [partSearchOpenId, setPartSearchOpenId] = useState(null)
  const [saving, setSaving] = useState(false)

  const [newForm, setNewForm] = useState({ vehicleId: '', service: '', priority: 'medium', eta: '', odometerKm: '' })
  const [creating, setCreating] = useState(false)

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  useEffect(() => {
    loadRows()
  }, [])

  useEffect(() => {
    supabase.from('vehicles').select('id, name, model, mileage_km').order('name').then(({ data }) => setVehicles(data ?? []))
    supabase
      .from('profiles')
      .select('id, name, roles!inner(name)')
      .eq('roles.name', 'Technician')
      .order('name')
      .then(({ data }) => setTechnicians(data ?? []))
    supabase.from('parts').select('id, name, part_number, qty_on_hand, reorder_point, unit_cost').order('name').then(({ data }) => setParts(data ?? []))
  }, [])

  // Route drives which record is open — a real URL for each work order
  // instead of local view state, so back/forward and deep links both work.
  useEffect(() => {
    if (isNewRoute) {
      setNewForm({ vehicleId: vehicles[0]?.id || '', service: '', priority: 'medium', eta: '', odometerKm: '' })
    } else if (routeId) {
      openDetail(routeId)
    } else {
      setDraft(null)
      setOriginal(null)
      setHistoryRows([])
      setInvoiceInfo(null)
      setLinkedPOs([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, isNewRoute])

  async function loadRows() {
    setLoadingRows(true)
    const { data } = await supabase
      .from('work_orders')
      .select('id, wo_number, service, status, priority, eta, started_at, invoice_sent_at, vehicles(name, model), profiles(id, name), work_order_line_items(qty, rate)')
      .order('created_at', { ascending: false })
    setRows(data ?? [])
    setLoadingRows(false)
  }

  // ---- list filtering + sorting ----
  const counts = useMemo(() => {
    const c = { all: rows.length, open: 0, inprogress: 0, onhold: 0, completed: 0 }
    for (const w of rows) if (c[w.status] !== undefined) c[w.status]++
    return c
  }, [rows])

  const filtered = useMemo(() => (filter === 'all' ? rows : rows.filter((w) => w.status === filter)), [rows, filter])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const statusRank = { open: 0, inprogress: 1, onhold: 2, completed: 3 }
    const priorityRank = { urgent: 0, high: 1, medium: 2, low: 3 }
    const valueFor = (w) => {
      switch (sortKey) {
        case 'vehicle': return (w.vehicles?.name || '').toLowerCase()
        case 'service': return (w.service || '').toLowerCase()
        case 'status': return statusRank[w.status] ?? 9
        case 'priority': return priorityRank[w.priority] ?? 9
        case 'tech': return (w.profiles?.name || '').toLowerCase()
        case 'eta': return w.eta ? new Date(w.eta).getTime() : 0
        case 'cost': return lineItemTotal(w.work_order_line_items)
        default: return ''
      }
    }
    const factor = sortDir === 'desc' ? -1 : 1
    return [...filtered].sort((a, b) => {
      const av = valueFor(a), bv = valueFor(b)
      if (av < bv) return -1 * factor
      if (av > bv) return 1 * factor
      return 0
    })
  }, [filtered, sortKey, sortDir])

  function sortClick(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }
  function sortArrow(key) {
    if (sortKey !== key) return ''
    return sortDir === 'desc' ? '↓' : '↑'
  }

  // ---- detail view ----
  async function openDetail(id) {
    setDetailTab('items')
    setPartSearchOpenId(null)
    const { data: wo } = await supabase
      .from('work_orders')
      .select('*, vehicles(id, name, model, owner_id, owners(id, name, email, billing_address)), profiles(id, name), work_order_line_items(*)')
      .eq('id', id)
      .single()
    if (!wo) return
    const lineItems = (wo.work_order_line_items || []).map((li) => ({ ...li }))
    const d = { ...wo, lineItems }
    setDraft(d)
    setOriginal({
      service: wo.service, status: wo.status, priority: wo.priority,
      technician_id: wo.technician_id, eta: wo.eta, odometer_km: wo.odometer_km,
      lineItems: lineItems.map((li) => ({ ...li })),
    })
    const { data: hist } = await supabase
      .from('audit_log')
      .select('id, action, detail, created_at, profiles(name)')
      .eq('entity_type', 'work_order')
      .eq('entity_id', id)
      .order('created_at', { ascending: false })
    setHistoryRows(hist ?? [])
    const { data: inv } = await supabase
      .from('invoices')
      .select('id, invoice_number, status')
      .eq('work_order_id', id)
      .maybeSingle()
    setInvoiceInfo(inv ?? null)
    const { data: linkedPOs } = await supabase
      .from('purchase_orders')
      .select('id, po_number, status, supplier, ordered_date, purchase_order_items(qty_ordered, qty_received, parts(name, part_number))')
      .eq('work_order_id', id)
      .order('created_at', { ascending: false })
    setLinkedPOs(linkedPOs ?? [])
  }

  function closeDetail() {
    navigate('/work-orders')
  }

  function updateDraft(field, value) {
    setDraft((d) => ({ ...d, [field]: value }))
  }

  function addLineItem(type) {
    const newItem = {
      id: 'new-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      _isNew: true,
      type,
      description: type === 'labor' ? '' : '',
      qty: 1,
      unit: type === 'labor' ? 'hr' : 'unit',
      rate: 0,
      part_id: null,
    }
    setDraft((d) => ({ ...d, lineItems: [...(d.lineItems || []), newItem] }))
    if (type === 'part') setPartSearchOpenId(newItem.id)
  }
  function updateLineItem(id, field, value) {
    setDraft((d) => ({ ...d, lineItems: d.lineItems.map((li) => (li.id === id ? { ...li, [field]: value } : li)) }))
  }
  function removeLineItem(id) {
    setDraft((d) => ({ ...d, lineItems: d.lineItems.filter((li) => li.id !== id) }))
  }
  function pickPartForLineItem(itemId, part) {
    setDraft((d) => ({
      ...d,
      lineItems: d.lineItems.map((li) => (li.id === itemId ? { ...li, description: part.name, rate: part.unit_cost, unit: 'unit', part_id: part.id } : li)),
    }))
    setPartSearchOpenId(null)
  }

  // Reordering a part from inside a work order links the new purchase
  // order back to this work order (purchase_orders.work_order_id), so it
  // shows up in the "Parts Ordered" section below instead of only in the
  // general Parts page.
  async function reorderLineItemPart(lineItem) {
    const part = parts.find((p) => p.id === lineItem.part_id)
    if (!part) {
      alert('This line item isn\'t linked to a part in inventory, so it can\'t be reordered automatically. Reorder it from the Parts page instead.')
      return
    }
    setReorderingItemId(lineItem.id)
    try {
      const { po, qty } = await createReorderPO(part, { workOrderId: draft.id })
      await logHistory(draft.id, 'Part reordered', `${po.po_number} — ${qty} × ${part.name}`, user?.id)
      openDetail(draft.id)
    } catch (e) {
      alert('Could not create purchase order: ' + (e.message || e))
    } finally {
      setReorderingItemId(null)
    }
  }

  const totals = useMemo(() => computeTotals(draft?.lineItems), [draft?.lineItems])
  const hasLineItems = (draft?.lineItems || []).length > 0
  const isCheckedOut = !!draft?.checked_out
  const isInvoiced = !!draft?.invoice_sent_at

  async function saveChanges() {
    if (!draft || isCheckedOut) return
    setSaving(true)
    try {
      const fieldChanges = []
      const labelFor = { service: 'Description', status: 'Status', priority: 'Priority', technician_id: 'Technician', eta: 'ETA', odometer_km: 'Odometer' }
      const displayFor = (field, val) => {
        if (field === 'status') return STATUS_META[val]?.label || val || '—'
        if (field === 'priority') return PRIORITY_META[val]?.label || val || '—'
        if (field === 'technician_id') return technicians.find((t) => t.id === val)?.name || 'Unassigned'
        if (field === 'eta') return val ? formatDate(val) : '—'
        if (field === 'odometer_km') return val != null && val !== '' ? `${Number(val).toLocaleString('id-ID')} km` : '—'
        return val || '—'
      }
      Object.keys(labelFor).forEach((field) => {
        if ((original?.[field] ?? null) !== (draft[field] ?? null)) {
          fieldChanges.push(`${labelFor[field]} changed: ${displayFor(field, original?.[field])} → ${displayFor(field, draft[field])}`)
        }
      })

      // Auto-stamp started_at the first time a WO moves into progress.
      const patch = {
        service: draft.service,
        status: draft.status,
        priority: draft.priority,
        technician_id: draft.technician_id || null,
        eta: draft.eta || null,
        odometer_km: draft.odometer_km === '' || draft.odometer_km == null ? null : Number(draft.odometer_km),
      }
      if (draft.status === 'inprogress' && !draft.started_at) {
        patch.started_at = new Date().toISOString()
      }
      const { error: woErr } = await supabase.from('work_orders').update(patch).eq('id', draft.id)
      if (woErr) throw woErr

      // An odometer reading logged on the work order is the source of truth
      // for the vehicle's current mileage — keep it in sync automatically.
      if (patch.odometer_km !== (original?.odometer_km ?? null)) {
        await bumpVehicleOdometer(draft.vehicle_id, patch.odometer_km, vehicles)
      }

      // Diff line items: insert new, update changed, delete removed.
      const origById = {}
      for (const li of original?.lineItems || []) origById[li.id] = li
      const currentIds = new Set()
      for (const li of draft.lineItems || []) {
        if (!li._isNew) currentIds.add(li.id)
        const payload = { work_order_id: draft.id, type: li.type, description: li.description, qty: Number(li.qty) || 0, unit: li.unit || null, rate: Number(li.rate) || 0, part_id: li.part_id || null }
        if (li._isNew) {
          const { error } = await supabase.from('work_order_line_items').insert(payload)
          if (error) throw error
          fieldChanges.push(`Line item added: ${li.description || 'Untitled'}`)
        } else {
          const o = origById[li.id]
          if (o && (o.description !== li.description || Number(o.qty) !== Number(li.qty) || Number(o.rate) !== Number(li.rate))) {
            const { error } = await supabase.from('work_order_line_items').update(payload).eq('id', li.id)
            if (error) throw error
            fieldChanges.push(`Line item updated: ${li.description || 'Untitled'} — qty ${li.qty}, rate ${formatRupiah(li.rate)}`)
          }
        }
      }
      for (const li of original?.lineItems || []) {
        if (!currentIds.has(li.id)) {
          const { error } = await supabase.from('work_order_line_items').delete().eq('id', li.id)
          if (error) throw error
          fieldChanges.push(`Line item removed: ${li.description || 'Untitled'}`)
        }
      }

      for (const detail of fieldChanges) await logHistory(draft.id, 'Work order updated', detail, user?.id)

      await loadRows()
      closeDetail()
    } catch (e) {
      alert('Could not save changes: ' + (e.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function handleCheckout() {
    if (!draft || isCheckedOut || !hasLineItems) return
    const { error } = await supabase.from('work_orders').update({ checked_out: true }).eq('id', draft.id)
    if (error) { alert(error.message); return }
    await logHistory(draft.id, 'Checked out', 'Marked ready for invoicing — locked from further edits', user?.id)
    setDraft((d) => ({ ...d, checked_out: true }))
    openDetail(draft.id)
  }

  // Sending an invoice writes a real ledger row (invoices table) with a
  // snapshot of the line items and totals, rather than just stamping a
  // timestamp on the work order. Actually emailing it is simulated for now
  // — no message provider is connected yet — but the record this creates
  // (recipient, amounts, status) is exactly what a real send would produce,
  // so wiring up a provider later only means replacing the "simulate"
  // step below with a real API call; nothing about the data model changes.
  async function handleSendInvoice() {
    if (!draft || !isCheckedOut) return
    const now = new Date().toISOString()
    const owner = draft.vehicles?.owners || null
    const recipientEmail = owner?.email || null

    let invoiceRow = null
    if (invoiceInfo?.id) {
      const { data, error } = await supabase
        .from('invoices')
        .update({ sent_at: now, recipient_email: recipientEmail })
        .eq('id', invoiceInfo.id)
        .select('id, invoice_number, status')
        .single()
      if (error) { alert('Could not resend invoice: ' + error.message); return }
      invoiceRow = data
    } else {
      const invoiceNumber = await nextInvoiceNumber()
      const dueDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
      const { data, error } = await supabase
        .from('invoices')
        .insert({
          invoice_number: invoiceNumber,
          work_order_id: draft.id,
          vehicle_id: draft.vehicle_id,
          owner_id: owner?.id || null,
          recipient_email: recipientEmail,
          line_items: draft.lineItems.map((li) => ({ type: li.type, description: li.description, qty: Number(li.qty) || 0, unit: li.unit, rate: Number(li.rate) || 0 })),
          subtotal: totals.subtotal,
          tax: totals.tax,
          total: totals.total,
          status: 'sent',
          sent_at: now,
          due_date: dueDate,
        })
        .select('id, invoice_number, status')
        .single()
      if (error) { alert('Could not create invoice: ' + error.message); return }
      invoiceRow = data
    }

    // SIMULATE: this is the one line that would become a real API call to
    // an email provider (e.g. Resend) once one is connected — see
    // invoiceRow / recipientEmail above for exactly what it would send.
    console.info(`[simulated email] Invoice ${invoiceRow?.invoice_number} would be sent to ${recipientEmail || '(no owner email on file)'}`)

    const { error: woErr } = await supabase.from('work_orders').update({ invoice_sent_at: now }).eq('id', draft.id)
    if (woErr) { alert(woErr.message); return }
    await logHistory(
      draft.id,
      isInvoiced ? 'Invoice resent' : 'Invoice sent',
      `${invoiceRow?.invoice_number || ''} — ${recipientEmail ? `email to ${recipientEmail} simulated (no provider connected yet)` : 'no owner email on file, recorded without sending'} · ${formatDate(now)}`,
      user?.id
    )
    openDetail(draft.id)
  }

  async function handleDelete() {
    if (!draft) return
    const { error } = await supabase.from('work_orders').delete().eq('id', draft.id)
    setConfirmDeleteOpen(false)
    if (error) { alert(error.message); return }
    await loadRows()
    closeDetail()
  }

  // ---- new work order ----
  function openNew() {
    navigate('/work-orders/new')
  }

  async function createWorkOrder() {
    if (!newForm.vehicleId || !newForm.service.trim()) {
      alert('Vehicle and description are required.')
      return
    }
    setCreating(true)
    try {
      const woNumber = await nextWoNumber()
      const odometerKm = newForm.odometerKm === '' ? null : Number(newForm.odometerKm)
      const { data, error } = await supabase
        .from('work_orders')
        .insert({
          wo_number: woNumber,
          vehicle_id: newForm.vehicleId,
          service: newForm.service.trim(),
          priority: newForm.priority,
          status: 'open',
          eta: newForm.eta || null,
          odometer_km: odometerKm,
        })
        .select()
        .single()
      if (error) throw error
      const vehicleName = vehicles.find((v) => v.id === newForm.vehicleId)?.name || ''
      await logHistory(data.id, 'Work order created', `${newForm.service.trim()} for ${vehicleName}`, user?.id)
      await bumpVehicleOdometer(newForm.vehicleId, odometerKm, vehicles)
      await loadRows()
      navigate(`/work-orders/${data.id}`)
    } catch (e) {
      alert('Could not create work order: ' + (e.message || e))
    } finally {
      setCreating(false)
    }
  }

  // ======================================================================
  // RENDER
  // ======================================================================

  if (isNewRoute) {
    return (
      <>
        <PageHeader title="New Work Order">
          <SecondaryButton onClick={() => navigate('/work-orders')}>Cancel</SecondaryButton>
        </PageHeader>
        <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Vehicle">
              <select value={newForm.vehicleId} onChange={(e) => setNewForm((f) => ({ ...f, vehicleId: e.target.value }))} style={selectStyle}>
                <option value="">Select a vehicle…</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}{v.model ? ` — ${v.model}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Description">
              <input type="text" value={newForm.service} onChange={(e) => setNewForm((f) => ({ ...f, service: e.target.value }))} placeholder="e.g. Oil & Filter Change" style={inputStyle} />
            </Field>
            <Field label="Priority">
              <select value={newForm.priority} onChange={(e) => setNewForm((f) => ({ ...f, priority: e.target.value }))} style={selectStyle}>
                {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
              </select>
            </Field>
            <Field label="ETA">
              <input type="datetime-local" value={newForm.eta} onChange={(e) => setNewForm((f) => ({ ...f, eta: e.target.value }))} style={inputStyle} />
            </Field>
            <Field label="Odometer at check-in (km)">
              <input
                type="number"
                value={newForm.odometerKm}
                onChange={(e) => setNewForm((f) => ({ ...f, odometerKm: e.target.value }))}
                placeholder={(() => {
                  const v = vehicles.find((v) => v.id === newForm.vehicleId)
                  return v?.mileage_km != null ? `Current: ${Number(v.mileage_km).toLocaleString('id-ID')} km` : 'Optional'
                })()}
                style={{ ...inputStyle, fontFamily: fontMono }}
              />
              <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: 5 }}>If set, this becomes the vehicle's current odometer.</div>
            </Field>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <PrimaryButton onClick={createWorkOrder} disabled={creating} style={creating ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
                {creating ? 'Creating…' : 'Create Work Order'}
              </PrimaryButton>
              <SecondaryButton onClick={() => navigate('/work-orders')}>Cancel</SecondaryButton>
            </div>
          </div>
        </main>
      </>
    )
  }

  if (routeId && draft) {
    return (
      <>
        <ConfirmModal
          open={confirmDeleteOpen}
          title="Delete work order?"
          body={`This permanently deletes ${draft.wo_number} and all of its line items. This cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={handleDelete}
        />
        <DetailHeader
          backTo="/work-orders"
          backLabel="Work Orders"
          title={draft.vehicles?.name || '—'}
          subtitle={`${draft.wo_number} · ${draft.service}`}
          badge={<Badge bg={STATUS_META[draft.status].bg} color={STATUS_META[draft.status].color}>{STATUS_META[draft.status].label}</Badge>}
        >
          {canDelete && (
            <SecondaryButton onClick={() => setConfirmDeleteOpen(true)} style={{ color: colors.danger, borderColor: 'rgba(192,57,43,0.35)' }}>Delete</SecondaryButton>
          )}
          <SecondaryButton onClick={closeDetail}>{isCheckedOut ? 'Close' : 'Cancel'}</SecondaryButton>
          {!isCheckedOut && (
            <PrimaryButton onClick={saveChanges} disabled={saving} style={saving ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
              {saving ? 'Saving…' : 'Save Changes'}
            </PrimaryButton>
          )}
        </DetailHeader>

        <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 22 }}>

            {isCheckedOut && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.neutralBg, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 16px' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={colors.neutral} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                <div style={{ fontSize: 13, color: colors.text2 }}>This work order is checked out and locked — details and line items can no longer be edited. You can still send or resend the invoice below.</div>
              </div>
            )}

            <fieldset disabled={isCheckedOut} style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Description">
                <input type="text" value={draft.service || ''} onChange={(e) => updateDraft('service', e.target.value)} style={inputStyle} />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Status">
                  <select value={draft.status} onChange={(e) => updateDraft('status', e.target.value)} style={selectStyle}>
                    {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                  </select>
                </Field>
                <Field label="Priority">
                  <select value={draft.priority} onChange={(e) => updateDraft('priority', e.target.value)} style={selectStyle}>
                    {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Technician">
                <select value={draft.technician_id || ''} onChange={(e) => updateDraft('technician_id', e.target.value || null)} style={selectStyle}>
                  <option value="">Unassigned</option>
                  {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="ETA">
                  <input
                    type="datetime-local"
                    value={draft.eta ? draft.eta.slice(0, 16) : ''}
                    onChange={(e) => updateDraft('eta', e.target.value ? new Date(e.target.value).toISOString() : null)}
                    style={inputStyle}
                  />
                </Field>
                <Field label="Odometer (km)">
                  <input
                    type="number"
                    value={draft.odometer_km ?? ''}
                    onChange={(e) => updateDraft('odometer_km', e.target.value)}
                    style={{ ...inputStyle, fontFamily: fontMono }}
                  />
                </Field>
              </div>
            </fieldset>

            <div role="tablist" aria-label="Work order sections" style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${colors.border}` }}>
              <TabButton active={detailTab === 'items'} onClick={() => setDetailTab('items')}>Line Items</TabButton>
              <TabButton active={detailTab === 'parts'} onClick={() => setDetailTab('parts')}>Parts Ordered{linkedPOs.length > 0 ? ` · ${linkedPOs.length}` : ''}</TabButton>
              <TabButton active={detailTab === 'history'} onClick={() => setDetailTab('history')}>History{historyRows.length > 0 ? ` · ${historyRows.length}` : ''}</TabButton>
            </div>

            {detailTab === 'items' && (
              <>
                <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 18 }}>
                  <h3 style={sectionTitleStyle}>Line items</h3>

                  {hasLineItems ? (
                    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, marginBottom: 12 }}>
                      <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                            <th style={liThStyle}>Type</th>
                            <th style={liThStyle}>Description</th>
                            <th style={liThStyle}>Qty</th>
                            <th style={liThStyle}>Unit</th>
                            <th style={liThStyle}>Rate (Rp)</th>
                            <th style={liThStyle}>Amount</th>
                            <th style={liThStyle}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {draft.lineItems.map((item) => {
                            const isPart = item.type === 'part'
                            const showSuggestions = isPart && partSearchOpenId === item.id && !isCheckedOut
                            const q = (item.description || '').trim().toLowerCase()
                            const suggestions = showSuggestions
                              ? parts.filter((p) => q === '' || p.name.toLowerCase().includes(q)).slice(0, 6)
                              : []
                            const linkedPart = isPart && item.part_id ? parts.find((p) => p.id === item.part_id) : null
                            const stock = partStockStatus(linkedPart)
                            return (
                              <tr key={item.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                                <td style={{ padding: '8px 10px' }}>
                                  <Badge bg={TYPE_META[item.type].bg} color={TYPE_META[item.type].color}>{TYPE_META[item.type].label}</Badge>
                                </td>
                                <td style={{ padding: '8px 10px', position: 'relative' }}>
                                  <input
                                    type="text"
                                    autoComplete="off"
                                    disabled={isCheckedOut}
                                    placeholder={isPart ? 'Type to search parts…' : 'Labor description'}
                                    value={item.description || ''}
                                    onChange={(e) => updateLineItem(item.id, 'description', e.target.value)}
                                    onFocus={() => isPart && setPartSearchOpenId(item.id)}
                                    onBlur={() => isPart && setTimeout(() => setPartSearchOpenId(null), 120)}
                                    style={{ ...liInputStyle, minWidth: 150 }}
                                  />
                                  {stock && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
                                      <Badge bg={stock.bg} color={stock.color}>{stock.label}</Badge>
                                      {stock.low && (
                                        <button
                                          type="button"
                                          onClick={() => reorderLineItemPart(item)}
                                          disabled={reorderingItemId === item.id}
                                          style={{ background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, color: colors.accent, cursor: reorderingItemId === item.id ? 'not-allowed' : 'pointer', textDecoration: 'underline' }}
                                        >
                                          {reorderingItemId === item.id ? 'Reordering…' : 'Reorder'}
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {showSuggestions && (
                                    <div style={suggestBoxStyle}>
                                      {suggestions.map((p) => {
                                        const stockLabel = p.qty_on_hand === 0 ? 'Out of stock' : (p.qty_on_hand <= p.reorder_point ? `Low stock · ${p.qty_on_hand} left` : `${p.qty_on_hand} in stock`)
                                        const stockColor = p.qty_on_hand === 0 ? colors.danger : (p.qty_on_hand <= p.reorder_point ? colors.warn : '#227A3E')
                                        return (
                                          <button key={p.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickPartForLineItem(item.id, p)} style={suggestRowStyle}>
                                            <span>
                                              <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ink }}>{p.name}</span>
                                              <span style={{ display: 'block', fontSize: 11, color: colors.mutedLight, fontFamily: fontMono, marginTop: 1 }}>{p.part_number} · <span style={{ color: stockColor }}>{stockLabel}</span></span>
                                            </span>
                                            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: fontMono, color: colors.ink, whiteSpace: 'nowrap' }}>{formatRupiah(p.unit_cost)}</span>
                                          </button>
                                        )
                                      })}
                                      {q !== '' && suggestions.length === 0 && (
                                        <div style={{ padding: 10, fontSize: 12, color: colors.mutedLight }}>No matching parts in inventory — this will be added as a custom item.</div>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td style={{ padding: '8px 8px' }}>
                                  <input type="number" step="0.5" min="0" disabled={isCheckedOut} value={item.qty} onChange={(e) => updateLineItem(item.id, 'qty', parseFloat(e.target.value) || 0)} style={{ ...liInputStyle, width: 64 }} />
                                </td>
                                <td style={{ padding: '8px 8px' }}>
                                  <select disabled={isCheckedOut} value={item.unit || ''} onChange={(e) => updateLineItem(item.id, 'unit', e.target.value)} style={{ ...liInputStyle, width: 74 }}>
                                    {UNIT_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                                  </select>
                                </td>
                                <td style={{ padding: '8px 8px' }}>
                                  <input type="number" step="1000" min="0" disabled={isCheckedOut} value={item.rate} onChange={(e) => updateLineItem(item.id, 'rate', parseFloat(e.target.value) || 0)} style={{ ...liInputStyle, width: 100, fontFamily: fontMono }} />
                                </td>
                                <td style={{ padding: '8px 10px', fontSize: 12, fontWeight: 600, fontFamily: fontMono, whiteSpace: 'nowrap' }}>{formatRupiah((Number(item.qty) || 0) * (Number(item.rate) || 0))}</td>
                                <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                                  {!isCheckedOut && (
                                    <button type="button" onClick={() => removeLineItem(item.id)} aria-label="Remove line item" style={removeBtnStyle}>
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={colors.danger} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: colors.mutedLight, padding: '6px 0 14px 0' }}>No labor or parts added yet.</div>
                  )}

                  {!isCheckedOut && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <DashedButton onClick={() => addLineItem('labor')}>+ Add Labor</DashedButton>
                      <DashedButton onClick={() => addLineItem('part')}>+ Add Part</DashedButton>
                    </div>
                  )}
                </div>

                <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <TotalsRow label="Labor" value={totals.laborTotal} />
                  <TotalsRow label="Parts" value={totals.partsTotal} />
                  <TotalsRow label="Subtotal" value={totals.subtotal} />
                  <TotalsRow label="PPN (11%)" value={totals.tax} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, color: colors.ink, borderTop: `1px solid ${colors.borderStrong}`, paddingTop: 8, marginTop: 2 }}>
                    <span>Total</span><span style={{ fontFamily: fontMono }}>{formatRupiah(totals.total)}</span>
                  </div>
                </div>

                <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16 }}>
                  {isInvoiced ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#E6F5EA', border: '1px solid rgba(34,122,62,0.2)', borderRadius: 10, padding: '12px 14px' }}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#227A3E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" /></svg>
                      <div style={{ fontSize: 13, color: '#1B5E33' }}>
                        Invoice sent · {formatDate(draft.invoice_sent_at)}
                        {invoiceInfo?.id && (
                          <> · <Link to={`/invoices/${invoiceInfo.id}`} style={{ color: '#1B5E33', fontWeight: 700 }}>{invoiceInfo.invoice_number}</Link></>
                        )}
                        <button type="button" onClick={handleSendInvoice} style={linkBtnStyle}>Resend invoice</button>
                        <div style={{ fontSize: 11, color: '#3F7A56', marginTop: 4 }}>Email delivery is simulated for now — no message provider is connected yet.</div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={handleCheckout}
                        disabled={isCheckedOut || !hasLineItems}
                        style={{
                          flex: '1 1 0', borderRadius: 8, padding: 11, fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
                          background: isCheckedOut ? '#E6F5EA' : (hasLineItems ? colors.accent : colors.white),
                          color: isCheckedOut ? '#227A3E' : (hasLineItems ? colors.white : colors.mutedLight),
                          border: `1px solid ${isCheckedOut ? 'rgba(34,122,62,0.3)' : (hasLineItems ? colors.accent : colors.borderStrong)}`,
                          cursor: (isCheckedOut || !hasLineItems) ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isCheckedOut ? 'Checked Out' : 'Check Out'}
                      </button>
                      <button
                        type="button"
                        onClick={handleSendInvoice}
                        disabled={!isCheckedOut}
                        style={{
                          flex: '1 1 0', borderRadius: 8, padding: 11, fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
                          background: isCheckedOut ? colors.accent : colors.white,
                          color: isCheckedOut ? colors.white : colors.mutedLight,
                          border: isCheckedOut ? 'none' : `1px solid ${colors.borderStrong}`,
                          cursor: isCheckedOut ? 'pointer' : 'not-allowed',
                        }}
                      >
                        Send Invoice
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {detailTab === 'parts' && (
              <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 18 }}>
                <h3 style={sectionTitleStyle}>Parts ordered for this work order</h3>
                <div style={{ fontSize: 12.5, color: colors.mutedLight, marginBottom: 14 }}>
                  Purchase orders created by reordering a part directly from the Line Items tab above. Reorder any low or out-of-stock part there to see it show up here.
                </div>
                {linkedPOs.length === 0 ? (
                  <div style={{ fontSize: 13, color: colors.mutedLight, padding: '6px 0 14px 0' }}>No parts have been reordered for this work order yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {linkedPOs.map((po) => {
                      const meta = PO_STATUS_META[po.status] || PO_STATUS_META.notordered
                      const items = po.purchase_order_items ?? []
                      return (
                        <div key={po.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                            <div>
                              <Link to="/parts" style={{ fontSize: 13, fontWeight: 700, color: colors.accent, fontFamily: fontMono }}>{po.po_number}</Link>
                              {po.supplier && <span style={{ fontSize: 12, color: colors.mutedLight, marginLeft: 8 }}>{po.supplier}</span>}
                            </div>
                            <Badge bg={meta.bg} color={meta.color}>{meta.label}</Badge>
                          </div>
                          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {items.map((it, i) => (
                              <div key={i} style={{ fontSize: 12.5, color: colors.text2 }}>
                                {it.parts?.name || 'Unknown part'} — {it.qty_received}/{it.qty_ordered} received
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {detailTab === 'history' && (
              <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 18 }}>
                <h3 style={sectionTitleStyle}>History</h3>
                {historyRows.length === 0 ? (
                  <div style={{ fontSize: 13, color: colors.mutedLight, padding: '6px 0 14px 0' }}>No history yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {historyRows.map((h) => (
                      <div key={h.id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                        <div style={{ width: 8, height: 8, borderRadius: 999, background: colors.accent, marginTop: 6, flexShrink: 0 }} />
                        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{h.action}</div>
                          <div style={{ fontSize: 13, color: colors.text2, marginTop: 2 }}>{h.detail}</div>
                          <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 4 }}>{h.profiles?.name || 'System'} · {formatDate(h.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </main>
      </>
    )
  }

  // ---- list view ----
  const inShopCount = rows.filter((w) => w.status === 'open' || w.status === 'inprogress').length

  return (
    <>
      <PageHeader title="Work Orders">
        <Link to="/calendar" style={{ fontSize: 13, fontWeight: 600, color: colors.accent, whiteSpace: 'nowrap' }}>View Calendar →</Link>
        <PrimaryButton onClick={openNew}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          New Work Order
        </PrimaryButton>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.accentBg, border: '1px solid rgba(20,107,105,0.18)', borderRadius: 10, padding: '12px 16px' }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v4l2.5 2.5" /></svg>
          <div style={{ fontSize: 13, color: '#0F4F4D' }}><strong style={{ fontWeight: 700 }}>{inShopCount} vehicle{inShopCount === 1 ? '' : 's'}</strong> {inShopCount === 1 ? 'is' : 'are'} currently in the shop on active work orders. Click any row to open it, add labor and parts, then check out and send the invoice.</div>
        </div>

        <div role="group" aria-label="Filter work orders by status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => {
            const isOn = filter === f.key
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  borderRadius: 999, border: `1px solid ${isOn ? colors.accent : colors.borderStrong}`,
                  background: isOn ? colors.accent : colors.white, color: isOn ? colors.white : colors.text2,
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
                }}
              >
                {f.label} · {counts[f.key]}
              </button>
            )
          })}
        </div>

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 1180, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <SortableTh label="Vehicle" col="vehicle" sortKey={sortKey} onClick={sortClick} arrow={sortArrow('vehicle')} />
                  <SortableTh label="Description" col="service" sortKey={sortKey} onClick={sortClick} arrow={sortArrow('service')} />
                  <SortableTh label="Status" col="status" sortKey={sortKey} onClick={sortClick} arrow={sortArrow('status')} />
                  <SortableTh label="Priority" col="priority" sortKey={sortKey} onClick={sortClick} arrow={sortArrow('priority')} />
                  <SortableTh label="Technician" col="tech" sortKey={sortKey} onClick={sortClick} arrow={sortArrow('tech')} />
                  <SortableTh label="ETA" col="eta" sortKey={sortKey} onClick={sortClick} arrow={sortArrow('eta')} />
                  <SortableTh label="Cost" col="cost" sortKey={sortKey} onClick={sortClick} arrow={sortArrow('cost')} />
                </tr>
              </thead>
              <tbody>
                {loadingRows && (
                  <tr><td colSpan={7} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Loading…</td></tr>
                )}
                {!loadingRows && sorted.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No work orders match this filter.</td></tr>
                )}
                {!loadingRows && sorted.map((w) => {
                  const cost = lineItemTotal(w.work_order_line_items)
                  const sm = STATUS_META[w.status] || STATUS_META.open
                  const pm = PRIORITY_META[w.priority] || PRIORITY_META.medium
                  return (
                    <tr key={w.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '14px 20px' }}>
                        <button type="button" onClick={() => navigate(`/work-orders/${w.id}`)} aria-label={`Open work order ${w.wo_number}`} style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: colors.accent }}>{w.vehicles?.name || '—'}</span>
                          <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, fontFamily: fontMono, marginTop: 1 }}>{w.wo_number}</span>
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{w.service}</td>
                      <td style={tdStyle}><Badge bg={sm.bg} color={sm.color}>{sm.label}</Badge></td>
                      <td style={tdStyle}><Badge bg={pm.bg} color={pm.color}>{pm.label}</Badge></td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{w.profiles?.name || 'Unassigned'}</td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{w.eta ? formatDate(w.eta) : '—'}</td>
                      <td style={{ padding: '14px 20px', fontSize: 13, color: colors.ink, fontWeight: 600, fontFamily: fontMono, whiteSpace: 'nowrap' }}>
                        {formatRupiah(cost)}
                        {w.invoice_sent_at && <div style={{ fontSize: 11, color: '#227A3E', fontWeight: 700, fontFamily: 'inherit', marginTop: 2 }}>Invoiced</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

      </main>
    </>
  )
}

// ---- small local components / shared styles ----

function Field({ label, children }) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      {children}
    </div>
  )
}

function DashedButton({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px dashed rgba(28,30,34,0.22)', background: '#FBFAF8', color: colors.text3, borderRadius: 8, padding: '8px 12px', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
      {children}
    </button>
  )
}

function TotalsRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: colors.text2 }}>
      <span>{label}</span><span style={{ fontFamily: fontMono }}>{formatRupiah(value)}</span>
    </div>
  )
}

function SortableTh({ label, col, sortKey, onClick, arrow }) {
  return (
    <th scope="col" style={{ padding: '12px 16px' }}>
      <button type="button" onClick={() => onClick(col)} aria-label={`Sort by ${label}`} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: sortKey === col ? colors.accent : colors.mutedLight, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {label} {arrow}
      </button>
    </th>
  )
}

const inputStyle = { width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 11px', fontFamily: 'inherit', fontSize: 13, color: colors.ink }
const selectStyle = { ...inputStyle, background: colors.white }
const fieldLabelStyle = { display: 'block', fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }
const sectionTitleStyle = { margin: '0 0 10px 0', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: colors.text3 }
const liThStyle = { padding: '9px 10px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const liInputStyle = { width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12, color: colors.ink }
const suggestBoxStyle = { position: 'absolute', top: '100%', left: 10, right: 10, marginTop: 4, border: `1px solid ${colors.borderStrong}`, borderRadius: 8, background: colors.white, boxShadow: '0 10px 24px rgba(20,20,20,0.18)', maxHeight: 220, overflowY: 'auto', zIndex: 20 }
const suggestRowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid rgba(28,30,34,0.06)', padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit' }
const removeBtnStyle = { width: 26, height: 26, borderRadius: 6, border: 'none', background: colors.dangerBg, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }
const linkBtnStyle = { display: 'block', marginTop: 2, background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: colors.accent, cursor: 'pointer', textDecoration: 'underline' }
const tdStyle = { padding: '14px 12px', fontSize: 13, whiteSpace: 'nowrap' }
