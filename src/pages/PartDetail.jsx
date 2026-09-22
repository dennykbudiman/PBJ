import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, severityPalette } from '../lib/theme'
import { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import ConfirmModal from '../components/ConfirmModal'
import DetailHeader from '../components/DetailHeader'

const PART_STATUS_LABEL = { in: 'In Stock', low: 'Low Stock', out: 'Out of Stock' }

export default function PartDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const canDelete = hasPermission('delete_parts')

  const [part, setPart] = useState(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('parts_with_status').select('*').eq('id', id).single()
    setPart(data ?? null)
    if (data) {
      setDraft({
        name: data.name, part_number: data.part_number || '', category: data.category || '',
        qty_on_hand: data.qty_on_hand, reorder_point: data.reorder_point, unit_cost: data.unit_cost,
        supplier: data.supplier || '', bin_location: data.bin_location || '',
      })
    }
    setLoading(false)
  }

  function updateDraft(field, isNumber) {
    return (e) => {
      const raw = e.target.value
      setDraft((d) => ({ ...d, [field]: isNumber ? Number(raw) || 0 : raw }))
    }
  }

  async function savePart() {
    if (!part || !draft) return
    setSaving(true)
    await supabase.from('parts').update({
      name: draft.name, part_number: draft.part_number || null, category: draft.category || null,
      qty_on_hand: draft.qty_on_hand, reorder_point: draft.reorder_point, unit_cost: draft.unit_cost,
      supplier: draft.supplier || null, bin_location: draft.bin_location || null,
    }).eq('id', part.id)
    setSaving(false)
    load()
  }

  async function deletePart() {
    if (!part) return
    const { error } = await supabase.from('parts').delete().eq('id', part.id)
    setShowDeleteConfirm(false)
    if (error) { alert(error.message); return }
    navigate('/parts')
  }

  if (loading) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading part…</main>
  }
  if (!part || !draft) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Part not found.</main>
  }

  const pal = severityPalette(part.stock_status === 'out' ? 'out' : part.stock_status === 'low' ? 'low' : 'default')

  return (
    <>
      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete this part?"
        body={`"${part.name}" will be removed from the catalog. This can't be undone, and it will fail if the part is referenced by an existing purchase order.`}
        confirmLabel="Delete"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={deletePart}
      />

      <DetailHeader
        backTo="/parts"
        backLabel="Parts Stocking"
        title={part.name}
        subtitle={part.part_number || '—'}
        badge={<Badge bg={pal.bg} color={pal.color}>{PART_STATUS_LABEL[part.stock_status]}</Badge>}
      >
        {canDelete && (
          <SecondaryButton onClick={() => setShowDeleteConfirm(true)} style={{ color: colors.danger, borderColor: 'rgba(192,57,43,0.35)' }}>Delete</SecondaryButton>
        )}
        <PrimaryButton onClick={savePart} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</PrimaryButton>
      </DetailHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Part name"><input type="text" value={draft.name} onChange={updateDraft('name')} style={inputStyle} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Part number"><input type="text" value={draft.part_number} onChange={updateDraft('part_number')} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
            <Field label="Category"><input type="text" value={draft.category} onChange={updateDraft('category')} style={inputStyle} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="On hand"><input type="number" min="0" step="1" value={draft.qty_on_hand} onChange={updateDraft('qty_on_hand', true)} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
            <Field label="Reorder point"><input type="number" min="0" step="1" value={draft.reorder_point} onChange={updateDraft('reorder_point', true)} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
          </div>
          <Field label="Unit cost (Rp)"><input type="number" min="0" step="1000" value={draft.unit_cost} onChange={updateDraft('unit_cost', true)} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
          <Field label="Supplier"><input type="text" value={draft.supplier} onChange={updateDraft('supplier')} style={inputStyle} /></Field>
          <Field label="Bin location"><input type="text" value={draft.bin_location} onChange={updateDraft('bin_location')} style={{ ...inputStyle, fontFamily: fontMono }} /></Field>
        </div>
      </main>
    </>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  )
}

const inputStyle = { width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 11px', font: 'inherit', fontSize: 13, color: colors.ink, boxSizing: 'border-box' }
