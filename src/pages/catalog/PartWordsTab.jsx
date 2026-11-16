import React, { useEffect, useMemo, useState } from 'react'
import { Button, Input, useConfirm, useToast } from '../../components/ui'
import { EmptyCard, ListShell, SearchBox } from './common'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'
import { useOwnerAdmin } from '../../components/Paperwork'
import { forgetPartWords } from '../../components/NewPart'

// Update 150 (item 49): the part-name dictionary. "Tertulis" → "Seharusnya" (isuzu nmr 71 → Elf NMR71). While a new
// part's name is typed, a word on this list shows "Maksud Anda …?". Everyone sees it; the Owner and Admins keep it.
export default function PartWordsTab() {
  const { t } = useT()
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const canEdit = useOwnerAdmin()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState(null)   // { id?, wrong, right_text }
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  async function load() {
    const { data, error: err } = await supabase.from('part_name_words').select('id, wrong, right_text, created_at').order('wrong')
    setError(err || null); setRows(data || [])
    forgetPartWords()
  }
  useEffect(() => { load() }, [])
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return (rows || []).filter((r) => !n || r.wrong.toLowerCase().includes(n) || r.right_text.toLowerCase().includes(n))
  }, [rows, q])

  async function save() {
    const wrong = edit.wrong.replace(/\s+/g, ' ').trim(), right = edit.right_text.replace(/\s+/g, ' ').trim()
    if (!wrong || !right) return setMsg(t('u150.dict.errBoth'))
    if (wrong.toLowerCase() === right.toLowerCase() && wrong === right) return setMsg(t('u150.dict.errSame'))
    setBusy(true); setMsg(null)
    const res = edit.id
      ? await supabase.from('part_name_words').update({ wrong, right_text: right }).eq('id', edit.id)
      : await supabase.from('part_name_words').insert({ wrong, right_text: right })
    setBusy(false)
    if (res.error) return setMsg(res.error.code === '23505' ? t('u150.dict.errDup', { wrong }) : errorText(res.error, t))
    toast(t('u150.dict.saved', { wrong, right }))
    setEdit(null); load()
  }
  async function remove(r) {
    const ok = await confirm({ title: t('u150.dict.delTitle'), text: t('u150.dict.delText', { wrong: r.wrong, right: r.right_text }), yes: t('common.delete'), danger: true })
    if (ok !== true) return
    const { error: err } = await supabase.from('part_name_words').delete().eq('id', r.id)
    if (err) toast(errorText(err, t), 'err'); else { toast(t('u150.dict.deleted')); load() }
  }

  const form = edit && (
    <tr className="dict-edit">
      <td><Input aria-label={t('u150.dict.wrong')} value={edit.wrong} onChange={(e) => setEdit((x) => ({ ...x, wrong: e.target.value }))} maxLength={120} autoFocus placeholder="isuzu nmr 71" /></td>
      <td><Input aria-label={t('u150.dict.right')} value={edit.right_text} onChange={(e) => setEdit((x) => ({ ...x, right_text: e.target.value }))} maxLength={120} placeholder="Elf NMR71" />
        {msg && <div className="error">{msg}</div>}</td>
      <td className="num nowrap"><Button size="sm" onClick={() => { setEdit(null); setMsg(null) }}>{t('common.cancel')}</Button> <Button size="sm" variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></td>
    </tr>
  )
  const empty = rows && rows.length === 0 && !edit ? <EmptyCard icon="book" title={t('u150.dict.empty')} text={t('u150.dict.emptyText')} />
    : rows && shown.length === 0 && !edit ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null
  return (
    <ListShell title={t('cat.tab.names')} sub={t('u150.dict.sub')} addLabel={t('u150.dict.add')} canEdit={canEdit}
      onAdd={() => { setEdit({ wrong: '', right_text: '' }); setMsg(null) }}
      empty={error ? <EmptyCard icon="info" title={errorText(error, t)} /> : !rows ? <div className="muted">{t('common.loading')}</div> : empty}
      filters={<SearchBox value={q} onChange={setQ} placeholder={t('u150.dict.search')} />}>
      <div className="table">
        <table>
          <thead><tr><th>{t('u150.dict.wrong')}</th><th>{t('u150.dict.right')}</th><th /></tr></thead>
          <tbody>
            {edit && !edit.id && form}
            {shown.map((r) => (edit?.id === r.id ? <React.Fragment key={r.id}>{form}</React.Fragment> : (
              <tr key={r.id}>
                <td>{r.wrong}</td><td><b>{r.right_text}</b></td>
                <td className="num nowrap">{canEdit && <>
                  <button type="button" className="linkbtn small" onClick={() => { setEdit({ id: r.id, wrong: r.wrong, right_text: r.right_text }); setMsg(null) }}>{t('common.edit')}</button>{' '}
                  <button type="button" className="linkbtn small danger" onClick={() => remove(r)}>{t('common.delete')}</button>
                </>}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>{t('u150.dict.hint')}</div>
      {confirmEl}
    </ListShell>
  )
}
