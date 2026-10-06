import React, { useMemo, useState } from 'react'
import { Badge, Input, Toggle, useToast } from '../../components/ui'
import { EditorPanel, EmptyCard, ListShell, RowButtons, SearchBox, Section, StatusSelect, RowLink, deleteErrorText, move, statusMatch, syncRows } from './common'
import { supabase, errorText } from '../../lib/supabase'
import History from './History'
import { useT } from '../../lib/i18n'

// A checklist is an ordered set of inspection items (e.g. "Basic 30-point inspection").
export default function ChecklistsTab({ data, id, canEdit, reload, go }) {
  const { t } = useT()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('active')
  const base = '/catalog/checklists'

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return data.checklists.filter((x) => statusMatch(x, status, id) && (!needle || x.name.toLowerCase().includes(needle)))
  }, [data.checklists, q, status, id])

  const isNew = id === 'new'
  const selected = isNew ? null : data.checklists.find((x) => x.id === id)
  const panel = id && (isNew || selected) ? (
    <ChecklistEditor key={`${id}:${data.version}`} list={selected} data={data} canEdit={canEdit}
      onClose={() => go(base)}
      onSaved={async (row) => { await reload(); go(`${base}/${row.id}`) }}
      onDeleted={async () => { await reload(); go(base) }} />
  ) : id ? <EmptyCard icon="info" title={t('cat.notFound')} /> : null

  const empty = data.checklists.length === 0
    ? <EmptyCard icon="clipboard" title={t('cat.empty.checklists')} text={t('cat.emptyText.checklists')} />
    : rows.length === 0 ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null

  return (
    <ListShell title={t('cat.tab.checklists')} sub={t('cat.sub.checklists')} addLabel={t('cat.add.checklists')} onAdd={() => go(`${base}/new`)}
      canEdit={canEdit} panel={panel} empty={empty}
      filters={<><SearchBox value={q} onChange={setQ} placeholder={t('cat.search.checklists')} /><StatusSelect value={status} onChange={setStatus} /></>}>
      <div className="table">
        <table>
          <thead><tr><th>{t('cat.name')}</th><th className="num">{t('cat.points')}</th><th className="wide-only">{t('cat.usedByBundles')}</th></tr></thead>
          <tbody>
            {rows.map((x) => {
              const n = data.checklistItems.filter((c) => c.checklist_id === x.id).length
              const bundles = data.templates.filter((tp) => tp.checklist_id === x.id)
              return (
                <tr key={x.id} className={`click ${x.id === id ? 'selected' : ''}`} onClick={() => go(`${base}/${x.id}`)}>
                  <td><RowLink to={`${base}/${x.id}`} go={go}>{x.name}</RowLink>{!x.active && <> <Badge color="gray">{t('cat.inactive')}</Badge></>}</td>
                  <td className="num">{n}</td>
                  <td className="wide-only muted">{bundles.length ? bundles.map((b) => b.name).join(', ') : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">{t('cat.listHint.checklists')}</div>
    </ListShell>
  )
}

function ChecklistEditor({ list, data, canEdit, onClose, onSaved, onDeleted }) {
  const { t } = useT()
  const toast = useToast()
  const isNew = !list
  const existing = useMemo(() => data.checklistItems.filter((c) => c.checklist_id === list?.id), [data.checklistItems, list?.id])
  const [f, setF] = useState(() => ({ name: list?.name || '', active: list ? list.active : true }))
  const [items, setItems] = useState(() => existing.map((c) => c.item_id))
  const [pick, setPick] = useState('')
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const dis = !canEdit
  const byId = Object.fromEntries(data.insp.map((x) => [x.id, x]))
  const available = data.insp.filter((x) => x.active && !items.includes(x.id))
  const groups = [...new Set(available.map((x) => x.category || ''))].sort((a, b) => a.localeCompare(b))

  // Adds every active point in a group at once ("Brakes", "Tyres", …).
  function addGroup(g) {
    setItems((xs) => [...xs, ...available.filter((x) => (x.category || '') === g).map((x) => x.id)])
  }

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    if (items.length === 0) e.items = t('cat.needPoint')
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    setMsg(null)
    const row = { name: f.name.trim(), active: f.active }
    const res = isNew
      ? await supabase.from('inspection_checklists').insert(row).select().single()
      : await supabase.from('inspection_checklists').update(row).eq('id', list.id).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    const saved = res.data
    const error = await syncRows({
      table: 'inspection_checklist_items', existing, rows: items, keyCols: ['checklist_id', 'item_id'],
      toRow: (itemId, i) => ({ checklist_id: saved.id, item_id: itemId, position: i }),
      same: (a, b) => a.position === b.position,
    })
    if (error) toast(t('cat.linesFailed', { error: errorText(error, t) }), 'err')
    else toast(t('cat.saved', { name: saved.name }))
    await onSaved(saved)
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('inspection_checklists').delete().eq('id', list.id)
    setBusy(false)
    if (error) return setMsg(deleteErrorText(error, t))
    toast(t('cat.deleted', { name: list.name }))
    onDeleted()
  }

  return (
    <EditorPanel title={isNew ? t('cat.new.checklist') : list.name} subtitle={!isNew ? t('cat.pointsN', { n: existing.length }) : null}
      badges={!isNew && !list.active ? <Badge color="gray">{t('cat.inactive')}</Badge> : null}
      canEdit={canEdit} busy={busy} error={msg} onSave={save} onClose={onClose} onDelete={remove} isNew={isNew}>
      <Input label={t('cat.name')} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} error={errors.name} disabled={dis} autoFocus={isNew} placeholder={t('cat.checklistExample')} />

      <Section title={t('cat.pointsTitle', { n: items.length })}>
        {items.length === 0 && <div className="muted small">{t('cat.noPoints')}</div>}
        <div className="lines">
          {items.map((itemId, i) => {
            const x = byId[itemId]
            return (
              <div key={itemId} className="line">
                <span className="line-no">{i + 1}</span>
                <div className="line-name">
                  <b>{x?.name || '?'}</b>
                  {(x?.category || !x?.active) && <div className="muted small">{[x?.category, x && !x.active ? t('cat.inactive') : null].filter(Boolean).join(' · ')}</div>}
                </div>
                <RowButtons i={i} n={items.length} disabled={dis} label={x?.name}
                  onMove={(j, d) => setItems((xs) => move(xs, j, d))} onRemove={(j) => setItems((xs) => xs.filter((_, k) => k !== j))} />
              </div>
            )
          })}
        </div>
        {errors.items && <div className="error">{errors.items}</div>}
        {canEdit && (data.insp.length === 0 ? <div className="hint">{t('cat.noInspItems')}</div> : available.length > 0 && (
          <div className="row wrap mt" style={{ gap: 8 }}>
            <select className="select" style={{ flex: '1 1 220px', width: 'auto' }} value={pick} aria-label={t('cat.addPoint')}
              onChange={(e) => { if (e.target.value) setItems((xs) => [...xs, e.target.value]); setPick('') }}>
              <option value="">{t('cat.addPoint')}</option>
              {groups.map((g) => (
                <optgroup key={g} label={g || t('cat.noGroup')}>
                  {available.filter((x) => (x.category || '') === g).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </optgroup>
              ))}
            </select>
            <select className="select" style={{ flex: '0 1 200px', width: 'auto' }} value="" aria-label={t('cat.addGroup')}
              onChange={(e) => { if (e.target.value) addGroup(e.target.value === '-' ? '' : e.target.value) }}>
              <option value="">{t('cat.addGroup')}</option>
              {groups.map((g) => <option key={g} value={g || '-'}>{g || t('cat.noGroup')}</option>)}
            </select>
          </div>
        ))}
      </Section>

      <Section title={t('cat.settings')}>
        <Toggle checked={f.active} onChange={(v) => setF((x) => ({ ...x, active: v }))} disabled={dis} label={t('cat.activeLabel')} />
      </Section>
      {!isNew && <Section title={t('cat.hist.section')}><History entityType={'inspection_checklists'} entityId={list.id} data={data} /></Section>}
    </EditorPanel>
  )
}
