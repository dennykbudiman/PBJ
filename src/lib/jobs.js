// Shared job (repair order) constants and small helpers.
import { zonedMidnightUtc } from './customers'

export const WORKFLOW = ['estimate', 'scheduled', 'arrived', 'in_progress', 'waiting_parts', 'completed', 'invoiced', 'paid']
// Statuses staff pick by hand; Invoiced and Paid are set by invoicing and payments.
export const WORKFLOW_MANUAL = ['estimate', 'scheduled', 'arrived', 'in_progress', 'waiting_parts', 'completed']
export const WORKFLOW_COLOR = { estimate: 'gray', scheduled: 'blue', arrived: 'blue', in_progress: 'purple', waiting_parts: 'amber', completed: 'green', invoiced: 'blue', paid: 'green' }
export const PRIORITIES = ['low', 'medium', 'high', 'urgent']
export const PRIORITY_COLOR = { low: 'gray', medium: 'gray', high: 'amber', urgent: 'red' }
export const APPROVALS = ['pending', 'approved', 'deferred', 'declined']
export const APPROVAL_COLOR = { pending: 'amber', approved: 'green', deferred: 'blue', declined: 'red' }
export const WORK_STATUS = ['todo', 'in_progress', 'completed']
export const WORK_COLOR = { todo: 'gray', in_progress: 'purple', completed: 'green' }
export const LINE_TYPES = ['labor', 'part', 'fee', 'sublet']
export const PAY_METHODS = ['transfer', 'cash', 'card', 'giro', 'other']
export const APPROVAL_METHODS = ['in_person', 'phone', 'whatsapp', 'email', 'internal']
export const PAYMENT_COLOR = { unpaid: 'amber', partial: 'blue', paid: 'green' }

// Where a job stands, in one word for lists: Estimate, Closed, Invoiced (unpaid/partial/overdue) or Paid.
export function jobState(j, today) {
  if (j.closed_at) return 'closed'
  if (j.order_status !== 'invoice') return 'estimate'
  if (j.payment_status === 'paid') return 'paid'
  if (j.due_date && j.due_date < today && Number(j.balance) > 0) return 'overdue'
  return j.payment_status === 'partial' ? 'partial' : 'unpaid'
}
export const STATE_COLOR = { estimate: 'gray', closed: 'gray', paid: 'green', overdue: 'red', partial: 'blue', unpaid: 'amber' }

// A shop-local date (YYYY-MM-DD) at midday, as a timestamp, so it never slips a day across time zones.
export function shopDateToTimestamp(dateStr, tz) {
  const midnight = new Date(zonedMidnightUtc(dateStr, tz))
  return new Date(midnight.getTime() + 12 * 3600 * 1000).toISOString()
}

// The shop-local date (YYYY-MM-DD) of a timestamp.
export function timestampToShopDate(ts, tz) {
  if (!ts) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts))
}

// Builds job lines from a catalog item: labor becomes hours × hourly rate, parts keep cost, price and core charge.
// Percent fees can't be a line (they depend on the whole job), so they are returned as a job fee instead.
export function linesFromCatalogItem(item, { qty, priceOverride } = {}) {
  if (!item) return { lines: [], jobFees: [] }
  if (item.item_type === 'fee' && item.fee_kind === 'percent') {
    return { lines: [], jobFees: [{ name: item.name, kind: 'percent', value: Number(item.fee_value) || 0, taxable: item.taxable }] }
  }
  const base = {
    item_type: item.item_type, catalog_item_id: item.id, name: item.name, description: item.description || null,
    taxable: !!item.taxable, show_qty_price: item.show_qty_price !== false, cost: Number(item.cost) || 0, core_charge: 0,
  }
  if (item.item_type === 'labor') {
    const hours = Number(item.labor_hours) || 0
    const total = priceOverride != null ? Number(priceOverride) : Number(item.price) || 0
    // Hours × hourly rate only when the price divides evenly; otherwise one line at the full price, so it never drifts.
    const rate = hours > 0 ? Math.round(total / hours) : total
    const useHours = hours > 0 && Math.abs(rate * hours - total) < 0.5
    const units = qty != null ? Number(qty) : 1          // how many times the labor item is sold
    const q = useHours ? Math.round(hours * units * 100) / 100 : units
    const unitCost = Number(item.cost) || 0
    return { lines: [{ ...base, qty: q, price: useHours ? rate : total, cost: useHours ? Math.round(unitCost / hours) : unitCost }], jobFees: [] }
  }
  if (item.item_type === 'fee') {
    const price = priceOverride != null ? Number(priceOverride) : Number(item.fee_value ?? item.price) || 0
    return { lines: [{ ...base, qty: qty != null ? Number(qty) : 1, price, cost: 0 }], jobFees: [] }
  }
  const price = priceOverride != null ? Number(priceOverride) : Number(item.price) || 0
  return {
    lines: [{ ...base, qty: qty != null ? Number(qty) : Number(item.default_qty) || 1, price, core_charge: item.has_core ? Number(item.core_cost) || 0 : 0 }],
    jobFees: [],
  }
}

// The fees set to be added automatically with a catalog item, as lines (fixed) or job fees (percent).
// Fixed fees take the quantity of the item they come with.
export function autoFeesFor(item, qty, data) {
  const links = data.itemFees.filter((f) => f.item_id === item.id)
  const out = { lines: [], jobFees: [] }
  for (const link of links) {
    const fee = data.itemById[link.fee_item_id]
    if (!fee || !fee.active) continue
    const r = linesFromCatalogItem(fee, { qty: fee.fee_kind === 'percent' ? undefined : qty })
    out.lines.push(...r.lines)
    out.jobFees.push(...r.jobFees)
  }
  return out
}

// Money each line brings in, as the database works it out (rounded like Postgres round()).
export const lineAmount = (l) => Math.round(Number(l.price) * Number(l.qty))
export function lineDiscount(l) {
  if (Number(l.discount_pct) > 0) return Math.round(Number(l.price) * Number(l.qty) * Number(l.discount_pct) / 100)
  return Number(l.discount_amount) || 0
}
export const lineNet = (l) => lineAmount(l) - lineDiscount(l)
