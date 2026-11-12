import React from 'react'
import { Link } from 'react-router-dom'
import { jobNo } from '../lib/format'

// Item 40 (Nov 12, migration 147): a job line that took (invoice) or will take (open job) a part left over on another
// job's PO: "Diambil dari sisa PO 100043-101 · job #100043 · INV-100043-1". Another book's leftover on an open job is
// shown as blocked (the invoice dialog says what to do). t: the page's translate; links only on screen.
export function leftoverUsesOf(leftover, lineId) {
  return (leftover?.uses || []).filter((u) => u.ro_item_id === lineId)
}

export default function LeftoverNote({ leftover, lineId, t, links = true }) {
  const uses = leftoverUsesOf(leftover, lineId)
  if (!uses.length) return null
  return uses.map((u, i) => {
    const vars = { po: u.po_number, job: `#${jobNo(u.src_job)}`, inv: u.src_invoice ? ` · ${u.src_invoice}` : '' }
    const text = leftover.planned
      ? (u.other_book ? t('u147.otherShort', { po: u.po_number, who: [u.payer, u.book].filter(Boolean).join(' · ') }) : t('u147.willTake', vars))
      : t('u147.fromLeftover', vars)
    return (
      <div key={i} className="small leftover-note" style={{ color: leftover.planned && u.other_book ? 'var(--red, #b42318)' : 'var(--amber-ink, #9A5B10)' }}>
        {links && u.po_id ? <Link className="plainlink" to={`/inventory/purchase-orders/${u.po_id}`}>{text}</Link> : text}
      </div>
    )
  })
}
