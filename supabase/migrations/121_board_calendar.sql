-- 121: Work board & calendar (stage 6, Oct 6, 2026)
--
-- 1. Appointments: tighter grants, a "who / what" rule, and links only to open estimates.
-- 2. An appointment moves its job on the board: booked → Scheduled, arrived → Arrived,
--    cancelled / no-show (with nothing else booked) → back to Estimate.
-- 3. Appointment changes show in the linked job's Activity.
-- 4. Deferred work can be carried into an open estimate of the same vehicle (carry_deferred_services),
--    or dismissed from the Deferred list (deferred_dismissals). Either takes it off the list.

-- ===== 1. Appointments =====
revoke insert, update on public.appointments from authenticated;
grant insert (id, ro_id, customer_id, vehicle_id, technician_id, title, start_time, end_time, notes, status) on public.appointments to authenticated;
grant update (ro_id, customer_id, vehicle_id, technician_id, title, start_time, end_time, notes, status) on public.appointments to authenticated;

alter table public.appointments add constraint appointment_who_or_what
  check (customer_id is not null or nullif(btrim(title), '') is not null);
alter table public.appointments add constraint appointment_text_length
  check (length(coalesce(title, '')) <= 200 and length(coalesce(notes, '')) <= 4000);
alter table public.appointments add constraint appointment_max_length
  check (end_time - start_time <= interval '14 days');
create index if not exists appointments_end_idx on public.appointments (end_time);

-- A new link to a job must be to an open estimate (an invoiced or closed job can't be booked).
create or replace function public.check_appointment_job() returns trigger language plpgsql security definer set search_path = public as $$
declare v_status text; v_closed timestamptz;
begin
  if new.ro_id is not null and (tg_op = 'INSERT' or new.ro_id is distinct from old.ro_id) then
    select order_status, closed_at into v_status, v_closed from repair_orders where id = new.ro_id;
    if v_status is distinct from 'estimate' or v_closed is not null then
      raise exception 'Only an open estimate can be booked';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.check_appointment_job() from public, anon, authenticated;
create trigger appointments_job_check before insert or update of ro_id on public.appointments
  for each row execute function check_appointment_job();

-- ===== 2. The appointment moves its job on the board =====
create or replace function public.appointment_moves_job() returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- the job the appointment left: if it was only Scheduled because of this booking, it goes back to Estimate
  if tg_op in ('UPDATE', 'DELETE') and old.ro_id is not null
     and (tg_op = 'DELETE' or new.ro_id is distinct from old.ro_id) then
    update repair_orders set workflow_status = 'estimate'
    where id = old.ro_id and order_status = 'estimate' and closed_at is null and workflow_status = 'scheduled'
      and not exists (select 1 from appointments a where a.ro_id = old.ro_id and a.id <> old.id
                      and a.status in ('requested', 'scheduled', 'confirmed') and a.end_time > now());
  end if;
  if tg_op = 'DELETE' or new.ro_id is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  -- Each update repeats its conditions, so a job invoiced or closed a moment ago is never touched.
  if new.status in ('scheduled', 'confirmed') then
    update repair_orders set workflow_status = 'scheduled'
    where id = new.ro_id and order_status = 'estimate' and closed_at is null and workflow_status = 'estimate';
  elsif new.status = 'arrived' then
    update repair_orders set workflow_status = 'arrived'
    where id = new.ro_id and order_status = 'estimate' and closed_at is null and workflow_status in ('estimate', 'scheduled');
  elsif new.status in ('cancelled', 'no_show') then
    update repair_orders set workflow_status = 'estimate'
    where id = new.ro_id and order_status = 'estimate' and closed_at is null and workflow_status = 'scheduled'
      and not exists (select 1 from appointments a where a.ro_id = new.ro_id and a.id <> new.id
                      and a.status in ('requested', 'scheduled', 'confirmed') and a.end_time > now());
  end if;
  return new;
end $$;
revoke execute on function public.appointment_moves_job() from public, anon, authenticated;
create trigger appointments_move_job after insert or update of status, ro_id or delete on public.appointments
  for each row execute function appointment_moves_job();

-- Closing a job without invoicing cancels its bookings that are still to come.
create or replace function public.close_cancels_appointments() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update appointments set status = 'cancelled'
  where ro_id = new.id and status in ('requested', 'scheduled', 'confirmed') and end_time > now();
  return null;
end $$;
revoke execute on function public.close_cancels_appointments() from public, anon, authenticated;
create trigger job_close_cancels_appointments after update of closed_at on public.repair_orders
  for each row when (new.closed_at is not null and old.closed_at is null) execute function close_cancels_appointments();

-- ===== 3. Appointment changes in the job's Activity =====
create or replace function public.log_appointment_job_activity() returns trigger language plpgsql security definer set search_path = public as $$
declare diff jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.ro_id is not null
     and (tg_op = 'DELETE' or new.ro_id is distinct from old.ro_id) then
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', old.ro_id, 'line_remove', jsonb_build_object('table', 'appointments', 'row', to_jsonb(old)));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.ro_id is null then return new; end if;
  if tg_op = 'INSERT' or new.ro_id is distinct from old.ro_id then
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', new.ro_id, 'line_add', jsonb_build_object('table', 'appointments', 'row', to_jsonb(new)));
    return new;
  end if;
  select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
  from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key = n.key
  where n.value is distinct from o.value and n.key not in ('customer_id', 'vehicle_id');
  if diff is not null then
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', new.ro_id, 'line_update', jsonb_build_object('table', 'appointments', 'row', to_jsonb(new), 'diff', diff));
  end if;
  return new;
end $$;
revoke execute on function public.log_appointment_job_activity() from public, anon, authenticated;
create trigger log_appointment_job after insert or update or delete on public.appointments
  for each row execute function log_appointment_job_activity();

-- ===== 4. Deferred work: carry into a new estimate, or dismiss =====
alter table public.ro_services add column carried_from uuid references public.ro_services(id) on delete set null;
create index ro_services_carried_from_idx on public.ro_services (carried_from) where carried_from is not null;

-- Deferred work counts as carried over while a copy sits on a job that wasn't closed without invoicing.
-- (Closing that job, or deleting the copy, puts the original back on the Deferred list.)
create or replace function public.deferred_is_carried(p_service uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from ro_services c join repair_orders j on j.id = c.ro_id where c.carried_from = p_service and j.closed_at is null)
$$;
revoke execute on function public.deferred_is_carried(uuid) from public, anon;
grant execute on function public.deferred_is_carried(uuid) to authenticated;

-- Deferred work is "waiting" only once its own visit is over: the job was invoiced, or closed without invoicing.
-- (On an estimate still open, it can simply be approved there.)
create or replace function public.deferred_is_waiting(p_service uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from ro_services s join repair_orders j on j.id = s.ro_id
                 where s.id = p_service and s.approval_status = 'deferred' and (j.order_status = 'invoice' or j.closed_at is not null))
$$;
revoke execute on function public.deferred_is_waiting(uuid) from public, anon;
grant execute on function public.deferred_is_waiting(uuid) to authenticated;

-- An invoiced job's services stay locked, except that the link back to the deferred original may be cleared
-- (when that original is deleted).
create or replace function public.lock_invoiced_job() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid; v_status text; allowed text[]; o jsonb; n jsonb;
begin
  if tg_table_name = 'ro_service_items' then
    if tg_op = 'DELETE' then select ro_id into v_ro from ro_services where id = old.service_id;
    else select ro_id into v_ro from ro_services where id = new.service_id; end if;
  elsif tg_op = 'DELETE' then v_ro := old.ro_id;
  else v_ro := new.ro_id; end if;
  select order_status into v_status from repair_orders where id = v_ro for no key update;
  if v_status is distinct from 'invoice' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op <> 'UPDATE' then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
  allowed := case tg_table_name
    when 'ro_services' then array['technician_id','work_status','completed_at','service_total','service_discount','service_net','service_schedule_id','carried_from']
    when 'ro_service_items' then array['stock_deducted','po_item_id','hours_worked','amount','discount','net']
    else array[]::text[] end;
  o := to_jsonb(old) - allowed; n := to_jsonb(new) - allowed;
  if o is distinct from n then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
  return new;
end $$;

create table public.deferred_dismissals (
  service_id uuid primary key references public.ro_services(id) on delete cascade,
  note text check (length(coalesce(note, '')) <= 500),
  dismissed_by uuid default auth.uid() references public.profiles(id),
  dismissed_at timestamptz not null default now()
);
alter table public.deferred_dismissals enable row level security;
create policy "staff read deferred_dismissals" on public.deferred_dismissals for select using ((select is_staff()));
create policy "edit deferred_dismissals" on public.deferred_dismissals for all
  using ((select has_permission('edit_jobs'))) with check ((select has_permission('edit_jobs')));
revoke all on public.deferred_dismissals from anon, authenticated;
grant select, delete on public.deferred_dismissals to authenticated;
grant insert (service_id, note) on public.deferred_dismissals to authenticated;
create index deferred_dismissals_by_idx on public.deferred_dismissals (dismissed_by);

create or replace function public.check_deferred_dismissal() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.dismissed_by := auth.uid();
  new.dismissed_at := now();
  if not deferred_is_waiting(new.service_id) then
    raise exception 'Only deferred work from an invoiced or closed job can be dismissed';
  end if;
  return new;
end $$;
revoke execute on function public.check_deferred_dismissal() from public, anon, authenticated;
create trigger deferred_dismissals_check before insert on public.deferred_dismissals
  for each row execute function check_deferred_dismissal();
-- Logged on the job the deferred work belongs to.
create or replace function public.log_dismissal_activity() returns trigger language plpgsql security definer set search_path = public as $$
declare d deferred_dismissals%rowtype; v_ro uuid; v_name text;
begin
  if tg_op = 'DELETE' then d := old; else d := new; end if;
  select ro_id, name into v_ro, v_name from ro_services where id = d.service_id;
  if v_ro is not null then
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', v_ro, case when tg_op = 'INSERT' then 'line_add' else 'line_remove' end,
            jsonb_build_object('table', 'deferred_dismissals', 'row', to_jsonb(d) || jsonb_build_object('name', v_name)));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function public.log_dismissal_activity() from public, anon, authenticated;
create trigger log_deferred_dismissals after insert or delete on public.deferred_dismissals
  for each row execute function log_dismissal_activity();

-- Copies deferred services (with their lines) into an open estimate of the same vehicle, as pending work.
-- The originals stay untouched on their own job (invoiced jobs are locked); the copy points back with carried_from.
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
    for update of sv   -- two people carrying the same work at once: the second waits, then sees the copy
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
    values (p_ro, v_pos, s.name, s.notes_external, s.template_id, s.checklist_id, s.service_schedule_id,
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
revoke execute on function public.carry_deferred_services(uuid, uuid[]) from public, anon;
grant execute on function public.carry_deferred_services(uuid, uuid[]) to authenticated;
