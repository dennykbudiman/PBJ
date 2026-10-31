// Supabase Edge Function: reset-password (Axle v2, migration 134)
//
// An Owner or Admin sets a new temporary password for someone who forgot theirs, mainly staff without an email
// address (they can't use "Forgot your password?"). The person signs in with their username and the temporary
// password, and must choose their own password first. Rules, checked here with the service-role key because the
// app can't change other people's passwords:
//   * the caller must be signed in and have the `manage_users` permission;
//   * not for your own account (change it in My profile);
//   * only an Owner can reset an Owner's password, or a customer's Fleet manager's (an Admin who knew a fleet
//     manager's password could approve work in the customer's name; fleet managers have email and can use
//     "Forgot your password?" themselves);
//   * the temporary password is 8 to 72 characters.
// It also confirms the login (an invite that was never opened can then be used: the invite itself already trusted that
// address), records the temporary password (mark_temp_password; the database clears it when the password changes),
// clears that person's failed sign-in count so the "too many tries" pause doesn't block the new password, and writes
// who reset whose password to the activity log.
//
// The caller's sign-in token is checked here (auth.getUser), so the function works with the platform's JWT check on
// or off. Deploy with it off (--no-verify-jwt): the platform check doesn't understand Supabase's new API keys.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// API keys: Supabase's new keys (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS, JSON by name) when the project
// has them, else the legacy anon / service_role keys (still used by self-hosted setups; retired on Supabase's servers
// by the end of 2026).
function apiKey(kind: 'public' | 'secret'): string {
  const [list, legacy] = kind === 'public' ? ['SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'] : ['SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY']
  try {
    const keys = JSON.parse(Deno.env.get(list) || '{}')
    if (typeof keys.default === 'string' && keys.default) return keys.default
  } catch { /* not set or not JSON: use the legacy key */ }
  return Deno.env.get(legacy)!
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const userId = String(body.userId ?? '')
    const password = typeof body.password === 'string' ? body.password : ''
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: 'Missing person.' }, 400)
    if (password.length < 8 || password.length > 72) return json({ error: 'The temporary password must be 8 to 72 characters.' }, 400)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Not signed in.' }, 401)

    const url = Deno.env.get('SUPABASE_URL')!
    const caller = createClient(url, apiKey('public'), { global: { headers: { Authorization: authHeader } } })
    const { data: who, error: whoErr } = await caller.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''))
    if (whoErr || !who?.user) return json({ error: 'Not signed in.' }, 401)
    const { data: allowed, error: permErr } = await caller.rpc('has_permission', { perm: 'manage_users' })
    if (permErr || !allowed) return json({ error: 'You do not have permission to reset passwords.' }, 403)
    if (who.user.id === userId) return json({ error: 'Change your own password in My profile.' }, 400)

    const admin = createClient(url, apiKey('secret'), { auth: { persistSession: false } })
    const { data: people, error: pErr } = await admin.from('profiles').select('id, username, roles(name)').in('id', [who.user.id, userId])
    if (pErr) return json({ error: pErr.message }, 500)
    const roleOf = (p: any) => (Array.isArray(p?.roles) ? p.roles[0]?.name : p?.roles?.name)
    const me = people?.find((p) => p.id === who.user.id)
    const target = people?.find((p) => p.id === userId)
    if (!target) return json({ error: 'That person was not found.' }, 404)
    if (roleOf(target) === 'Owner' && roleOf(me) !== 'Owner') return json({ error: 'Only an Owner can reset an Owner\'s password.' }, 403)
    if (roleOf(target) === 'Fleet manager' && roleOf(me) !== 'Owner') {
      return json({ error: 'Only an Owner can reset a fleet manager\'s password. They can also use "Forgot your password?" with their email.' }, 403)
    }

    const { data: found, error: getErr } = await admin.auth.admin.getUserById(userId)
    if (getErr || !found?.user) return json({ error: getErr?.message || 'That login was not found.' }, 404)
    const { error: updErr } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true })
    if (updErr) return json({ error: /password/i.test(updErr.message) ? 'Supabase refused that temporary password: ' + updErr.message : updErr.message }, 400)

    const { error: markErr } = await admin.rpc('mark_temp_password', { p_user: userId, p_by: who.user.id })
    if (markErr) return json({ error: `The password was set, but couldn't be marked as temporary: ${markErr.message}` }, 500)
    await admin.from('activity_log').insert({ entity_type: 'profile', entity_id: userId, user_id: who.user.id, action: 'password_reset_temp', changes: { username: target.username } })

    // Clear the failed sign-in count for this person's username and email (best effort).
    const keys = [target.username, found.user.email].filter(Boolean).map((k) => String(k).toLowerCase())
    if (keys.length) await admin.from('login_attempts').delete().in('login_key', keys).eq('ok', false)

    return json({ ok: true })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
