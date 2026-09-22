import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  // Fails loudly in dev rather than silently making requests to "undefined".
  // Copy .env.example to .env.local and fill in your Supabase project's
  // URL + anon key (Project Settings -> API in the Supabase dashboard).
  console.warn(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.'
  )
}

export const supabase = createClient(url, anonKey)
