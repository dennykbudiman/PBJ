import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors } from '../lib/theme'
import { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import ConfirmModal from '../components/ConfirmModal'
import DetailHeader from '../components/DetailHeader'

export default function OwnerDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const canManage = hasPermission('edit_settings')

  const [owner, setOwner] = useState(null)
  const [vehicles, setVehicles] = useState([])
  const [owners, setOwners] = useState([])
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
    const [{ data: o }, { data: allOwners }, { data: v }] = await Promise.all([
      supabase.from('owners').select('*').eq('id', id).single(),
      supabase.from('owners').select('id, name').order('name', { ascending: true }),
      supabase.from('vehicles').select('id, name, vehicle_year, make, model, plate, owner_id').order('name', { ascending: true }),
    ])
    setOwner(o ?? null)
    setOwners(allOwners ?? [])
    setVehicles(v ?? [])
    if (o) {
      setDraft({
        name: o.name || '', contact_name: o.contact_name || '', email: o.email || '',
        phone: o.phone || '', billing_address: o.billing_address || '',
      })
    }
    setLoading(false)
  }

  async function saveDetail() {
    if (!owner || !draft) return
    setSaving(true)
    await supabase
      .from('owners')
      .update({
        name: draft.name.trim(),
        contact_name: draft.contact_name || null,
        email: draft.email || null,
        phone: draft.phone || null,
        billing_address: draft.billing_address || null,
      })
      .eq('id', owner.id)
    setSaving(false)
    load()
  }

  async function deleteOwner() {
    if (!owner) return
    await supabase.from('owners').delete().eq('id', owner.id)
    setShowDeleteConfirm(false)
    navigate('/fleet-groups')
  }

  async function assignVehicle(vehicleId, ownerId) {
    await supabase.from('vehicles').update({ owner_id: ownerId || null }).eq('id', vehicleId)
    load()
  }

  if (loading) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading fleet group…</main>
  }
  if (!owner || !draft) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Fleet group not found.</main>
  }

  const myVehicles = vehicles.filter((v) => v.owner_id === owner.id)
  const unassigned = vehicles.filter((v) => !v.owner_id)

  return (
    <>
      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete fleet group?"
        body={`This removes ${owner.name}. Vehicles assigned to it become unassigned rather than being deleted.`}
        confirmLabel="Delete group"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={deleteOwner}
      />

      <DetailHeader
        backTo="/fleet-groups"
        backLabel="Fleet Groups"
        title={owner.name}
        subtitle={`${myVehicles.length} vehicle${myVehicles.length === 1 ? '' : 's'}`}
      >
        {canManage && (
          <SecondaryButton onClick={() => setShowDeleteConfirm(true)} style={{ color: colors.danger, borderColor: 'rgba(192,57,43,0.35)' }}>Delete</SecondaryButton>
        )}
        {canManage && (
          <PrimaryButton onClick={saveDetail} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</PrimaryButton>
        )}
      </DetailHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 24 }}>

          <fieldset disabled={!canManage} style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="Name">
              <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Contact name">
                <input type="text" value={draft.contact_name} onChange={(e) => setDraft({ ...draft, contact_name: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="Phone">
                <input type="text" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} style={inputStyle} />
              </Field>
            </div>
            <Field label="Email">
              <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Billing address">
              <textarea rows={3} value={draft.billing_address} onChange={(e) => setDraft({ ...draft, billing_address: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </Field>
          </fieldset>
          {!canManage && (
            <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: -14 }}>
              Only Admins and the Owner can edit fleet group details, but any staff member can reassign a vehicle below.
            </div>
          )}

          <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Assigned vehicles</div>
            {myVehicles.length === 0 && (
              <div style={{ fontSize: 13, color: colors.mutedLight }}>No vehicles assigned yet.</div>
            )}
            {myVehicles.map((v) => (
              <VehicleAssignRow key={v.id} vehicle={v} owners={owners} onChange={assignVehicle} />
            ))}

            {unassigned.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginTop: 8 }}>Unassigned vehicles</div>
                {unassigned.map((v) => (
                  <VehicleAssignRow key={v.id} vehicle={v} owners={owners} onChange={assignVehicle} />
                ))}
              </>
            )}
          </div>
        </div>
      </main>
    </>
  )
}

function VehicleAssignRow({ vehicle, owners, onChange }) {
  const navigate = useNavigate()
  const ymm = [vehicle.vehicle_year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '9px 12px' }}>
      <button
        type="button"
        onClick={() => navigate(`/vehicles/${vehicle.id}`)}
        style={{ minWidth: 0, flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: colors.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vehicle.name}</div>
        <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: 1 }}>{ymm}{vehicle.plate ? ` · ${vehicle.plate}` : ''}</div>
      </button>
      <select
        value={vehicle.owner_id || ''}
        onChange={(e) => onChange(vehicle.id, e.target.value)}
        style={{ ...selectStyle, width: 150, flexShrink: 0 }}
      >
        <option value="">Unassigned</option>
        {owners.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </div>
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
const selectStyle = { ...inputStyle, background: colors.white }
