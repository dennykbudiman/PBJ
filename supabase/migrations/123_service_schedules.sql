-- 123: Service schedules (stage 8, Oct 7, 2026)
--
-- 1. Schedules: tighter grants and checks; one active schedule per vehicle and service bundle.
-- 2. A bundle service added to a job links itself to the vehicle's schedule for that bundle; completing it
--    updates the schedule, or starts one when the bundle has a suggested interval ("On completion: next due …").
-- 3. Reminders: refresh_reminders() writes "service due" and "invoice overdue" notifications (no duplicates)
--    and clears ones that no longer apply. The app calls it when it opens (at most once an hour);
--    if pg_cron is switched on, it also runs every morning.

-- ===== 1. Schedules =====
revoke insert, update on public.service_schedules from authenticated;
grant insert (id, vehicle_id, name, template_id, interval_km, interval_months, last_done_km, last_done_date, active) on public.service_schedules to authenticated;
grant update (name, template_id, interval_km, interval_months, last_done_km, last_done_date, active) on public.service_schedules to authenticated;

alter table public.service_schedules add constraint schedule_name check (length(btrim(name)) between 1 and 120);
alter table public.service_schedules add constraint schedule_interval_km check (interval_km is null or interval_km between 100 and 1000000);
alter table public.service_schedules add constraint schedule_interval_months check (interval_months is null or interval_months between 1 and 120);
alter table public.service_schedules add constraint schedule_last_km check (last_done_km is null or last_done_km between 0 and 9999999);
create unique index service_schedules_one_per_bundle on public.service_schedules (vehicle_id, template_id) where active and template_id is not null;

-- "Last done" can't be in the future (on the shop's calendar).
create or replace function public.check_service_schedule_row() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.last_done_date is not null and new.last_done_date > local_date()
     and (tg_op = 'INSERT' or new.last_done_date is distinct from old.last_done_date) then
    raise exception 'The last service date can''t be in the future';
  end if;
  new.name := btrim(new.name);
  return new;
end $$;
revoke execute on function public.check_service_schedule_row() from public, anon, authenticated;
create trigger service_schedules_check before insert or update on public.service_schedules
  for each row execute function check_service_schedule_row();

-- ===== 2. Jobs and schedules =====
-- A service made from a bundle counts towards the vehicle's schedule for that bundle.
create or replace function public.link_service_schedule() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.service_schedule_id is null and new.template_id is not null then
    select ss.id into new.service_schedule_id
    from service_schedules ss join repair_orders r on r.vehicle_id = ss.vehicle_id
    where r.id = new.ro_id and ss.template_id = new.template_id and ss.active
    limit 1;
  end if;
  return new;
end $$;
revoke execute on function public.link_service_schedule() from public, anon, authenticated;
-- (named to run before the other ro_services triggers, which fire in name order)
create trigger ro_services_0_link_schedule before insert on public.ro_services
  for each row execute function link_service_schedule();

-- Completing a service updates its schedule; a bundle with a suggested interval and no schedule yet starts one.
-- Only the moment of completion does that. Re-linking an already completed service to another schedule
-- updates that schedule with the job's own completion date; clearing the link (or deleting the schedule,
-- which clears it) changes nothing else.
create or replace function public.on_service_completed() returns trigger language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; km int; v_newly boolean; tp service_templates%rowtype; v_km int; v_months int; v_day date;
begin
  if new.work_status <> 'completed' then return new; end if;
  v_newly := tg_op = 'INSERT' or old.work_status is distinct from 'completed';
  if not v_newly and new.service_schedule_id is not distinct from old.service_schedule_id then return new; end if;
  select * into ro from repair_orders where id = new.ro_id;
  km := coalesce(ro.odometer_out, ro.odometer_in, (select mileage_km from vehicles where id = ro.vehicle_id));
  if v_newly then
    new.completed_at := coalesce(new.completed_at, now());
    v_day := local_date();
    if new.service_schedule_id is null and new.template_id is not null then
      select * into tp from service_templates where id = new.template_id;
      -- only intervals the schedule table accepts; a km-only interval needs a km reading to start from
      v_km := case when tp.default_interval_km between 100 and 1000000 then tp.default_interval_km end;
      v_months := case when tp.default_interval_months between 1 and 120 then tp.default_interval_months end;
      if km is null then v_km := null; end if;
      -- a schedule switched off for this vehicle and bundle stays off: no new one is started
      if found and (v_km is not null or v_months is not null)
         and not exists (select 1 from service_schedules where vehicle_id = ro.vehicle_id and template_id = tp.id) then
        insert into service_schedules (vehicle_id, name, template_id, interval_km, interval_months, last_done_km, last_done_date)
        values (ro.vehicle_id, left(btrim(tp.name), 120), tp.id, v_km, v_months, km, v_day)
        on conflict (vehicle_id, template_id) where active and template_id is not null do nothing
        returning id into new.service_schedule_id;
        if new.service_schedule_id is null then   -- another job started it a moment ago
          select id into new.service_schedule_id from service_schedules where vehicle_id = ro.vehicle_id and template_id = tp.id and active;
        end if;
      end if;
    end if;
  else
    -- re-linked after completion: the work was done when the service was completed, not today
    v_day := coalesce((new.completed_at at time zone coalesce((select timezone from shop_settings limit 1), 'Asia/Jakarta'))::date, local_date());
  end if;
  if new.service_schedule_id is not null then
    update service_schedules set
      last_done_km = case when km is null then last_done_km else greatest(coalesce(last_done_km, 0), km) end,
      last_done_date = greatest(coalesce(last_done_date, v_day), v_day)
    where id = new.service_schedule_id;
  end if;
  if v_newly and km is not null then update vehicles set mileage_km = greatest(coalesce(mileage_km,0), km) where id = ro.vehicle_id; end if;
  return new;
end $$;

-- Carrying deferred work over keeps its schedule link only while that schedule is on;
-- otherwise the link trigger above picks the vehicle's current schedule for the bundle.
create or replace function public.carry_deferred_services(p_ro uuid, p_services uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare r repair_orders%rowtype; s record; v_new uuid; v_pos int; v_n int := 0;
begin
  if not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  select * into r from repair_orders where id = p_ro for update;
  if not found or r.order_status <> 'estimate' or r.closed_at is not null then
    raise exception 'Deferred work can only go into an open estimate';
  end if;
  if coalesce(array_length(p_services, 1), 0) = 0 then return 0; end if;
  select coalesce(max(position), -1) into v_pos from ro_services where ro_id = p_ro;
  for s in
    select sv.* from ro_services sv
    where sv.id = any(p_services) order by sv.ro_id, sv.position, sv.id
    for update of sv
  loop
    if s.ro_id = p_ro then raise exception 'That work is already on this job'; end if;
    if not deferred_is_waiting(s.id) then raise exception 'Only deferred work from an invoiced or closed job can be carried over'; end if;
    if (select vehicle_id from repair_orders where id = s.ro_id) <> r.vehicle_id then
      raise exception 'That deferred work is for another vehicle';
    end if;
    if deferred_is_carried(s.id) then
      raise exception 'That deferred work has already been carried over';
    end if;
    if exists (select 1 from deferred_dismissals where service_id = s.id) then
      raise exception 'That deferred work was dismissed';
    end if;
    v_pos := v_pos + 1;
    insert into ro_services (ro_id, position, name, notes_external, template_id, checklist_id, service_schedule_id,
                             flat_price, discount_pct, discount_amount, carried_from)
    values (p_ro, v_pos, s.name, s.notes_external, s.template_id, s.checklist_id,
            (select id from service_schedules where id = s.service_schedule_id and active),
            s.flat_price, s.discount_pct, s.discount_amount, s.id)
    returning id into v_new;
    insert into ro_service_items (service_id, position, item_type, catalog_item_id, name, description, cost, price, qty,
                                  discount_pct, discount_amount, taxable, core_charge, show_qty_price)
    select v_new, position, item_type, catalog_item_id, name, description, cost, price, qty,
           discount_pct, discount_amount, taxable, core_charge, show_qty_price
    from ro_service_items where service_id = s.id order by position, id;
    v_n := v_n + 1;
  end loop;
  if v_n <> (select count(distinct x) from unnest(p_services) x) then
    raise exception 'Some of that deferred work no longer exists';
  end if;
  return v_n;
end $$;

-- ===== 3. Reminders =====
alter table public.notifications add column data jsonb;
alter table public.notifications add column dedupe_key text;
create unique index notifications_dedupe_key on public.notifications (dedupe_key) where dedupe_key is not null;

create table public.app_runs (            -- when background jobs last ran (not logged)
  name text primary key,
  last_run timestamptz not null
);
alter table public.app_runs enable row level security;
revoke all on public.app_runs from anon, authenticated;
insert into public.app_runs (name, last_run) values ('reminders', '-infinity');   -- so the first run can be locked too

-- What should be in the bell right now for service schedules: one row per schedule that is due soon or overdue.
create or replace function public.service_reminder_rows() returns table (
  schedule_id uuid, name text, next_due_km int, next_due_date date, vehicle_id uuid, plate text, mileage_km int, company text, status text, dedupe_key text)
language sql stable security definer set search_path = public as $$
  with s as (select coalesce(due_soon_km, 1000) as soon_km, coalesce(due_soon_days, 14) as soon_days from shop_settings limit 1),
  d as (
    select ss.id, ss.name, ss.next_due_km, ss.next_due_date, v.id as vehicle_id, v.plate, v.mileage_km, c.display_name as company,
      case
        when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km) or (ss.next_due_date is not null and local_date() >= ss.next_due_date) then 'overdue'
        when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km - (select soon_km from s))
          or (ss.next_due_date is not null and local_date() >= ss.next_due_date - (select soon_days from s)) then 'due_soon'
        else 'ok' end as status
    from service_schedules ss join vehicles v on v.id = ss.vehicle_id left join customers c on c.id = v.customer_id
    where ss.active and v.status not in ('sold', 'inactive')
  )
  select id, name, next_due_km, next_due_date, vehicle_id, plate, mileage_km, company, status,
    'service_due:' || id || ':' || status || ':' || coalesce(next_due_km::text, '') || ':' || coalesce(next_due_date::text, '')
  from d where status <> 'ok'
$$;
revoke execute on function public.service_reminder_rows() from public, anon, authenticated;

create or replace function public.refresh_reminders(p_force boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare v_last timestamptz; v_n int := 0; v_add int; v_today date := local_date();
begin
  -- Called by staff from the app (or by pg_cron, which has no signed-in user).
  if auth.uid() is not null and not is_staff() then raise exception 'Not allowed'; end if;
  select last_run into v_last from app_runs where name = 'reminders' for update;
  -- "force" is for the morning job (no signed-in user); from the app, at most once an hour for the whole shop.
  if not (p_force and auth.uid() is null) and v_last is not null and v_last > now() - interval '1 hour' then return 0; end if;
  insert into app_runs (name, last_run) values ('reminders', now()) on conflict (name) do update set last_run = excluded.last_run;

  -- Service due / overdue: one notification per schedule, due point and status.
  with ins as (
    insert into notifications (type, severity, title, body, entity_type, entity_id, data, dedupe_key)
    select 'service_due', case when r.status = 'overdue' then 'urgent' else 'warning' end,
      r.plate || ': ' || r.name || case when r.status = 'overdue' then ' is overdue' else ' is due soon' end,
      concat_ws(' · ', r.company, case when r.next_due_km is not null then 'due at ' || r.next_due_km || ' km' end,
                case when r.next_due_date is not null then 'due ' || to_char(r.next_due_date, 'DD Mon YYYY') end),
      'vehicle', r.vehicle_id,
      jsonb_build_object('schedule_id', r.schedule_id, 'name', r.name, 'plate', r.plate, 'company', r.company, 'status', r.status,
                         'next_due_km', r.next_due_km, 'next_due_date', r.next_due_date, 'mileage_km', r.mileage_km),
      r.dedupe_key
    from service_reminder_rows() r
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning 1
  ) select count(*) into v_add from ins;
  v_n := v_n + v_add;
  -- Clear service reminders that no longer apply (done since, now overdue instead of due soon, switched off, vehicle sold).
  delete from notifications where type = 'service_due' and dedupe_key is not null
    and dedupe_key not in (select r.dedupe_key from service_reminder_rows() r);

  -- Invoices past their due date with money still owed.
  with ins as (
    insert into notifications (type, severity, title, body, entity_type, entity_id, data, dedupe_key)
    select 'invoice_overdue', 'urgent',
      'INV-' || lpad(r.invoice_number::text, 6, '0') || ' is overdue',
      concat_ws(' · ', c.display_name, 'Rp ' || to_char(r.balance, 'FM999G999G999G999')),
      'repair_order', r.id,
      jsonb_build_object('invoice_number', r.invoice_number, 'company', c.display_name, 'balance', r.balance, 'due_date', r.due_date),
      'invoice_overdue:' || r.id || ':' || r.due_date
    from repair_orders r left join customers c on c.id = r.customer_id
    where r.order_status = 'invoice' and r.balance > 0 and r.due_date < v_today
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning 1
  ) select count(*) into v_add from ins;
  v_n := v_n + v_add;
  delete from notifications n where n.type = 'invoice_overdue' and n.dedupe_key is not null and not exists (
    select 1 from repair_orders r where r.id = n.entity_id and r.order_status = 'invoice' and r.balance > 0 and r.due_date < v_today
      and n.dedupe_key = 'invoice_overdue:' || r.id || ':' || r.due_date);
  return v_n;
end $$;
revoke execute on function public.refresh_reminders(boolean) from public, anon;
grant execute on function public.refresh_reminders(boolean) to authenticated;

-- Every morning at 06:00 Jakarta time (23:00 UTC), when pg_cron is switched on in Supabase (Database → Extensions).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('axle-reminders', '0 23 * * *', 'select public.refresh_reminders(true)');
  end if;
end $$;
