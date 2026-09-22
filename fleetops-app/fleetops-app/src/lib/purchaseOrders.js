import { supabase } from './supabaseClient'

// Sequential, human-readable PO numbering — same max-based pattern as
// nextWoNumber()/nextInvoiceNumber() in WorkOrders.jsx. purchase_orders.po_number
// has a UNIQUE constraint in the database, and the old count()-based scheme
// (`PO-${1001 + count}`) would collide with it whenever a PO had been
// deleted (shrinking the count), causing the insert to fail silently. This
// version looks at the actual numbers in use, so gaps from deletions can't
// cause a collision.
export async function nextPoNumber() {
  const { data, error } = await supabase.from('purchase_orders').select('po_number')
  if (error) throw error
  let max = 1000
  for (const po of data ?? []) {
    const m = /^PO-(\d+)$/.exec(po.po_number || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `PO-${max + 1}`
}

// Creates a draft ("Not Ordered") purchase order for a single part. When
// called with a workOrderId, the PO is linked back to that work order
// (purchase_orders.work_order_id) so it shows up in that work order's
// "Parts Ordered" tab in addition to the general Parts page. Throws on
// failure instead of failing silently, so callers can alert the user.
export async function createReorderPO(part, { workOrderId = null, qty = null } = {}) {
  const qtyToOrder = qty != null ? qty : Math.max(part.reorder_point * 2 - part.qty_on_hand, part.reorder_point, 1)
  const poNumber = await nextPoNumber()
  const { data: newPo, error: poError } = await supabase
    .from('purchase_orders')
    .insert({ po_number: poNumber, supplier: part.supplier, status: 'notordered', work_order_id: workOrderId })
    .select()
    .single()
  if (poError) throw poError
  const { error: itemError } = await supabase.from('purchase_order_items').insert({
    purchase_order_id: newPo.id, part_id: part.id, qty_ordered: qtyToOrder, qty_received: 0, unit_cost: part.unit_cost,
  })
  if (itemError) throw itemError
  return { po: newPo, qty: qtyToOrder }
}
