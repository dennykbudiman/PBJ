import React, { useState } from 'react'
import { Badge, Button, Empty, Notice, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import ContactForm from './ContactForm'
import { DeferredList, JobsFor } from '../jobs/JobLists'
import { IssueCreditModal, PayBackCreditModal } from '../jobs/JobModals'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { rp, km } from '../../lib/format'
import { TYPE_COLOR, VEHICLE_STATUS_COLOR, rpShort, vehicleName } from '../../lib/customers'

function Field({ label, children }) {
  return (
    <div className="pfield">
      <div className="fieldlabel">{label}</div>
      <div className="pvalue">{children || <span className="muted">—</span>}</div>
    </div>
  )
}

function Kpi({ label, value, note, noteColor }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {note && <div className="kpi-note" style={{ color: noteColor }}>{note}</div>}
    </div>
  )
}

const TABS = ['contact', 'vehicles', 'jobs', 'deferred', 'finances']

export default function CustomerPanel({ customer, stats, vehicles, canEdit, onEdit, onReload, onClose, onAddVehicle, onOpenVehicle, onDeleted }) {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [creditOpen, setCreditOpen] = useState(false)
  const [payBackOpen, setPayBackOpen] = useState(false)
  const { t, lang } = useT()
  const toast = useToast()
  const { settings } = useShop()
  const [tab, setTab] = useState('contact')
  const [contact, setContact] = useState(undefined) // undefined = closed, null = new
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const s = stats || {}
  const terms = customer.payment_terms_days ?? settings?.default_payment_terms_days ?? 30
  const termsLabel = terms === 0 ? t('cust.dueOnReceipt') : t('cust.netDays', { days: terms })
  const monthName = new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { month: 'long' }).format(new Date())

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('customers').delete().eq('id', customer.id)
    setBusy(false)
    setConfirmDelete(false)
    if (error) {
      if (error.code === '23503') return toast(t('cust.deleteBlocked'), 'err')
      return toast(errorText(error, t), 'err')
    }
    toast(t('cust.deleted', { name: customer.display_name }))
    onDeleted()
  }

  return (
    <aside className="panel" aria-label={customer.display_name}>
      <div className="panel-head">
        <button className="btn ghost sm panel-back" onClick={onClose} aria-label={t('common.back')}><Icon name="x" size={16} /></button>
        <div style={{ minWidth: 0 }}>
          <h2 className="panel-title">{customer.display_name}</h2>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            <Badge color={TYPE_COLOR[customer.type]}>{t(`cust.type.${customer.type}`)}</Badge>
            {customer.charge_account && <Badge color="green">{t('cust.chargeAccountBadge')}</Badge>}
            {customer.tax_exempt && <Badge color="amber">{t('cust.taxExemptBadge')}</Badge>}
            <Badge color={customer.active ? 'gray' : 'red'}>{customer.active ? t('cust.active') : t('cust.inactive')}</Badge>
          </div>
        </div>
        <div className="spacer" />
        {canEdit && <Button size="sm" icon="edit" onClick={onEdit}>{t('common.edit')}</Button>}
      </div>

      <div className="subtabs panel-tabs">
        {TABS.map((x) => (
          <button key={x} className={`subtab ${tab === x ? 'on' : ''}`} onClick={() => setTab(x)}>
            {t(`cust.tab.${x}`)}{x === 'vehicles' ? ` (${s.vehicles ?? 0})` : ''}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {customer.pinned_notes && <Notice kind="warn" style={{ marginBottom: 12 }}><b>{t('cust.pinned')}:</b> {customer.pinned_notes}</Notice>}

        {tab === 'contact' && (
          <>
            <div className="pgrid">
              <Field label={t('cust.legalName')}>{customer.legal_name}</Field>
              <Field label={t('cust.type')}>{t(`cust.type.${customer.type}`)}</Field>
              <Field label="NPWP">{customer.npwp}</Field>
              <Field label={t('cust.terms')}>{termsLabel}{customer.payment_terms_days == null && <span className="muted small"> · {t('cust.shopDefault')}</span>}</Field>
              <Field label={t('cust.billingAddress')}><span style={{ whiteSpace: 'pre-line' }}>{customer.billing_address}</span></Field>
              <Field label={t('cust.creditLimit')}>{customer.credit_limit == null ? null : rp(customer.credit_limit)}</Field>
              <Field label={t('settings.phone')}>{customer.phone}</Field>
              <Field label={t('settings.email')}>{customer.email && <a href={`mailto:${customer.email}`}>{customer.email}</a>}</Field>
            </div>

            <div className="row" style={{ marginTop: 16 }}>
              <div className="sectionlabel" style={{ margin: 0 }}>{t('cust.contacts')}</div>
              <div className="spacer" />
              {canEdit && <button className="linkbtn small" onClick={() => setContact(null)}>+ {t('cust.addContact')}</button>}
            </div>
            {(s.contacts ?? []).length === 0 && <div className="muted small" style={{ padding: '10px 0' }}>{t('cust.noContacts')}</div>}
            {(s.contacts ?? []).map((ct) => (
              <div key={ct.id} className="contactrow">
                <div style={{ minWidth: 0 }}>
                  <b>{ct.name}</b>
                  <span className="muted"> · {t(`cust.role.${ct.role}`)}{ct.can_approve ? ` (${t('cust.approver')})` : ''}</span>
                  {ct.is_primary && <Badge color="green">{t('cust.primary')}</Badge>}
                </div>
                <div className="spacer" />
                <div className="contactreach">
                  {ct.phone && <a href={`tel:${ct.phone.replace(/[^+\d]/g, '')}`}>{ct.phone}</a>}
                  {ct.email && <a href={`mailto:${ct.email}`}>{ct.email}</a>}
                </div>
                {canEdit && <button className="btn ghost sm" onClick={() => setContact(ct)} aria-label={t('common.edit')}><Icon name="edit" size={14} /></button>}
              </div>
            ))}

            <div className="kpis">
              <Kpi label={t('cust.outstanding')} value={rpShort(s.balance, lang)}
                note={s.overdue > 0 ? t('cust.overdueAmount', { amount: rpShort(s.overdue, lang) }) : t('cust.nothingOverdue')}
                noteColor={s.overdue > 0 ? 'var(--red)' : 'var(--green)'} />
              <Kpi label={t('cust.vehicles')} value={s.vehicles ?? 0}
                note={s.sold ? `${t('cust.inShop', { n: s.inShop ?? 0 })} · ${t('cust.soldCount', { n: s.sold })}` : t('cust.inShop', { n: s.inShop ?? 0 })} />
              <Kpi label={t('cust.salesIn', { month: monthName })} value={rpShort(s.sales, lang)} note={t(s.invoices === 1 ? 'cust.invoicesOne' : 'cust.invoicesCount', { n: s.invoices ?? 0 })} />
            </div>

            <div className="row wrap" style={{ marginTop: 14 }}>
              {can('edit_jobs') && <Button variant="primary" icon="plus" onClick={() => navigate(`/jobs/new?customer=${customer.id}`)}>{t('create.job')}</Button>}
              <Button disabled title={t('cust.calendarSoon')}>{t('cust.appointment')}</Button>
              {canEdit && <Button onClick={onAddVehicle}>{t('cust.addVehicle')}</Button>}
              {can('issue_credits') && <Button onClick={() => setCreditOpen(true)}>{t('cust.creditMemo')}</Button>}
              {can('refund_payments') && Number(s.credit) > 0 && <Button onClick={() => setPayBackOpen(true)}>{t('credit.payBack')}</Button>}
            </div>
            <div className="hint">{t('cust.availableCredit', { amount: rp(s.credit) })}</div>
          </>
        )}

        {tab === 'vehicles' && (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="muted small">{s.sold ? `${t('cust.vehiclesOf', { n: s.vehicles ?? 0 })} · ${t('cust.soldCount', { n: s.sold })}` : t('cust.vehiclesOf', { n: s.vehicles ?? 0 })}</span>
              <div className="spacer" />
              {canEdit && <Button size="sm" icon="plus" onClick={onAddVehicle}>{t('cust.addVehicle')}</Button>}
            </div>
            {vehicles.length === 0 ? (
              <Empty icon="car" title={t('cust.noVehiclesTitle')}>{t('cust.noVehiclesText')}</Empty>
            ) : (
              <div className="table" style={{ borderRadius: 10 }}>
                <table style={{ minWidth: 0 }}>
                  <thead><tr><th>{t('veh.plate')}</th><th>{t('veh.vehicle')}</th><th className="num">{t('veh.odometer')}</th><th>{t('veh.status')}</th></tr></thead>
                  <tbody>
                    {vehicles.map((v) => (
                      <tr key={v.id} className="click" onClick={() => onOpenVehicle(v.id)}>
                        <td><b>{v.plate}</b></td>
                        <td>{vehicleName(v) || <span className="muted">—</span>}</td>
                        <td className="num">{km(v.mileage_km)}</td>
                        <td><Badge color={VEHICLE_STATUS_COLOR[v.status]}>{t(`veh.st.${v.status}`)}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'jobs' && <JobsFor customerId={customer.id} />}
        {tab === 'deferred' && <DeferredList customerId={customer.id} embedded />}

        {tab === 'finances' && (
          <>
            <div className="pgrid">
              <Field label={t('cust.outstanding')}>{rp(s.balance)}</Field>
              <Field label={t('cust.overdue')}><span style={{ color: s.overdue > 0 ? 'var(--red)' : undefined }}>{rp(s.overdue)}</span></Field>
              <Field label={t('cust.openInvoices')}>{s.openInvoices ?? 0}</Field>
              <Field label={t('cust.availableCreditLabel')}>{rp(s.credit)}</Field>
              <Field label={t('cust.creditLimit')}>{customer.credit_limit == null ? t('cust.noLimit') : rp(customer.credit_limit)}</Field>
              <Field label={t('cust.terms')}>{termsLabel}</Field>
            </div>
            {customer.credit_limit != null && s.balance > Number(customer.credit_limit) && (
              <Notice kind="err" style={{ marginTop: 12 }}>{t('cust.overLimit')}</Notice>
            )}
            <div className="hint" style={{ marginTop: 12 }}>{t('cust.financesSoon')}</div>
          </>
        )}

        {canEdit && tab === 'contact' && (
          <div style={{ marginTop: 22, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
            {confirmDelete ? (
              <div className="row wrap">
                <span className="small">{t('cust.confirmDelete', { name: customer.display_name })}</span>
                <Button size="sm" variant="danger" className="solid" onClick={remove} loading={busy}>{t('cust.confirmDeleteYes')}</Button>
                <Button size="sm" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
              </div>
            ) : (
              <button className="linkbtn small" style={{ color: 'var(--red)' }} onClick={() => setConfirmDelete(true)}>{t('cust.deleteCompany')}</button>
            )}
          </div>
        )}
      </div>

      <ContactForm
        open={contact !== undefined}
        customerId={customer.id}
        contact={contact}
        others={s.contacts}
        onClose={() => setContact(undefined)}
        onSaved={() => { setContact(undefined); onReload() }}
      />
      <IssueCreditModal open={creditOpen} customer={customer} onClose={() => setCreditOpen(false)} onDone={() => { setCreditOpen(false); onReload?.() }} />
      <PayBackCreditModal open={payBackOpen} customer={customer} onClose={() => setPayBackOpen(false)}
        onDone={(amount) => { setPayBackOpen(false); toast(t('credit.paidBack', { amount: rp(amount) })); onReload?.() }} />
    </aside>
  )
}
