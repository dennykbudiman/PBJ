// Inventory & purchase orders: statuses, colours and the money sums the database also uses.
import { addDays } from './calendar'

export const PO_STATUSES = ['draft', 'ordered', 'partially_delivered', 'delivered', 'cancelled']
export const PO_COLOR = { draft: 'gray', ordered: 'blue', partially_delivered: 'amber', delivered: 'green', cancelled: 'gray' }
export const PAY_COLOR = { unpaid: 'gray', partial: 'amber', paid: 'green' }
export const PAY_METHODS = ['transfer', 'cash', 'giro', 'card', 'other']

export const RETURN_STEPS = ['marked', 'shipped', 'delivered', 'refunded']
export const RETURN_COLOR = { marked: 'amber', shipped: 'blue', delivered: 'purple', refunded: 'green' }
export const CORE_STEPS = ['to_be_returned', 'marked', 'shipped', 'delivered', 'refunded']
export const CORE_COLOR = { to_be_returned: 'gray', marked: 'amber', shipped: 'blue', delivered: 'purple', refunded: 'green', damaged: 'red' }
export const RETRIEVAL_COLOR = { to_be_retrieved: 'amber', retrieved: 'green', damaged: 'red' }

const n = (v) => Number(v) || 0

// Same sum as po_line_amount() in the database: cost + core for the quantity, plus tax on the cost when taxable.
// Worked in whole hundredths so 15 × 4,1 rounds to 62 like Postgres does (floating point would give 61).
const q100 = (v) => Math.round(n(v) * 100)
export function lineAmount(cost, core, qty, taxable, rate) {
  const q = q100(qty)
  const c = Math.round(Math.round(n(cost)) * q / 100)
  const k = Math.round(Math.round(n(core)) * q / 100)
  const tax = taxable ? Math.round(Math.round(n(cost)) * q * q100(rate) / 1000000) : 0
  return c + k + tax
}

export const openQty = (l) => Math.max(n(l.qty_ordered) - n(l.qty_delivered) - n(l.qty_cancelled), 0)
export const owedQty = (l) => Math.max(n(l.qty_delivered) - n(l.qty_paid), 0)
export const lineOwed = (l, po) => lineAmount(l.cost, l.core_cost, owedQty(l), l.taxable, po?.tax_rate)

// "Waiting", "Part delivered", "Delivered" or "Cancelled" for one PO line.
export function lineState(l) {
  if (n(l.qty_cancelled) >= n(l.qty_ordered)) return 'cancelled'
  if (openQty(l) === 0) return 'delivered'
  if (n(l.qty_delivered) > 0) return 'partial'
  return 'waiting'
}
export const LINE_COLOR = { waiting: 'blue', partial: 'amber', delivered: 'green', cancelled: 'gray' }

// The PO's totals on what is still wanted (ordered minus cancelled), and what was delivered / paid.
export function poTotals(po, lines) {
  let parts = 0, core = 0, tax = 0, delivered = 0, paid = 0, owed = 0
  for (const l of lines) {
    const q = Math.max(n(l.qty_ordered) - n(l.qty_cancelled), 0)
    parts += lineAmount(l.cost, 0, q, false, 0)
    core += lineAmount(0, l.core_cost, q, false, 0)
    if (l.taxable) tax += lineAmount(l.cost, 0, q, true, po?.tax_rate) - lineAmount(l.cost, 0, q, false, 0)
    delivered += lineAmount(l.cost, l.core_cost, l.qty_delivered, l.taxable, po?.tax_rate)
    paid += lineAmount(l.cost, l.core_cost, l.qty_paid, l.taxable, po?.tax_rate)
    owed += lineOwed(l, po)
  }
  return { parts, core, tax, total: parts + core + tax, delivered, paid, owed }
}

// When a delivered line must be paid: the due date typed in, else invoice (or delivery) date + the PO's terms.
export function lineDue(l, po, supplier) {
  if (l.payment_due) return l.payment_due
  const from = l.invoice_date || l.delivered_at
  if (!from) return null
  const days = po?.payment_terms_days ?? supplier?.payment_terms_days ?? 0
  return addDays(from, Number(days) || 0)
}

// Stock picture for a tracked part: on hand minus what open estimates need is "available".
export function stockState(item, lvl) {
  const onHand = n(lvl?.qty_on_hand ?? item?.qty_on_hand)
  const onEst = n(lvl?.qty_on_estimates)
  const onOrder = n(lvl?.qty_on_order)
  const available = onHand - onEst
  const rp = item?.reorder_point == null ? null : n(item.reorder_point)
  const status = onHand <= 0 ? 'out' : rp != null && onHand <= rp ? 'low' : 'ok'
  // Needs ordering: what's free plus what's coming doesn't get above the reorder point (or estimates need more than is here).
  const needsOrder = (rp != null && available + onOrder <= rp) || available + onOrder < 0
  const suggest = needsOrder ? Math.max(Math.ceil((rp ?? 0) - available - onOrder) + 1, 1) : 1
  return { onHand, onEst, onOrder, available, reorder: rp, status, needsOrder, suggest }
}
export const STOCK_COLOR = { out: 'red', low: 'amber', ok: 'green' }

export const poNumber = (po) => po?.po_number || '—'
