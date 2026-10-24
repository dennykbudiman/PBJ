// Supabase Edge Function: login (Axle v2, migration 129)
//
// People sign in with a username (or their email) and a password. Turning a username into an email needs the
// server: if the browser could do it, anyone who knows a username could learn that person's email. This function:
//   1. slows down guessing: after 8 failed tries for one username/email, or 30 from one network address, within
//      15 minutes, it refuses for a while (login_allowed / login_note in the database, service role only);
//   2. looks up the email for a username (get_email_for_username, service role only);
//   3. signs in with Supabase Auth and hands the session back to the app, which keeps it as usual.
// Any wrong username, wrong email or wrong password gets the same answer, so the function doesn't reveal which
// usernames exist.
//
// Deploy with JWT verification off (the person isn't signed in yet):
//   supabase functions deploy login --no-verify-jwt
// Note: Supabase Auth limits sign-ins per network address, and every sign-in now comes from this function, so the
// limit applies to the whole shop. The default is plenty for a shop; it can be raised under Authentication → Rate Limits.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Used when a username doesn't exist, so the answer takes about as long as a real wrong password.
const NOBODY = 'no-such-user@axle.invalid'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const login = String(body.login ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    if (!login || !password || login.length > 254 || password.length > 200) return json({ error: 'bad_login' }, 401)

    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || null

    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const { data: allowed, error: limitErr } = await admin.rpc('login_allowed', { p_key: login, p_ip: ip })
    if (limitErr) return json({ error: 'server' }, 500)
    if (!allowed) return json({ error: 'too_many' }, 429)

    let email: string | null = login
    if (!login.includes('@')) {
      const { data, error } = await admin.rpc('get_email_for_username', { p_username: login })
      if (error) return json({ error: 'server' }, 500)
      email = typeof data === 'string' && data ? data : null
    }

    const auth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: signed, error: signErr } = await auth.auth.signInWithPassword({ email: email ?? NOBODY, password })
    const ok = Boolean(email && !signErr && signed?.session)

    await admin.rpc('login_note', { p_key: login, p_ip: ip, p_ok: ok })
    if (!ok) {
      // Supabase Auth's own limit (many sign-ins from this server in a short time) is passed on as "too many".
      if (signErr && (signErr.status === 429 || /rate limit/i.test(signErr.message))) return json({ error: 'too_many' }, 429)
      return json({ error: 'bad_login' }, 401)
    }
    const s = signed.session!
    return json({ session: { access_token: s.access_token, refresh_token: s.refresh_token } })
  } catch (_e) {
    return json({ error: 'server' }, 500)
  }
})
