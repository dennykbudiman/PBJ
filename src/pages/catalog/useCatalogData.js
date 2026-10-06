import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { selectAll } from '../customers/useCustomerData'

// Loads the whole catalog (items, categories, suppliers, rates, discounts, bundles,
// inspection items and checklists) in one go; catalogs are a few hundred rows.
export function useCatalogData() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const loads = useRef(0)

  const load = useCallback(async () => {
    const q = (table, order = 'name') => selectAll(() => supabase.from(table).select('*').order(order).order('id'))
    const [items, categories, suppliers, rates, discounts, templates, templateItems, insp, notes, checklists, checklistItems, itemFees, stock] = await Promise.all([
      q('catalog_items'), q('categories'), q('suppliers'), q('labor_rates'), q('discounts'),
      q('service_templates'), selectAll(() => supabase.from('service_template_items').select('*').order('position').order('id')),
      q('inspection_items'), selectAll(() => supabase.from('inspection_item_notes').select('*').order('id')),
      q('inspection_checklists'), selectAll(() => supabase.from('inspection_checklist_items').select('*').order('checklist_id').order('position').order('item_id')),
      selectAll(() => supabase.from('catalog_item_fees').select('*').order('item_id').order('fee_item_id')),
      selectAll(() => supabase.from('stock_levels').select('id, qty_on_hand, qty_on_estimates, qty_on_order').order('id')),
    ])
    const all = { items, categories, suppliers, rates, discounts, templates, templateItems, insp, notes, checklists, checklistItems, itemFees, stock }
    const firstError = Object.values(all).find((r) => r.error)?.error
    setError(firstError || null)
    const d = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.data ?? []]))
    d.version = ++loads.current
    d.itemById = Object.fromEntries(d.items.map((x) => [x.id, x]))
    d.categoryById = Object.fromEntries(d.categories.map((x) => [x.id, x]))
    d.supplierById = Object.fromEntries(d.suppliers.map((x) => [x.id, x]))
    d.rateById = Object.fromEntries(d.rates.map((x) => [x.id, x]))
    d.stockById = Object.fromEntries(d.stock.map((x) => [x.id, x]))
    setData(d)
  }, [])

  useEffect(() => { load() }, [load])
  return { data, error, reload: load }
}

// "Engine › Filters" for a category with a parent.
export function categoryPath(cat, byId) {
  if (!cat) return ''
  const names = [cat.name]
  let p = cat.parent_id ? byId[cat.parent_id] : null
  for (let i = 0; p && i < 5; i++) { names.unshift(p.name); p = p.parent_id ? byId[p.parent_id] : null }
  return names.join(' › ')
}
