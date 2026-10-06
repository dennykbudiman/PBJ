import React, { useMemo, useState } from 'react'
import { Badge, Input, Select, Textarea, Toggle, useToast } from '../../components/ui'
import { EditorPanel, EmptyCard, ListShell, SearchBox, Section, StatusSelect, RowLink, deleteErrorText, statusMatch } from './common'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'

const TYPE_COLOR = { internal: 'blue', sublet: 'purple' }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function SuppliersTab({ data, id, canEdit, reload, go }) {
  const { t } = useT()
  const [q, setQ] = useState('')
  const [type, setType] = useState('all')
  const [status, setStatus] = useState('active')
  const base = '/catalog/suppliers'

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const digits = needle.replace(/\D/g, '')
    return data.suppliers.filter((x) => statusMatch(x, status, id) && (type === 'all' || x.type === type) && (!needle
      || [x.name, x.contact_name, x.email, x.account_number].filter(Boolean).join(' ').toLowerCase().includes(needle)
      || (digits.length >= 3 && (x.phone || '').replace(/\D/g, '').includes(digits))))
  }, [data.suppliers, q, type, status, id])

  const isNew = id === 'new'
  const selected = isNew ? null : data.supplierById[id]
  const panel = id && (isNew || selected) ? (
    <SupplierEditor key={`${id}:${data.version}`} supplier={selected} data={data} canEdit={canEdit}
      onClose={() => go(base)}
      onSaved={async (row) => { await reload(); go(`${base}/${row.id}`) }}
      onDeleted={async () => { await reload(); go(base) }} />
  ) : id ? <EmptyCard icon="info" title={t('cat.notFound')} /> : null

  const empty = data.suppliers.length === 0
    ? <EmptyCard icon="truck" title={t('cat.empty.suppliers')} text={t('cat.emptyText.suppliers')} />
    : rows.length === 0 ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null

  return (
    <ListShell title={t('cat.tab.suppliers')} sub={t('cat.sub.suppliers')} addLabel={t('cat.add.suppliers')} onAdd={() => go(`${base}/new`)}
      canEdit={canEdit} panel={panel} empty={empty}
      filters={<>
        <SearchBox value={q} onChange={setQ} placeholder={t('cat.search.suppliers')} />
        <select className="select chipselect" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('cat.supplierType')}>
          <option value="all">{t('cat.typeAll')}</option>
          <option value="internal">{t('cat.stype.internal')}</option>
          <option value="sublet">{t('cat.stype.sublet')}</option>
        </select>
        <StatusSelect value={status} onChange={setStatus} />
      </>}>
      <div className="table">
        <table>
          <thead><tr><th>{t('cat.name')}</th><th>{t('cat.supplierType')}</th><th className="wide-only">{t('cat.contact')}</th><th>{t('settings.phone')}</th><th className="num wide-only">{t('cat.termsCol')}</th><th className="num">{t('cat.partsCol')}</th></tr></thead>
          <tbody>
            {rows.map((x) => {
              const n = data.items.filter((i) => i.supplier_id === x.id).length
              return (
                <tr key={x.id} className={`click ${x.id === id ? 'selected' : ''}`} onClick={() => go(`${base}/${x.id}`)}>
                  <td><RowLink to={`${base}/${x.id}`} go={go}>{x.name}</RowLink>{!x.active && <> <Badge color="gray">{t('cat.inactive')}</Badge></>}{x.pinned_notes && <div className="muted small ellipsis">📌 {x.pinned_notes}</div>}</td>
                  <td><Badge color={TYPE_COLOR[x.type]}>{t(`cat.stype.${x.type}`)}</Badge></td>
                  <td className="wide-only">{x.contact_name || <span className="muted">—</span>}</td>
                  <td className="code">{x.phone || <span className="muted">—</span>}</td>
                  <td className="num wide-only">{x.payment_terms_days == null ? '—' : x.payment_terms_days === 0 ? t('cat.cod') : t('cat.daysN', { n: x.payment_terms_days })}</td>
                  <td className="num">{n || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">{t('cat.listHint.suppliers')}</div>
    </ListShell>
  )
}

function SupplierEditor({ supplier, data, canEdit, onClose, onSaved, onDeleted }) {
  const { t } = useT()
  const toast = useToast()
  const isNew = !supplier
  const s = supplier || {}
  const [f, setF] = useState(() => ({
    name: s.name || '', type: s.type || 'internal', contact_name: s.contact_name || '', phone: s.phone || '', email: s.email || '',
    address: s.address || '', account_number: s.account_number || '', terms: s.payment_terms_days == null ? '' : String(s.payment_terms_days),
    pinned_notes: s.pinned_notes || '', active: supplier ? supplier.active : true,
  }))
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const dis = !canEdit
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  const parts = supplier ? data.items.filter((i) => i.supplier_id === supplier.id) : []

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    const dup = data.suppliers.find((x) => x.id !== supplier?.id && x.name.trim().toLowerCase() === f.name.trim().toLowerCase())
    if (dup) e.name = t('cat.dupName')
    if (f.email.trim() && !EMAIL.test(f.email.trim())) e.email = t('settings.badEmail')
    const terms = f.terms.trim() === '' ? null : Number(f.terms)
    if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365)) e.terms = t('cust.termsRule')
    setErrors(e)
    if (Object.keys(e).length) return
    const row = {
      name: f.name.trim(), type: f.type, contact_name: f.contact_name.trim() || null, phone: f.phone.trim() || null,
      email: f.email.trim() || null, address: f.address.trim() || null, account_number: f.account_number.trim() || null,
      payment_terms_days: terms, pinned_notes: f.pinned_notes.trim() || null, active: f.active,
    }
    setBusy(true)
    setMsg(null)
    const res = isNew
      ? await supabase.from('suppliers').insert(row).select().single()
      : await supabase.from('suppliers').update(row).eq('id', supplier.id).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    toast(t('cat.saved', { name: res.data.name }))
    await onSaved(res.data)
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('suppliers').delete().eq('id', supplier.id)
    setBusy(false)
    if (error) return setMsg(deleteErrorText(error, t))
    toast(t('cat.deleted', { name: supplier.name }))
    onDeleted()
  }

  return (
    <EditorPanel title={isNew ? t('cat.new.supplier') : supplier.name} subtitle={!isNew ? t(`cat.stype.${supplier.type}`) : null}
      badges={!isNew && !supplier.active ? <Badge color="gray">{t('cat.inactive')}</Badge> : null}
      canEdit={canEdit} busy={busy} error={msg} onSave={save} onClose={onClose} onDelete={remove} isNew={isNew}>
      {!isNew && supplier.pinned_notes && <div className="pinned">📌 {supplier.pinned_notes}</div>}
      <div className="grid2">
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={set('name')} error={errors.name} disabled={dis} autoFocus={isNew} />
        <Select label={t('cat.supplierType')} value={f.type} onChange={set('type')} disabled={dis}
          options={[{ value: 'internal', label: t('cat.stype.internal') }, { value: 'sublet', label: t('cat.stype.sublet') }]} hint={t(`cat.stypeHint.${f.type}`)} />
        <Input label={t('cat.termsDays')} value={f.terms} onChange={set('terms')} disabled={dis} inputMode="numeric" suffix={t('common.days')} error={errors.terms} hint={t('cat.termsHint')} />
      </div>
      <Section title={t('cat.contact')}>
        <div className="grid2">
          <Input label={t('cat.contactName')} value={f.contact_name} onChange={set('contact_name')} disabled={dis} />
          <Input label={t('settings.phone')} value={f.phone} onChange={set('phone')} disabled={dis} inputMode="tel" />
          <Input fieldClass="span2" label={t('settings.email')} value={f.email} onChange={set('email')} disabled={dis} type="email" error={errors.email} />
          <Textarea fieldClass="span2" label={t('settings.address')} value={f.address} onChange={set('address')} disabled={dis} rows={2} />
          <Input fieldClass="span2" label={t('cat.accountNo')} value={f.account_number} onChange={set('account_number')} disabled={dis} hint={t('cat.accountHint')} />
        </div>
      </Section>
      <Section title={t('cat.settings')}>
        <Textarea label={t('cat.pinnedNotes')} value={f.pinned_notes} onChange={set('pinned_notes')} disabled={dis} rows={2} hint={t('cat.pinnedHint')} />
        <div className="mt"><Toggle checked={f.active} onChange={set('active')} disabled={dis} label={t('cat.activeLabel')} /></div>
      </Section>
      {parts.length > 0 && (
        <Section title={t('cat.suppliedParts', { n: parts.length })}>
          <div className="row wrap" style={{ gap: 6 }}>
            {parts.slice(0, 12).map((p) => <Badge key={p.id} color="gray">{p.name}</Badge>)}
            {parts.length > 12 && <span className="muted small">+{parts.length - 12}</span>}
          </div>
        </Section>
      )}
    </EditorPanel>
  )
}
