import React, { useMemo, useState } from 'react'
import { Badge, Input, Select, useToast } from '../../components/ui'
import { EditorPanel, EmptyCard, ListShell, SearchBox, RowLink, deleteErrorText } from './common'
import { categoryPath } from './useCatalogData'
import { supabase, errorText } from '../../lib/supabase'
import { useT } from '../../lib/i18n'

export const APPLIES = ['part', 'labor', 'fee', 'any']
const APPLIES_COLOR = { part: 'blue', labor: 'purple', fee: 'amber', any: 'gray' }

// A category and everything below it (so a category can't be moved under its own child).
function descendants(id, categories) {
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const c of categories) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) { out.add(c.id); grew = true }
  }
  return out
}

export default function CategoriesTab({ data, id, canEdit, reload, go }) {
  const { t } = useT()
  const [q, setQ] = useState('')
  const [applies, setApplies] = useState('all')
  const base = '/catalog/categories'

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return data.categories
      .map((c) => ({ ...c, path: categoryPath(c, data.categoryById) }))
      .filter((c) => (applies === 'all' || c.applies_to === applies) && (!needle || c.path.toLowerCase().includes(needle)))
      .sort((a, b) => a.path.localeCompare(b.path))
  }, [data.categories, data.categoryById, q, applies])

  const isNew = id === 'new'
  const selected = isNew ? null : data.categoryById[id]
  const panel = id && (isNew || selected) ? (
    <CategoryEditor key={`${id}:${data.version}`} category={selected} data={data} canEdit={canEdit}
      onClose={() => go(base)}
      onSaved={async (row) => { await reload(); go(`${base}/${row.id}`) }}
      onDeleted={async () => { await reload(); go(base) }} />
  ) : id ? <EmptyCard icon="info" title={t('cat.notFound')} /> : null

  const empty = data.categories.length === 0
    ? <EmptyCard icon="folder" title={t('cat.empty.categories')} text={t('cat.emptyText.categories')} />
    : rows.length === 0 ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null

  return (
    <ListShell title={t('cat.tab.categories')} sub={t('cat.sub.categories')} addLabel={t('cat.add.categories')} onAdd={() => go(`${base}/new`)}
      canEdit={canEdit} panel={panel} empty={empty}
      filters={<>
        <SearchBox value={q} onChange={setQ} placeholder={t('cat.search.categories')} />
        <select className="select chipselect" value={applies} onChange={(e) => setApplies(e.target.value)} aria-label={t('cat.usedFor')}>
          <option value="all">{t('cat.usedForAll')}</option>
          {APPLIES.map((a) => <option key={a} value={a}>{t(`cat.applies.${a}`)}</option>)}
        </select>
      </>}>
      <div className="table">
        <table>
          <thead><tr><th>{t('cat.name')}</th><th>{t('cat.usedFor')}</th><th className="num">{t('cat.itemsCol')}</th><th className="num wide-only">{t('cat.subcategories')}</th></tr></thead>
          <tbody>
            {rows.map((c) => {
              const n = data.items.filter((x) => x.category_id === c.id).length
              const subs = data.categories.filter((x) => x.parent_id === c.id).length
              return (
                <tr key={c.id} className={`click ${c.id === id ? 'selected' : ''}`} onClick={() => go(`${base}/${c.id}`)}>
                  <td>
                    {c.parent_id && <span className="muted">{categoryPath(data.categoryById[c.parent_id], data.categoryById)} › </span>}
                    <RowLink to={`${base}/${c.id}`} go={go}>{c.name}</RowLink>
                  </td>
                  <td><Badge color={APPLIES_COLOR[c.applies_to]}>{t(`cat.applies.${c.applies_to}`)}</Badge></td>
                  <td className="num">{n}</td>
                  <td className="num wide-only">{subs || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">{t('cat.listHint.categories')}</div>
    </ListShell>
  )
}

function CategoryEditor({ category, data, canEdit, onClose, onSaved, onDeleted }) {
  const { t } = useT()
  const toast = useToast()
  const isNew = !category
  const [f, setF] = useState(() => ({ name: category?.name || '', parent_id: category?.parent_id || '', applies_to: category?.applies_to || 'part' }))
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const dis = !canEdit
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const blocked = category ? descendants(category.id, data.categories) : new Set()
  const parents = data.categories.filter((c) => !blocked.has(c.id))
    .map((c) => ({ value: c.id, label: categoryPath(c, data.categoryById) })).sort((a, b) => a.label.localeCompare(b.label))
  const itemCount = category ? data.items.filter((x) => x.category_id === category.id).length : 0
  const subCount = category ? data.categories.filter((x) => x.parent_id === category.id).length : 0
  // Items already filed here that a narrower "used for" would hide from their own list.
  const mismatched = category && f.applies_to !== 'any' ? data.items.filter((x) => x.category_id === category.id && x.item_type !== f.applies_to).length : 0

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    const dup = data.categories.find((c) => c.id !== category?.id && (c.parent_id || '') === f.parent_id && c.name.trim().toLowerCase() === f.name.trim().toLowerCase())
    if (dup) e.name = t('cat.dupName')
    if (mismatched) e.applies_to = t('cat.appliesMismatch', { n: mismatched })
    setErrors(e)
    if (Object.keys(e).length) return
    const row = { name: f.name.trim(), parent_id: f.parent_id || null, applies_to: f.applies_to }
    setBusy(true)
    setMsg(null)
    const res = isNew
      ? await supabase.from('categories').insert(row).select().single()
      : await supabase.from('categories').update(row).eq('id', category.id).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    toast(t('cat.saved', { name: res.data.name }))
    await onSaved(res.data)
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('categories').delete().eq('id', category.id)
    setBusy(false)
    if (error) return setMsg(deleteErrorText(error, t))
    toast(t('cat.deleted', { name: category.name }))
    onDeleted()
  }

  return (
    <EditorPanel title={isNew ? t('cat.new.category') : category.name}
      subtitle={!isNew ? [t('cat.itemsCount', { n: itemCount }), subCount ? t('cat.subsCount', { n: subCount }) : null].filter(Boolean).join(' · ') : null}
      canEdit={canEdit} busy={busy} error={msg} onSave={save} onClose={onClose} onDelete={remove} isNew={isNew}>
      <div className="grid2">
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={set('name')} error={errors.name} disabled={dis} autoFocus={isNew} placeholder={t('cat.categoryExample')} />
        <Select label={t('cat.parent')} value={f.parent_id} onChange={set('parent_id')} disabled={dis}
          options={[{ value: '', label: t('cat.topLevel') }, ...parents]} hint={t('cat.parentHint')} />
        <Select label={t('cat.usedFor')} value={f.applies_to} onChange={set('applies_to')} disabled={dis} error={errors.applies_to}
          options={APPLIES.map((a) => ({ value: a, label: t(`cat.applies.${a}`) }))} />
      </div>
      {!isNew && (itemCount > 0 || subCount > 0) && <div className="hint" style={{ marginTop: 12 }}>{t('cat.categoryInUse')}</div>}
    </EditorPanel>
  )
}
