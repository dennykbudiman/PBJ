import React from 'react'
import { colors } from '../lib/theme'

// Shared header bar: title on the left, optional actions on the right.
// Matches the header markup repeated at the top of every prototype page.
export default function PageHeader({ title, children }) {
  return (
    <header
      style={{
        display: 'flex', alignItems: 'center', gap: 20, padding: '20px 32px',
        borderBottom: `1px solid ${colors.border}`, background: colors.white,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em', flexShrink: 0 }}>{title}</h1>
      <div style={{ flex: '1 1 auto' }} />
      {children}
    </header>
  )
}

export function PrimaryButton({ children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, background: colors.accent, color: colors.white,
        border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700,
        cursor: 'pointer', whiteSpace: 'nowrap', ...(props.style || {}),
      }}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, background: colors.white, color: colors.ink,
        border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700,
        cursor: 'pointer', whiteSpace: 'nowrap', ...(props.style || {}),
      }}
    >
      {children}
    </button>
  )
}
