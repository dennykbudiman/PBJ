// Supabase Edge Function: invite-user (Axle v2)
//
// Creating a login needs the service-role key, which must never reach the
// browser, so the app calls this function instead. It:
//   1. checks the caller is signed in and has the `manage_users` permission
//      (checked here, server-side, with the caller's own token);
//   2. checks the role exists and the username is free (case-insensitive);
//   3. creates the login (the database's handle_new_user trigger creates a profile), one of two ways:
//      - method "email" (the default): sends a Supabase invite email. The invite link opens the app's "set your
//        password" screen, so its address must be listed under Authentication → URL Configuration → Redirect URLs;
//      - method "password" (migration 134), for people without email: nothing is sent. The Owner or Admin sets a
//        temporary password and tells the person; they sign in with their username and must choose their own
//        password first (mark_temp_password records it; the database clears it when the password changes). The login
//        gets a hidden placeholder address that can never receive mail: <username>.<random>@no-email.invalid, or the
//        domain in the AXLE_NO_EMAIL_DOMAIN secret. That domain must never be one that receives mail, or whoever
//        reads it could reset these logins' passwords;
//   4. sets the profile's name, username, phone and role, and makes it active.
//      If that fails, the new login is removed again so nothing is left half-made;
//   5. writes who created the login, and how, to the activity log.
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

// Supabase's wording for a taken or refused address, in the app's words.
function createError(msg: string): string {
  if (/already been registered|already exists/i.test(msg)) return 'Someone with that email already has an account.'
  if (/password/i.test(msg) && /weak|short|characters|pwned|leaked/i.test(msg)) return 'Supabase refused that temporary password: ' + msg
  return msg
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const method = body.method === 'password' ? 'password' : 'email'
    const password = typeof body.password === 'string' ? body.password : ''
    let email = method === 'email' ? String(body.email ?? '').trim().toLowerCase() : ''
    const name = String(body.name ?? '').trim()
    const username = String(body.username ?? '').trim().toLowerCase()
    const phone = body.phone ? String(body.phone).trim() : null
    const roleId = String(body.roleId ?? '')
    const redirectTo = typeof body.redirectTo === 'string' ? body.redirectTo : undefined

    if (!name || !username || !roleId || (method === 'email' && !email)) {
      return json({ error: method === 'email' ? 'Name, email, username and role are required.' : 'Name, username and role are required.' }, 400)
    }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'That email address does not look right.' }, 400)
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: 'Usernames are 3–30 characters: letters, numbers, dot, dash or underscore.' }, 400)
    if (method === 'password' && (password.length < 8 || password.length > 72)) {
      return json({ error: 'The temporary password must be 8 to 72 characters.' }, 400)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Not signed in.' }, 401)

    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = apiKey('public')
    const serviceKey = apiKey('secret')

    // Caller-scoped client: same access rules as the app.
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: who, error: whoErr } = await caller.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''))
    if (whoErr || !who?.user) return json({ error: 'Not signed in.' }, 401)
    const { data: allowed, error: permErr } = await caller.rpc('has_permission', { perm: 'manage_users' })
    if (permErr || !allowed) return json({ error: 'You do not have permission to invite people.' }, 403)

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

    const { data: role } = await admin.from('roles').select('id, name').eq('id', roleId).maybeSingle()
    if (!role) return json({ error: 'That role does not exist.' }, 400)
    if (role.name === 'Owner') {
      const { data: me } = await admin.from('profiles').select('roles(name)').eq('id', who.user.id).maybeSingle()
      const myRole = Array.isArray(me?.roles) ? me?.roles[0]?.name : (me?.roles as any)?.name
      if (myRole !== 'Owner') return json({ error: 'Only an Owner can make someone an Owner.' }, 403)
    }

    const { data: taken } = await admin.from('profiles').select('id').ilike('username', username.replace(/[\\%_]/g, (c) => `\\${c}`)).limit(1)
    if (taken && taken.length) return json({ error: 'That username is already taken.' }, 409)

    let newId: string
    if (method === 'email') {
      const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { name },
        redirectTo,
      })
      if (inviteErr || !invited?.user) return json({ error: createError(inviteErr?.message || 'The invite could not be sent.') }, 400)
      newId = invited.user.id
      // Keep role and username in app metadata too (only the server can set it).
      await admin.auth.admin.updateUserById(newId, { app_metadata: { role: role.name, username } })
    } else {
      const domain = (Deno.env.get('AXLE_NO_EMAIL_DOMAIN') || 'no-email.invalid').replace(/^@/, '')
      email = `${username}.${crypto.randomUUID().slice(0, 8)}@${domain}`
      const { data: made, error: makeErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
        app_metadata: { role: role.name, username, no_email: true },
      })
      if (makeErr || !made?.user) return json({ error: createError(makeErr?.message || 'The login could not be created.') }, 400)
      newId = made.user.id
    }

    const { error: profErr } = await admin
      .from('profiles')
      .update({ name, username, phone, role_id: role.id, status: 'active' })
      .eq('id', newId)
    if (profErr) {
      await admin.auth.admin.deleteUser(newId)
      const reason = /username/i.test(profErr.message) ? 'That username is already taken.' : profErr.message
      return json({ error: `The invite was cancelled: ${reason}` }, 500)
    }
    if (method === 'password') {
      const { error: markErr } = await admin.rpc('mark_temp_password', { p_user: newId, p_by: who.user.id })
      if (markErr) {
        await admin.auth.admin.deleteUser(newId)
        return json({ error: `The login was cancelled: ${markErr.message}` }, 500)
      }
    }
    await admin.from('activity_log').insert({
      entity_type: 'profile', entity_id: newId, user_id: who.user.id,
      action: method === 'password' ? 'login_created_temp_password' : 'invited',
      changes: { username, role: role.name },
    })

    return json({ ok: true, userId: newId })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
