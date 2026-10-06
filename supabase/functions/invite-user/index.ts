// Supabase Edge Function: invite-user (Axle v2)
//
// Creating a login needs the service-role key, which must never reach the
// browser, so the app calls this function instead. It:
//   1. checks the caller is signed in and has the `manage_users` permission
//      (checked here, server-side, with the caller's own token);
//   2. checks the role exists and the username is free (case-insensitive);
//   3. sends a Supabase invite email (creates the auth user; the database's
//      handle_new_user trigger creates a profile);
//   4. sets the profile's name, username, phone and role, and makes it active.
//      If that fails, the new login is removed again so nothing is left half-made.
//
// The invite link opens the app's "set your password" screen. Its address must be
// listed under Authentication → URL Configuration → Redirect URLs.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim().toLowerCase()
    const name = String(body.name ?? '').trim()
    const username = String(body.username ?? '').trim().toLowerCase()
    const phone = body.phone ? String(body.phone).trim() : null
    const roleId = String(body.roleId ?? '')
    const redirectTo = typeof body.redirectTo === 'string' ? body.redirectTo : undefined

    if (!email || !name || !username || !roleId) return json({ error: 'Name, email, username and role are required.' }, 400)
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'That email address does not look right.' }, 400)
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: 'Usernames are 3–30 characters: letters, numbers, dot, dash or underscore.' }, 400)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Not signed in.' }, 401)

    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Caller-scoped client: same access rules as the app.
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: who, error: whoErr } = await caller.auth.getUser()
    if (whoErr || !who?.user) return json({ error: 'Not signed in.' }, 401)
    const { data: allowed, error: permErr } = await caller.rpc('has_permission', { perm: 'manage_users' })
    if (permErr || !allowed) return json({ error: 'You do not have permission to invite people.' }, 403)

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

    const { data: role } = await admin.from('roles').select('id, name').eq('id', roleId).maybeSingle()
    if (!role) return json({ error: 'That role does not exist.' }, 400)

    const { data: taken } = await admin.from('profiles').select('id').ilike('username', username.replace(/[\\%_]/g, (c) => `\\${c}`)).limit(1)
    if (taken && taken.length) return json({ error: 'That username is already taken.' }, 409)

    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { name },
      redirectTo,
    })
    if (inviteErr || !invited?.user) {
      const msg = inviteErr?.message || 'The invite could not be sent.'
      return json({ error: /already been registered|already exists/i.test(msg) ? 'Someone with that email already has an account.' : msg }, 400)
    }
    const newId = invited.user.id

    // Keep role and username in app metadata too (only the server can set it).
    await admin.auth.admin.updateUserById(newId, { app_metadata: { role: role.name, username } })

    const { error: profErr } = await admin
      .from('profiles')
      .update({ name, username, phone, role_id: role.id, status: 'active' })
      .eq('id', newId)
    if (profErr) {
      await admin.auth.admin.deleteUser(newId)
      const reason = /username/i.test(profErr.message) ? 'That username is already taken.' : profErr.message
      return json({ error: `The invite was cancelled: ${reason}` }, 500)
    }

    return json({ ok: true, userId: newId })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
