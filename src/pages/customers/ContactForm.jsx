import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Notice, Select, Toggle } from '../../components/ui'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { CONTACT_ROLES } from '../../lib/customers'

const EMPTY = { name: '', role: 'fleet_manager', phone: '', email: '', is_primary: false, can_approve: false }

// A person at a company: fleet manager (the future approver), billing contact, or other.
export default function ContactForm({ open, customerId, contact, others, onClose, onSaved }) {
  const { t } = useT()
  const [f, setF] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!open) return
    setMsg(null)
    setConfirmDelete(false)
    setF(contact ? { name: contact.name, role: contact.role, phone: contact.phone || '', email: contact.email || '', is_primary: contact.is_primary, can_approve: contact.can_approve }
      : { ...EMPTY, is_primary: (others ?? []).length === 0 })
  }, [open, contact]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))

  async function save() {
    setMsg(null)
    if (!f.name.trim()) return setMsg(t('cust.contactNameRequired'))
    if (f.email.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim())) return setMsg(t('settings.badEmail'))
    setBusy(true)
    const row = { name: f.name.trim(), role: f.role, phone: f.phone.trim() || null, email: f.email.trim() || null, is_primary: f.is_primary, can_approve: f.can_approve }
    const res = contact
      ? await supabase.from('customer_contacts').update(row).eq('id', contact.id).select('id').single()
      : await supabase.from('customer_contacts').insert({ ...row, customer_id: customerId }).select('id').single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    // One main contact per company: take the flag off the others.
    if (f.is_primary) {
      const ids = (others ?? []).filter((o) => o.is_primary && o.id !== res.data.id).map((o) => o.id)
      if (ids.length) {
        const { error } = await supabase.from('customer_contacts').update({ is_primary: false }).in('id', ids)
        if (error) { setBusy(false); return setMsg(errorText(error, t)) }
      }
    }
    setBusy(false)
    onSaved()
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('customer_contacts').delete().eq('id', contact.id)
    if (error) { setBusy(false); return setMsg(errorText(error, t)) }
    // Removing the main contact: the next one becomes main, so the company always has one.
    if (contact.is_primary) {
      const next = (others ?? []).find((o) => o.id !== contact.id)
      if (next) await supabase.from('customer_contacts').update({ is_primary: true }).eq('id', next.id)
    }
    setBusy(false)
    onSaved()
  }

  return (
    <Modal open={open} onClose={onClose} title={contact ? t('cust.editContact') : t('cust.addContact')}
      footer={<>
        {contact && (confirmDelete
          ? <Button variant="danger" className="solid" onClick={remove} loading={busy} style={{ marginRight: 'auto' }}>{t('cust.confirmDeleteContact')}</Button>
          : <Button variant="ghost" className="danger" onClick={() => setConfirmDelete(true)} style={{ marginRight: 'auto' }}>{t('common.delete')}</Button>)}
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button>
      </>}>
      {msg && <Notice kind="err">{msg}</Notice>}
      <div className="grid2">
        <Input label={t('cust.contactName')} value={f.name} onChange={set('name')} autoFocus />
        <Select label={t('cust.contactRole')} value={f.role} onChange={set('role')} options={CONTACT_ROLES.map((r) => ({ value: r, label: t(`cust.role.${r}`) }))} />
        <Input label={t('settings.phone')} value={f.phone} onChange={set('phone')} />
        <Input label={t('settings.email')} type="email" value={f.email} onChange={set('email')} />
      </div>
      <Toggle checked={f.is_primary} onChange={set('is_primary')} label={t('cust.isPrimary')} />
      <Toggle checked={f.can_approve} onChange={set('can_approve')} label={t('cust.canApprove')} />
    </Modal>
  )
}
