import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon'
import { useT } from '../lib/i18n'
import { initials } from '../lib/format'

export function Button({ children, variant, size, icon, type = 'button', loading, disabled, className = '', ...rest }) {
  const cls = ['btn', variant, size, className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : icon ? <Icon name={icon} size={15} stroke={2.3} /> : null}
      {children}
    </button>
  )
}

export function Card({ title, actions, children, id, className = '', style }) {
  return (
    <section className={`card ${className}`} id={id} style={style}>
      {(title || actions) && (
        <div className="row" style={{ marginBottom: 12 }}>
          {title && <h2 style={{ margin: 0 }}>{title}</h2>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function PageHead({ title, sub, actions }) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="spacer" />
      {actions}
    </div>
  )
}

const BADGE_COLORS = { green: 'b-green', amber: 'b-amber', red: 'b-red', blue: 'b-blue', gray: 'b-gray', purple: 'b-purple' }
export function Badge({ color = 'gray', children, title }) {
  return <span className={`badge ${BADGE_COLORS[color] || 'b-gray'}`} title={title}>{children}</span>
}

const AVATAR_COLORS = [['#1D4ED8', '#E6EEFE'], ['#146B40', '#E3F4EA'], ['#9A5B10', '#FDF0DE'], ['#6D28D9', '#F1EAFE'], ['#B42318', '#FDE8E7'], ['#4B5563', '#EEF0F2']]
export function Avatar({ name, size = 26 }) {
  const n = String(name || '?')
  let h = 0
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0
  const [fg, bg] = AVATAR_COLORS[h % AVATAR_COLORS.length]
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.max(9, size * 0.38) }}>
      {initials(n)}
    </span>
  )
}

export function Field({ label, children, hint, error, className = '', htmlFor }) {
  return (
    <div className={`field ${className}`}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && !error && <div className="hint" style={{ marginTop: 0 }}>{hint}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

export function Input({ label, hint, error, className = '', fieldClass = '', prefix, suffix, ...rest }) {
  const id = useId()
  const input = <input id={id} className={`input ${error ? 'invalid' : ''} ${className}`} {...rest} />
  return (
    <Field label={label} hint={hint} error={error} className={fieldClass} htmlFor={id}>
      {prefix || suffix ? (
        <div className="affix">
          {prefix && <span>{prefix}</span>}
          {input}
          {suffix && <span>{suffix}</span>}
        </div>
      ) : input}
    </Field>
  )
}

export function Select({ label, hint, error, options, fieldClass = '', className = '', ...rest }) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} className={fieldClass} htmlFor={id}>
      <select id={id} className={`select ${className}`} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
    </Field>
  )
}

export function Textarea({ label, hint, error, fieldClass = '', className = '', ...rest }) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} className={fieldClass} htmlFor={id}>
      <textarea id={id} className={`textarea ${className}`} {...rest} />
    </Field>
  )
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="track" />
      <span>{label}</span>
    </label>
  )
}

export function SubTabs({ tabs, active, onChange }) {
  return (
    <div className="subtabs">
      {tabs.map((t) => (
        <button key={t.value} className={`subtab ${active === t.value ? 'on' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ size = 22 }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function FullPageSpinner() {
  return (
    <div className="fullcenter">
      <Spinner size={28} />
    </div>
  )
}

export function Empty({ icon = 'info', title, children, action }) {
  return (
    <div className="empty">
      <div className="icon"><Icon name={icon} size={24} /></div>
      {title && <h2>{title}</h2>}
      {children && <div style={{ maxWidth: 460, margin: '0 auto', lineHeight: 1.55 }}>{children}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}

export function Notice({ kind = 'info', children, style }) {
  return <div className={`notice ${kind}`} style={style}>{children}</div>
}

// Open modals, newest last: Escape closes only the one on top (e.g. a confirm over a form).
const modalStack = []
export function Modal({ open, title, onClose, children, footer, wide }) {
  const { t } = useT()
  const me = useRef({})
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const token = me.current
    modalStack.push(token)
    const onKey = (e) => { if (e.key === 'Escape' && modalStack[modalStack.length - 1] === token) closeRef.current?.() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = modalStack.lastIndexOf(token)
      if (i >= 0) modalStack.splice(i, 1)
    }
  }, [open])
  if (!open) return null
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label={t('common.close')}><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

// Closes a popover when clicking outside it or pressing Escape.
export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false)
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref, toggle: () => setOpen((o) => !o) }
}

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback((text, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((ts) => [...ts, { id, text, kind }])
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === 'err' ? 6000 : 3000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind === 'err' ? 'err' : ''}`}>{x.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

// "Are you sure?" as a promise: const [confirm, confirmEl] = useConfirm(); if (await confirm({ title, text })) …
// Render {confirmEl} once in the component.
export function useConfirm() {
  const { t } = useT()
  const [ask, setAsk] = useState(null)
  // Resolves true (yes), false (no) or null (closed with X / Escape). A second question answers the first with false.
  const confirm = (opts) => new Promise((resolve) => setAsk((prev) => { prev?.resolve(false); return { ...opts, resolve } }))
  const done = (v) => { ask?.resolve(v); setAsk(null) }
  const el = (
    <Modal open={!!ask} title={ask?.title || ''} onClose={() => done(null)}
      footer={<><Button onClick={() => done(false)}>{ask?.no || t('common.cancel')}</Button>
        <Button variant={ask?.danger ? 'danger' : 'primary'} className={ask?.danger ? 'solid' : ''} onClick={() => done(true)}>{ask?.yes || t('common.confirm')}</Button></>}>
      <div style={{ lineHeight: 1.55 }}>{ask?.text}</div>
    </Modal>
  )
  return [confirm, el]
}
