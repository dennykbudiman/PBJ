import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, LICENSE_CLASSES, severityPalette } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import ConfirmModal from '../components/ConfirmModal'

const STATUS_META = {
  active: { label: 'Active', bg: colors.accentBg, color: colors.good },
  leave: { label: 'On Leave', ...severityPalette('warning') },
  inactive: { label: 'Inactive', ...severityPalette('default') },
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'leave', label: 'On leave' },
  { key: 'inactive', label: 'Inactive' },
]

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function initialsOf(name) {
  return (name || '')
    .split(' ')
    .filter(Boolean)
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// License-expiry status label/color, based on whole months until the
// license_expiry date (Indonesian SIM licenses run 5 years).
function expiryMeta(dateStr) {
  if (!dateStr) return { label: 'Not on file', color: colors.mutedLight }
  const exp = new Date(dateStr + 'T00:00:00')
  if (isNaN(exp)) return { label: 'Not on file', color: colors.mutedLight }
  const now = new Date()
  const diffMonths = (exp.getFullYear() - now.getFullYear()) * 12 + (exp.getMonth() - now.getMonth())
  if (exp < now) return { label: 'Expired', color: colors.danger }
  if (diffMonths <= 1) return { label: 'Expires next month', color: colors.danger }
  if (diffMonths <= 3) return { label: `Expires in ${diffMonths} months`, color: colors.warn }
  return { label: `Exp. ${MONTH_NAMES[exp.getMonth()]} ${exp.getFullYear()}`, color: colors.mutedLight }
}

const EMPTY_FORM = {
  name: '', license_class: 'SIM A Umum', license_number: '', license_expiry: '', phone: '',
  hired_date: '', status: 'active', vehicleId: '',
}

export default function Drivers() {
  const { hasPermission } = useAuth()
  const [drivers, setDrivers] = useState([])
  const [vehicles, setVehicles] = useState([])
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
    const [{ data: d }, { data: v }] = await Promise.all([
      supabase.from('drivers').select('*').order('name', { ascending: true }),
      supabase.from('vehicles').select('id, name, driver_id').order('name', { ascending: true }),
    ])
    setDrivers(d ?? [])
    setVehicles(v ?? [])
    setLoading(false)
  }

  const vehicleForDriver = (driverId) => vehicles.find((v) => v.driver_id === driverId) || null

  const counts = useMemo(
    () => ({
      all: drivers.length,
      active: drivers.filter((d) => d.status === 'active').length,
      leave: drivers.filter((d) => d.status === 'leave').length,
      inactive: drivers.filter((d) => d.status === 'inactive').length,
    }),
    [drivers]
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return drivers
      .filter((d) => filter === 'all' || d.status === filter)
      .filter((d) => {
        if (!q) return true
        return [d.name, d.phone].some((s) => (s || '').toLowerCase().includes(q))
      })
  }, [drivers, filter, search])

  const selected = drivers.find((d) => d.id === selectedId) || null

  function openDetail(d) {
    const currentVehicle = vehicleForDriver(d.id)
    setSelectedId(d.id)
    setDraft({
      status: d.status,
      license_class: d.license_class || 'SIM A Umum',
      license_number: d.license_number || '',
      license_expiry: d.license_expiry || '',
      phone: d.phone || '',
      vehicleId: currentVehicle?.id || '',
      originalVehicleId: currentVehicle?.id || '',
    })
  }

  function closeDetail() {
    setSelectedId(null)
    setDraft(null)
    setShowDeleteConfirm(false)
  }

  // The expiry select pair is derived from license_expiry (a real date),
  // always normalized to the 1st of the chosen month.
  const draftExpParsed = draft?.license_expiry ? new Date(draft.license_expiry + 'T00:00:00') : null
  const now = new Date()
  const draftExpMonth = draftExpParsed ? MONTH_NAMES[draftExpParsed.getMonth()] : MONTH_NAMES[now.getMonth()]
  const draftExpYear = draftExpParsed ? String(draftExpParsed.getFullYear()) : String(now.getFullYear())
  const YEAR_OPTIONS = useMemo(() => {
    const y = new Date().getFullYear()
    return Array.from({ length: 6 }, (_, i) => String(y + i))
  }, [])

  function setExpiryMonth(monthName) {
    const mi = MONTH_NAMES.indexOf(monthName)
    setDraft({ ...draft, license_expiry: `${draftExpYear}-${String(mi + 1).padStart(2, '0')}-01` })
  }
  function setExpiryYear(year) {
    const mi = MONTH_NAMES.indexOf(draftExpMonth)
    setDraft({ ...draft, license_expiry: `${year}-${String(mi + 1).padStart(2, '0')}-01` })
  }

  async function saveDetail() {
    if (!selected) return
    setSaving(true)
    await supabase
      .from('drivers')
      .update({
        status: draft.status,
        license_class: draft.license_class,
        license_number: draft.license_number || null,
        license_expiry: draft.license_expiry || null,
        phone: draft.phone || null,
      })
      .eq('id', selected.id)

    // driver_id lives on vehicles, not drivers — move the assignment there.
    if (draft.vehicleId !== draft.originalVehicleId) {
      if (draft.originalVehicleId) {
        await supabase.from('vehicles').update({ driver_id: null }).eq('id', draft.originalVehicleId)
      }
      if (draft.vehicleId) {
        await supabase.from('vehicles').update({ driver_id: selected.id }).eq('id', draft.vehicleId)
      }
    }
    setSaving(false)
    closeDetail()
    load()
  }

  async function deleteDriver() {
    if (!selected) return
    await supabase.from('drivers').delete().eq('id', selected.id)
    setShowDeleteConfirm(false)
    closeDetail()
    load()
  }

  async function addDriver(e) {
    e.preventDefault()
    setSaving(true)
    const { data, error } = await supabase
      .from('drivers')
      .insert({
        name: addForm.name,
        license_class: addForm.license_class,
        license_number: addForm.license_number || null,
        license_expiry: addForm.license_expiry || null,
        phone: addForm.phone || null,
        hired_date: addForm.hired_date || null,
        status: addForm.status,
      })
      .select()
      .single()
    if (!error && data && addForm.vehicleId) {
      await supabase.from('vehicles').update({ driver_id: data.id }).eq('id', addForm.vehicleId)
    }
    setSaving(false)
    setShowAdd(false)
    setAddForm(EMPTY_FORM)
    load()
  }

  return (
    <>
      <PageHeader title="Drivers">
        <div style={{ flex: '0 1 360px', display: 'flex', alignItems: 'center', gap: 8, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.mutedLight} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            aria-label="Search drivers"
            style={{ border: 'none', background: 'transparent', outline: 'none', font: 'inherit', fontSize: 13, width: '100%', color: colors.ink }}
          />
        </div>
        <PrimaryButton onClick={() => setShowAdd(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          Add Driver
        </PrimaryButton>
      </PageHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div role="group" aria-label="Filter drivers by status" style={{ display: 'flex', gap: 8 }}>
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
            <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Driver</th>
                  <th style={thStyle}>Assigned vehicle</th>
                  <th style={thStyle}>License</th>
                  <th style={thStyle}>License #</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, padding: '12px 20px' }}>Phone</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={6} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>Loading drivers…</td></tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No drivers match this view.</td></tr>
                )}
                {!loading && visible.map((d) => {
                  const meta = STATUS_META[d.status] || { label: d.status, bg: colors.neutralBg, color: colors.neutral }
                  const veh = vehicleForDriver(d.id)
                  const em = expiryMeta(d.license_expiry)
                  return (
                    <tr key={d.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                      <td style={{ padding: '14px 20px' }}>
                        <button
                          type="button"
                          onClick={() => openDetail(d)}
                          aria-label={`Open ${d.name}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
                        >
                          <div style={{ width: 30, height: 30, borderRadius: 999, background: colors.accentBg, color: colors.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                            {initialsOf(d.name)}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: colors.accent, whiteSpace: 'nowrap' }}>{d.name}</div>
                            <div style={{ fontSize: 12, color: colors.mutedLight }}>Since {d.hired_date ? new Date(d.hired_date).getFullYear() : '—'}</div>
                          </div>
                        </button>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2 }}>{veh?.name || '—'}</td>
                      <td style={{ ...tdStyle }}>
                        <span style={{ color: colors.text2 }}>{d.license_class || '—'}</span>
                        <div style={{ fontSize: 12, color: em.color, marginTop: 1 }}>{em.label}</div>
                      </td>
                      <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{d.license_number || '—'}</td>
                      <td style={{ padding: '14px 12px' }}><Badge bg={meta.bg} color={meta.color}>{meta.label}</Badge></td>
                      <td style={{ padding: '14px 20px', fontSize: 13, color: colors.text2, fontFamily: fontMono, whiteSpace: 'nowrap' }}>{d.phone || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {!loading && (
          <div style={{ fontSize: 13, color: colors.mutedLight }}>
            Showing {visible.length} of {drivers.length} drivers
          </div>
        )}
      </main>

      {selected && draft && (
        <>
          <button
            type="button"
            onClick={closeDetail}
            aria-label="Close driver details"
            style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,20,0.32)', border: 'none', padding: 0, cursor: 'default' }}
          />
          <aside aria-label="Driver details" style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 420, background: colors.white, boxShadow: '-8px 0 24px rgba(20,20,20,0.10)', display: 'flex', flexDirection: 'column', zIndex: 50 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 38, height: 38, borderRadius: 999, background: colors.accentBg, color: colors.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                  {initialsOf(selected.name)}
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{selected.name}</h2>
                  <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>
                    Driver since {selected.hired_date ? new Date(selected.hired_date).getFullYear() : '—'}
                  </div>
                </div>
              </div>
              <button type="button" onClick={closeDetail} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: colors.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4B505A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <Badge bg={(STATUS_META[draft.status] || {}).bg} color={(STATUS_META[draft.status] || {}).color}>
                  {(STATUS_META[draft.status] || {}).label || draft.status}
                </Badge>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Status">
                  <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} style={selectStyle}>
                    <option value="active">Active</option>
                    <option value="leave">On Leave</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </Field>
                <Field label="Assigned vehicle">
                  <select value={draft.vehicleId} onChange={(e) => setDraft({ ...draft, vehicleId: e.target.value })} style={selectStyle}>
                    <option value="">Unassigned</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="License">
                  <select value={draft.license_class} onChange={(e) => setDraft({ ...draft, license_class: e.target.value })} style={selectStyle}>
                    {LICENSE_CLASSES.map((lc) => (
                      <option key={lc} value={lc}>{lc}</option>
                    ))}
                  </select>
                </Field>
                <Field label="License number">
                  <input
                    type="text"
                    value={draft.license_number}
                    onChange={(e) => setDraft({ ...draft, license_number: e.target.value })}
                    style={{ ...inputStyle, fontFamily: fontMono }}
                  />
                </Field>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="License expiry">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <select aria-label="Expiry month" value={draftExpMonth} onChange={(e) => setExpiryMonth(e.target.value)} style={selectStyle}>
                      {MONTH_NAMES.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <select aria-label="Expiry year" value={draftExpYear} onChange={(e) => setExpiryYear(e.target.value)} style={selectStyle}>
                      {YEAR_OPTIONS.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ fontSize: 11, color: expiryMeta(draft.license_expiry).color, marginTop: 5 }}>
                    {expiryMeta(draft.license_expiry).label}
                  </div>
                </Field>
              </div>

              <Field label="Phone">
                <input
                  type="text"
                  value={draft.phone}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            </div>

            <div style={{ padding: '18px 24px', borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
              {hasPermission('delete_drivers') && (
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
        title="Delete driver?"
        body={`This will permanently remove ${selected?.name || 'this driver'} from the roster. This can't be undone.`}
        confirmLabel="Delete driver"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={deleteDriver}
      />

      {showAdd && (
        <div
          role="presentation"
          onClick={() => setShowAdd(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(28,30,34,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
        >
          <form
            onSubmit={addDriver}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 440, maxHeight: '86vh', overflowY: 'auto', background: colors.white, borderRadius: 12, padding: 24, boxShadow: '0 8px 30px rgba(20,20,20,0.18)', display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Add driver</h2>

            <Field label="Name">
              <input required type="text" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Full name" style={inputStyle} />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="License">
                <select value={addForm.license_class} onChange={(e) => setAddForm({ ...addForm, license_class: e.target.value })} style={selectStyle}>
                  {LICENSE_CLASSES.map((lc) => (
                    <option key={lc} value={lc}>{lc}</option>
                  ))}
                </select>
              </Field>
              <Field label="License number">
                <input type="text" value={addForm.license_number} onChange={(e) => setAddForm({ ...addForm, license_number: e.target.value })} style={{ ...inputStyle, fontFamily: fontMono }} />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Status">
                <select value={addForm.status} onChange={(e) => setAddForm({ ...addForm, status: e.target.value })} style={selectStyle}>
                  <option value="active">Active</option>
                  <option value="leave">On Leave</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
            </div>

            <AddExpiryField addForm={addForm} setAddForm={setAddForm} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Phone">
                <input type="text" value={addForm.phone} onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })} placeholder="+62 812-…" style={inputStyle} />
              </Field>
              <Field label="Hired date">
                <input type="date" value={addForm.hired_date} onChange={(e) => setAddForm({ ...addForm, hired_date: e.target.value })} style={inputStyle} />
              </Field>
            </div>

            <Field label="Assigned vehicle">
              <select value={addForm.vehicleId} onChange={(e) => setAddForm({ ...addForm, vehicleId: e.target.value })} style={selectStyle}>
                <option value="">Unassigned</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </Field>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <SecondaryButton type="button" onClick={() => setShowAdd(false)}>Cancel</SecondaryButton>
              <PrimaryButton type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add Driver'}</PrimaryButton>
            </div>
          </form>
        </div>
      )}
    </>
  )
}

// Same two-dropdown (month + year) expiry picker as the detail panel, scoped
// to the "add driver" form's own state instead of `draft`.
function AddExpiryField({ addForm, setAddForm }) {
  const now = new Date()
  const parsed = addForm.license_expiry ? new Date(addForm.license_expiry + 'T00:00:00') : null
  const month = parsed ? MONTH_NAMES[parsed.getMonth()] : MONTH_NAMES[now.getMonth()]
  const year = parsed ? String(parsed.getFullYear()) : String(now.getFullYear())
  const years = Array.from({ length: 6 }, (_, i) => String(now.getFullYear() + i))

  function setMonth(m) {
    const mi = MONTH_NAMES.indexOf(m)
    setAddForm({ ...addForm, license_expiry: `${year}-${String(mi + 1).padStart(2, '0')}-01` })
  }
  function setYear(y) {
    const mi = MONTH_NAMES.indexOf(month)
    setAddForm({ ...addForm, license_expiry: `${y}-${String(mi + 1).padStart(2, '0')}-01` })
  }

  return (
    <Field label="License expiry">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <select aria-label="Expiry month" value={month} onChange={(e) => setMonth(e.target.value)} style={selectStyle}>
          {MONTH_NAMES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select aria-label="Expiry year" value={year} onChange={(e) => setYear(e.target.value)} style={selectStyle}>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
    </Field>
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
const tdStyle = { padding: '14px 12px', fontSize: 13, whiteSpace: 'nowrap' }
