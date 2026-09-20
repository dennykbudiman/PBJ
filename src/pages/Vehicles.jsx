import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, formatDate, severityPalette } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import ConfirmModal from '../components/ConfirmModal'

const STATUS_META = {
  active: { label: 'Active', sev: 'good' },
  shop: { label: 'In Shop', sev: 'warning' },
  idle: { label: 'Idle', sev: 'default' },
}

// severityPalette doesn't have a "good"/success case (it maps everything
// unmatched to neutral), so give "active" its own green pill like the
// prototype did, and route the rest through the shared palette helper.
function statusPalette(statusKey) {
  if (statusKey === 'active') return { bg: colors.accentBg, color: colors.good }
  if (statusKey === 'shop') return severityPalette('warning')
  return severityPalette('default')
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'shop', label: 'In shop' },
  { key: 'idle', label: 'Idle' },
]

const EMPTY_FORM = {
  name: '', model: '', type: '', plate: '', vin: '', status: 'active',
  mileage_km: '', fuel_type: '', location: '', purchase_date: '',
  last_service_date: '', last_service_desc: '', driver_id: '',
}

export default function Vehicles() {
  const { hasPermission } = useAuth()
  const [vehicles, setVehicles] = useState([])
  const [drivers, setDrivers] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_FORM)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: v }, { data: d }] = await Promise.all([
      supabase.from('vehicles').select('*').order('name', { ascending: true }),
      supabase.from('drivers').select('id, name').order('name', { ascending: true }),
    ])
    setVehicles(v ?? [])
    setDrivers(d ?? [])
    setLoading(false)
  }

  const driverName = (id) => drivers.find((d) => d.id === id)?.name || 'Unassigned'

  const counts = useMemo(
    () => ({
      all: vehicles.length,
      active: vehicles.filter((v) => v.status === 'active').length,
      shop: vehicles.filter((v) => v.status === 'shop').length,
      idle: vehicles.filter((v) => v.status === 'idle').length,
    }),
    [vehicles]
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return vehicles
      .filter((v) => filter === 'all' || v.status === filter)
      .filter((v) => {
        if (!q) return true
        return [v.name, v.plate, v.vin].some((s) => (s || '').toLowerCase().includes(q))
      })
  }, [vehicles, filter, search])

  const selected = vehicles.find((v) => v.id === selectedId) || null

  function openDetail(v) {
    setSelectedId(v.id)
    setDraft({
      status: v.status,
      driver_id: v.driver_id || '',
      mileage_km: v.mileage_km ?? '',
      location: v.location || '',
      last_service_date: v.last_service_date || '',
      last_service_desc: v.last_service_desc || '',
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
      .from('vehicles')
      .update({
        status: draft.status,
        driver_id: draft.driver_id || null,
        mileage_km: draft.mileage_km === '' ? null : Number(draft.mileage_km),
        location: draft.location || null,
        last_service_date: draft.last_service_date || null,
        last_service_desc: draft.last_service_desc || null,
      })
      .eq('id', selected.id)
    setSaving(false)
    closeDetail()
    load()
  }

  async function deleteVehicle() {
    if (!selected) return
    await supabase.from('vehicles').delete().eq('id', selected.id)
    setShowDeleteConfirm(false)
    closeDetail()
    load()
  }

  async function addVehicle(e) {
    e.preventDefault()
    setSaving(true)
    await supabase.from('vehicles').insert({
      name: addForm.name,
      model: addForm.model || null,
      type: addForm.type || null,
      plate: addForm.plate || null,
      vin: addForm.vin || null,
      status: addForm.status,
      mileage_km: addForm.mileage_km === '' ? null : Number(addForm.mileage_km),
      fuel_type: addForm.fuel_type || null,
      location: addForm.location || null,
      purchase_date: addForm.purchase_date || null,
      last_service_date: addForm.last_service_date || null,
      last_service_desc: addForm.last_service_desc || null,
      driver_id: addForm.driver_id || null,
    })
    setSaving(false)
    setShowAdd(false)
    setAddForm(EMPTY_FORM)
    load()
  }

  return (
    <>
      <PageHeader title="Vehicles">
        <div style={{ flex: '0 1 360px', display: 'flex', alignItems: 'center', gap: 8, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by vehicle, plate, VIN…"
            aria-label="Search vehicles"
            style={{ border: 'none', background: 'transparent', outline: 'none', font: 'inherit', fontSize: 13, width: '100%', color: colors.ink }}
          />
        </div>
        <PrimaryButton onClick={() => setShowAdd(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          Add Vehicle
        </PrimaryButton>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div role="group" aria-label="Filter vehicles by status" style={{ display: 'flex', gap: 8 }}>
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
                  fontSize: 13, fontWeight: 600, padding: '7px 14px', cursor: 'pointer',
                }}
              >
                {f.label} · {counts[f.key]}
              </button>
            )
          })}
        </div>

        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 980, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Vehicle</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Plate</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Driver</th>
                  <th style={thStyle}>Mileage</th>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Last service</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={7} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Loading vehicles…</td></tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No vehicles match this view.</td></tr>
                )}
                {!loading && visible.map((v) => {
                  const meta = STATUS_META[v.status] || { label: v.status }
                  const pal = statusPalette(v.status)
                  return (
                    <tr key={v.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '16px 20px' }}>
                        <button
                          type="button"
                          onClick={() => openDetail(v)}
                          aria-label={`View details for ${v.name}`}
                          style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
                        >
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: colors.accent }}>{v.name}</span>
                          <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, marginTop: 1 }}>{v.model}</span>
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{v.type || '—'}</td>
                      <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{v.plate || '—'}</td>
                      <td style={{ padding: '16px 12px' }}><Badge bg={pal.bg} color={pal.color}>{meta.label}</Badge></td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{driverName(v.driver_id)}</td>
                      <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{v.mileage_km != null ? `${Number(v.mileage_km).toLocaleString('id-ID')} km` : '—'}</td>
                      <td style={{ padding: '16px 20px', fontSize: 13, color: colors.text2 }}>
                        {v.last_service_desc || '—'}
                        <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{formatDate(v.last_service_date)}</div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {!loading && (
          <div style={{ fontSize: 13, color: colors.mutedLight }}>
            Showing {visible.length} of {vehicles.length} vehicles
          </div>
        )}
      </main>

      {selected && draft && (
        <>
          <button
            type="button"
            onClick={closeDetail}
            aria-label="Close vehicle details"
            style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,20,0.32)', border: 'none', padding: 0, cursor: 'default' }}
          />
          <aside aria-label="Vehicle details" style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 400, background: colors.white, boxShadow: '-8px 0 24px rgba(20,20,20,0.10)', display: 'flex', flexDirection: 'column', zIndex: 50 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: `1px solid ${colors.border}` }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{selected.name}</h2>
              <button type="button" onClick={closeDetail} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: colors.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4B505A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ height: 140, borderRadius: 10, background: colors.neutralBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 16V7a1 1 0 0 1 1-1h9v10" /><path d="M13 10h4.5l3.5 3.5V16h-2" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" />
                </svg>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Status">
                  <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} style={selectStyle}>
                    <option value="active">Active</option>
                    <option value="shop">In Shop</option>
                    <option value="idle">Idle</option>
                  </select>
                </Field>
                <Field label="Driver">
                  <select value={draft.driver_id} onChange={(e) => setDraft({ ...draft, driver_id: e.target.value })} style={selectStyle}>
                    <option value="">Unassigned</option>
                    {drivers.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Odometer (km)">
                  <input
                    type="number"
                    value={draft.mileage_km}
                    onChange={(e) => setDraft({ ...draft, mileage_km: e.target.value })}
                    style={inputStyle}
                  />
                </Field>
                <Field label="Location">
                  <input
                    type="text"
                    value={draft.location}
                    onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                    style={inputStyle}
                  />
                </Field>
              </div>

              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 12px' }}>
                <DL label="Model" value={selected.model} />
                <DL label="Plate" value={selected.plate} mono />
                <DL label="VIN" value={selected.vin} mono />
                <DL label="Type" value={selected.type} />
                <DL label="Fuel" value={selected.fuel_type} />
                <DL label="Purchased" value={formatDate(selected.purchase_date)} />
              </dl>

              <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Last service</div>
                <Field label="Description">
                  <input
                    type="text"
                    value={draft.last_service_desc}
                    onChange={(e) => setDraft({ ...draft, last_service_desc: e.target.value })}
                    style={inputStyle}
                  />
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    value={draft.last_service_date}
                    onChange={(e) => setDraft({ ...draft, last_service_date: e.target.value })}
                    style={inputStyle}
                  />
                </Field>
              </div>
            </div>

            <div style={{ padding: '18px 24px', borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
              {hasPermission('delete_vehicles') && (
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
              <PrimaryButton onClick={saveDetail} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</PrimaryButton>
            </div>
          </aside>
        </>
      )}

      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete vehicle?"
        body={`This will permanently remove ${selected?.name || 'this vehicle'} from the fleet. This can't be undone.`}
        confirmLabel="Delete vehicle"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={deleteVehicle}
      />

      {showAdd && (
        <div
          role="presentation"
          onClick={() => setShowAdd(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(28,30,34,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
        >
          <form
            onSubmit={addVehicle}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 460, maxHeight: '86vh', overflowY: 'auto', background: colors.white, borderRadius: 12, padding: 24, boxShadow: '0 8px 30px rgba(20,20,20,0.18)', display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Add vehicle</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Name">
                <input required type="text" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Van 21" style={inputStyle} />
              </Field>
              <Field label="Model">
                <input type="text" value={addForm.model} onChange={(e) => setAddForm({ ...addForm, model: e.target.value })} placeholder="Toyota HiAce" style={inputStyle} />
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Type">
                <input type="text" value={addForm.type} onChange={(e) => setAddForm({ ...addForm, type: e.target.value })} placeholder="Cargo Van" style={inputStyle} />
              </Field>
              <Field label="Status">
                <select value={addForm.status} onChange={(e) => setAddForm({ ...addForm, status: e.target.value })} style={selectStyle}>
                  <option value="active">Active</option>
                  <option value="shop">In Shop</option>
                  <option value="idle">Idle</option>
                </select>
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Plate">
                <input type="text" value={addForm.plate} onChange={(e) => setAddForm({ ...addForm, plate: e.target.value })} placeholder="B 1234 XYZ" style={inputStyle} />
              </Field>
              <Field label="VIN">
                <input type="text" value={addForm.vin} onChange={(e) => setAddForm({ ...addForm, vin: e.target.value })} style={inputStyle} />
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Odometer (km)">
                <input type="number" value={addForm.mileage_km} onChange={(e) => setAddForm({ ...addForm, mileage_km: e.target.value })} style={inputStyle} />
              </Field>
              <Field label="Fuel type">
                <input type="text" value={addForm.fuel_type} onChange={(e) => setAddForm({ ...addForm, fuel_type: e.target.value })} placeholder="Gasoline" style={inputStyle} />
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Location">
                <input type="text" value={addForm.location} onChange={(e) => setAddForm({ ...addForm, location: e.target.value })} placeholder="Lot A" style={inputStyle} />
              </Field>
              <Field label="Purchase date">
                <input type="date" value={addForm.purchase_date} onChange={(e) => setAddForm({ ...addForm, purchase_date: e.target.value })} style={inputStyle} />
              </Field>
            </div>
            <Field label="Driver">
              <select value={addForm.driver_id} onChange={(e) => setAddForm({ ...addForm, driver_id: e.target.value })} style={selectStyle}>
                <option value="">Unassigned</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </Field>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <SecondaryButton type="button" onClick={() => setShowAdd(false)}>Cancel</SecondaryButton>
              <PrimaryButton type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add Vehicle'}</PrimaryButton>
            </div>
          </form>
        </div>
      )}
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

function DL({ label, value, mono }) {
  return (
    <div>
      <dt style={{ fontSize: 11, color: colors.mutedLight, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</dt>
      <dd style={{ margin: '2px 0 0 0', fontSize: 13, fontWeight: 600, fontFamily: mono ? fontMono : 'inherit' }}>{value || '—'}</dd>
    </div>
  )
}

const inputStyle = { width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 11px', font: 'inherit', fontSize: 13, color: colors.ink, boxSizing: 'border-box' }
const selectStyle = { ...inputStyle, background: colors.white }
const thStyle = { padding: '12px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle = { padding: '16px 12px', fontSize: 13, whiteSpace: 'nowrap' }
