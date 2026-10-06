// Supabase Edge Function: delete-user (Axle v2)
//
// Removes a person's login completely (their profile and personal notifications go with it).
// Rules, checked here with the service-role key because the app can't delete logins itself:
//   * the caller must have the `manage_users` permission;
//   * nobody can remove themselves;
//   * only an Owner can remove an Owner, and the last active Owner can't be removed;
//   * a person who has done anything in Axle (jobs, payments, stock, history…) can't be
//     removed, so records always show who did them. Disable them instead.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Every place that records a person. Any match means they have history.
const HISTORY: [string, string][] = [
  ['activity_log', 'user_id'],
  ['repair_orders', 'service_advisor_id'], ['repair_orders', 'created_by'], ['repair_orders', 'closed_by'],
  ['ro_services', 'technician_id'], ['ro_inspections', 'technician_id'],
  ['appointments', 'technician_id'], ['appointments', 'created_by'],
  ['approvals', 'recorded_by'], ['payments', 'recorded_by'], ['credit_memos', 'created_by'],
  ['invoice_voids', 'voided_by'], ['attachments', 'uploaded_by'],
  ['purchase_orders', 'created_by'], ['stock_movements', 'created_by'],
  ['supplier_payments', 'recorded_by'], ['vehicle_transfers', 'recorded_by'],
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const userId = String(body.userId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: 'Missing person.' }, 400)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Not signed in.' }, 401)

    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: who, error: whoErr } = await caller.auth.getUser()
    if (whoErr || !who?.user) return json({ error: 'Not signed in.' }, 401)
    const { data: allowed, error: permErr } = await caller.rpc('has_permission', { perm: 'manage_users' })
    if (permErr || !allowed) return json({ error: 'You do not have permission to remove people.' }, 403)
    if (who.user.id === userId) return json({ error: 'You can\'t remove your own account.' }, 400)

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

    const { data: people, error: pErr } = await admin.from('profiles').select('id, status, roles(name)').in('id', [who.user.id, userId])
    if (pErr) return json({ error: pErr.message }, 500)
    const me = people?.find((p) => p.id === who.user.id)
    const target = people?.find((p) => p.id === userId)
    const roleOf = (p: any) => (Array.isArray(p?.roles) ? p.roles[0]?.name : p?.roles?.name)

    if (target && roleOf(target) === 'Owner') {
      if (roleOf(me) !== 'Owner') return json({ error: 'Only an Owner can remove an Owner.' }, 403)
      if (target.status === 'active') {
        const { data: owners } = await admin.from('profiles').select('id, roles!inner(name)').eq('roles.name', 'Owner').eq('status', 'active')
        if ((owners ?? []).filter((o) => o.id !== userId).length === 0) {
          return json({ error: 'There must always be at least one active Owner.' }, 400)
        }
      }
    }

    for (const [table, column] of HISTORY) {
      const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).eq(column, userId)
      if (error) return json({ error: `Could not check ${table}: ${error.message}` }, 500)
      if ((count ?? 0) > 0) {
        return json({ error: 'This person has work recorded in Axle, so they can\'t be removed. Disable them instead; their name stays on past records.', code: 'has_history' }, 409)
      }
    }

    const { error: delErr } = await admin.auth.admin.deleteUser(userId)
    if (delErr) {
      return json({ error: /foreign key|violates|Database error/i.test(delErr.message)
        ? 'This person has work recorded in Axle, so they can\'t be removed. Disable them instead.'
        : delErr.message, code: 'delete_failed' }, 409)
    }
    return json({ ok: true })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
