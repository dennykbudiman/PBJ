import React, { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Empty, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import TransferForm from './TransferForm'
import ScheduleSection from './ScheduleSection'
import { JobsFor, VehicleInspections } from '../jobs/JobLists'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { fmtDate, jobNo, km } from '../../lib/format'
import { VEHICLE_STATUS_COLOR, vehicleName } from '../../lib/customers'

function Field({ label, children }) {
  return (
    <div className="pfield">
      <div className="fieldlabel">{label}</div>
      <div className="pvalue">{children || <span className="muted">—</span>}</div>
    </div>
  )
}

const TABS = ['overview', 'jobs', 'inspections']

export default function VehiclePanel({ vehicle, customers, openJob, canEdit, onEdit, onClose, onChanged, onOpenCustomer, onDeleted }) {
  const navigate = useNavigate()
  const { can } = useAuth()
  const { t, lang } = useT()
  const toast = useToast()
  const { timezone } = useShop()
  const [tab, setTab] = useState('overview')
  const [history, setHistory] = useState(null)
  const [transfer, setTransfer] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const nameOf = (id) => customers.find((c) => c.id === id)?.display_name || '—'

  const loadHistory = useCallback(async () => {
    const { data, error } = await supabase.from('vehicle_transfers')
      .select('id, from_customer_id, to_customer_id, transferred_at, odometer_km, note, created_at')
      .eq('vehicle_id', vehicle.id).order('transferred_at', { ascending: false }).order('created_at', { ascending: false })
    if (error) toast(errorText(error, t), 'err')
    setHistory(data ?? [])
  }, [vehicle.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHistory(null); setTab('overview'); setConfirmDelete(false); loadHistory() }, [loadHistory])

  async function remove() {
    // Its ownership history must stay, so a transferred vehicle is never deleted.
    if (history && history.length) { setConfirmDelete(false); return toast(t('veh.deleteBlocked'), 'err') }
    setBusy(true)
    const { error } = await supabase.from('vehicles').delete().eq('id', vehicle.id)
    setBusy(false)
    setConfirmDelete(false)
    if (error) {
      if (error.code === '23503') return toast(t('veh.deleteBlocked'), 'err')
      return toast(errorText(error, t), 'err')
    }
    toast(t('veh.deleted', { plate: vehicle.plate }))
    onDeleted()
  }

  // The first owner is whoever the vehicle belonged to before the first transfer that was recorded.
  const earliest = history && history.length ? [...history].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0] : null
  const firstOwner = earliest ? earliest.from_customer_id : vehicle.customer_id
  const lastTransferDate = history && history.length ? history.reduce((m, h) => (h.transferred_at > m ? h.transferred_at : m), '') : null

  return (
    <aside className="panel" aria-label={vehicle.plate}>
      <div className="panel-head">
        <button className="btn ghost sm panel-back" onClick={onClose} aria-label={t('common.back')}><Icon name="x" size={16} /></button>
        <div style={{ minWidth: 0 }}>
          <h2 className="panel-title">{vehicle.plate}{vehicleName(vehicle) && <span style={{ fontWeight: 700 }}> · {vehicleName(vehicle)}</span>}</h2>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            <Badge color={VEHICLE_STATUS_COLOR[vehicle.status]}>{t(`veh.st.${vehicle.status}`)}</Badge>
            {openJob && <Badge color="amber">{t('veh.openJob', { job: jobNo(openJob.job_number) })}</Badge>}
          </div>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          {can('edit_jobs') && vehicle.status !== 'sold' && <Button size="sm" variant="primary" icon="plus" onClick={() => navigate(`/jobs/new?vehicle=${vehicle.id}`)}>{t('create.job')}</Button>}
          {canEdit && <Button size="sm" icon="edit" onClick={onEdit}>{t('common.edit')}</Button>}
        </div>
      </div>

      <div className="subtabs panel-tabs">
        {TABS.map((x) => (
          <button key={x} className={`subtab ${tab === x ? 'on' : ''}`} onClick={() => setTab(x)}>{t(`veh.tab.${x}`)}</button>
        ))}
      </div>

      <div className="panel-body">
        {tab === 'overview' && (
          <>
            <div className="pgrid three">
              <Field label={t('veh.owner')}><button className="linkbtn" onClick={() => onOpenCustomer(vehicle.customer_id)}>{nameOf(vehicle.customer_id)}</button></Field>
              <Field label="VIN"><span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}>{vehicle.vin}</span></Field>
              <Field label={t('veh.odometer')}>{vehicle.mileage_km == null ? null : km(vehicle.mileage_km)}</Field>
              <Field label={t('veh.type')}>{vehicle.type ? t(`veh.vtype.${vehicle.type}`) : null}</Field>
              <Field label={t('veh.fuel')}>{vehicle.fuel_type ? t(`veh.fuel.${vehicle.fuel_type}`) : null}</Field>
              <Field label={t('veh.added')}>{fmtDate(vehicle.created_at, lang, timezone)}</Field>
            </div>
            {vehicle.notes && <div className="hint" style={{ whiteSpace: 'pre-line', marginTop: 10 }}><b>{t('veh.notes')}:</b> {vehicle.notes}</div>}

            <ScheduleSection vehicle={vehicle} />

            <div className="row" style={{ marginTop: 14 }}>
              <div className="sectionlabel" style={{ margin: 0 }}>{t('veh.history')}</div>
              <div className="spacer" />
              {canEdit && <Button size="sm" onClick={() => setTransfer(true)}>{t('veh.transfer')}</Button>}
            </div>
            {history === null ? <div className="muted small" style={{ padding: '8px 0' }}>{t('common.loading')}</div> : (
              <div style={{ marginTop: 6 }}>
                {history.map((h) => (
                  <div key={h.id} className="histrow">
                    <span className="muted histdate">{fmtDate(h.transferred_at, lang, timezone)}</span>
                    <span>
                      {t('veh.transferred')} <b>{nameOf(h.from_customer_id)}</b> → <b>{nameOf(h.to_customer_id)}</b>
                      {h.odometer_km != null && <> {t('veh.atKm', { km: km(h.odometer_km) })}</>}
                      {h.note && <span className="muted"> · {h.note}</span>}
                    </span>
                  </div>
                ))}
                <div className="histrow">
                  <span className="muted histdate">{fmtDate(vehicle.created_at, lang, timezone)}</span>
                  <span>{t('veh.registered', { company: nameOf(firstOwner) })}</span>
                </div>
              </div>
            )}

            {canEdit && (
              <div style={{ marginTop: 22, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
                {confirmDelete ? (
                  <div className="row wrap">
                    <span className="small">{t('veh.confirmDelete', { plate: vehicle.plate })}</span>
                    <Button size="sm" variant="danger" className="solid" onClick={remove} loading={busy}>{t('veh.confirmDeleteYes')}</Button>
                    <Button size="sm" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
                  </div>
                ) : (
                  <button className="linkbtn small" style={{ color: 'var(--red)' }} onClick={() => setConfirmDelete(true)}>{t('veh.delete')}</button>
                )}
              </div>
            )}
          </>
        )}
        {tab === 'jobs' && <JobsFor vehicleId={vehicle.id} />}
        {tab === 'inspections' && <VehicleInspections vehicleId={vehicle.id} />}
      </div>

      <TransferForm open={transfer} vehicle={vehicle} customers={customers} minDate={lastTransferDate} onClose={() => setTransfer(false)}
        onDone={() => { setTransfer(false); toast(t('veh.transferredToast', { plate: vehicle.plate })); onChanged(); loadHistory() }} />
    </aside>
  )
}
