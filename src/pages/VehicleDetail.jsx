import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, fontMono, formatRupiah, formatDate } from '../lib/theme'
import { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'
import ConfirmModal from '../components/ConfirmModal'
import DetailHeader from '../components/DetailHeader'
import { TabBar, TabButton } from '../components/Tabs'

const STATUS_META = {
  active: { label: 'Active', bg: colors.accentBg, color: colors.good },
  shop: { label: 'In Shop', bg: colors.warnBg, color: colors.warn },
  idle: { label: 'Idle', bg: colors.neutralBg, color: colors.neutral },
}
const WO_STATUS_META = {
  open: { label: 'Open', bg: colors.neutralBg, color: colors.neutral },
  inprogress: { label: 'In Progress', bg: colors.accentBg, color: colors.accent },
  onhold: { label: 'On Hold', bg: colors.warnBg, color: colors.warn },
  completed: { label: 'Completed', bg: '#E6F5EA', color: '#227A3E' },
}

function ymm(v) {
  return [v.vehicle_year, v.make, v.model].filter(Boolean).join(' ') || '—'
}
function lineItemTotal(items) {
  return (items || []).reduce((s, li) => s + (Number(li.qty) || 0) * (Number(li.rate) || 0), 0)
}

export default function VehicleDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()

  const [vehicle, setVehicle] = useState(null)
  const [drivers, setDrivers] = useState([])
  const [owners, setOwners] = useState([])
  const [workOrders, setWorkOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('details')
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function load() {
    setLoading(true)
    const [{ data: v }, { data: d }, { data: o }, { data: wos }] = await Promise.all([
      supabase.from('vehicles').select('*').eq('id', id).single(),
      supabase.from('drivers').select('id, name').order('name', { ascending: true }),
      supabase.from('owners').select('id, name').order('name', { ascending: true }),
      supabase
        .from('work_orders')
        .select('id, wo_number, service, status, created_at, odometer_km, work_order_line_items(qty, rate)')
        .eq('vehicle_id', id)
        .order('created_at', { ascending: false }),
    ])
    setVehicle(v ?? null)
    setDrivers(d ?? [])
    setOwners(o ?? [])
    setWorkOrders(wos ?? [])
    if (v) {
      setDraft({ status: v.status, driver_id: v.driver_id || '' })
    }
    setLoading(false)
  }

  const driverName = (did) => drivers.find((d) => d.id === did)?.name || 'Unassigned'
  const ownerName = (oid) => owners.find((o) => o.id === oid)?.name || 'Unassigned'

  async function saveDetail() {
    if (!vehicle || !draft) return
    setSaving(true)
    await supabase
      .from('vehicles')
      .update({
        status: draft.status,
        driver_id: draft.driver_id || null,
      })
      .eq('id', vehicle.id)
    setSaving(false)
    load()
  }

  async function deleteVehicle() {
    if (!vehicle) return
    await supabase.from('vehicles').delete().eq('id', vehicle.id)
    setShowDeleteConfirm(false)
    navigate('/vehicles')
  }

  if (loading) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading vehicle…</main>
  }
  if (!vehicle) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Vehicle not found.</main>
  }

  const meta = STATUS_META[vehicle.status] || { label: vehicle.status, bg: colors.neutralBg, color: colors.neutral }

  return (
    <>
      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete vehicle?"
        body={`This will permanently remove ${vehicle.name} from the fleet. This can't be undone.`}
        confirmLabel="Delete vehicle"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={deleteVehicle}
      />

      <DetailHeader
        backTo="/vehicles"
        backLabel="Vehicles"
        title={vehicle.name}
        subtitle={ymm(vehicle)}
        badge={<Badge bg={meta.bg} color={meta.color}>{meta.label}</Badge>}
      >
        {hasPermission('delete_vehicles') && (
          <SecondaryButton onClick={() => setShowDeleteConfirm(true)} style={{ color: colors.danger, borderColor: 'rgba(192,57,43,0.35)' }}>Delete</SecondaryButton>
        )}
        <PrimaryButton onClick={saveDetail} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</PrimaryButton>
      </DetailHeader>

      <main style={{ flex: '1 1 auto', padding: '24px 32px 48px 32px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 20 }}>

          <TabBar ariaLabel="Vehicle sections">
            <TabButton active={tab === 'details'} onClick={() => setTab('details')}>Details</TabButton>
            <TabButton active={tab === 'history'} onClick={() => setTab('history')}>Service History{workOrders.length > 0 ? ` · ${workOrders.length}` : ''}</TabButton>
          </TabBar>

          {tab === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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

              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px 16px', background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20 }}>
                <DL label="Year" value={vehicle.vehicle_year} />
                <DL label="Make" value={vehicle.make} />
                <DL label="Model" value={vehicle.model} />
                <DL label="Plate" value={vehicle.plate} mono />
                <DL label="VIN" value={vehicle.vin} mono />
                <DL label="Type" value={vehicle.type} />
                <DL label="Fuel" value={vehicle.fuel_type} />
                <DL label="Odometer" value={vehicle.mileage_km != null ? `${Number(vehicle.mileage_km).toLocaleString('id-ID')} km` : null} mono />
                <DL label="Owner" value={ownerName(vehicle.owner_id)} />
              </dl>
              <div style={{ fontSize: 11.5, color: colors.mutedLight, marginTop: -12 }}>
                Year is set when the vehicle is added and can't be changed here. Odometer updates automatically from work order readings — see Service History. Owner is managed from the Fleet Groups page.
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {workOrders.length === 0 && (
                <div style={{ fontSize: 13, color: colors.mutedLight }}>No work orders on file for this vehicle yet.</div>
              )}
              {workOrders.length > 0 && (
                <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                          <th style={{ ...thStyle, padding: '12px 20px' }}>Work order</th>
                          <th style={thStyle}>Status</th>
                          <th style={thStyle}>Date</th>
                          <th style={thStyle}>Odometer</th>
                          <th style={{ ...thStyle, padding: '12px 20px' }}>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workOrders.map((w) => {
                          const sm = WO_STATUS_META[w.status] || WO_STATUS_META.open
                          return (
                            <tr key={w.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                              <td style={{ padding: '14px 20px' }}>
                                <button
                                  type="button"
                                  onClick={() => navigate(`/work-orders/${w.id}`)}
                                  style={{ display: 'block', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
                                >
                                  <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: colors.accent }}>{w.service}</span>
                                  <span style={{ display: 'block', fontSize: 12, color: colors.mutedLight, fontFamily: fontMono, marginTop: 1 }}>{w.wo_number}</span>
                                </button>
                              </td>
                              <td style={tdStyle}><Badge bg={sm.bg} color={sm.color}>{sm.label}</Badge></td>
                              <td style={{ ...tdStyle, color: colors.text2 }}>{formatDate(w.created_at)}</td>
                              <td style={{ ...tdStyle, color: colors.text2, fontFamily: fontMono }}>{w.odometer_km != null ? `${Number(w.odometer_km).toLocaleString('id-ID')} km` : '—'}</td>
                              <td style={{ padding: '14px 20px', fontSize: 13, fontWeight: 600, fontFamily: fontMono }}>{formatRupiah(lineItemTotal(w.work_order_line_items))}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
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
const tdStyle = { padding: '14px 12px', fontSize: 13, whiteSpace: 'nowrap' }
