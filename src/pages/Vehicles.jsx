import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { colors, fontMono, formatDate } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'

const STATUS_META = {
  active: { label: 'Active', sev: 'good' },
  shop: { label: 'In Shop', sev: 'warning' },
  idle: { label: 'Idle', sev: 'default' },
}

function statusPalette(statusKey) {
  if (statusKey === 'active') return { bg: colors.accentBg, color: colors.good }
  if (statusKey === 'shop') return { bg: colors.warnBg, color: colors.warn }
  return { bg: colors.neutralBg, color: colors.neutral }
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'shop', label: 'In shop' },
  { key: 'idle', label: 'Idle' },
]

// Standard "Year Make Model" description string, e.g. "2022 Toyota HiAce".
function ymm(v) {
  return [v.vehicle_year, v.make, v.model].filter(Boolean).join(' ') || '—'
}

const EMPTY_FORM = {
  name: '', vehicle_year: '', make: '', model: '', type: '', plate: '', vin: '', status: 'active',
  mileage_km: '', fuel_type: '',
  last_service_date: '', last_service_desc: '', driver_id: '', owner_id: '',
}

export default function Vehicles() {
  const navigate = useNavigate()
  const [vehicles, setVehicles] = useState([])
  const [drivers, setDrivers] = useState([])
  const [owners, setOwners] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: v }, { data: d }, { data: o }] = await Promise.all([
      supabase.from('vehicles').select('*').order('name', { ascending: true }),
      supabase.from('drivers').select('id, name').order('name', { ascending: true }),
      supabase.from('owners').select('id, name').order('name', { ascending: true }),
    ])
    setVehicles(v ?? [])
    setDrivers(d ?? [])
    setOwners(o ?? [])
    setLoading(false)
  }

  const driverName = (id) => drivers.find((d) => d.id === id)?.name || 'Unassigned'
  const ownerName = (id) => owners.find((o) => o.id === id)?.name || 'Unassigned'

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

  async function addVehicle(e) {
    e.preventDefault()
    setSaving(true)
    const { data, error } = await supabase.from('vehicles').insert({
      name: addForm.name,
      vehicle_year: addForm.vehicle_year === '' ? null : Number(addForm.vehicle_year),
      make: addForm.make || null,
      model: addForm.model || null,
      type: addForm.type || null,
      plate: addForm.plate || null,
      vin: addForm.vin || null,
      status: addForm.status,
      mileage_km: addForm.mileage_km === '' ? null : Number(addForm.mileage_km),
      fuel_type: addForm.fuel_type || null,
      last_service_date: addForm.last_service_date || null,
      last_service_desc: addForm.last_service_desc || null,
      driver_id: addForm.driver_id || null,
      owner_id: addForm.owner_id || null,
    }).select().single()
    setSaving(false)
    setShowAdd(false)
    setAddForm(EMPTY_FORM)
    if (!error && data) {
      navigate(`/vehicles/${data.id}`)
    } else {
      load()
    }
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
                  <th style={thStyle}>Owner</th>
                  <th style={thStyle}>Mileage</th>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Last service</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={8} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Loading vehicles…</td></tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No vehicles match this view.</td></tr>
                )}
                {!loading && visible.map((v) => {
                  const meta = STATUS_META[v.status] || { label: v.status }
                  const pal = statusPalette(v.status)
                  return (
                    <tr key={v.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '16px 20px' }}>
                        <button
                          type="button"
                          onClick={() => navigate(`/vehicles/${v.id}`)}
                          aria-label={`View details for ${v.name}`}
                          style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
                        >
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: colors.accent }}>{v.name}</span>
                          <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, marginTop: 1 }}>{ymm(v)}</span>
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{v.type || '—'}</td>
                      <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{v.plate || '—'}</td>
                      <td style={{ padding: '16px 12px' }}><Badge bg={pal.bg} color={pal.color}>{meta.label}</Badge></td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{driverName(v.driver_id)}</td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{ownerName(v.owner_id)}</td>
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

            <Field label="Name">
              <input required type="text" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Van 21" style={inputStyle} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <Field label="Year">
                <input
                  type="number"
                  value={addForm.vehicle_year}
                  onChange={(e) => setAddForm({ ...addForm, vehicle_year: e.target.value })}
                  placeholder="2022"
                  min="1980"
                  max={new Date().getFullYear() + 1}
                  style={inputStyle}
                />
              </Field>
              <Field label="Make">
                <input type="text" value={addForm.make} onChange={(e) => setAddForm({ ...addForm, make: e.target.value })} placeholder="Toyota" style={inputStyle} />
              </Field>
              <Field label="Model">
                <input type="text" value={addForm.model} onChange={(e) => setAddForm({ ...addForm, model: e.target.value })} placeholder="HiAce" style={inputStyle} />
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
            <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: -8 }}>
              The odometer can only be set here — afterwards it updates automatically from work order readings.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Driver">
                <select value={addForm.driver_id} onChange={(e) => setAddForm({ ...addForm, driver_id: e.target.value })} style={selectStyle}>
                  <option value="">Unassigned</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Owner">
                <select value={addForm.owner_id} onChange={(e) => setAddForm({ ...addForm, owner_id: e.target.value })} style={selectStyle}>
                  <option value="">Unassigned</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </Field>
            </div>

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

const inputStyle = { width: '100%', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 11px', font: 'inherit', fontSize: 13, color: colors.ink, boxSizing: 'border-box' }
const selectStyle = { ...inputStyle, background: colors.white }
const thStyle = { padding: '12px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle = { padding: '16px 12px', fontSize: 13, whiteSpace: 'nowrap' }
