import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import ConfirmModal from '../components/ConfirmModal'

// "Fleet Groups" = who a vehicle belongs to for billing purposes. Grouping
// vehicles under an owner is what lets a work-order invoice be routed to
// the right party (a corporate client, a partner company, a private owner)
// instead of just sitting on the shop's own books.

const EMPTY_FORM = { name: '', contact_name: '', email: '', phone: '', billing_address: '' }

export default function FleetGroups() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('edit_settings')

  const [owners, setOwners] = useState([])
  const [vehicles, setVehicles] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [selectedId, setSelectedId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_FORM)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: o }, { data: v }] = await Promise.all([
      supabase.from('owners').select('*').order('name', { ascending: true }),
      supabase.from('vehicles').select('id, name, vehicle_year, make, model, plate, owner_id').order('name', { ascending: true }),
    ])
    setOwners(o ?? [])
    setVehicles(v ?? [])
    setLoading(false)
  }

  const vehiclesByOwner = useMemo(() => {
    const m = {}
    for (const v of vehicles) {
      const key = v.owner_id || 'unassigned'
      if (!m[key]) m[key] = []
      m[key].push(v)
    }
    return m
  }, [vehicles])

  const unassigned = vehiclesByOwner.unassigned || []

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return owners
    return owners.filter((o) => [o.name, o.contact_name, o.email].some((s) => (s || '').toLowerCase().includes(q)))
  }, [owners, search])

  const selected = owners.find((o) => o.id === selectedId) || null

  function openDetail(o) {
    setSelectedId(o.id)
    setDraft({
      name: o.name || '',
      contact_name: o.contact_name || '',
      email: o.email || '',
      phone: o.phone || '',
      billing_address: o.billing_address || '',
    })
  }

  function closeDetail() {
    setSelectedId(null)
    setDraft(null)
    setShowDeleteConfirm(false)
  }

  async function saveDetail() {
    if (!selected) return
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
      .eq('id', selected.id)
    setSaving(false)
    closeDetail()
    load()
  }

  async function deleteOwner() {
    if (!selected) return
    // Vehicles pointing at this owner fall back to unassigned automatically
    // (owner_id references owners(id) on delete set null).
    await supabase.from('owners').delete().eq('id', selected.id)
    setShowDeleteConfirm(false)
    closeDetail()
    load()
  }

  async function assignVehicle(vehicleId, ownerId) {
    await supabase.from('vehicles').update({ owner_id: ownerId || null }).eq('id', vehicleId)
    load()
  }

  async function addOwner(e) {
    e.preventDefault()
    if (!addForm.name.trim()) return
    setSaving(true)
    await supabase.from('owners').insert({
      name: addForm.name.trim(),
      contact_name: addForm.contact_name || null,
      email: addForm.email || null,
      phone: addForm.phone || null,
      billing_address: addForm.billing_address || null,
    })
    setSaving(false)
    setShowAdd(false)
    setAddForm(EMPTY_FORM)
    load()
  }

  return (
    <>
      <PageHeader title="Fleet Groups">
        <div style={{ flex: '0 1 320px', display: 'flex', alignItems: 'center', gap: 8, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search owners…"
            aria-label="Search fleet owners"
            style={{ border: 'none', background: 'transparent', outline: 'none', font: 'inherit', fontSize: 13, width: '100%', color: colors.ink }}
          />
        </div>
        {canManage && (
          <PrimaryButton onClick={() => setShowAdd(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Add Owner
          </PrimaryButton>
        )}
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, color: colors.mutedLight, maxWidth: 720 }}>
          Group vehicles by who owns them so that work-order invoices can be sent to the right party. Click an owner to edit their details or change which vehicles belong to them.
        </div>

        {unassigned.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.warnBg, border: '1px solid rgba(154,91,16,0.2)', borderRadius: 10, padding: '12px 16px' }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={colors.warn} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M6 8a6 6 0 0 1 12 0c0 4.5 1.5 6 2 6.5H4c.5-.5 2-2 2-6.5z" /><path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
            </svg>
            <div style={{ fontSize: 13, color: '#5C3A0A' }}>
              <strong style={{ fontWeight: 700 }}>{unassigned.length} vehicle{unassigned.length === 1 ? '' : 's'}</strong> {unassigned.length === 1 ? 'has' : 'have'} no owner assigned yet — invoices for {unassigned.length === 1 ? 'it' : 'them'} can't be routed until you assign one below.
            </div>
          </div>
        )}

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Owner</th>
                  <th style={thStyle}>Contact</th>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Vehicles</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={4} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Loading owners…</td></tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No owners match this search.</td></tr>
                )}
                {!loading && visible.map((o) => {
                  const count = (vehiclesByOwner[o.id] || []).length
                  return (
                    <tr key={o.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '16px 20px' }}>
                        <button
                          type="button"
                          onClick={() => openDetail(o)}
                          aria-label={`View details for ${o.name}`}
                          style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
                        >
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: colors.accent }}>{o.name}</span>
                          {o.email && <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, marginTop: 1 }}>{o.email}</span>}
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{o.contact_name || '—'}</td>
                      <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{o.phone || '—'}</td>
                      <td style={tdStyle}><Badge bg={colors.accentBg} color={colors.accent}>{count} vehicle{count === 1 ? '' : 's'}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {!loading && (
          <div style={{ fontSize: 13, color: colors.mutedLight }}>
            Showing {visible.length} of {owners.length} fleet groups
          </div>
        )}
      </main>

      {selected && draft && (
        <>
          <button
            type="button"
            onClick={closeDetail}
            aria-label="Close fleet group details"
            style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,20,0.32)', border: 'none', padding: 0, cursor: 'default' }}
          />
          <aside aria-label="Fleet group details" style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 420, background: colors.white, boxShadow: '-8px 0 24px rgba(20,20,20,0.10)', display: 'flex', flexDirection: 'column', zIndex: 50 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: `1px solid ${colors.border}` }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{selected.name}</h2>
                <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{(vehiclesByOwner[selected.id] || []).length} vehicle{(vehiclesByOwner[selected.id] || []).length === 1 ? '' : 's'}</div>
              </div>
              <button type="button" onClick={closeDetail} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: colors.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4B505A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
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
                <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: -10 }}>
                  Only Admins and the Owner can edit fleet group details, but any staff member can reassign a vehicle below.
                </div>
              )}

              <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Assigned vehicles</div>
                {(vehiclesByOwner[selected.id] || []).length === 0 && (
                  <div style={{ fontSize: 13, color: colors.mutedLight }}>No vehicles assigned yet.</div>
                )}
                {(vehiclesByOwner[selected.id] || []).map((v) => (
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

            <div style={{ padding: '18px 24px', borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  style={{ background: colors.white, color: colors.danger, border: `1px solid #F0C4BC`, borderRadius: 8, padding: '11px 14px', font: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                >
                  Delete
                </button>
              )}
              <div style={{ flex: '1 1 auto' }} />
              <SecondaryButton onClick={closeDetail}>Cancel</SecondaryButton>
              {canManage && (
                <PrimaryButton onClick={saveDetail} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</PrimaryButton>
              )}
            </div>
          </aside>
        </>
      )}

      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete fleet group?"
        body={`This removes ${selected?.name || 'this owner'}. Vehicles assigned to it become unassigned rather than being deleted.`}
        confirmLabel="Delete group"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={deleteOwner}
      />

      {showAdd && (
        <div
          role="presentation"
          onClick={() => setShowAdd(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(28,30,34,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
        >
          <form
            onSubmit={addOwner}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 440, maxHeight: '86vh', overflowY: 'auto', background: colors.white, borderRadius: 12, padding: 24, boxShadow: '0 8px 30px rgba(20,20,20,0.18)', display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Add fleet group</h2>
            <Field label="Name">
              <input required type="text" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Acme Logistics Co." style={inputStyle} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Contact name">
                <input type="text" value={addForm.contact_name} onChange={(e) => setAddForm({ ...addForm, contact_name: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="Phone">
                <input type="text" value={addForm.phone} onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })} style={inputStyle} />
              </Field>
            </div>
            <Field label="Email">
              <input type="email" value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Billing address">
              <textarea rows={3} value={addForm.billing_address} onChange={(e) => setAddForm({ ...addForm, billing_address: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
            </Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <SecondaryButton type="button" onClick={() => setShowAdd(false)}>Cancel</SecondaryButton>
              <PrimaryButton type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add Group'}</PrimaryButton>
            </div>
          </form>
        </div>
      )}
    </>
  )
}

function VehicleAssignRow({ vehicle, owners, onChange }) {
  const ymm = [vehicle.vehicle_year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '9px 12px' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vehicle.name}</div>
        <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: 1 }}>{ymm}{vehicle.plate ? ` · ${vehicle.plate}` : ''}</div>
      </div>
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
const thStyle = { padding: '12px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle = { padding: '16px 12px', fontSize: 13, whiteSpace: 'nowrap' }
