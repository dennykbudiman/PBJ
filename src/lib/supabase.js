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
  if (/Failed to fetch|NetworkError/i.test(msg)) return t ? t('err.network') : 'Cannot reach the server. Check your connection.'
  return msg
}

export const LOGO_BUCKET = 'shop-assets'

export function publicFileUrl(bucket, path) {
  if (!path) return null
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl
}
