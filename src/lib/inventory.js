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
// Still to pay the supplier: delivered, minus parts sent back (migration 131), minus what was already paid.
export const owedQty = (l) => Math.max(n(l.qty_delivered) - n(l.qty_returned) - n(l.qty_paid), 0)
export const lineOwed = (l, po) => lineAmount(l.cost, l.core_cost, owedQty(l), l.taxable, po?.tax_rate)

// What a set of PO lines comes to with the PPN worked out once per PO (and supplier invoice), like the supplier's
// faktur (145, item 36), the same way as po_amounts() in the database: cost and core rounded per line, the PPN on the
// taxable total; each line takes its step of the rounded running total (lines in id order), so they add up exactly.
// rows: [{ l, po }]; kind: 'owed' | 'delivered' (less returns) | 'received' | 'paid' | 'wanted' (ordered − cancelled).
// Returns Map(line id → { qty, base, tax, amount }).
const qtyOf = (l, kind) => kind === 'owed' ? owedQty(l)
  : kind === 'delivered' ? Math.max(n(l.qty_delivered) - n(l.qty_returned), 0)
  : kind === 'received' ? n(l.qty_delivered)
  : kind === 'paid' ? n(l.qty_paid)
  : Math.max(n(l.qty_ordered) - n(l.qty_cancelled), 0)
export function poAmounts(rows, kind = 'owed') {
  const groups = new Map()
  for (const r of rows || []) {
    const po = r.po
    const k = `${po?.id || r.l.po_id}|${String(r.l.supplier_invoice_no || '').trim()}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const out = new Map()
  for (const list of groups.values()) {
    list.sort((a, b) => (a.l.id < b.l.id ? -1 : a.l.id > b.l.id ? 1 : 0))
    let cum = 0 // running PPN in 1/10 000 rupiah, so the sums stay exact
    for (const { l, po } of list) {
      const q = qtyOf(l, kind)
      const c = lineAmount(l.cost, 0, q, false, 0)
      const k = lineAmount(0, l.core_cost, q, false, 0)
      const ex = l.taxable ? c * Math.round(n(po?.tax_rate) * 100) : 0
      const tax = Math.round((cum + ex) / 10000) - Math.round(cum / 10000)
      cum += ex
      out.set(l.id, { qty: q, base: c + k, tax, amount: c + k + tax })
    }
  }
  return out
}
export const amountsTotal = (m) => [...m.values()].reduce((a, x) => a + x.amount, 0)

// "Waiting", "Part delivered", "Delivered" or "Cancelled" for one PO line.
export function lineState(l) {
  if (n(l.qty_cancelled) >= n(l.qty_ordered)) return 'cancelled'
  if (openQty(l) === 0) return 'delivered'
  if (n(l.qty_delivered) > 0) return 'partial'
  return 'waiting'
}
export const LINE_COLOR = { waiting: 'blue', partial: 'amber', delivered: 'green', cancelled: 'gray' }

// The PO's totals on what is still wanted (ordered minus cancelled), and what was delivered / paid.
// (145) the PPN once per PO and supplier invoice, as on the supplier's faktur
// item 42 (Denny, Nov 12): a driver's payback (talangan) is approved in person, so the app shows no Belum/Sudah diganti
// and no "Sudah diganti" button. The data and po_reimburse stay; set this to true to show them again.
export const SHOW_TALANGAN_PAYBACK = false

export function poTotals(po, lines) {
  const rows = (lines || []).map((l) => ({ l, po }))
  const want = poAmounts(rows, 'wanted')
  let parts = 0, core = 0, tax = 0
  for (const l of lines || []) {
    const q = Math.max(n(l.qty_ordered) - n(l.qty_cancelled), 0)
    parts += lineAmount(l.cost, 0, q, false, 0)
    core += lineAmount(0, l.core_cost, q, false, 0)
    tax += want.get(l.id)?.tax || 0
  }
  return { parts, core, tax, total: parts + core + tax, delivered: amountsTotal(poAmounts(rows, 'received')),
    paid: amountsTotal(poAmounts(rows, 'paid')), owed: amountsTotal(poAmounts(rows, 'owed')) }
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

// Parts delivered on a job's PO that the job doesn't use (Nov 4, Denny): the part line was removed, declined or
// deferred, or never added. A catalog part stays on the shelf (it goes onto the shelf when it arrives and only comes off
// when a job using it is invoiced); a typed-in part isn't counted in stock until it is added to the catalog.
// Matching is by catalog part, else by name; quantities are shared out in PO order. Returns Map(poLineId → spare qty).
// linkOf: PO line id → catalog part, for typed-in PO lines added to the catalog afterwards (migration 138).
export function sparePoParts(poLines, jobItems, services, returnedOf = () => 0, linkOf = {}) {
  const live = new Set((services || []).filter((s) => s.approval_status === 'approved' || s.approval_status === 'pending').map((s) => s.id))
  const key = (x) => {
    const c = x.catalog_item_id || linkOf[x.id]
    return c ? `c:${c}` : `n:${String(x.name || '').trim().toLowerCase()}`
  }
  const need = new Map()
  for (const i of jobItems || []) {
    if (i.item_type !== 'part' || !live.has(i.service_id)) continue
    need.set(key(i), (need.get(key(i)) || 0) + Number(i.qty || 0))
  }
  const out = new Map()
  for (const l of poLines || []) {
    if (l.line_type === 'sublet') continue // outside work never goes to stock (141)
    const got = Number(l.qty_delivered || 0) - Number(returnedOf(l) || 0)
    if (got <= 0) continue
    const n = need.get(key(l)) || 0
    const take = Math.min(n, got)
    need.set(key(l), n - take)
    if (got - take > 0) out.set(l.id, Math.round((got - take) * 100) / 100)
  }
  return out
}

// Lines on a job's POs that aren't on the job (141, Denny Nov 9): not linked to a job line and not fully cancelled.
// Each gets `match`: an unlinked job line of the same kind (part / sublet) and the same part (catalog part, else name)
// to link it to instead of adding a copy. Job lines are matched once, in PO order.
// pos: the job's POs (cancelled ones are skipped); linkOf: typed-in PO line → catalog part (138).
export function poLinesNotOnJob(pos, poLines, jobItems, services, linkOf = {}) {
  const openPo = new Set((pos || []).filter((p) => p.status !== 'cancelled').map((p) => p.id))
  const live = new Set((services || []).filter((s) => s.approval_status === 'approved' || s.approval_status === 'pending').map((s) => s.id))
  const key = (x, type) => {
    const c = x.catalog_item_id || linkOf[x.id]
    return `${type}|${c ? `c:${c}` : `n:${String(x.name || '').trim().toLowerCase()}`}`
  }
  const free = new Map()
  for (const i of jobItems || []) {
    if (!['part', 'sublet'].includes(i.item_type) || i.po_item_id || i.stock_deducted || !live.has(i.service_id)) continue
    const k = key(i, i.item_type)
    if (!free.has(k)) free.set(k, [])
    free.get(k).push(i)
  }
  const out = []
  for (const l of poLines || []) {
    if (!openPo.has(l.po_id) || l.ro_service_item_id) continue
    // a typed-in part added to the catalog after it arrived is stock now; it goes on the job as the catalog part
    if (!l.catalog_item_id && linkOf[l.id] && Number(l.qty_delivered) > 0) continue
    if (Number(l.qty_ordered) - Number(l.qty_cancelled) - Number(l.qty_returned || 0) <= 0) continue
    const list = free.get(key(l, l.line_type || 'part'))
    out.push({ line: l, match: list?.length ? list.shift() : null })
  }
  return out
}

// A PO the PT pays its supplier for directly (142): a job's PO of a company with "Part dibayar langsung", or a stock
// PO (e.g. an oil drum) that names the PT that paid it. It isn't one of the shop's supplier bills.
export const poPaidByPt = (po) => !!po && (!!po.paid_by_pt || !!po.paid_by_name)
// The paying PT's name: for a job's PO its company's "PT pembayar" (else its name); for a stock PO the name on it.
export function poPayer(po, data) {
  if (!po) return null
  if (po.paid_by_name) return po.paid_by_name
  if (!po.paid_by_pt) return null
  const job = po.ro_id ? data?.jobById?.[po.ro_id] : null
  const c = job ? data?.customerById?.[job.customer_id] : null
  return c ? (c.payer_name || c.display_name) : 'PT'
}

// the book a PO is billed to inside its PT (143): a job's PO → the book of the job's company; a stock PO → its own
export function poBook(po, data) {
  if (!po) return null
  if (!po.ro_id) return po.paid_by_name ? po.paid_by_book || null : null
  if (!po.paid_by_pt) return null
  const job = data?.jobById?.[po.ro_id]
  const c = job ? data?.customerById?.[job.customer_id] : null
  return c ? (c.book_name?.trim() || c.display_name) : null
}

// PPN while the shop is non-PKP (142): the shop can't claim the supplier's PPN back, so on the job a PO line's cost
// (before PPN) counts with the PO's PPN added; a job cost goes to the PO with it taken out. A PKP shop: the same number.
// Whole rupiah, rounded like the database (the rate in hundredths, so the sums are exact).
const r100 = (rate) => Math.round(n(rate) * 100)
export const isNonPkp = (settings) => settings?.pkp_status === 'non_pkp'
export function poToJobCost(cost, taxable, rate, nonPkp) {
  if (cost == null || cost === '') return cost
  if (!nonPkp || !taxable || !(n(rate) > 0)) return n(cost)
  return Math.round(Math.round(n(cost)) * (10000 + r100(rate)) / 10000)
}
export function jobToPoCost(cost, taxable, rate, nonPkp) {
  if (cost == null || cost === '') return cost
  if (!nonPkp || !taxable || !(n(rate) > 0)) return n(cost)
  return Math.round(Math.round(n(cost)) * 10000 / (10000 + r100(rate)))
}
// a new PO's PPN: the shop's rate, or 0 for a supplier that doesn't charge PPN
export const supplierTaxRate = (supplier, shopRate) => (supplier && supplier.charges_tax === false ? 0 : n(shopRate))
