-- Axle v2 · 140 "Tanya Claude": a read-only helper that answers staff and fleet questions (Denny, Nov 6, 2026)
--
-- 1. Settings (Pengaturan → Tanya Claude, Owner/Admin): on/off, questions per person per day, monthly cost cap.
-- 2. Question log: every question, the answer, which model answered, the lookups it made, tokens and cost.
--    Owner/Admin see all of it; everyone sees their own. Nobody can write to it directly: a question is started by
--    tanya_start (which also enforces the limits) and finished only by the server function (service role).
-- 3. The lookups Claude may make (tc_*): fixed, read-only functions. They are STABLE (the database refuses any
--    write inside them) and SECURITY INVOKER (they run as the person asking, through the same *_read views and row
--    rules as the app), so Claude sees exactly what that person may see: a Fleet manager only their own companies,
--    no cost prices without view_costs, no money without view_reports. The server function calls them over GET,
--    which PostgREST runs in a read-only transaction.
--
-- Run once in the SQL Editor, after 139. Safe to re-run.

-- 1. Settings ---------------------------------------------------------------------------------------------------------
create table if not exists public.tanya_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  daily_limit int not null default 30 check (daily_limit between 0 and 500),
  monthly_cap_idr numeric not null default 300000 check (monthly_cap_idr between 0 and 100000000),
  idr_per_usd numeric not null default 16500 check (idr_per_usd between 1000 and 100000),
  -- auto: Haiku, Sonnet when needed · sonnet / opus: always that model
  model_mode text not null default 'auto' check (model_mode in ('auto', 'sonnet', 'opus')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.tanya_settings (id) values (true) on conflict (id) do nothing;
alter table public.tanya_settings enable row level security;
revoke all on public.tanya_settings from anon, authenticated;
grant select on public.tanya_settings to authenticated;
drop policy if exists "settings read tanya_settings" on public.tanya_settings;
create policy "settings read tanya_settings" on public.tanya_settings for select to authenticated
  using ((select has_permission('edit_settings')));

-- 2. Question log -----------------------------------------------------------------------------------------------------
create table if not exists public.tanya_log (
  id uuid primary key default gen_random_uuid(),
  -- kept when a login is removed, so the month's spend and the record stay
  user_id uuid references public.profiles(id) on delete set null,
  asked_at timestamptz not null default now(),
  page text check (char_length(page) <= 300),
  page_label text check (char_length(page_label) <= 200),
  question text not null check (char_length(question) between 1 and 2000),
  mode text not null default 'ask' check (mode in ('ask', 'compare')),
  answer text,
  model text,
  escalated text check (escalated in ('auto', 'staff')),
  escalation_reason text,
  tools jsonb,
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
  cost_usd numeric not null default 0,
  status text not null default 'asked' check (status in ('asked', 'answered', 'failed')),
  error text,
  rating smallint check (rating in (-1, 1)),
  retry_of uuid references public.tanya_log(id) on delete set null,
  finished_at timestamptz
);
create index if not exists tanya_log_user_day on public.tanya_log (user_id, asked_at);
create index if not exists tanya_log_asked on public.tanya_log (asked_at);
alter table public.tanya_log enable row level security;
revoke all on public.tanya_log from anon, authenticated;
grant select on public.tanya_log to authenticated;
drop policy if exists "read tanya_log" on public.tanya_log;
create policy "read tanya_log" on public.tanya_log for select to authenticated
  using (user_id = (select auth.uid()) or (select has_permission('edit_settings')));

-- Who may ask: any active login (staff within their hours, or a Fleet manager).
create or replace function public.tanya_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('enabled', coalesce((select enabled from tanya_settings), false) and (is_staff() or is_fleet()));
$$;
revoke execute on function public.tanya_status() from public, anon;
grant execute on function public.tanya_status() to authenticated;

-- Starts a question: checks the limits, logs it, and returns who is asking (for Claude's background).
create or replace function public.tanya_start(p_question text, p_page text default null, p_page_label text default null,
                                              p_retry_of uuid default null, p_mode text default 'ask') returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  s tanya_settings%rowtype; me profiles%rowtype; v_role text; v_today int; v_month_usd numeric; v_id uuid;
  v_q text := btrim(coalesce(p_question, '')); v_mode text := coalesce(p_mode, 'ask');
begin
  if auth.uid() is null or not (is_staff() or is_fleet()) then raise exception 'TANYA_NOT_ALLOWED'; end if;
  -- comparing models side by side (Owner/Admin, from the settings page) doesn't use up their daily questions
  if v_mode not in ('ask', 'compare') then raise exception 'TANYA_NOT_ALLOWED'; end if;
  if v_mode = 'compare' and not has_permission('edit_settings') then raise exception 'TANYA_NOT_ALLOWED'; end if;
  select * into s from tanya_settings;
  if not found or not s.enabled then raise exception 'TANYA_OFF'; end if;
  -- one question at a time per person, so parallel requests can't slip past the count
  perform pg_advisory_xact_lock(hashtextextended('tanya:' || auth.uid()::text, 0));
  -- "Tanya lebih teliti": the same question again, once, for one's own answered question (its text comes from the log)
  if p_retry_of is not null then
    if v_mode <> 'ask' then raise exception 'TANYA_NOT_ALLOWED'; end if;
    select question into v_q from tanya_log
     where id = p_retry_of and user_id = auth.uid() and mode = 'ask' and status = 'answered' and escalated is null
       and not exists (select 1 from tanya_log r where r.retry_of = p_retry_of);
    if not found then raise exception 'TANYA_NOT_ALLOWED'; end if;
  end if;
  if v_q = '' then raise exception 'TANYA_EMPTY'; end if;
  if char_length(v_q) > 2000 then raise exception 'TANYA_TOO_LONG'; end if;
  -- failed questions don't count, unless they already cost something
  select count(*) into v_today from tanya_log
   where user_id = auth.uid() and (status <> 'failed' or cost_usd > 0) and mode = 'ask' and asked_at >= shop_start(local_date());
  if v_mode = 'ask' and v_today >= s.daily_limit then raise exception 'TANYA_LIMIT_DAY'; end if;
  select coalesce(sum(cost_usd), 0) into v_month_usd from tanya_log
   where asked_at >= shop_start(date_trunc('month', local_date())::date);
  if v_month_usd * s.idr_per_usd >= s.monthly_cap_idr then raise exception 'TANYA_LIMIT_MONTH'; end if;

  -- an estimate is counted against the month while the answer is on its way (tanya_finish puts the real cost)
  insert into tanya_log (user_id, page, page_label, question, retry_of, mode, cost_usd)
  values (auth.uid(), left(p_page, 300), left(p_page_label, 200), v_q, p_retry_of, v_mode, 0.02)
  returning id into v_id;

  select * into me from profiles where id = auth.uid();
  select name into v_role from roles where id = me.role_id;
  return jsonb_build_object(
    'id', v_id, 'question', v_q, 'name', me.name, 'role', v_role, 'fleet', is_fleet(), 'language', me.language, 'model_mode', s.model_mode,
    'timezone', coalesce((select timezone from shop_settings limit 1), 'Asia/Jakarta'),
    'today', local_date(), 'now', to_char(now() at time zone shop_tz(), 'YYYY-MM-DD HH24:MI'),
    'shop', (select shop_name from shop_settings limit 1),
    'can', jsonb_build_object('money', has_permission('view_reports'), 'costs', has_permission('view_costs'),
                              'payments', has_permission('record_payments'), 'edit_jobs', has_permission('edit_jobs'),
                              'inventory', has_permission('manage_inventory'), 'settings', has_permission('edit_settings')),
    'companies', case when is_fleet() then
      (select coalesce(jsonb_agg(c.display_name order by c.display_name), '[]') from fleet_manager_companies f
         join customers c on c.id = f.customer_id where f.user_id = auth.uid()) end);
end $$;
revoke execute on function public.tanya_start(text, text, text, uuid, text) from public, anon;
grant execute on function public.tanya_start(text, text, text, uuid, text) to authenticated;

-- Finishes a question (server function only).
create or replace function public.tanya_finish(p_id uuid, p_status text, p_answer text, p_model text, p_escalated text,
                                               p_reason text, p_tools jsonb, p_in int, p_out int, p_cache_read int,
                                               p_cache_write int, p_cost numeric, p_error text) returns void
language sql volatile security definer set search_path = public as $$
  update tanya_log set status = p_status, answer = left(p_answer, 20000), model = p_model, escalated = p_escalated,
         escalation_reason = left(p_reason, 300), tools = p_tools, input_tokens = p_in, output_tokens = p_out,
         cache_read_tokens = p_cache_read, cache_write_tokens = p_cache_write, cost_usd = greatest(coalesce(p_cost, 0), 0),
         error = left(p_error, 1000), finished_at = now()
   where id = p_id and status = 'asked';
$$;
revoke execute on function public.tanya_finish(uuid, text, text, text, text, text, jsonb, int, int, int, int, numeric, text) from public, anon, authenticated;
grant execute on function public.tanya_finish(uuid, text, text, text, text, text, jsonb, int, int, int, int, numeric, text) to service_role;

-- 👍 / 👎 on one's own answer.
create or replace function public.tanya_rate(p_id uuid, p_rating int) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_rating is not null and p_rating not in (-1, 1) then raise exception 'Invalid rating'; end if;
  update tanya_log set rating = p_rating where id = p_id and user_id = auth.uid() and status = 'answered';
  if not found then raise exception 'Answer not found'; end if;
end $$;
revoke execute on function public.tanya_rate(uuid, int) from public, anon;
grant execute on function public.tanya_rate(uuid, int) to authenticated;

-- Settings (Owner/Admin).
create or replace function public.tanya_save_settings(p_enabled boolean, p_daily_limit int, p_monthly_cap_idr numeric,
                                                      p_idr_per_usd numeric, p_model_mode text) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not has_permission('edit_settings') then raise exception 'Only the Owner or Admin can change Tanya Claude settings'; end if;
  if p_daily_limit is null or p_daily_limit < 0 or p_daily_limit > 500 then raise exception 'Questions per day must be 0 to 500'; end if;
  if p_monthly_cap_idr is null or p_monthly_cap_idr < 0 or p_monthly_cap_idr > 100000000 then raise exception 'The monthly cap must be 0 to 100.000.000'; end if;
  if p_idr_per_usd is null or p_idr_per_usd < 1000 or p_idr_per_usd > 100000 then raise exception 'The dollar rate must be 1.000 to 100.000'; end if;
  if coalesce(p_model_mode, '') not in ('auto', 'sonnet', 'opus') then raise exception 'Unknown model choice'; end if;
  update tanya_settings set enabled = coalesce(p_enabled, enabled), daily_limit = p_daily_limit, monthly_cap_idr = p_monthly_cap_idr,
         idr_per_usd = p_idr_per_usd, model_mode = p_model_mode, updated_at = now(), updated_by = auth.uid();
end $$;
revoke execute on function public.tanya_save_settings(boolean, int, numeric, numeric, text) from public, anon;
grant execute on function public.tanya_save_settings(boolean, int, numeric, numeric, text) to authenticated;

-- The settings page: this month's use and the question log (Owner/Admin).
create or replace function public.tanya_overview(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s tanya_settings%rowtype; m0 date := date_trunc('month', coalesce(p_month, local_date()))::date;
  t0 timestamptz; t1 timestamptz;
begin
  if not has_permission('edit_settings') then raise exception 'Not allowed'; end if;
  select * into s from tanya_settings;
  t0 := shop_start(m0); t1 := shop_start((m0 + interval '1 month')::date);
  return jsonb_build_object(
    'settings', jsonb_build_object('enabled', s.enabled, 'daily_limit', s.daily_limit, 'monthly_cap_idr', s.monthly_cap_idr,
                                   'idr_per_usd', s.idr_per_usd, 'model_mode', s.model_mode, 'updated_at', s.updated_at),
    'month', m0,
    'questions', (select count(*) from tanya_log where asked_at >= t0 and asked_at < t1 and status <> 'failed' and mode = 'ask'),
    'compare_runs', (select count(*) from tanya_log where asked_at >= t0 and asked_at < t1 and mode = 'compare'),
    'failed', (select count(*) from tanya_log where asked_at >= t0 and asked_at < t1 and status = 'failed'),
    'cost_usd', (select coalesce(sum(cost_usd), 0) from tanya_log where asked_at >= t0 and asked_at < t1),
    'sonnet_auto', (select count(*) from tanya_log where asked_at >= t0 and asked_at < t1 and escalated = 'auto'),
    'sonnet_staff', (select count(*) from tanya_log where asked_at >= t0 and asked_at < t1 and escalated = 'staff'),
    'thumbs_down', (select count(*) from tanya_log where asked_at >= t0 and asked_at < t1 and rating = -1),
    'by_person', (select coalesce(jsonb_agg(x order by x.n desc, x.name), '[]') from (
                    select p.name, r.name as role, count(*) as n,
                           (select string_agg(c.display_name, ', ' order by c.display_name) from fleet_manager_companies f
                              join customers c on c.id = f.customer_id where f.user_id = p.id and r.name = 'Fleet manager') as companies
                      from tanya_log l join profiles p on p.id = l.user_id left join roles r on r.id = p.role_id
                     where l.asked_at >= t0 and l.asked_at < t1 and l.status <> 'failed' and l.mode = 'ask'
                     group by p.id, p.name, r.name) x),
    'log', (select coalesce(jsonb_agg(x order by x.asked_at desc), '[]') from (
              select l.id, l.asked_at, p.name, r.name as role,
                     (select string_agg(c.display_name, ', ' order by c.display_name) from fleet_manager_companies f
                        join customers c on c.id = f.customer_id where f.user_id = p.id and r.name = 'Fleet manager') as companies,
                     l.page, l.page_label, left(l.question, 300) as question, l.mode, l.model, l.escalated, l.escalation_reason, l.status,
                     l.rating, l.cost_usd
                from tanya_log l left join profiles p on p.id = l.user_id left join roles r on r.id = p.role_id
               where l.asked_at >= t0 and l.asked_at < t1
               order by l.asked_at desc limit 300) x));
end $$;
revoke execute on function public.tanya_overview(date) from public, anon;
grant execute on function public.tanya_overview(date) to authenticated;

-- 3. The lookups (read-only, run as the person asking) ----------------------------------------------------------------
create or replace function public.tc_norm(p text) returns text
language sql immutable set search_path = public as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- A moment as shop time ("2026-11-06 14:32"), so Claude never has to convert time zones.
create or replace function public.tc_t(p timestamptz) returns text
language sql stable security invoker set search_path = public as $$
  select to_char(p at time zone coalesce((select timezone from shop_settings limit 1), 'Asia/Jakarta'), 'YYYY-MM-DD HH24:MI')
$$;
-- Same for the timestamps inside a result from jobs_waiting / stock_card / day_summary (keys ending in _at, "at", "appt").
create or replace function public.tc_local(j jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare k text; v jsonb; out jsonb;
begin
  if j is null then return null; end if;
  if jsonb_typeof(j) = 'array' then
    select coalesce(jsonb_agg(tc_local(e) order by o), '[]') into out from jsonb_array_elements(j) with ordinality x(e, o);
    return out;
  elsif jsonb_typeof(j) <> 'object' then return j;
  end if;
  out := '{}';
  for k, v in select * from jsonb_each(j) loop
    if jsonb_typeof(v) = 'string' and (k ~ '(_at|^at|^appt)$') and (v #>> '{}') ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d' then
      out := out || jsonb_build_object(k, tc_t((v #>> '{}')::timestamptz));
    else
      out := out || jsonb_build_object(k, tc_local(v));
    end if;
  end loop;
  return out;
end $$;

-- A job from "#100005", "100005", "INV-000021", or its id. Only jobs the person may see.
create or replace function public.tc_job_id(p_ref text) returns uuid
language plpgsql stable security invoker set search_path = public as $$
declare v text := btrim(coalesce(p_ref, '')); d text; r uuid;
begin
  if v ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then
    select id into r from repair_orders_read where id = v::uuid; return r;
  end if;
  d := regexp_replace(v, '\D', '', 'g');
  if d = '' or length(d) > 15 then return null; end if;
  if v ~* 'inv' then
    select id into r from repair_orders_read where invoice_number = d::bigint limit 1; return r;
  end if;
  select id into r from repair_orders_read where job_number = d::bigint limit 1;
  if r is null then select id into r from repair_orders_read where invoice_number = d::bigint limit 1; end if;
  return r;
end $$;

-- Search everything by a word, plate, job/invoice/PO number or part number.
create or replace function public.tc_search(p_q text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare q text := btrim(coalesce(p_q, '')); n text := tc_norm(p_q); lk text;
begin
  if char_length(q) < 2 then return jsonb_build_object('error', 'Type at least 2 characters'); end if;
  lk := '%' || replace(replace(q, '%', ''), '_', '') || '%';
  return jsonb_strip_nulls(jsonb_build_object(
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'job_number', r.job_number, 'invoice', r.invoice_no,
                                                         'workflow', r.workflow_status, 'plate', v.plate, 'company', c.display_name,
                                                         'created', left(tc_t(r.created_at), 10)) order by r.created_at desc), '[]')
               from (select * from repair_orders_read r
                      where (n <> '' and (r.job_no = n or tc_norm(r.invoice_no) = n or r.job_number::text = n
                                          or (n ~ '^INV\d{1,15}$' and r.invoice_number = regexp_replace(n, '\D', '', 'g')::bigint)))
                         or r.vehicle_id in (select id from vehicles_read where n <> '' and tc_norm(plate) like '%' || n || '%')
                         or r.driver_name ilike lk
                      order by r.created_at desc limit 8) r
               left join vehicles_read v on v.id = r.vehicle_id left join customers_read c on c.id = r.customer_id),
    'vehicles', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'plate', v.plate, 'vehicle', concat_ws(' ', v.year, v.make, v.model),
                                                             'company', c.display_name, 'driver', v.driver_name)), '[]')
                   from (select * from vehicles_read v
                          where (n <> '' and tc_norm(v.plate) like '%' || n || '%') or concat_ws(' ', v.make, v.model) ilike lk
                             or v.driver_name ilike lk or v.vin ilike lk
                          order by v.plate limit 8) v left join customers_read c on c.id = v.customer_id),
    'companies', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name, 'legal_name', c.legal_name)), '[]')
                    from (select * from customers_read where display_name ilike lk or legal_name ilike lk order by display_name limit 8) c),
    'parts', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'type', i.item_type, 'name', i.name, 'code', i.code, 'brand', i.brand,
                                                          'on_shelf', case when i.item_type = 'part' and i.track_inventory then i.qty_on_hand end,
                                                          'unit', i.unit, 'active', i.active)), '[]')
                from (select * from catalog_items_read i
                       where i.name ilike lk or i.brand ilike lk or (n <> '' and (tc_norm(i.code) like '%' || n || '%' or tc_norm(i.alt_numbers) like '%' || n || '%'))
                       order by i.active desc, i.name limit 10) i),
    'purchase_orders', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'po_number', p.po_number, 'supplier', s.name, 'status', p.status)), '[]')
                          from (select * from purchase_orders p where n <> '' and tc_norm(p.po_number) like '%' || n || '%'
                                 order by p.created_at desc limit 8) p left join suppliers_read s on s.id = p.supplier_id),
    'suppliers', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone)), '[]')
                    from (select * from suppliers_read where name ilike lk order by name limit 5) s)));
end $$;

-- One job: everything the job page shows (as far as this person may see it).
create or replace function public.tc_job(p_ref text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_id uuid := tc_job_id(p_ref); r repair_orders_read%rowtype; w_kind text; w_info jsonb;
begin
  if v_id is null then return jsonb_build_object('error', 'Job not found (or not visible to this login)'); end if;
  select * into r from repair_orders_read where id = v_id;
  if is_staff() then select kind, info into w_kind, w_info from jobs_waiting(array[v_id]); end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'id', r.id, 'job_number', r.job_number, 'invoice', r.invoice_no, 'order_status', r.order_status,
    'workflow', r.workflow_status, 'priority', r.priority, 'tags', r.tags,
    'created', tc_t(r.created_at), 'invoiced_at', tc_t(r.invoiced_at), 'due_date', r.due_date,
    'closed', case when r.closed_at is not null then jsonb_build_object('at', tc_t(r.closed_at), 'reason', r.close_reason) end,
    'archived_at', tc_t(r.archived_at), 'km_in', r.odometer_in, 'km_out', r.odometer_out,
    'driver', nullif(concat_ws(' · ', r.driver_name, r.driver_phone), ''),
    'advisor', (select name from profiles where id = r.service_advisor_id),
    'shop_notes', r.shop_notes, 'recommendations', r.recommendations,
    'money', case when r.total is not null then jsonb_build_object('parts', r.parts_total, 'labor', r.labor_total, 'subtotal', r.subtotal,
                  'discounts', coalesce(r.item_discount_total, 0) + coalesce(r.service_discount_total, 0) + coalesce(r.job_discount_total, 0),
                  'fees', r.job_fees_total, 'tax', r.tax_total, 'total', r.total, 'paid', r.paid_total, 'balance', r.balance,
                  'payment_status', r.payment_status) end,
    'waiting_for', case when w_kind is not null then jsonb_build_object('kind', w_kind, 'info', tc_local(w_info)) end,
    'vehicle', (select jsonb_build_object('id', v.id, 'plate', v.plate, 'vehicle', concat_ws(' ', v.year, v.make, v.model), 'km_now', v.mileage_km)
                  from vehicles_read v where v.id = r.vehicle_id),
    'company', (select jsonb_build_object('id', c.id, 'name', c.display_name) from customers_read c where c.id = r.customer_id),
    'complaints', (select jsonb_agg(text order by position) from ro_concerns where ro_id = v_id),
    'services', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'name', s.name, 'approval', s.approval_status, 'work', s.work_status, 'technician', (select name from profiles where id = s.technician_id),
                    'completed_at', tc_t(s.completed_at), 'flat_price', s.flat_price, 'net', s.service_net, 'note', s.notes_external,
                    'lines', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                 'type', i.item_type, 'name', i.name, 'qty', i.qty, 'unit', ci.unit, 'price', i.price, 'cost', i.cost, 'net', i.net,
                                 'catalog_part', i.catalog_item_id is not null, 'part_id', i.catalog_item_id,
                                 'off_shelf', case when i.item_type = 'part' and i.catalog_item_id is not null then i.stock_deducted end,
                                 'po', (select jsonb_build_object('po_number', p.po_number, 'status', p.status, 'ordered', pi.qty_ordered,
                                                                  'received', pi.qty_delivered, 'cancelled', pi.qty_cancelled)
                                          from purchase_order_items_read pi join purchase_orders p on p.id = pi.po_id where pi.id = i.po_item_id)))
                                 order by i.position, i.created_at)
                               from ro_service_items_read i left join catalog_items_read ci on ci.id = i.catalog_item_id
                              where i.service_id = s.id)))
                    order by s.position, s.created_at) from ro_services_read s where s.ro_id = v_id),
    'approvals', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('service', s.name, 'decision', a.decision, 'method', a.method,
                                                                         'by', a.approved_by_name, 'at', tc_t(a.decided_at),
                                                                         case when a.method = 'online' then 'customer_note' else 'note' end, a.note)) order by a.decided_at)
                    from approvals a left join ro_services_read s on s.id = a.service_id where a.ro_id = v_id),
    'purchase_orders', (select jsonb_agg(jsonb_build_object('id', p.id, 'po_number', p.po_number, 'supplier', sp.name, 'status', p.status,
                                                            'payment', p.payment_status, 'ordered_at', tc_t(p.ordered_at)) order by p.created_at)
                          from purchase_orders p left join suppliers_read sp on sp.id = p.supplier_id where p.ro_id = v_id),
    'bookings', (select jsonb_agg(jsonb_build_object('start', tc_t(a.start_time), 'title', a.title, 'status', a.status) order by a.start_time)
                   from appointments a where a.ro_id = v_id),
    'payments', (select jsonb_agg(jsonb_build_object('kind', p.kind, 'method', p.method, 'amount', p.amount, 'paid_at', tc_t(p.paid_at),
                                                     'receipt', p.receipt_number) order by p.paid_at)
                   from payments p where p.ro_id = v_id)));
end $$;

-- One vehicle by plate (any spacing) or id: details, open jobs, service history, services due.
create or replace function public.tc_vehicle(p_ref text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_id uuid; n text := tc_norm(p_ref); v vehicles_read%rowtype; many jsonb;
begin
  if btrim(coalesce(p_ref, '')) ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then
    select id into v_id from vehicles_read where id = btrim(p_ref)::uuid;
  elsif n <> '' then
    select id into v_id from vehicles_read where tc_norm(plate) = n limit 1;
    if v_id is null then
      select jsonb_agg(jsonb_build_object('id', x.id, 'plate', x.plate)) into many
        from (select id, plate from vehicles_read where tc_norm(plate) like '%' || n || '%' order by plate limit 10) x;
      if jsonb_array_length(coalesce(many, '[]')) = 1 then v_id := (many -> 0 ->> 'id')::uuid;
      elsif many is not null then return jsonb_build_object('several_match', many);
      end if;
    end if;
  end if;
  if v_id is null then return jsonb_build_object('error', 'Vehicle not found (or not visible to this login)'); end if;
  select * into v from vehicles_read where id = v_id;
  return jsonb_strip_nulls(jsonb_build_object(
    'id', v.id, 'plate', v.plate, 'vehicle', concat_ws(' ', v.year, v.make, v.model), 'type', v.type, 'fuel', v.fuel_type, 'vin', v.vin,
    'status', v.status, 'km_now', v.mileage_km, 'driver', nullif(concat_ws(' · ', v.driver_name, v.driver_phone), ''), 'notes', v.notes,
    'company', (select jsonb_build_object('id', c.id, 'name', c.display_name) from customers_read c where c.id = v.customer_id),
    'jobs', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'id', r.id, 'job_number', r.job_number, 'invoice', r.invoice_no, 'workflow', r.workflow_status,
                'date', left(tc_t(coalesce(r.invoiced_at, r.created_at)), 10), 'km_in', r.odometer_in, 'closed', r.closed_at is not null,
                'services', (select jsonb_agg(s.name order by s.position) from ro_services_read s
                              where s.ro_id = r.id and s.approval_status = 'approved'),
                'parts', (select jsonb_agg(concat(i.name, ' × ', trim_scale(i.qty)) order by i.position)
                            from ro_services_read s join ro_service_items_read i on i.service_id = s.id
                           where s.ro_id = r.id and s.approval_status = 'approved' and i.item_type = 'part')))
                order by r.created_at desc)
               from (select * from repair_orders_read where vehicle_id = v_id order by created_at desc limit 15) r),
    'service_due', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', d.name, 'every_km', d.interval_km, 'every_months', d.interval_months,
                                                                           'last_km', d.last_done_km, 'last_date', d.last_done_date,
                                                                           'next_km', d.next_due_km, 'next_date', d.next_due_date,
                                                                           'km_left', d.km_left, 'days_left', d.days_left, 'status', d.due_status))
                                      order by d.next_due_date nulls last)
                      from service_due d where d.vehicle_id = v_id and d.active)));
end $$;

-- One part (or service/fee from the catalog) by name, part number or id: stock, what's on jobs and on order, recent moves.
create or replace function public.tc_part(p_ref text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v text := btrim(coalesce(p_ref, '')); n text := tc_norm(p_ref); v_id uuid; many jsonb; it catalog_items_read%rowtype;
  sc jsonb; reserved numeric := 0; notes jsonb := '[]';
begin
  if v ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then
    select id into v_id from catalog_items_read where id = v::uuid;
  elsif n <> '' then
    select id into v_id from catalog_items_read where tc_norm(code) = n or lower(name) = lower(v) order by active desc limit 1;
    if v_id is null then
      select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'code', x.code, 'brand', x.brand, 'type', x.item_type, 'active', x.active)) into many
        from (select * from catalog_items_read i
               where i.name ilike '%' || v || '%' or tc_norm(i.code) like '%' || n || '%' or tc_norm(i.alt_numbers) like '%' || n || '%'
                  or concat_ws(' ', i.brand, i.name) ilike '%' || v || '%'
               order by i.active desc, i.name limit 12) x;
      if jsonb_array_length(coalesce(many, '[]')) = 1 then v_id := (many -> 0 ->> 'id')::uuid;
      elsif many is not null then return jsonb_build_object('several_match', many);
      end if;
    end if;
  end if;
  if v_id is null then return jsonb_build_object('error', 'Not found in the catalog'); end if;
  select * into it from catalog_items_read where id = v_id;
  if it.item_type = 'part' and is_staff() then
    sc := stock_card(v_id);
    select coalesce(sum((e ->> 'qty')::numeric), 0) into reserved from jsonb_array_elements(sc -> 'on_estimates') e;
    if it.track_inventory and it.qty_on_hand > 0 and it.qty_on_hand - reserved < it.qty_on_hand then
      notes := notes || to_jsonb(format('On the shelf: %s, but %s is already on open jobs (not invoiced yet), so only %s is free for new work.',
                                        trim_scale(it.qty_on_hand), trim_scale(reserved), trim_scale(it.qty_on_hand - reserved)));
    end if;
    if it.track_inventory and it.qty_on_hand < 0 then
      notes := notes || to_jsonb(format('Stock is below zero (%s): more was used on jobs than was received or counted.', trim_scale(it.qty_on_hand)));
    end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'id', it.id, 'type', it.item_type, 'name', it.name, 'code', it.code, 'alt_numbers', it.alt_numbers, 'brand', it.brand,
    'fits', it.fits, 'unit', it.unit, 'active', it.active, 'description', it.description,
    'category', (select name from categories where id = it.category_id),
    'supplier', (select name from suppliers_read where id = it.supplier_id),
    'price', it.price, 'cost', it.cost, 'labor_hours', it.labor_hours, 'default_qty', it.default_qty, 'notes', it.notes,
    'track_stock', case when it.item_type = 'part' then it.track_inventory end,
    'on_shelf', case when it.item_type = 'part' then it.qty_on_hand end,
    'reorder_point', it.reorder_point,
    'on_open_jobs', case when sc is not null then sc -> 'on_estimates' end,
    'free_for_new_work', case when sc is not null and it.track_inventory then it.qty_on_hand - reserved end,
    'on_order', case when sc is not null then tc_local(sc -> 'on_order') end,
    'used_today', sc -> 'used_today', 'used_last_7_days', sc -> 'used_7d',
    'recent_moves', case when sc is not null then (select jsonb_agg(tc_local(jsonb_strip_nulls(m - 'id' - 'ro_id' - 'po_id'))) from
                       (select value as m from jsonb_array_elements(sc -> 'moves') with ordinality o(value, k) where k <= 15) x) end,
    'attention', case when jsonb_array_length(notes) > 0 then notes end,
    -- shelf count and free stock disagree in a way that confuses people: worth a more careful answer
    'data_conflict', case when sc is not null and it.track_inventory and it.qty_on_hand > 0 and it.qty_on_hand - reserved < 0 then true end));
end $$;

-- Parts at or below their reorder point.
create or replace function public.tc_stock_low() returns jsonb
language sql stable security invoker set search_path = public as $$
  select case when not (select is_staff()) then jsonb_build_object('error', 'Not available for this login') else
    jsonb_build_object('parts', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                   'id', s.id, 'name', s.name, 'code', s.code, 'on_shelf', s.qty_on_hand, 'reorder_point', s.reorder_point,
                                   'on_open_jobs', s.qty_on_estimates, 'on_order', s.qty_on_order,
                                   'supplier', (select name from suppliers_read where id = s.supplier_id))) order by s.name), '[]')
                                   from stock_levels s join catalog_items_read i on i.id = s.id
                                  where i.active and s.reorder_point is not null and s.qty_on_hand - coalesce(s.qty_on_estimates, 0) <= s.reorder_point))
  end
$$;

-- One purchase order by number or id.
create or replace function public.tc_po(p_ref text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v text := btrim(coalesce(p_ref, '')); n text := tc_norm(p_ref); p purchase_orders%rowtype;
begin
  if v ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then select * into p from purchase_orders where id = v::uuid;
  elsif n <> '' then select * into p from purchase_orders where tc_norm(po_number) = n;
  end if;
  if p.id is null then return jsonb_build_object('error', 'Purchase order not found (or not visible to this login)'); end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'id', p.id, 'po_number', p.po_number, 'status', p.status, 'payment', p.payment_status, 'ordered_at', tc_t(p.ordered_at),
    'created', tc_t(p.created_at), 'created_by', (select name from profiles where id = p.created_by), 'notes', p.notes,
    'payment_terms_days', p.payment_terms_days,
    'supplier', (select name from suppliers_read where id = p.supplier_id),
    'job', (select jsonb_build_object('id', r.id, 'job_number', r.job_number, 'plate', v2.plate, 'company', c.display_name, 'workflow', r.workflow_status)
              from repair_orders_read r left join vehicles_read v2 on v2.id = r.vehicle_id left join customers_read c on c.id = r.customer_id
             where r.id = p.ro_id),
    'lines', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'name', i.name, 'part_number', i.part_number, 'part_id', i.catalog_item_id, 'cost', i.cost,
                'ordered', i.qty_ordered, 'received', i.qty_delivered, 'cancelled', i.qty_cancelled, 'returned', i.qty_returned,
                'paid_qty', i.qty_paid, 'received_at', i.delivered_at, 'supplier_invoice', i.supplier_invoice_no, 'paid_at', i.paid_at,
                'for_job_line', i.ro_service_item_id is not null,
                'shelf_count_shown_on_po', (select ci.qty_on_hand from catalog_items_read ci where ci.id = i.catalog_item_id and ci.track_inventory)))
                order by i.created_at)
                from purchase_order_items_read i where i.po_id = p.id)));
end $$;

-- All open jobs (the Work board), with what each is waiting for.
create or replace function public.tc_open_jobs() returns jsonb
language sql stable security invoker set search_path = public as $$
  with a as (select * from repair_orders_read where archived_at is null and closed_at is null),
       j as (select * from a order by created_at limit 120),
       w as (select * from jobs_waiting((select coalesce(array_agg(id), '{}') from a)) where (select is_staff())),
       -- unfinished approved work per mechanic, over all open jobs
       t as (select p.name, count(distinct s.ro_id) as jobs, count(*) as services
               from ro_services_read s join a on a.id = s.ro_id join profiles p on p.id = s.technician_id
              where s.approval_status = 'approved' and s.work_status <> 'completed' group by p.name)
  select jsonb_build_object(
    -- totals over every open job (the list below shows the oldest 120)
    'summary', jsonb_strip_nulls(jsonb_build_object(
      'open_jobs', (select count(*) from a),
      'by_workflow', (select jsonb_object_agg(workflow_status, n) from (select workflow_status, count(*) n from a group by 1) x),
      'by_waiting_for', (select jsonb_object_agg(kind, n) from (select kind, count(*) n from w group by 1) x),
      'unfinished_work_by_mechanic', (select jsonb_agg(jsonb_build_object('mechanic', name, 'jobs', jobs, 'services', services) order by jobs desc, name) from t))),
    'jobs', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', j.id, 'job_number', j.job_number, 'invoice', j.invoice_no, 'workflow', j.workflow_status, 'priority', j.priority,
           'created', left(tc_t(j.created_at), 10), 'plate', v.plate, 'company', c.display_name,
           'balance', case when j.order_status = 'invoice' then j.balance end,
           'waiting_for', case when w.kind is not null then jsonb_build_object('kind', w.kind, 'info', tc_local(w.info) - 'po_id' - 'draft_id') end)) order by j.created_at)
         from j left join vehicles_read v on v.id = j.vehicle_id left join customers_read c on c.id = j.customer_id
         left join w on w.ro_id = j.id), '[]'))
$$;

-- What each company owes (and credit it holds), largest first, with the total.
create or replace function public.tc_balances() returns jsonb
language sql stable security invoker set search_path = public as $$
  with b as (select * from customer_balances where balance_due <> 0 or available_credit <> 0)
  select jsonb_build_object(
    'total_owed', (select coalesce(sum(balance_due), 0) from b),
    'total_overdue', (select coalesce(sum(overdue), 0) from b),
    'companies', coalesce((select jsonb_agg(jsonb_build_object('company', display_name, 'owed', balance_due, 'overdue', overdue,
                                                               'open_invoices', open_invoices, 'credit', available_credit)
                                            order by balance_due desc, display_name) from b), '[]'))
$$;

-- One day at the shop (Hari ini).
create or replace function public.tc_day(p_day date default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
begin
  if not is_staff() then return jsonb_build_object('error', 'Not available for this login'); end if;
  return tc_local(day_summary(p_day));
end $$;

-- One company: details, vehicles, open jobs, what it owes.
create or replace function public.tc_company(p_ref text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v text := btrim(coalesce(p_ref, '')); v_id uuid; many jsonb; c customers_read%rowtype;
begin
  if v ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then select id into v_id from customers_read where id = v::uuid;
  elsif v <> '' then
    select id into v_id from customers_read where lower(display_name) = lower(v) or lower(legal_name) = lower(v) limit 1;
    if v_id is null then
      select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.display_name)) into many
        from (select id, display_name from customers_read where display_name ilike '%' || v || '%' or legal_name ilike '%' || v || '%'
               order by display_name limit 10) x;
      if jsonb_array_length(coalesce(many, '[]')) = 1 then v_id := (many -> 0 ->> 'id')::uuid;
      elsif many is not null then return jsonb_build_object('several_match', many);
      end if;
    end if;
  end if;
  if v_id is null then return jsonb_build_object('error', 'Company not found (or not visible to this login)'); end if;
  select * into c from customers_read where id = v_id;
  return jsonb_strip_nulls(jsonb_build_object(
    'id', c.id, 'name', c.display_name, 'legal_name', c.legal_name, 'type', c.type, 'phone', c.phone, 'email', c.email,
    'payment_terms_days', c.payment_terms_days, 'notes', c.pinned_notes, 'active', c.active,
    'contacts', (select jsonb_agg(jsonb_build_object('name', k.name, 'phone', k.phone)) from customer_contacts k where k.customer_id = v_id),
    'vehicles', (select jsonb_build_object('count', count(*), 'list', jsonb_agg(jsonb_build_object('plate', x.plate, 'vehicle', concat_ws(' ', x.make, x.model), 'status', x.status) order by x.plate))
                   from vehicles_read x where x.customer_id = v_id),
    'open_jobs', (select jsonb_agg(jsonb_build_object('id', r.id, 'job_number', r.job_number, 'plate', vv.plate, 'workflow', r.workflow_status) order by r.created_at)
                    from repair_orders_read r left join vehicles_read vv on vv.id = r.vehicle_id
                   where r.customer_id = v_id and r.archived_at is null and r.closed_at is null),
    'balance', (select jsonb_build_object('owed', b.balance_due, 'overdue', b.overdue, 'open_invoices', b.open_invoices, 'credit', b.available_credit)
                  from customer_balances b where b.customer_id = v_id),
    'unpaid_invoices', (select jsonb_agg(jsonb_build_object('invoice', r.invoice_no, 'job_number', r.job_number, 'date', left(tc_t(r.invoiced_at), 10),
                                                            'due', r.due_date, 'total', r.total, 'balance', r.balance) order by r.invoiced_at)
                          from repair_orders_read r where r.customer_id = v_id and r.order_status = 'invoice' and r.balance > 0)));
end $$;

-- Invoices: unpaid, overdue, or the latest.
create or replace function public.tc_invoices(p_kind text default 'unpaid') returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare k text := lower(coalesce(p_kind, 'unpaid'));
begin
  if k not in ('unpaid', 'overdue', 'recent') then return jsonb_build_object('error', 'kind must be unpaid, overdue or recent'); end if;
  return jsonb_build_object('kind', k, 'invoices', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', r.id, 'invoice', r.invoice_no, 'job_number', r.job_number, 'date', left(tc_t(r.invoiced_at), 10), 'due', r.due_date,
           'company', c.display_name, 'plate', v.plate, 'total', r.total, 'paid', r.paid_total, 'balance', r.balance,
           'payment_status', r.payment_status)) order by r.invoiced_at desc)
         from (select * from repair_orders_read r
                where r.order_status = 'invoice'
                  and (k = 'recent' or r.balance > 0)
                  and (k <> 'overdue' or coalesce(r.due_date, left(tc_t(r.invoiced_at), 10)::date) < local_date())
                order by r.invoiced_at desc limit 60) r
         left join customers_read c on c.id = r.customer_id left join vehicles_read v on v.id = r.vehicle_id), '[]'));
end $$;

-- Bookings (Kalender) in a date range (up to 31 days).
create or replace function public.tc_bookings(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare d0 date := coalesce(p_from, local_date()); d1 date := coalesce(p_to, coalesce(p_from, local_date()) + 6);
        tz text := coalesce((select timezone from shop_settings limit 1), 'Asia/Jakarta');
begin
  if d1 < d0 then d1 := d0; end if;
  if d1 - d0 > 30 then d1 := d0 + 30; end if;
  return jsonb_build_object('from', d0, 'to', d1, 'bookings', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'start', to_char(a.start_time at time zone tz, 'YYYY-MM-DD HH24:MI'), 'end', to_char(a.end_time at time zone tz, 'HH24:MI'),
           'title', a.title, 'status', a.status, 'plate', v.plate, 'company', c.display_name,
           'technician', (select name from profiles where id = a.technician_id),
           'job_number', (select job_number from repair_orders_read where id = a.ro_id))) order by a.start_time)
         from appointments a left join vehicles_read v on v.id = a.vehicle_id left join customers_read c on c.id = a.customer_id
        where a.start_time >= (d0::timestamp at time zone tz) and a.start_time < ((d1 + 1)::timestamp at time zone tz)), '[]'));
end $$;

do $$
declare f text;
begin
  foreach f in array array['tc_norm(text)', 'tc_t(timestamptz)', 'tc_local(jsonb)', 'tc_job_id(text)', 'tc_search(text)', 'tc_job(text)', 'tc_vehicle(text)', 'tc_part(text)',
                           'tc_stock_low()', 'tc_po(text)', 'tc_open_jobs()', 'tc_day(date)', 'tc_company(text)', 'tc_invoices(text)',
                           'tc_bookings(date, date)', 'tc_balances()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
