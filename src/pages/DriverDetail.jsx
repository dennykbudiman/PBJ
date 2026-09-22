import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, LICENSE_CLASSES } from '../lib/theme'
import { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import ConfirmModal from '../components/ConfirmModal'
import DetailHeader from '../components/DetailHeader'
import { MONTH_NAMES, expiryMeta } from './Drivers'

const STATUS_META = {
  active: { label: 'Active', bg: colors.accentBg, color: colors.good },
  leave: { label: 'On Leave', bg: colors.warnBg, color: colors.warn },
  inactive: { label: 'Inactive', bg: colors.neutralBg, color: colors.neutral },
}

function initialsOf(name) {
  return (name || '').split(' ').filter(Boolean).map((s) => s[0]).slice(0, 2).join('').toUpperCase()
}

export default function DriverDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()

  const [driver, setDriver] = useState(null)
  const [vehicles, setVehicles] = useState([])
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
    const [{ data: d }, { data: v }] = await Promise.all([
      supabase.from('drivers').select('*').eq('id', id).single(),
      supabase.from('vehicles').select('id, name, driver_id').order('name', { ascending: true }),
    ])
    setDriver(d ?? null)
    setVehicles(v ?? [])
    if (d) {
      const currentVehicle = (v ?? []).find((veh) => veh.driver_id === d.id) || null
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
    setLoading(false)
  }

  const draftExpParsed = draft?.license_expiry ? new Date(draft.license_expiry + 'T00:00:00') : null
  const now = new Date()
  const draftExpMonth = draftExpParsed ? MONTH_NAMES[draftExpParsed.getMonth()] : MONTH_NAMES[now.getMonth()]
  const draftExpYear = draftExpParsed ? String(draftExpParsed.getFullYear()) : String(now.getFullYear())
  const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => String(new Date().getFullYear() + i))

  function setExpiryMonth(monthName) {
    const mi = MONTH_NAMES.indexOf(monthName)
    setDraft({ ...draft, license_expiry: `${draftExpYear}-${String(mi + 1).padStart(2, '0')}-01` })
  }
  function setExpiryYear(year) {
    const mi = MONTH_NAMES.indexOf(draftExpMonth)
    setDraft({ ...draft, license_expiry: `${year}-${String(mi + 1).padStart(2, '0')}-01` })
  }

  async function saveDetail() {
    if (!driver || !draft) return
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
      .eq('id', driver.id)

    if (draft.vehicleId !== draft.originalVehicleId) {
      if (draft.originalVehicleId) {
        await supabase.from('vehicles').update({ driver_id: null }).eq('id', draft.originalVehicleId)
      }
      if (draft.vehicleId) {
        await supabase.from('vehicles').update({ driver_id: driver.id }).eq('id', draft.vehicleId)
      }
    }
    setSaving(false)
    load()
  }

  async function deleteDriver() {
    if (!driver) return
    await supabase.from('drivers').delete().eq('id', driver.id)
    setShowDeleteConfirm(false)
    navigate('/drivers')
  }

  if (loading) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading driver…</main>
  }
  if (!driver || !draft) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Driver not found.</main>
  }

  const meta = STATUS_META[draft.status] || { label: draft.status, bg: colors.neutralBg, color: colors.neutral }

  return (
    <>
      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete driver?"
        body={`This will permanently remove ${driver.name} from the roster. This can't be undone.`}
        confirmLabel="Delete driver"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={deleteDriver}
      />

      <DetailHeader
        backTo="/drivers"
        backLabel="Drivers"
        title={driver.name}
        subtitle={`Driver since ${driver.hired_date ? new Date(driver.hired_date).getFullYear() : '—'}`}
        badge={<Badge bg={meta.bg} color={meta.color}>{meta.label}</Badge>}
      >
        {hasPermission('delete_drivers') && (
          <SecondaryButton onClick={() => setShowDeleteConfirm(true)} style={{ color: colors.danger, borderColor: 'rgba(192,57,43,0.35)' }}>Delete</SecondaryButton>
        )}
        <PrimaryButton onClick={saveDetail} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</PrimaryButton>
      </DetailHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 999, background: colors.accentBg, color: colors.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, flexShrink: 0 }}>
              {initialsOf(driver.name)}
            </div>
            <div style={{ fontSize: 13, color: colors.mutedLight }}>{driver.phone || 'No phone on file'}</div>
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

          <Field label="License expiry">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, maxWidth: 320 }}>
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

          <Field label="Phone">
            <input
              type="text"
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              style={{ ...inputStyle, maxWidth: 320 }}
            />
          </Field>
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
const selectStyle = { ...inputStyle, background: colors.white }
