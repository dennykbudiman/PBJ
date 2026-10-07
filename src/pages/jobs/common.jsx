import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useToast, usePopover } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { num, rp } from '../../lib/format'

// An input that saves when you leave it (or press Enter), only if the value changed.
export function BlurInput({ value, onCommit, disabled, className = 'input', multiline, rows = 2, ...rest }) {
  const [v, setV] = useState(value ?? '')
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setV(value ?? '') }, [value])
  const commit = () => {
    focused.current = false
    if (String(v) === String(value ?? '')) return
    const reset = () => setV(value ?? '')
    const r = onCommit(v, reset)
    // A save the database refused puts the saved value back.
    if (r && typeof r.then === 'function') r.then((ok) => { if (ok === false) reset() })
  }
  const props = {
    className, value: v, disabled,
    onFocus: () => { focused.current = true },
    onChange: (e) => setV(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === 'Enter' && !multiline) e.currentTarget.blur()
      if (e.key === 'Escape') { setV(value ?? ''); focused.current = false; setTimeout(() => e.target.blur(), 0) }
    },
    ...rest,
  }
  return multiline ? <textarea {...props} rows={rows} className={className === 'input' ? 'textarea' : className} /> : <input {...props} />
}

// Runs a database change, shows a toast on failure and reloads the job afterwards.
export function useRun(reload) {
  const { t } = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const pending = useRef(0)
  async function run(fn, okText) {
    pending.current += 1
    setBusy(true)
    try {
      const res = await fn()
      const list = Array.isArray(res) ? res : [res]
      const err = list.find((r) => r && r.error)?.error
      if (err) { toast(errorText(err, t), 'err'); return false }
      if (okText) toast(okText)
      return true
    } finally {
      await reload()
      pending.current -= 1
      if (pending.current === 0) setBusy(false)
    }
  }
  return { run, busy }
}

// A "…" menu. The list floats over the page (fixed position), so a table that scrolls sideways doesn't cut it off,
// opens upwards when there isn't room below, and closes when the page scrolls.
export function MoreMenu({ items, label, icon = 'more' }) {
  const pop = usePopover()
  const btn = useRef(null)
  const list = useRef(null)
  const [pos, setPos] = useState(null)
  const shown = items.filter(Boolean)
  useLayoutEffect(() => {
    if (!pop.open || !btn.current || !list.current) { setPos(null); return }
    const place = () => {
      const r = btn.current.getBoundingClientRect()
      const h = list.current.offsetHeight
      const w = list.current.offsetWidth
      const below = window.innerHeight - r.bottom
      const top = below < h + 8 && r.top > below ? Math.max(8, r.top - h - 4) : Math.min(r.bottom + 4, window.innerHeight - h - 8)
      const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)
      setPos({ top, left })
    }
    place()
    // Once the button actually moves (the page or table scrolls) or the window resizes, it closes, so it never floats
    // away from its button. Scroll events that arrive late from before it opened don't count: the button hasn't moved.
    const at = btn.current.getBoundingClientRect()
    const close = (e) => {
      if (list.current && e?.target instanceof Node && list.current.contains(e.target)) return
      const now = btn.current?.getBoundingClientRect()
      if (e?.type === 'scroll' && now && Math.abs(now.top - at.top) < 2 && Math.abs(now.left - at.left) < 2) return
      pop.setOpen(false)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close) }
  }, [pop.open]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown.length) return null
  return (
    <div style={{ position: 'relative' }} ref={pop.ref}>
      <button type="button" ref={btn} className="btn sm" onClick={pop.toggle} aria-label={label} aria-expanded={pop.open} title={label}>
        <Icon name={icon} size={15} />
      </button>
      {pop.open && (
        <div ref={list} className="popover floating" style={{ minWidth: 200, position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, right: 'auto', visibility: pos ? 'visible' : 'hidden' }}>
          {shown.map((it) => (
            <button key={it.label} type="button" className="menuitem" disabled={it.disabled} title={it.title}
              style={it.danger ? { color: 'var(--red)' } : undefined} onClick={() => { pop.setOpen(false); it.onClick() }}>
              {it.icon && <Icon name={it.icon} size={15} />}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Type to find a catalog item or bundle; arrow keys and Enter pick one.
let pickerSeq = 0
export function Picker({ options, onPick, placeholder, render, disabled, autoFocus }) {
  const [uid] = useState(() => `pick${++pickerSeq}`)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [i, setI] = useState(0)
  const ref = useRef(null)
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return options.slice(0, 8)
    return options.filter((o) => o.search.includes(needle)).slice(0, 8)
  }, [options, q])
  useEffect(() => {
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])
  const pick = (o) => { onPick(o); setQ(''); setOpen(false); setI(0) }
  return (
    <div className="picker" ref={ref}>
      <div className="searchbox" style={{ width: '100%' }}>
        <Icon name="search" size={14} color="var(--muted)" />
        <input value={q} disabled={disabled} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus}
          role="combobox" aria-expanded={open && list.length > 0} aria-controls={`${uid}-list`} aria-autocomplete="list"
          aria-activedescendant={open && list[i] ? `${uid}-${i}` : undefined}
          onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); setI(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, list.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
            if (e.key === 'Enter' && list[i]) { e.preventDefault(); pick(list[i]) }
            if (e.key === 'Escape') setOpen(false)
          }} />
      </div>
      {open && list.length > 0 && (
        <div className="picker-list" role="listbox" id={`${uid}-list`}>
          {list.map((o, k) => (
            <button key={o.key} id={`${uid}-${k}`} type="button" role="option" aria-selected={k === i} tabIndex={-1} className={`picker-item ${k === i ? 'on' : ''}`}
              onMouseEnter={() => setI(k)} onClick={() => pick(o)}>
              {render(o)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// One line of the totals card.
export function TotalRow({ label, value, strong, negative, muted, children }) {
  return (
    <div className={`trow ${strong ? 'strong' : ''} ${muted ? 'muted' : ''}`}>
      <span>{label}</span>
      {children}
      <span className="trow-val">{negative && Number(value) > 0 ? '-' : ''}{rp(value)}</span>
    </div>
  )
}

// "10%" → { pct: 10 }, "8.500" → { amount: 8500 }, "" → none. Anything else is invalid.
export function parseDiscount(text) {
  const s = String(text ?? '').trim()
  if (!s) return { pct: 0, amount: 0 }
  if (s.endsWith('%')) {
    const v = Number(s.slice(0, -1).trim().replace(',', '.'))
    if (Number.isNaN(v) || v < 0 || v > 100) return null
    return { pct: v, amount: 0 }
  }
  const clean = s.replace(/^rp\.?\s*/i, '').replace(/[\s.]/g, '')
  if (!/^\d+$/.test(clean)) return null
  return { pct: 0, amount: Number(clean) }
}
export function discountText(pct, amount) {
  if (Number(pct) > 0) return `${num(pct, 2)}%`
  if (Number(amount) > 0) return num(amount)
  return ''
}
