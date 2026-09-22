import React from 'react'
import { colors } from '../lib/theme'

// Generic delete-confirmation modal, matching the pattern added to
// Drivers.dc.html in the prototype. Reused by every page with a delete action.
export default function ConfirmModal({ open, title, body, confirmLabel = 'Delete', onCancel, onConfirm }) {
  if (!open) return null
  return (
    <div
      role="presentation"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(28,30,34,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, background: colors.white, borderRadius: 12, padding: 24,
          boxShadow: '0 8px 30px rgba(20,20,20,0.18)',
        }}
      >
        <h2 id="confirm-modal-title" style={{ margin: '0 0 8px 0', fontSize: 16, fontWeight: 700 }}>
          {title}
        </h2>
        <p style={{ margin: '0 0 20px 0', fontSize: 13, color: colors.muted, lineHeight: 1.5 }}>{body}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ border: `1px solid ${colors.borderStrong}`, background: colors.white, color: colors.ink, borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ border: 'none', background: colors.danger, color: colors.white, borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
