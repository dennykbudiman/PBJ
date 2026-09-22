import React from 'react'
import { colors } from '../lib/theme'

export function TabBar({ children, ariaLabel }) {
  return (
    <div role="tablist" aria-label={ariaLabel} style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${colors.border}` }}>
      {children}
    </div>
  )
}

export function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: '10px 2px', background: 'none', border: 'none',
        borderBottom: `2px solid ${active ? colors.accent : 'transparent'}`,
        color: active ? colors.accent : colors.mutedLight,
        font: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
