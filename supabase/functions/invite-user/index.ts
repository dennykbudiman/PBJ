// Supabase Edge Function: invite-user
//
// Why this exists: creating a real login (a row in auth.users) requires the
// `service_role` key, which must never be shipped to the browser. This
// function runs on Supabase's servers, holds that key as a secret, and is
// the only place that key is ever used. The React app calls this function
// (via supabase.functions.invoke) instead of touching auth.users directly.
//
// What it does:
//   1. Checks the CALLER is signed in and has the `manage_users` permission
//      (re-checked here, server-side — never trust the client's own check).
//   2. Sends a real Supabase invite email via auth.admin.inviteUserByEmail,
//      which creates the auth.users row. That insert fires the existing
//      on_auth_user_created trigger, which auto-creates a `profiles` row
//      defaulted to the 'Viewer' role.
//   3. Updates that new profiles row with the name/phone/role actually
//      chosen in the invite form.
//
// Deploy with:
//   supabase functions deploy invite-user
// (see the project README for the one-time setup this needs).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, name, phone, roleId } = await req.json()
    if (!email || !roleId) {
      return json({ error: 'email and roleId are required' }, 400)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')

    // Client scoped to the CALLER's own JWT, purely to verify who they are
    // and that they're allowed to invite people. This client never uses
    // the service role key, so it's bound by the same RLS as the app.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await callerClient.auth.getUser()
    if (userErr || !userData?.user) {
      return json({ error: 'Not authenticated' }, 401)
    }

    const { data: allowed, error: permErr } = await callerClient.rpc('has_permission', {
      perm: 'manage_users',
    })
    if (permErr || !allowed) {
      return json({ error: 'You do not have permission to invite users' }, 403)
    }

    // Admin client, using the service role key — ONLY reachable here,
    // server-side, never in the browser bundle.
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { name: name || email },
    })
    if (inviteErr) {
      return json({ error: inviteErr.message }, 400)
    }

    const newUserId = invited.user.id

    // The on_auth_user_created trigger already inserted a default 'Viewer'
    // profile row for this id — update it with what the form actually chose.
    const { error: profileErr } = await adminClient
      .from('profiles')
      .update({ name: name || email, phone: phone || null, role_id: roleId, status: 'invited' })
      .eq('id', newUserId)

    if (profileErr) {
      return json({ error: `User invited, but profile update failed: ${profileErr.message}` }, 500)
    }

    return json({ ok: true, userId: newUserId })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
