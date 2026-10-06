import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Notice, Select, Textarea, Toggle, useToast } from '../../components/ui'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { num, readAmount } from '../../lib/format'
import { CUSTOMER_TYPES, npwpDigits } from '../../lib/customers'

const EMPTY = {
  type: 'fleet_internal', display_name: '', legal_name: '', npwp: '', phone: '', email: '', billing_address: '',
  payment_terms_days: '', credit_limit: '', charge_account: true, tax_exempt: false, pinned_notes: '', active: true,
  contact_name: '', contact_phone: '', contact_email: '',
}

function toForm(c) {
  if (!c) return { ...EMPTY }
  return {
    ...EMPTY,
    type: c.type, display_name: c.display_name || '', legal_name: c.legal_name || '', npwp: c.npwp || '',
    phone: c.phone || '', email: c.email || '', billing_address: c.billing_address || '',
    payment_terms_days: c.payment_terms_days == null ? '' : String(c.payment_terms_days),
    credit_limit: c.credit_limit == null ? '' : num(c.credit_limit),
    charge_account: c.charge_account, tax_exempt: c.tax_exempt, pinned_notes: c.pinned_notes || '', active: c.active,
  }
}

// Add or edit a company (PT). A new company can get its first contact in the same step.
export default function CustomerForm({ open, customer, customers, onClose, onSaved }) {
  const { t } = useT()
  const { settings } = useShop()
  const toast = useToast()
  const [f, setF] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const editing = Boolean(customer)

  useEffect(() => {
    if (open) { setF(toForm(customer)); setErrors({}); setMsg(null) }
  }, [open, customer])

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))

  async function save() {
    const errs = {}
    const name = f.display_name.trim()
    if (!name) errs.display_name = t('settings.required')
    else if ((customers ?? []).some((c) => c.id !== customer?.id && c.display_name.trim().toLowerCase() === name.toLowerCase())) {
      errs.display_name = t('cust.nameTaken')
    }
    const digits = npwpDigits(f.npwp)
    if (f.npwp.trim() && digits.length !== 15 && digits.length !== 16) errs.npwp = t('cust.npwpRule')
    if (f.email.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim())) errs.email = t('settings.badEmail')
    // Terms are whole days (0–365); "7.5" is a typo, not 75 days.
    const termsText = f.payment_terms_days.trim()
    const terms = termsText === '' ? null : /^\d+$/.test(termsText) ? Number(termsText) : NaN
    if (Number.isNaN(terms) || terms > 365) errs.payment_terms_days = t('cust.termsRule')
    const limit = readAmount(f.credit_limit)
    if (Number.isNaN(limit) || limit > 1e13) errs.credit_limit = t('settings.badAmount')
    if (f.contact_email.trim() && !/^\S+@\S+\.\S+$/.test(f.contact_email.trim())) errs.contact_email = t('settings.badEmail')
    setErrors(errs)
    if (Object.keys(errs).length) return

    const row = {
      type: f.type, display_name: name, legal_name: f.legal_name.trim() || null, npwp: f.npwp.trim() || null,
      phone: f.phone.trim() || null, email: f.email.trim() || null, billing_address: f.billing_address.trim() || null,
      payment_terms_days: terms, credit_limit: limit, charge_account: f.charge_account, tax_exempt: f.tax_exempt,
      pinned_notes: f.pinned_notes.trim() || null, active: f.active,
    }
    setBusy(true)
    setMsg(null)
    const res = editing
      ? await supabase.from('customers').update(row).eq('id', customer.id).select().single()
      : await supabase.from('customers').insert(row).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    if (!editing && f.contact_name.trim()) {
      const { error } = await supabase.from('customer_contacts').insert({
        customer_id: res.data.id, name: f.contact_name.trim(), phone: f.contact_phone.trim() || null,
        email: f.contact_email.trim() || null, role: 'fleet_manager', is_primary: true,
      })
      if (error) {
        // The company exists now; say so on screen, since this form is about to close.
        setBusy(false)
        onSaved(res.data)
        return toast(t('cust.contactFailed', { error: errorText(error, t) }), 'err')
      }
    }
    setBusy(false)
    onSaved(res.data)
  }

  const shopTerms = settings?.default_payment_terms_days ?? 30

  return (
    <Modal open={open} onClose={onClose} wide title={editing ? t('cust.editTitle') : t('cust.newTitle')}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={save} loading={busy}>{editing ? t('common.save') : t('cust.create')}</Button>
      </>}>
      {msg && <Notice kind="err">{msg}</Notice>}
      <div className="grid2">
        <Input label={t('cust.displayName')} value={f.display_name} onChange={set('display_name')} error={errors.display_name} autoFocus placeholder="PT Sumber Jaya" hint={t('cust.displayNameHint')} />
        <Select label={t('cust.type')} value={f.type} onChange={set('type')} options={CUSTOMER_TYPES.map((x) => ({ value: x, label: t(`cust.type.${x}`) }))} />
        <Input label={t('cust.legalName')} value={f.legal_name} onChange={set('legal_name')} placeholder={t('cust.legalNamePh')} />
        <Input label="NPWP" value={f.npwp} onChange={set('npwp')} error={errors.npwp} placeholder={t('settings.npwpHint')} />
        <Input label={t('settings.phone')} value={f.phone} onChange={set('phone')} />
        <Input label={t('settings.email')} type="email" value={f.email} onChange={set('email')} error={errors.email} />
        <Textarea fieldClass="span2" label={t('cust.billingAddress')} value={f.billing_address} onChange={set('billing_address')} rows={2} />
        <Input label={t('cust.terms')} value={f.payment_terms_days} onChange={set('payment_terms_days')} inputMode="numeric" suffix={t('common.days')}
          placeholder={String(shopTerms)} hint={t('cust.termsHint', { days: shopTerms })} error={errors.payment_terms_days} />
        <Input label={t('cust.creditLimit')} value={f.credit_limit} onChange={set('credit_limit')} inputMode="numeric" prefix="Rp" hint={t('cust.creditLimitHint')} error={errors.credit_limit} />
      </div>
      <div className="row wrap" style={{ gap: 22 }}>
        <Toggle checked={f.charge_account} onChange={set('charge_account')} label={t('cust.chargeAccount')} />
        <Toggle checked={f.tax_exempt} onChange={set('tax_exempt')} label={t('cust.taxExempt')} />
        {editing && <Toggle checked={f.active} onChange={set('active')} label={t('cust.activeLabel')} />}
      </div>
      <Textarea label={t('cust.pinnedNotes')} value={f.pinned_notes} onChange={set('pinned_notes')} rows={2} hint={t('cust.pinnedHint')} />
      {!editing && (
        <>
          <div className="sectionlabel" style={{ marginBottom: 0 }}>{t('cust.firstContact')}</div>
          <div className="grid3">
            <Input label={t('cust.contactName')} value={f.contact_name} onChange={set('contact_name')} />
            <Input label={t('settings.phone')} value={f.contact_phone} onChange={set('contact_phone')} />
            <Input label={t('settings.email')} type="email" value={f.contact_email} onChange={set('contact_email')} error={errors.contact_email} />
          </div>
        </>
      )}
    </Modal>
  )
}
