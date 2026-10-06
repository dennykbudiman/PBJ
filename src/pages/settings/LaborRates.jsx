import React, { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Notice, Toggle, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { supabase, errorText } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../lib/i18n'
import { num, parseAmount, rp } from '../../lib/format'

const EMPTY = { id: null, name: '', rate: '', is_default: false, active: true }

export default function LaborRates({ id }) {
  const { t } = useT()
  const toast = useToast()
  const { can } = useAuth()
  const editable = can('edit_settings')
  const [rates, setRates] = useState(null)
  const [edit, setEdit] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from('labor_rates').select('*').order('is_default', { ascending: false }).order('name')
    if (err) toast(errorText(err, t), 'err')
    setRates(data ?? [])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  function openNew() {
    setError(null)
    setConfirmDelete(false)
    setEdit({ ...EMPTY, is_default: (rates ?? []).length === 0 })
  }
  function openEdit(r) {
    setError(null)
    setConfirmDelete(false)
    setEdit({ id: r.id, name: r.name, rate: num(r.rate_per_hour), is_default: r.is_default, active: r.active })
  }

  async function save() {
    setError(null)
    const name = edit.name.trim()
    const rate = parseAmount(edit.rate)
    if (!name) return setError(t('labor.nameRequired'))
    if (rate === null || rate < 0) return setError(t('labor.rateRequired'))
    if (edit.is_default && !edit.active) return setError(t('labor.defaultActive'))
    setBusy(true)
    // Save this rate first, then take the default flag off the others. If anything
    // fails midway there is briefly a second default, never none.
    const row = { name, rate_per_hour: rate, is_default: edit.is_default, active: edit.active }
    const { data: saved, error: err } = edit.id
      ? await supabase.from('labor_rates').update(row).eq('id', edit.id).select('id').single()
      : await supabase.from('labor_rates').insert(row).select('id').single()
    if (err) { setBusy(false); load(); return setError(errorText(err, t)) }
    if (edit.is_default) {
      const others = (rates ?? []).filter((r) => r.is_default && r.id !== saved.id).map((r) => r.id)
      if (others.length) {
        const { error: e1 } = await supabase.from('labor_rates').update({ is_default: false }).in('id', others)
        if (e1) { setBusy(false); load(); return setError(errorText(e1, t)) }
      }
    }
    setBusy(false)
    setEdit(null)
    toast(t('labor.saved'))
    load()
  }

  async function remove() {
    setBusy(true)
    const { error: err } = await supabase.from('labor_rates').delete().eq('id', edit.id)
    setBusy(false)
    if (err) {
      // Rates used by catalog labor items can't be deleted; they can be switched off instead.
      if (err.code === '23503') return setError(t('labor.inUse'))
      return setError(errorText(err, t))
    }
    setEdit(null)
    toast(t('labor.deleted'))
    load()
  }

  return (
    <Card id={id} title={t('settings.nav.labor')} actions={editable && <Button icon="plus" size="sm" onClick={openNew}>{t('labor.add')}</Button>}>
      {rates === null && <div className="muted small">{t('common.loading')}</div>}
      {rates?.length === 0 && <div className="muted small">{t('labor.none')}</div>}
      {rates?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rates.map((r) => (
            <div key={r.id} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--line-soft)', opacity: r.active ? 1 : 0.6 }}>
              <span style={{ fontWeight: 700 }}>{r.name}</span>
              {r.is_default && <Badge color="green">{t('labor.default')}</Badge>}
              {!r.active && <Badge color="gray">{t('labor.inactive')}</Badge>}
              <div className="spacer" />
              <span style={{ fontWeight: 700 }}>{t('labor.perHour', { amount: rp(r.rate_per_hour) })}</span>
              {editable && <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label={t('common.edit')}><Icon name="edit" size={15} /></Button>}
            </div>
          ))}
        </div>
      )}
      <div className="hint">{t('labor.hint')}</div>

      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? t('labor.edit') : t('labor.add')}
        footer={<>
          {edit?.id && (confirmDelete
            ? <Button variant="danger" className="solid" onClick={remove} loading={busy} style={{ marginRight: 'auto' }}>{t('labor.confirmDelete')}</Button>
            : <Button variant="ghost" className="danger" onClick={() => setConfirmDelete(true)} disabled={busy} style={{ marginRight: 'auto' }}>{t('common.delete')}</Button>)}
          <Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button>
        </>}
      >
        {edit && <>
          {error && <Notice kind="err">{error}</Notice>}
          <div className="grid2">
            <Input label={t('labor.name')} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus placeholder={t('labor.namePh')} />
            <Input label={t('labor.rate')} value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} inputMode="numeric" prefix="Rp" suffix={t('labor.hour')} />
          </div>
          <Toggle checked={edit.is_default} onChange={(v) => setEdit({ ...edit, is_default: v })} label={t('labor.makeDefault')} />
          <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label={t('labor.activeLabel')} />
        </>}
      </Modal>
    </Card>
  )
}
