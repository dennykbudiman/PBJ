import React, { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Input, Modal, Notice, useConfirm, useToast } from './ui'
import { useT } from '../lib/i18n'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { supabase, errorText } from '../lib/supabase'
import { fmtDate, invoiceNo } from '../lib/format'
import { shopToday } from '../lib/customers'

// Item 47 (migration 148): "Berkas diterima". The service advisor hands the Owner a copy of each invoice stapled with
// the PO, the supplier's receipt and the drum-oil sheet; the Owner or an Admin marks it received. Nobody else sees it.

export const useOwnerAdmin = () => {
  const { roleName, isStaff } = useAuth()
  return isStaff && (roleName === 'Owner' || roleName === 'Admin')
}

// Marks one or more invoiced jobs received: the date (today by default, not later) and an optional note.
export function MarkPaperworkModal({ open, ids, label, onClose, onDone }) {
  const { t } = useT()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [on, setOn] = useState(today)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => { if (open) { setOn(today); setNote(''); setError(null) } }, [open, today])
  async function save() {
    setBusy(true); setError(null)
    const { data, error: err } = await supabase.rpc('paperwork_mark', { p_ros: ids, p_on: on || null, p_note: note.trim() || null })
    setBusy(false)
    if (err) { setError(err); return }
    onDone?.(Number(data) || 0)
  }
  return (
    <Modal open={open} title={ids.length > 1 ? t('u148.titleMany', { n: ids.length }) : t('u148.title')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" icon="check" loading={busy} disabled={!on || on > today || !ids.length} onClick={save}>{t('u148.mark')}</Button></>}>
      {label && <div style={{ marginBottom: 10 }}><b>{label}</b></div>}
      <div className="small muted" style={{ marginBottom: 12, lineHeight: 1.5 }}>{t('u148.hint')}</div>
      {error && <Notice kind="err" style={{ marginBottom: 10 }}>{errorText(error, t)}</Notice>}
      <Input type="date" label={t('u148.date')} value={on} max={today} onChange={(e) => setOn(e.target.value)} />
      <Input label={t('u148.note')} value={note} maxLength={200} placeholder={t('u148.notePh')} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  )
}

// The job page (invoiced jobs; Owner and Admins only): received or not, mark / undo.
export function PaperworkCard({ job, staff }) {
  const { t, lang } = useT()
  const toast = useToast()
  const ro = job.ro
  const [row, setRow] = useState(undefined)
  const [ask, setAsk] = useState(false)
  const [confirm, confirmEl] = useConfirm()
  const load = useCallback(() => {
    supabase.from('invoice_paperwork').select('*').eq('ro_id', ro.id).maybeSingle()
      .then(({ data }) => setRow(data || null))
  }, [ro.id])
  useEffect(() => { load() }, [load, ro.invoice_number, ro.order_status])
  const who = row && (staff || []).find((s) => s.id === row.received_by)?.name
  async function undo() {
    if (!(await confirm({ title: t('u148.box'), text: t('u148.undoAsk', { inv: invoiceNo(ro.invoice_number) }), yes: t('u148.undo'), danger: true }))) return
    const { error } = await supabase.rpc('paperwork_unmark', { p_ro: ro.id })
    if (error) { toast(errorText(error, t), 'err'); return }
    toast(t('u148.undone')); load()
  }
  if (row === undefined) return null
  return (
    <section className="card side-card paperwork-card">
      {confirmEl}
      <div className="sectionlabel" style={{ marginTop: 0 }}>{t('u148.box')}</div>
      {row ? (
        <div className="small" style={{ lineHeight: 1.6 }}>
          <Badge color="green">{t('u148.received', { date: fmtDate(row.received_on, lang), who: who || '—' })}</Badge>
          {row.note && <div className="muted" style={{ marginTop: 4 }}>{row.note}</div>}
          <button type="button" className="linkbtn small" style={{ marginTop: 4 }} onClick={undo}>{t('u148.undo')}</button>
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <Badge color="amber">{t('u148.notYet')}</Badge>
          <Button size="sm" icon="check" onClick={() => setAsk(true)}>{t('u148.mark')}</Button>
        </div>
      )}
      <MarkPaperworkModal open={ask} ids={[ro.id]} label={invoiceNo(ro.invoice_number)} onClose={() => setAsk(false)}
        onDone={(n) => { setAsk(false); toast(t('u148.done', { n })); load() }} />
    </section>
  )
}
