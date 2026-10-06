import React, { useMemo, useState } from 'react'
import { Badge, Input, Toggle, useToast } from '../../components/ui'
import { EditorPanel, EmptyCard, ListShell, RowButtons, SearchBox, Section, StatusSelect, RowLink, deleteErrorText, statusMatch, syncRows } from './common'
import { supabase, errorText } from '../../lib/supabase'
import History from './History'
import { useT } from '../../lib/i18n'

export const FLAGS = ['green', 'yellow', 'red']
const FLAG_BADGE = { green: 'green', yellow: 'amber', red: 'red' }
const flagOf = (n) => FLAGS.find((c) => n[c]) || 'green'

// Inspection items are the points a technician checks (e.g. "Front brake pads"),
// each with canned notes tagged green (good), yellow (soon) or red (now).
export default function InspectionsTab({ data, id, canEdit, reload, go }) {
  const { t } = useT()
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('all')
  const [status, setStatus] = useState('active')
  const base = '/catalog/inspections'
  const groups = [...new Set(data.insp.map((x) => x.category).filter(Boolean))].sort((a, b) => a.localeCompare(b))

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return data.insp.filter((x) => statusMatch(x, status, id)
      && (group === 'all' || (x.category || '') === group)
      && (!needle || [x.name, x.category].filter(Boolean).join(' ').toLowerCase().includes(needle)))
  }, [data.insp, q, group, status, id])

  const isNew = id === 'new'
  const selected = isNew ? null : data.insp.find((x) => x.id === id)
  const panel = id && (isNew || selected) ? (
    <InspectionEditor key={`${id}:${data.version}`} item={selected} data={data} groups={groups} canEdit={canEdit}
      onClose={() => go(base)}
      onSaved={async (row) => { await reload(); go(`${base}/${row.id}`) }}
      onDeleted={async () => { await reload(); go(base) }} />
  ) : id ? <EmptyCard icon="info" title={t('cat.notFound')} /> : null

  const empty = data.insp.length === 0
    ? <EmptyCard icon="clipboard" title={t('cat.empty.inspections')} text={t('cat.emptyText.inspections')} />
    : rows.length === 0 ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null

  return (
    <ListShell title={t('cat.tab.inspections')} sub={t('cat.sub.inspections')} addLabel={t('cat.add.inspections')} onAdd={() => go(`${base}/new`)}
      canEdit={canEdit} panel={panel} empty={empty}
      filters={<>
        <SearchBox value={q} onChange={setQ} placeholder={t('cat.search.inspections')} />
        {groups.length > 0 && (
          <select className="select chipselect" value={group} onChange={(e) => setGroup(e.target.value)} aria-label={t('cat.group')}>
            <option value="all">{t('cat.groupAll')}</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <StatusSelect value={status} onChange={setStatus} />
      </>}>
      <div className="table">
        <table>
          <thead><tr><th>{t('cat.name')}</th><th>{t('cat.group')}</th><th>{t('cat.cannedNotes')}</th><th className="num wide-only">{t('cat.inChecklists')}</th></tr></thead>
          <tbody>
            {rows.map((x) => {
              const notes = data.notes.filter((n) => n.item_id === x.id)
              const lists = data.checklistItems.filter((c) => c.item_id === x.id).length
              return (
                <tr key={x.id} className={`click ${x.id === id ? 'selected' : ''}`} onClick={() => go(`${base}/${x.id}`)}>
                  <td><RowLink to={`${base}/${x.id}`} go={go}>{x.name}</RowLink>{!x.active && <> <Badge color="gray">{t('cat.inactive')}</Badge></>}</td>
                  <td>{x.category || <span className="muted">—</span>}</td>
                  <td>
                    {notes.length === 0 ? <span className="muted">—</span> : (
                      <span className="row wrap" style={{ gap: 4 }}>
                        {FLAGS.map((c) => {
                          const n = notes.filter((x2) => flagOf(x2) === c).length
                          return n ? <Badge key={c} color={FLAG_BADGE[c]}>{n} {t(`cat.flag.${c}`)}</Badge> : null
                        })}
                      </span>
                    )}
                  </td>
                  <td className="num wide-only">{lists || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">{t('cat.listHint.inspections')}</div>
    </ListShell>
  )
}

let rowKey = 0

function InspectionEditor({ item, data, groups, canEdit, onClose, onSaved, onDeleted }) {
  const { t } = useT()
  const toast = useToast()
  const isNew = !item
  const existing = useMemo(() => data.notes.filter((n) => n.item_id === item?.id)
    .sort((a, b) => FLAGS.indexOf(flagOf(a)) - FLAGS.indexOf(flagOf(b)) || a.note.localeCompare(b.note)), [data.notes, item?.id])
  const [f, setF] = useState(() => ({ name: item?.name || '', category: item?.category || '', active: item ? item.active : true }))
  const [notes, setNotes] = useState(() => existing.map((n) => ({ key: ++rowKey, id: n.id, note: n.note, flag: flagOf(n) })))
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const dis = !canEdit
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  const setNote = (i, patch) => setNotes((ns) => ns.map((n, j) => (j === i ? { ...n, ...patch } : n)))
  const usedIn = item ? data.checklistItems.filter((c) => c.item_id === item.id).map((c) => data.checklists.find((l) => l.id === c.checklist_id)?.name).filter(Boolean) : []

  // Copy the canned notes of another inspection point, skipping notes this one already has.
  const noteCount = data.notes.reduce((m, n) => ({ ...m, [n.item_id]: (m[n.item_id] || 0) + 1 }), {})
  const sources = data.insp.filter((x) => x.id !== item?.id && noteCount[x.id])
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
  const sourceGroups = [...new Set(sources.map((x) => x.category || ''))]
  function copyFrom(sourceId) {
    const src = data.insp.find((x) => x.id === sourceId)
    if (!src) return
    const have = new Set(notes.map((n) => n.note.trim().toLowerCase()).filter(Boolean))
    const add = data.notes.filter((n) => n.item_id === sourceId && !have.has(n.note.trim().toLowerCase()))
      .sort((a, b) => FLAGS.indexOf(flagOf(a)) - FLAGS.indexOf(flagOf(b)))
      .map((n) => ({ key: ++rowKey, note: n.note, flag: flagOf(n) }))
    // Empty rows are replaced by the copied notes rather than left in between.
    setNotes((ns) => [...ns.filter((n) => n.note.trim()), ...add])
    toast(add.length ? t('cat.copiedNotes', { n: add.length, name: src.name }) : t('cat.copiedNone', { name: src.name }))
    if (!f.category.trim() && src.category) setF((x) => ({ ...x, category: src.category }))
  }

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    const dup = data.insp.find((x) => x.id !== item?.id && x.name.trim().toLowerCase() === f.name.trim().toLowerCase())
    if (dup) e.name = t('cat.dupName')
    setErrors(e)
    if (Object.keys(e).length) return
    const keep = notes.filter((n) => n.note.trim())
    setBusy(true)
    setMsg(null)
    const row = { name: f.name.trim(), category: f.category.trim() || null, active: f.active }
    const res = isNew
      ? await supabase.from('inspection_items').insert(row).select().single()
      : await supabase.from('inspection_items').update(row).eq('id', item.id).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    const saved = res.data
    const error = await syncRows({
      table: 'inspection_item_notes', existing, rows: keep, keyCols: ['id'],
      toRow: (n) => ({ ...(n.id ? { id: n.id } : {}), item_id: saved.id, note: n.note.trim(), green: n.flag === 'green', yellow: n.flag === 'yellow', red: n.flag === 'red' }),
      same: (a, b) => a.note === b.note && a.green === b.green && a.yellow === b.yellow && a.red === b.red,
    })
    if (error) toast(t('cat.notesFailed', { error: errorText(error, t) }), 'err')
    else toast(t('cat.saved', { name: saved.name }))
    await onSaved(saved)
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('inspection_items').delete().eq('id', item.id)
    setBusy(false)
    if (error) return setMsg(deleteErrorText(error, t))
    toast(t('cat.deleted', { name: item.name }))
    onDeleted()
  }

  return (
    <EditorPanel title={isNew ? t('cat.new.inspection') : item.name} subtitle={!isNew ? item.category : null}
      badges={!isNew && !item.active ? <Badge color="gray">{t('cat.inactive')}</Badge> : null}
      canEdit={canEdit} busy={busy} error={msg} onSave={save} onClose={onClose} onDelete={remove} isNew={isNew}>
      <div className="grid2">
        <Input label={t('cat.name')} value={f.name} onChange={set('name')} error={errors.name} disabled={dis} autoFocus={isNew} placeholder={t('cat.inspExample')} />
        <Input label={t('cat.group')} value={f.category} onChange={set('category')} disabled={dis} list="insp-groups" placeholder={t('cat.groupExample')} hint={t('cat.groupHint')} />
        <datalist id="insp-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
      </div>

      <Section title={t('cat.cannedNotes')}>
        {notes.length === 0 && <div className="muted small">{t('cat.noNotes')}</div>}
        <div className="lines">
          {notes.map((n, i) => (
            <div key={n.key} className="line">
              <span className="flagpick" role="radiogroup" aria-label={t('cat.flagFor', { note: n.note || i + 1 })}>
                {FLAGS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={n.flag === c} disabled={dis} title={t(`cat.flag.${c}`)} aria-label={t(`cat.flag.${c}`)}
                    className={`flag ${c} ${n.flag === c ? 'on' : ''}`} onClick={() => setNote(i, { flag: c })} />
                ))}
              </span>
              <input className="input line-grow" value={n.note} disabled={dis} placeholder={t(`cat.notePlaceholder.${n.flag}`)} aria-label={t('cat.noteN', { n: i + 1 })}
                onChange={(e) => setNote(i, { note: e.target.value })} />
              <RowButtons i={i} n={notes.length} disabled={dis} label={n.note || String(i + 1)}
                onRemove={(j) => setNotes((ns) => ns.filter((_, k) => k !== j))} />
            </div>
          ))}
        </div>
        {canEdit && (
          <div className="row wrap mt" style={{ gap: 12 }}>
            <button type="button" className="linkbtn small" onClick={() => setNotes((ns) => [...ns, { key: ++rowKey, note: '', flag: 'green' }])}>+ {t('cat.addNote')}</button>
            {sources.length > 0 && (
              <select className="select" style={{ width: 'auto', flex: '1 1 200px', minHeight: 32, padding: '5px 30px 5px 10px' }} value="" aria-label={t('cat.copyNotes')}
                onChange={(e) => copyFrom(e.target.value)}>
                <option value="">{t('cat.copyNotes')}</option>
                {sourceGroups.map((g) => (
                  <optgroup key={g} label={g || t('cat.noGroup')}>
                    {sources.filter((x) => (x.category || '') === g).map((x) => <option key={x.id} value={x.id}>{x.name} ({noteCount[x.id]})</option>)}
                  </optgroup>
                ))}
              </select>
            )}
          </div>
        )}
        <div className="hint">{t('cat.notesHint2')}</div>
      </Section>

      {usedIn.length > 0 && (
        <Section title={t('cat.inChecklists')}>
          <div className="row wrap" style={{ gap: 6 }}>{usedIn.map((name) => <Badge key={name} color="blue">{name}</Badge>)}</div>
          {canEdit && <div className="hint">{t('cat.deleteRemoves')}</div>}
        </Section>
      )}

      <Section title={t('cat.settings')}>
        <Toggle checked={f.active} onChange={set('active')} disabled={dis} label={t('cat.activeLabel')} />
      </Section>
      {!isNew && <Section title={t('cat.hist.section')}><History entityType={'inspection_items'} entityId={item.id} data={data} /></Section>}
    </EditorPanel>
  )
}
