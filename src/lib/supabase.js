import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(url && anonKey)

if (!supabaseConfigured) {
  console.warn('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.')
}

export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'missing-key')

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
    const prefix = DB_PREFIXES.find((x) => msg.startsWith(x))
    if (prefix) {
      const tr = t(`db:${prefix}`)
      if (tr !== `db:${prefix}`) return tr
    }
  }
  return msg
}

// Messages that end with an amount or number; matched by their start.
const DB_PREFIXES = ['That is more than the balance due on this invoice', 'Payments received (Rp', 'This credit (Rp', 'Invoice number']

export const LOGO_BUCKET = 'shop-assets'

export function publicFileUrl(bucket, path) {
  if (!path) return null
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}
