import React, { useRef, useState } from 'react'
import { Button, Empty, Notice } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { errorText, supabase } from '../../lib/supabase'

export function SearchBox({ value, onChange, placeholder }) {
  const { t } = useT()
  return (
    <div className="searchbox">
      <Icon name="search" size={14} color="var(--muted)" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button className="btn ghost sm" onClick={() => onChange('')} aria-label={t('common.clear')} style={{ padding: 2 }}><Icon name="x" size={13} /></button>}
    </div>
  )
}

// A catalog list on the left and, when something is open, its editor on the right.
export function ListShell({ title, sub, addLabel, onAdd, canEdit, filters, panel, empty, children }) {
  return (
    <div className={`split catalog ${panel ? 'has-panel' : ''}`}>
      <div className="split-main">
        <div className="pagehead">
          <div>
            <h1>{title}</h1>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <div className="spacer" />
          {canEdit && onAdd && <Button variant="primary" icon="plus" onClick={onAdd}>{addLabel}</Button>}
        </div>
        {filters && <div className="filterbar">{filters}</div>}
        {empty || children}
      </div>
      {panel && <div className="split-side">{panel}</div>}
    </div>
  )
}

export function EmptyCard({ icon, title, text, action }) {
  return <div className="card"><Empty icon={icon} title={title} action={action}>{text}</Empty></div>
}

// The right-hand editor: title, form body and Save / Cancel / Delete.
// View-only users get the same panel without the buttons (fields are disabled by the caller).
export function EditorPanel({ title, subtitle, badges, canEdit, busy, error, onSave, onClose, onDelete, deleteLabel, children, isNew }) {
  const { t } = useT()
  const [confirm, setConfirm] = useState(false)
  // One save at a time, even for a fast double click before the button shows it is busy.
  const running = useRef(false)
  async function runSave() {
    if (running.current) return
    running.current = true
    try { await onSave() } finally { running.current = false }
  }
  return (
    <aside className="panel" aria-label={title}>
      <div className="panel-head">
        <button className="btn ghost sm panel-back" onClick={onClose} aria-label={t('common.close')}><Icon name="x" size={16} /></button>
        <div style={{ minWidth: 0 }}>
          <h2 className="panel-title">{title}</h2>
          {subtitle && <div className="muted small" style={{ marginTop: 2 }}>{subtitle}</div>}
          {badges && <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>{badges}</div>}
        </div>
      </div>
      <div className="panel-body editor">
        {error && <Notice kind="err" style={{ marginBottom: 12 }}>{error}</Notice>}
        {!canEdit && !isNew && <Notice kind="info" style={{ marginBottom: 12 }}>{t('cat.viewOnly')}</Notice>}
        {children}
      </div>
      {canEdit && (
        <div className="panel-foot">
          {onDelete && !isNew && (confirm
            ? <Button variant="danger" className="solid" size="sm" onClick={() => { setConfirm(false); onDelete() }} loading={busy}>{t('cat.confirmDelete')}</Button>
            : <button className="linkbtn small" style={{ color: 'var(--red)' }} onClick={() => setConfirm(true)}>{deleteLabel || t('common.delete')}</button>)}
          <div className="spacer" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={runSave} loading={busy}>{isNew ? t('cat.create') : t('common.save')}</Button>
        </div>
      )}
    </aside>
  )
}

export function Section({ title, children, right }) {
  return (
    <>
      <div className="row" style={{ marginTop: 14, marginBottom: 6 }}>
        <div className="sectionlabel" style={{ margin: 0 }}>{title}</div>
        <div className="spacer" />
        {right}
      </div>
      {children}
    </>
  )
}

// Turns a delete error into plain words: records still in use can't be deleted.
export function deleteErrorText(error, t) {
  if (error?.code === '23503') return t('cat.inUse')
  return errorText(error, t)
}

// Moves item i one place up (-1) or down (+1) in a list.
export function move(list, i, dir) {
  const j = i + dir
  if (j < 0 || j >= list.length) return list
  const next = list.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

// The record name in a list row: a real link so the row can be opened from the keyboard.
export function RowLink({ to, go, children }) {
  return <a href={to} className="rowlink" onClick={(e) => { e.preventDefault(); e.stopPropagation(); go(to) }}>{children}</a>
}

// Active / Inactive / All filter shared by every catalog list.
export function StatusSelect({ value, onChange }) {
  const { t } = useT()
  return (
    <select className="select chipselect" value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('cat.status')}>
      <option value="active">{t('cat.statusActive')}</option>
      <option value="inactive">{t('cat.statusInactive')}</option>
      <option value="all">{t('cat.statusAll')}</option>
    </select>
  )
}

// Keeps rows matching the status filter; the open record always stays visible.
export function statusMatch(row, status, openId) {
  if (status === 'active') return row.active || row.id === openId
  if (status === 'inactive') return !row.active
  return true
}

// Up / down / remove buttons for an ordered list row.
export function RowButtons({ i, n, onMove, onRemove, disabled, label }) {
  const { t } = useT()
  if (disabled) return null
  return (
    <span className="rowbtns">
      {onMove && <>
        <button type="button" className="btn ghost sm" disabled={i === 0} onClick={() => onMove(i, -1)} aria-label={t('cat.moveUp', { name: label })}><Icon name="chevronUp" size={14} /></button>
        <button type="button" className="btn ghost sm" disabled={i === n - 1} onClick={() => onMove(i, 1)} aria-label={t('cat.moveDown', { name: label })}><Icon name="chevronDown" size={14} /></button>
      </>}
      <button type="button" className="btn ghost sm" onClick={() => onRemove(i)} aria-label={t('cat.removeRow', { name: label })}><Icon name="x" size={14} /></button>
    </span>
  )
}

// Writes an ordered child list with as few changes as possible: updates rows that changed,
// inserts new ones and deletes the dropped ones. Returns the first error, if any.
export async function syncRows({ table, existing, rows, toRow, same, keyCols }) {
  const keyOf = (r) => keyCols.map((k) => r[k]).join('|')
  const before = new Map(existing.map((r) => [keyOf(r), r]))
  const next = rows.map((r, i) => toRow(r, i))
  const keep = new Set(next.filter((r) => before.has(keyOf(r))).map(keyOf))
  const drop = existing.filter((r) => !keep.has(keyOf(r)))
  for (const r of drop) {
    let q = supabase.from(table).delete()
    for (const k of keyCols) q = q.eq(k, r[k])
    const { error } = await q
    if (error) return error
  }
  for (const r of next) {
    const old = before.get(keyOf(r))
    if (old) {
      if (same(old, r)) continue
      const patch = Object.fromEntries(Object.entries(r).filter(([k]) => !keyCols.includes(k)))
      let q = supabase.from(table).update(patch)
      for (const k of keyCols) q = q.eq(k, old[k])
      const { error } = await q
      if (error) return error
    } else {
      const { error } = await supabase.from(table).insert(r)
      if (error) return error
    }
  }
  return null
}

// Turns "a, b ,c" into ['a','b','c'] (tags).
export function parseTags(text) {
  return [...new Set(String(text || '').split(',').map((x) => x.trim()).filter(Boolean))]
}
