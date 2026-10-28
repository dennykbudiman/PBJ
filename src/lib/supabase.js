import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(url && anonKey)

// Sign-in goes through the server function `login` (migration 129): it turns a username into an email without
// telling the browser, slows down guessing, and returns the session. Resolves to { error } or { session }.
export async function signInThroughServer(login, password) {
  let res
  try {
    res = await fetch(`${url}/functions/v1/login`, {
      method: 'POST',
      // New publishable keys (sb_publishable_…) go only in `apikey`; a legacy anon key (a JWT) also as the bearer token.
      headers: { 'Content-Type': 'application/json', apikey: anonKey, ...(anonKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${anonKey}` }) },
      body: JSON.stringify({ login, password }),
    })
  } catch (e) {
    return { error: { message: 'Failed to fetch' } }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.session) return { error: { code: body.error || 'server', message: body.error || `HTTP ${res.status}` } }
  return { session: body.session }
}

if (!supabaseConfigured) {
  console.warn('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.')
}

export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'missing-key')

// Money is kept back by the database (migration 129): these tables don't hand out their money columns, and are read
// through views that show each figure only to people allowed to see it (blank otherwise). Reads of these tables go to
// the views; inserts, updates and deletes still go to the tables.
export const READ_VIEWS = {
  catalog_items: 'catalog_items_read',
  ro_service_items: 'ro_service_items_read',
  purchase_order_items: 'purchase_order_items_read',
  supplier_payments: 'supplier_payments_read',
  returns: 'returns_read',
  cores: 'cores_read',
  repair_orders: 'repair_orders_read',
  ro_services: 'ro_services_read',
  ro_job_fees: 'ro_job_fees_read',
  ro_job_discounts: 'ro_job_discounts_read',
  activity_log: 'activity_log_read',
  // migration 130: the voided-invoice copy without cost prices, and the price list for people who handle money
  invoice_voids: 'invoice_voids_read',
  labor_rates: 'labor_rates_read',
  service_templates: 'service_templates_read',
  service_template_items: 'service_template_items_read',
  discounts: 'discounts_read',
  customers: 'customers_read',
  // migration 132: supplier bank account only for people who see costs or pay supplier bills
  suppliers: 'suppliers_read',
  // migration 133: the shop's own vehicle notes stay internal (Fleet managers read their vehicles without them)
  vehicles: 'vehicles_read',
}
const tableFrom = supabase.from.bind(supabase)
supabase.from = (table) => {
  const builder = tableFrom(table)
  const view = READ_VIEWS[table]
  if (view) builder.select = (...args) => tableFrom(view).select(...args)
  return builder
}

// Insert or update one row and get it back as the person may see it (writes can't return the hidden columns).
export async function writeRow(table, row, id = null) {
  const res = id
    ? await tableFrom(table).update(row).eq('id', id).select('id').single()
    : await tableFrom(table).insert(row).select('id').single()
  if (res.error) return res
  return supabase.from(table).select('*').eq('id', res.data.id).single()
}

// Turns a Supabase / Postgres error into a sentence a person can act on.
// Database rules raise plain-English messages (e.g. "This job is closed. Reopen it first."),
// so those are passed through; low-level codes get a friendlier wording.
export function errorText(error, t) {
  if (!error) return ''
  const msg = error.message || String(error)
  if (error.code === '42501' || /permission denied|row-level security/i.test(msg)) {
    return t ? t('err.permission') : 'You do not have permission to do this.'
  }
  if (error.code === '23505') return t ? t('err.duplicate') : 'That value is already in use.'
  if (error.code === '23503' && /update or delete/i.test(msg)) return t ? t('err.inUse') : 'This is still used elsewhere, so it can\'t be removed.'
  if (/Failed to fetch|NetworkError/i.test(msg)) return t ? t('err.network') : 'Cannot reach the server. Check your connection.'
  // Database rules are written in English; known ones have an Indonesian wording (key "db:<message>").
  if (t) {
    const exact = t(`db:${msg}`)
    if (exact !== `db:${msg}`) return exact
    for (const [re, key] of DB_PATTERNS) {
      const m = msg.match(re)
      if (m) { const tr = t(key, { n: m[1] }); if (tr !== key) return tr }
    }
    const prefix = DB_PREFIXES.find((x) => msg.startsWith(x))
    if (prefix) {
      const tr = t(`db:${prefix}`)
      if (tr !== `db:${prefix}`) return tr
    }
  }
  return msg
}

// Messages with a number or name in the middle; the captured part is passed on as {n}.
const DB_PATTERNS = [
  [/^Only ([\d.,]+) delivered on this line can still be returned$/, 'db:returnLeft'],
  [/^Numbers can only move forward \(current next number: (\d+)\)$/, 'db:numbersForward'],
  [/^Unknown time zone "(.+)"\. Use a name like/, 'db:unknownTz'],
  [/^Only ([\d.,]+) in stock; you can't send back more than you have$/, 'db:returnStock'],
  [/^This part is already on PO (.+)$/, 'db:alreadyOnPo'],
  [/^Only ([\d.,]+) of this line went onto the shelf, so only that much can be taken off$/, 'db:unreceiveLine'],
  [/^Only ([\d.,]+) can be taken off: paid or returned parts stay received$/, 'db:unreceivePaid'],
  [/^Only ([\d.,]+) on the shelf, so the received quantity can't go down by more$/, 'db:unreceiveShelf'],
]

// Messages that end with an amount or number; matched by their start.
const DB_PREFIXES = ['That is more than the balance due on this invoice', 'Payments received (Rp', 'This credit (Rp', 'Invoice number']

export const LOGO_BUCKET = 'shop-assets'

export function publicFileUrl(bucket, path) {
  if (!path) return null
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}
