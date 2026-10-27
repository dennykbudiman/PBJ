-- Axle v2 · 131 Fixes from the whole-system audit (Oct 25, 2026)
--
-- 1. Service schedules: completing a service moves its schedule on; un-completing it (back to To do / In progress)
--    or deleting it now puts the schedule back as it was, unless the schedule was changed since. A schedule this
--    service started is removed again, unless it was switched off or its interval changed. Services can be
--    un-completed in any order. (Before: the schedule stayed moved, hiding the overdue service.)
-- 2. Percent fees are at most 100% (catalog fee items and job fees), as the screens already check.
-- 3. PPN: a flat-price service with no priced lines (e.g. "General repair" at a flat Rp 500.000) is taxed like its
--    lines, or with no lines, like new items (Settings → Tax). Typed-in job lines (no catalog item) are taxable when
--    Settings says new items are. (Before: both were always untaxed.)
-- 4. A deposit stays with the company that paid it: changing an estimate's company when it has payments needs the
--    record_payments permission (a correction by the Cashier, Owner or Admin), and a vehicle can't be transferred
--    while one of its open jobs holds the current company's deposit.
-- 5. Approvals: on an invoiced job they can't be added, changed or removed (void the invoice first); who recorded an
--    approval and when can't be changed (the time is when it was recorded); a service's approval status only changes
--    through an approval.
-- 6. Supplier bills: parts sent back to the supplier are no longer charged when paying a PO line; a PO counts as paid
--    once everything kept is paid, and the dashboard's bills owed leave returned parts out. The PO lines view shows
--    qty_returned.
-- 7. app_environment: a one-row marker saying which project this is. deploy/staging-reset.sql only runs where it says
--    'staging'. Production is marked 'production' at go-live (README); the marker can't be changed afterwards.
-- 8. Reports: report_voids also lists invoices issued in the period that were voided later, and shows the invoice
--    that replaced a voided one. A reissued invoice still counts in the month it was reissued.
--
-- Run once, after 130, in the SQL Editor. Then (staging only) mark the staging project:
--   insert into public.app_environment (name) values ('staging');

-- ===== 1. Service schedules follow an un-completed service
alter table public.service_schedule_log
  add column if not exists prev_km int,                       -- the schedule's last done km / date before this service
  add column if not exists prev_date date,
  add column if not exists set_km int,                        -- what this service set them to
  add column if not exists set_date date,
  add column if not exists started boolean not null default false,  -- this service started the schedule
  add column if not exists seq bigint generated always as identity;   -- order of the records (several can share a time)

create or replace function public.on_service_completed() returns trigger language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; km int; v_newly boolean; tp service_templates%rowtype; v_km int; v_months int; v_day date;
        v_due_km int; v_due_date date; v_started boolean := false; v_prev_km int; v_prev_date date; v_set_km int; v_set_date date;
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
        v_started := new.service_schedule_id is not null;   -- this service starts the schedule: nothing was due yet
      end if;
    end if;
  else
    -- re-linked after completion: the work was done when the service was completed, not today
    v_day := coalesce((new.completed_at at time zone coalesce((select timezone from shop_settings limit 1), 'Asia/Jakarta'))::date, local_date());
  end if;
  if new.service_schedule_id is not null then
    if not v_started then
      select next_due_km, next_due_date, last_done_km, last_done_date into v_due_km, v_due_date, v_prev_km, v_prev_date
      from service_schedules where id = new.service_schedule_id for update;
    end if;
    update service_schedules set
      last_done_km = case when km is null then last_done_km else greatest(coalesce(last_done_km, 0), km) end,
      last_done_date = greatest(coalesce(last_done_date, v_day), v_day)
    where id = new.service_schedule_id
    returning last_done_km, last_done_date into v_set_km, v_set_date;
    -- The first record for a service and schedule is kept: completing it again, or linking it away and back,
    -- would otherwise see a due point this same service has already moved on. It also keeps what the schedule said
    -- before (prev_*) and after (set_*), so un-completing the service can put the schedule back (131).
    insert into service_schedule_log (ro_service_id, schedule_id, ro_id, vehicle_id, due_km, due_date, done_km, done_date,
                                      prev_km, prev_date, set_km, set_date, started)
    values (new.id, new.service_schedule_id, new.ro_id, ro.vehicle_id, v_due_km, v_due_date, km, v_day,
            v_prev_km, v_prev_date, v_set_km, v_set_date, v_started)
    on conflict (ro_service_id, schedule_id) do nothing;
  end if;
  if v_newly and km is not null then update vehicles set mileage_km = greatest(coalesce(mileage_km,0), km) where id = ro.vehicle_id; end if;
  return new;
end $$;

-- Un-completing runs after the update; deleting runs before the delete (the log rows go with the service). A schedule
-- the service started is removed after the delete, once the service no longer points at it.
-- How the schedule is put back: the oldest log record of a schedule keeps what the schedule said before any of its
-- tracked services (prev_*); the newest keeps what the schedule says now (set_*). When a service is un-completed, the
-- schedule goes back to the later of that starting point and the readings of the services still completed. If the
-- schedule no longer matches the newest record, someone changed it by hand, and it is left alone. Records from before
-- 131 have no starting point, so their schedules are left alone too.
create or replace function public.on_service_uncompleted() returns trigger language plpgsql security definer set search_path = public as $$
declare l service_schedule_log%rowtype; s service_schedules%rowtype; first_l service_schedule_log%rowtype;
        last_l service_schedule_log%rowtype; v_km int; v_date date; v_next uuid; v_any boolean; v_same boolean;
begin
  for l in select * from service_schedule_log where ro_service_id = old.id loop
    if l.schedule_id is null then delete from service_schedule_log where id = l.id; continue; end if;
    select * into s from service_schedules where id = l.schedule_id for update;
    if not found then delete from service_schedule_log where id = l.id; continue; end if;
    select * into first_l from service_schedule_log where schedule_id = s.id order by seq limit 1;
    select * into last_l from service_schedule_log where schedule_id = s.id order by seq desc limit 1;
    delete from service_schedule_log where id = l.id;
    v_any := exists (select 1 from service_schedule_log where schedule_id = s.id);
    -- the starting point passes to the next oldest record
    if first_l.id = l.id and v_any then
      select id into v_next from service_schedule_log where schedule_id = s.id order by seq limit 1;
      update service_schedule_log set prev_km = l.prev_km, prev_date = l.prev_date, started = l.started where id = v_next;
    end if;
    -- left alone: changed by hand since, or tracked before 131
    continue when last_l.set_date is null or first_l.set_date is null
      or s.last_done_km is distinct from last_l.set_km or s.last_done_date is distinct from last_l.set_date;
    if first_l.started and not v_any then
      -- the service that started the schedule is gone and nothing else counts towards it: as if it had never started,
      -- unless the schedule was switched off or its interval changed (then only its last-done reading goes)
      select (case when t.default_interval_km between 100 and 1000000 then t.default_interval_km end) is not distinct from s.interval_km
         and (case when t.default_interval_months between 1 and 120 then t.default_interval_months end) is not distinct from s.interval_months
        into v_same from service_templates t where t.id = s.template_id;
      if s.active and coalesce(v_same, false) then
        if tg_op = 'DELETE' then
          perform set_config('axle.drop_schedules', concat_ws(',', nullif(current_setting('axle.drop_schedules', true), ''), s.id::text), true);
        else
          delete from service_schedules where id = s.id;
        end if;
        continue;
      end if;
    end if;
    select max(x) into v_km from (select first_l.prev_km as x union all select done_km from service_schedule_log where schedule_id = s.id) q;
    select max(x) into v_date from (select first_l.prev_date as x union all select done_date from service_schedule_log where schedule_id = s.id) q;
    update service_schedules set last_done_km = v_km, last_done_date = v_date where id = s.id;
    -- the newest remaining record now describes the schedule as it is
    update service_schedule_log set set_km = v_km, set_date = v_date
    where id = (select id from service_schedule_log where schedule_id = s.id order by seq desc limit 1);
  end loop;
  return case when tg_op = 'DELETE' then old end;
end $$;
create or replace function public.drop_started_schedules() returns trigger language plpgsql security definer set search_path = public as $$
declare v text := nullif(current_setting('axle.drop_schedules', true), '');
begin
  if v is not null then
    perform set_config('axle.drop_schedules', '', true);
    delete from service_schedules ss where ss.id = any(string_to_array(v, ',')::uuid[])
      and not exists (select 1 from service_schedule_log where schedule_id = ss.id);
  end if;
  return null;
end $$;
revoke execute on function public.on_service_uncompleted(), public.drop_started_schedules() from public, anon, authenticated;
drop trigger if exists ro_services_uncompleted on public.ro_services;
create trigger ro_services_uncompleted after update of work_status on public.ro_services for each row
  when (old.work_status = 'completed' and new.work_status <> 'completed') execute function on_service_uncompleted();
drop trigger if exists ro_services_uncompleted_delete on public.ro_services;
create trigger ro_services_uncompleted_delete before delete on public.ro_services for each row
  when (old.work_status = 'completed') execute function on_service_uncompleted();
drop trigger if exists ro_services_uncompleted_drop on public.ro_services;
create trigger ro_services_uncompleted_drop after delete on public.ro_services for each row
  when (old.work_status = 'completed') execute function drop_started_schedules();

-- ===== 2. Percent fees at most 100% (existing rows are left as they are; new and changed rows are checked)
alter table public.catalog_items drop constraint if exists catalog_fee_percent_max;
alter table public.catalog_items add constraint catalog_fee_percent_max
  check (fee_kind is distinct from 'percent' or fee_value is null or fee_value <= 100) not valid;
alter table public.ro_job_fees drop constraint if exists ro_job_fee_percent_max;
alter table public.ro_job_fees add constraint ro_job_fee_percent_max check (kind <> 'percent' or value <= 100) not valid;

-- ===== 3. PPN: typed-in job lines follow Settings → new items taxable (catalog lines carry the item's own setting)
create or replace function public.new_line_taxable() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select new_items_taxable from shop_settings limit 1), false)
$$;
revoke execute on function public.new_line_taxable() from public, anon;
grant execute on function public.new_line_taxable() to authenticated;
alter table public.ro_service_items alter column taxable set default public.new_line_taxable();

-- ===== 3b. PPN on a flat-price service with no priced lines (recalc_repair_order from 112, one change)
create or replace function public.recalc_repair_order(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
declare
  s record; st shop_settings%rowtype; ro repair_orders%rowtype;
  v_parts numeric := 0; v_labor numeric := 0; v_other numeric := 0; v_fees numeric := 0;
  v_item_disc numeric := 0; v_svc_disc numeric := 0; v_taxable numeric := 0;
  v_job_fees numeric := 0; v_job_disc numeric := 0; v_pre numeric; v_base numeric; v_amt numeric;
  v_subtotal numeric; v_tax numeric; v_paid numeric; v_total numeric; v_taxable_fees numeric := 0; v_rate numeric;
  line_sum numeric; line_taxable numeric; svc_total numeric; svc_disc numeric; svc_taxable numeric;
  c_p numeric; c_l numeric; c_o numeric; c_f numeric; c_disc numeric; k numeric; rem numeric; any_taxable boolean;
  f record; d record;
begin
  select * into ro from repair_orders where id = p_ro for no key update;
  if not found then return; end if;

  select coalesce(sum(case when kind = 'payment' then amount else -amount end),0) into v_paid from payments where ro_id = p_ro;
  if v_paid < 0 then raise exception 'Refunds can''t be more than the payments received on this job'; end if;
  select v_paid + coalesce(sum(amount),0) into v_paid from credit_memos where applied_ro_id = p_ro;

  if ro.order_status = 'invoice' then
    if v_paid > ro.total then
      raise exception 'That is more than the balance due on this invoice (total Rp %)', to_char(ro.total, 'FM999G999G999G990');
    end if;
    -- an issued invoice never re-prices; only the payment side moves
    update repair_orders set paid_total = v_paid, balance = total - v_paid,
      payment_status = case when v_paid >= total then 'paid' when v_paid > 0 then 'partial' else 'unpaid' end,
      workflow_status = case when v_paid >= total then 'paid' when workflow_status = 'paid' then 'invoiced' else workflow_status end
    where id = p_ro;
    return;
  end if;

  select * into st from shop_settings limit 1;
  v_rate := case when st.pkp_status = 'non_pkp' then 0 else st.tax_rate end;

  for s in select * from ro_services where ro_id = p_ro loop
    select coalesce(sum(net + round(core_charge * qty)),0),
           coalesce(sum(net + round(core_charge * qty)) filter (where taxable),0),
           coalesce(sum(net + round(core_charge * qty)) filter (where item_type = 'part'),0),
           coalesce(sum(net) filter (where item_type = 'labor'),0),
           coalesce(sum(net) filter (where item_type = 'sublet'),0),
           coalesce(sum(net) filter (where item_type = 'fee'),0),
           coalesce(sum(discount),0), bool_or(taxable)
      into line_sum, line_taxable, c_p, c_l, c_o, c_f, c_disc, any_taxable
      from ro_service_items where service_id = s.id;
    if s.flat_price is not null then
      if line_sum > 0 then
        k := s.flat_price / line_sum;
        c_p := round(c_p * k); c_l := round(c_l * k); c_o := round(c_o * k); c_f := round(c_f * k);
        rem := s.flat_price - (c_p + c_l + c_o + c_f);
        if c_p >= greatest(c_l, c_o, c_f) then c_p := c_p + rem; elsif c_l >= greatest(c_o, c_f) then c_l := c_l + rem;
        elsif c_o >= c_f then c_o := c_o + rem; else c_f := c_f + rem; end if;
        line_taxable := line_taxable * k;
      else
        -- no priced lines: taxed like its lines (any taxable one), or with no lines, like new items (Settings)
        c_p := 0; c_l := s.flat_price; c_o := 0; c_f := 0;
        line_taxable := case when coalesce(any_taxable, st.new_items_taxable, false) then s.flat_price else 0 end;
      end if;
      svc_total := s.flat_price;
    else
      svc_total := line_sum;
    end if;
    svc_taxable := line_taxable;
    svc_disc := case when s.discount_pct > 0 then round(svc_total * s.discount_pct / 100) else least(s.discount_amount, svc_total) end;
    update ro_services set service_total = svc_total, service_discount = svc_disc, service_net = svc_total - svc_disc
      where id = s.id and (service_total, service_discount, service_net) is distinct from (svc_total, svc_disc, svc_total - svc_disc);
    if s.approval_status in ('pending','approved') then
      v_parts := v_parts + c_p; v_labor := v_labor + c_l; v_other := v_other + c_o; v_fees := v_fees + c_f;
      v_item_disc := v_item_disc + c_disc;
      v_svc_disc := v_svc_disc + svc_disc;
      if svc_total > 0 then v_taxable := v_taxable + svc_taxable * (svc_total - svc_disc) / svc_total; end if;
    end if;
  end loop;

  for f in select * from ro_job_fees where ro_id = p_ro loop
    if f.manual_override then
      v_amt := f.amount;
    elsif f.is_shop_supplies then
      -- the job's own rate (copied from Settings when the job was created, editable per job); base and min/max from Settings
      v_base := greatest(case st.shop_supplies_base when 'parts' then v_parts when 'labor' then v_labor else v_parts + v_labor end, 0);
      v_amt := case when f.kind = 'fixed' then round(f.value) else round(v_base * f.value / 100) end;
      if st.shop_supplies_min is not null then v_amt := greatest(v_amt, st.shop_supplies_min); end if;
      if st.shop_supplies_max is not null then v_amt := least(v_amt, st.shop_supplies_max); end if;
      if v_base = 0 then v_amt := 0; end if;
    elsif f.kind = 'percent' then
      v_amt := round(greatest(v_parts + v_labor, 0) * f.value / 100);
    else
      v_amt := round(f.value);
    end if;
    v_amt := greatest(v_amt, 0);
    update ro_job_fees set amount = v_amt where id = f.id and amount is distinct from v_amt;
    v_job_fees := v_job_fees + v_amt;
    if f.taxable then v_taxable_fees := v_taxable_fees + v_amt; end if;
  end loop;

  v_pre := v_parts + v_labor + v_other + v_fees - v_svc_disc + v_job_fees;

  for d in select * from ro_job_discounts where ro_id = p_ro loop
    v_amt := case when d.kind = 'percent' then round(v_pre * d.value / 100) else round(d.value) end;
    if d.max_amount is not null then v_amt := least(v_amt, d.max_amount); end if;
    v_amt := greatest(least(v_amt, v_pre - v_job_disc), 0);
    update ro_job_discounts set amount = v_amt where id = d.id and amount is distinct from v_amt;
    v_job_disc := v_job_disc + v_amt;
  end loop;

  v_subtotal := v_pre - v_job_disc;
  v_taxable := v_taxable + v_taxable_fees;
  if v_pre > 0 then v_taxable := v_taxable * (v_pre - v_job_disc) / v_pre; end if;
  v_taxable := round(v_taxable);
  if exists (select 1 from customers where id = ro.customer_id and tax_exempt) then v_taxable := 0; end if;
  v_tax := round(v_taxable * v_rate / 100);
  v_total := v_subtotal + v_tax;

  update repair_orders set
    parts_total = v_parts, labor_total = v_labor, other_total = v_other, service_fees_total = v_fees,
    item_discount_total = v_item_disc, service_discount_total = v_svc_disc,
    job_fees_total = v_job_fees, job_discount_total = v_job_disc,
    subtotal = v_subtotal, taxable_base = v_taxable, tax_total = v_tax, total = v_total,
    paid_total = v_paid, balance = v_total - v_paid,
    payment_status = case when v_paid >= v_total and v_total > 0 then 'paid' when v_paid > 0 then 'partial' else 'unpaid' end
  where id = p_ro;
end $$;

-- ===== 4. Deposits stay with the company that paid them
-- Money received on a job from one company since its last void (payments less refunds).
create or replace function public.job_deposit(p_ro uuid, p_customer uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when p.kind = 'payment' then p.amount else -p.amount end), 0)
  from payments p
  where p.ro_id = p_ro and p.customer_id = p_customer
    and p.created_at > coalesce((select max(voided_at) from invoice_voids where ro_id = p_ro), '-infinity')
$$;
revoke execute on function public.job_deposit(uuid, uuid) from public, anon, authenticated;

create or replace function public.guard_job_company_money() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is distinct from old.customer_id and auth.uid() is not null and not has_permission('record_payments')
     and job_deposit(new.id, old.customer_id) > 0 then
    raise exception 'This job has payments from its company. Ask someone who records payments to change the company';
  end if;
  return new;
end $$;
revoke execute on function public.guard_job_company_money() from public, anon, authenticated;
drop trigger if exists repair_orders_company_money on public.repair_orders;
create trigger repair_orders_company_money before update of customer_id on public.repair_orders
  for each row execute function guard_job_company_money();

-- Vehicle transfer (from 114, one check added)
create or replace function public.transfer_vehicle(p_vehicle uuid, p_to uuid, p_date date default null, p_odometer int default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from uuid;
begin
  if auth.uid() is not null and not has_permission('edit_customers') then raise exception 'Not allowed'; end if;
  select customer_id into v_from from vehicles where id = p_vehicle for update;
  if not found then raise exception 'Vehicle not found'; end if;
  if not exists (select 1 from customers where id = p_to) then raise exception 'Company not found'; end if;
  if v_from = p_to then return; end if;
  -- a deposit belongs to the company that paid it: it can't move to the new owner with the vehicle (131)
  if exists (select 1 from repair_orders r where r.vehicle_id = p_vehicle and r.order_status = 'estimate' and job_deposit(r.id, v_from) > 0) then
    raise exception 'A job on this vehicle has a deposit from the current company. Refund it before transferring the vehicle';
  end if;
  insert into vehicle_transfers (vehicle_id, from_customer_id, to_customer_id, transferred_at, odometer_km, note)
  values (p_vehicle, v_from, p_to, coalesce(p_date, local_date()), p_odometer, p_note);
  update vehicles set customer_id = p_to, mileage_km = coalesce(greatest(mileage_km, p_odometer), mileage_km) where id = p_vehicle;
  -- open jobs follow the vehicle (their payments, credits and linked appointments follow via triggers)
  update repair_orders set customer_id = p_to where vehicle_id = p_vehicle and order_status = 'estimate';
  -- future appointments not tied to a job move too; ones tied to an invoiced job stay with that job
  update appointments set customer_id = p_to
  where vehicle_id = p_vehicle and ro_id is null and start_time > now() and status not in ('cancelled','no_show') and customer_id is distinct from p_to;
end $$;

-- ===== 5. Approvals locked with the invoice; recorder and time fixed; status only through approvals
create or replace function public.guard_approval() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid := case when tg_op = 'DELETE' then old.ro_id else new.ro_id end;
begin
  if auth.uid() is not null and exists (select 1 from repair_orders where id = v_ro and order_status = 'invoice') then
    raise exception 'This job is invoiced. Void the invoice to change its approvals';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' then new.recorded_by := old.recorded_by; new.decided_at := old.decided_at; end if;
  if tg_op = 'INSERT' and auth.uid() is not null then new.decided_at := now(); end if;   -- when it was recorded, not backdated
  return new;
end $$;
revoke execute on function public.guard_approval() from public, anon, authenticated;
drop trigger if exists approvals_0_guard on public.approvals;
create trigger approvals_0_guard before insert or update or delete on public.approvals
  for each row execute function guard_approval();
revoke insert (approval_status), update (approval_status) on public.ro_services from authenticated;

-- ===== 6. Supplier bills leave out returned parts
create or replace function public.po_qty_returned(p_item uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(qty), 0) from returns where po_item_id = p_item
$$;
revoke execute on function public.po_qty_returned(uuid) from public, anon;
grant execute on function public.po_qty_returned(uuid) to authenticated;
create index if not exists returns_po_item_idx on public.returns (po_item_id);

-- pay_po_items (from 124 as changed by 129): delivered minus returned minus already paid
create or replace function public.pay_po_items(p_items uuid[], p_paid_at date, p_method text, p_reference text, p_expected numeric default null) returns numeric
language plpgsql security definer set search_path = public as $$
declare n int; v_sup uuid; v_amt numeric := 0; v_lines jsonb := '[]'; r record; a numeric; v_id uuid; v_date date := coalesce(p_paid_at, local_date());
begin
  if not has_permission('pay_supplier_bills') then raise exception 'Not allowed'; end if;
  if p_items is null or cardinality(p_items) = 0 then raise exception 'Pick at least one delivered line to pay'; end if;
  if v_date > local_date() then raise exception 'The payment date can''t be in the future'; end if;
  if p_method is not null and p_method not in ('transfer','cash','card','giro','other') then raise exception 'Unknown payment method'; end if;
  perform 1 from purchase_order_items where id = any(p_items) order by id for update;
  select count(distinct po.supplier_id), min(po.supplier_id::text)::uuid into n, v_sup
  from purchase_order_items i join purchase_orders po on po.id = i.po_id
  where i.id = any(p_items) and i.qty_delivered - po_qty_returned(i.id) > i.qty_paid;
  if n = 0 then raise exception 'Nothing left to pay on these lines'; end if;
  if n > 1 then raise exception 'Pay one supplier at a time'; end if;
  for r in select i.id, i.qty_delivered - po_qty_returned(i.id) - i.qty_paid as q, i.cost, i.core_cost, i.taxable, po.tax_rate
           from purchase_order_items i join purchase_orders po on po.id = i.po_id
           where i.id = any(p_items) and i.qty_delivered - po_qty_returned(i.id) > i.qty_paid order by i.id loop
    a := po_line_amount(r.cost, r.core_cost, r.q, r.taxable, r.tax_rate);
    v_amt := v_amt + a;
    v_lines := v_lines || jsonb_build_object('item', r.id, 'qty', r.q, 'amount', a);
  end loop;
  if p_expected is not null and p_expected <> v_amt then
    raise exception 'The amount to pay has changed since this was opened. Check it and try again.';
  end if;
  insert into supplier_payments (supplier_id, amount, paid_at, method, reference, po_item_ids, lines)
  values (v_sup, v_amt, v_date, p_method, nullif(left(btrim(p_reference), 200), ''),
          array(select (x->>'item')::uuid from jsonb_array_elements(v_lines) x), v_lines)
  returning id into v_id;
  update purchase_order_items i set qty_paid = i.qty_paid + (x->>'qty')::numeric, paid_at = v_date
  from jsonb_array_elements(v_lines) x where i.id = (x->>'item')::uuid;
  return v_amt;
end $$;
-- PO lines view (from 129) with qty_returned added at the end
create or replace view public.purchase_order_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.po_id, t.catalog_item_id, t.ro_service_item_id, t.name, t.part_number,
       case when p.supplier then t.cost end as cost,
       case when p.supplier then t.core_cost end as core_cost,
       t.taxable, t.qty_ordered, t.qty_delivered, t.qty_cancelled, t.delivered_at, t.supplier_invoice_no,
       t.invoice_date, t.payment_due, t.paid_at, t.created_at, t.qty_paid,
       public.po_qty_returned(t.id) as qty_returned
from public.purchase_order_items t
cross join p
where (select public.is_staff());

-- ===== 6b. A PO counts as paid once everything delivered and kept (not sent back) is paid; returns refresh it.
-- The dashboard's supplier bills leave out returned parts too.
create or replace function public.refresh_po_payment(p_po uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_pay text;
begin
  v_pay := case
      when exists (select 1 from purchase_order_items where po_id = p_po and qty_paid > 0)
           and not exists (select 1 from purchase_order_items i where i.po_id = p_po and i.qty_delivered - po_qty_returned(i.id) > i.qty_paid) then 'paid'
      when exists (select 1 from purchase_order_items where po_id = p_po and qty_paid > 0) then 'partial'
      else 'unpaid' end;
  update purchase_orders set payment_status = v_pay where id = p_po and payment_status is distinct from v_pay;
end $$;
revoke execute on function public.refresh_po_payment(uuid) from public, anon, authenticated;

create or replace function public.refresh_po_status() returns trigger language plpgsql security definer set search_path = public as $$
declare v_po uuid := coalesce(new.po_id, old.po_id); o numeric; d numeric; c numeric; cur text; v_new text;
begin
  select coalesce(sum(qty_ordered),0), coalesce(sum(qty_delivered),0), coalesce(sum(qty_cancelled),0) into o, d, c
  from purchase_order_items where po_id = v_po;
  select status into cur from purchase_orders where id = v_po;
  if cur is null then return null; end if;
  if not (cur = 'draft' and d = 0 and c = 0) then
    v_new := case
        when o > 0 and c >= o then 'cancelled'
        when o > 0 and d + c >= o then 'delivered'
        when d > 0 then 'partially_delivered'
        when cur = 'cancelled' then 'cancelled'
        when cur = 'draft' then 'draft'
        else 'ordered' end;
    update purchase_orders set status = v_new where id = v_po and status is distinct from v_new;
  end if;
  perform refresh_po_payment(v_po);
  return null;
end $$;

create or replace function public.returns_refresh_po() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' and old.po_item_id is not null then
    perform refresh_po_payment((select po_id from purchase_order_items where id = old.po_item_id));
  end if;
  if tg_op <> 'DELETE' and new.po_item_id is not null then
    perform refresh_po_payment((select po_id from purchase_order_items where id = new.po_item_id));
  end if;
  return null;
end $$;
revoke execute on function public.returns_refresh_po() from public, anon, authenticated;
drop trigger if exists returns_refresh_po on public.returns;
create trigger returns_refresh_po after insert or delete or update of qty, po_item_id on public.returns
  for each row execute function returns_refresh_po();

-- dashboard_summary (from 126 as it stands): bills owed = delivered - returned - paid
CREATE OR REPLACE FUNCTION public.dashboard_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  tz text := shop_tz(); d date := local_date();
  m0 date := date_trunc('month', local_date())::date; p0 date := (date_trunc('month', local_date()) - interval '1 month')::date;
  s0 date := (date_trunc('month', local_date()) - interval '5 months')::date;
  t_today timestamptz := shop_start(local_date()); t_tomorrow timestamptz := shop_start(local_date() + 1);
  v_money boolean := has_permission('view_reports'); v_costs boolean := has_permission('view_costs') or has_permission('pay_supplier_bills');
  out jsonb; money jsonb := null; bills jsonb := null; series jsonb := null; v_over int; v_soon int;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  select count(*) filter (where status = 'overdue'), count(*) filter (where status = 'due_soon') into v_over, v_soon from service_reminder_rows();
  out := jsonb_build_object(
    'today', d,
    -- bookings that overlap today on the shop calendar
    'bookings_today', (select count(*) from appointments a where a.status not in ('cancelled','no_show') and a.start_time < t_tomorrow and a.end_time > t_today),
    'requests', (select count(*) from appointments a where a.status = 'requested' and a.end_time > now()),
    'in_shop', (select coalesce(jsonb_object_agg(workflow_status, n), '{}') from (
                  select workflow_status, count(*) n from repair_orders
                  where order_status = 'estimate' and closed_at is null and workflow_status in ('scheduled','arrived','in_progress','waiting_parts','completed')
                  group by workflow_status) w),
    'open_estimates', (select count(*) from repair_orders where order_status = 'estimate' and closed_at is null and workflow_status = 'estimate'),
    -- open jobs with parts ordered that haven't all arrived
    'waiting_parts', (select count(distinct po.ro_id) from purchase_orders po join purchase_order_items pi on pi.po_id = po.id
                       join repair_orders r on r.id = po.ro_id
                       where po.status in ('ordered','partially_delivered') and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0
                         and r.order_status = 'estimate' and r.closed_at is null),
    'service_overdue', v_over,
    'service_due_soon', v_soon,
    'low_stock', (select count(*) from catalog_items where item_type = 'part' and track_inventory and active
                   and (qty_on_hand <= 0 or (reorder_point is not null and qty_on_hand <= reorder_point))),
    'cores_to_retrieve', (select count(*) from cores where retrieval_status = 'to_be_retrieved' and return_status = 'to_be_returned'),
    'cores_to_return', (select count(*) from cores where retrieval_status = 'retrieved' and return_status = 'to_be_returned'),
    'returns_open', (select count(distinct coalesce(batch_id, id)) from returns where status <> 'refunded')
  );
  if v_money then
    with inv as (select total, invoiced_at from repair_orders where order_status = 'invoice' and invoiced_at >= shop_start(p0) and invoiced_at < t_tomorrow),
         open_inv as (select balance, coalesce(due_date, shop_day(invoiced_at)) as due from repair_orders where order_status = 'invoice' and balance > 0)
    select jsonb_build_object(
      'invoiced_mtd', (select coalesce(sum(total), 0) from inv where invoiced_at >= shop_start(m0)),
      'invoices_mtd', (select count(*) from inv where invoiced_at >= shop_start(m0)),
      -- last month up to the same day, so the comparison is fair early in the month
      'invoiced_prev', (select coalesce(sum(total), 0) from inv where invoiced_at >= shop_start(p0) and invoiced_at < shop_start(least(p0 + (d - m0), m0 - 1) + 1)),
      'received_mtd', net_received(shop_start(m0), t_tomorrow),
      'outstanding', (select coalesce(sum(balance), 0) from open_inv),
      'open_invoices', (select count(*) from open_inv),
      'overdue', (select coalesce(sum(balance), 0) from open_inv where due < d),
      'overdue_invoices', (select count(*) from open_inv where due < d),
      'overdue_90', (select coalesce(sum(balance), 0) from open_inv where due < d - 90))
    into money;
    -- six months in one pass per table
    with months as (select g::date as ms from generate_series(s0::timestamp, m0::timestamp, interval '1 month') g),
         inv as (select date_trunc('month', invoiced_at at time zone tz)::date as ms, sum(total) as v from repair_orders
                 where order_status = 'invoice' and invoiced_at >= shop_start(s0) and invoiced_at < t_tomorrow group by 1),
         pay as (select date_trunc('month', paid_at at time zone tz)::date as ms, sum(case when kind = 'payment' then amount else -amount end) as v from payments
                 where source = 'manual' and paid_at >= shop_start(s0) and paid_at < t_tomorrow group by 1),
         crf as (select date_trunc('month', refunded_at at time zone tz)::date as ms, sum(amount) as v from credit_memos
                 where refunded_at >= shop_start(s0) and refunded_at < t_tomorrow group by 1)
    select jsonb_agg(jsonb_build_object('month', to_char(months.ms, 'YYYY-MM'), 'invoiced', coalesce(inv.v, 0),
                                        'received', coalesce(pay.v, 0) - coalesce(crf.v, 0)) order by months.ms)
      into series
      from months left join inv on inv.ms = months.ms left join pay on pay.ms = months.ms left join crf on crf.ms = months.ms;
  end if;
  if v_costs then
    with owed as (
      select po_line_amount(pi.cost, pi.core_cost, pi.qty_delivered - po_qty_returned(pi.id) - pi.qty_paid, pi.taxable, po.tax_rate) as amt,
             coalesce(pi.payment_due, coalesce(pi.invoice_date, pi.delivered_at) + coalesce(po.payment_terms_days, s.payment_terms_days, 0)) as due
      from purchase_order_items pi join purchase_orders po on po.id = pi.po_id left join suppliers s on s.id = po.supplier_id
      where pi.qty_delivered - po_qty_returned(pi.id) > pi.qty_paid)
    select jsonb_build_object('owed', coalesce(sum(amt), 0),
                              'overdue', coalesce(sum(amt) filter (where due < d), 0),
                              'due_7', coalesce(sum(amt) filter (where due between d and d + 7), 0))
      into bills from owed;
  end if;
  return out || jsonb_build_object('money', money, 'series', series, 'bills', bills);
end $function$;

-- POs already paid in full apart from returned parts
select public.refresh_po_payment(id) from public.purchase_orders;


revoke all on public.purchase_order_items_read from public, anon, authenticated;
grant select on public.purchase_order_items_read to authenticated;

-- ===== 7. Which project this is
create table if not exists public.app_environment (
  id boolean primary key default true check (id),             -- one row at most
  name text not null check (name in ('production', 'staging', 'development')),
  set_at timestamptz not null default now()
);
alter table public.app_environment enable row level security;
revoke all on public.app_environment from public, anon, authenticated;
create or replace function public.app_environment_fixed() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'The environment marker can''t be changed or removed';
end $$;
revoke execute on function public.app_environment_fixed() from public, anon, authenticated;
drop trigger if exists app_environment_fixed on public.app_environment;
create trigger app_environment_fixed before update or delete on public.app_environment
  for each row execute function app_environment_fixed();
drop trigger if exists app_environment_no_truncate on public.app_environment;
create trigger app_environment_no_truncate before truncate on public.app_environment
  for each statement execute function app_environment_fixed();

-- ===== 8. Voided invoices: also listed in the period they were issued; the replacing invoice shown
drop function if exists public.report_voids(date, date);
create function public.report_voids(p_from date, p_to date)
returns table (id uuid, ro_id uuid, invoice_number bigint, invoiced_on date, voided_on date, total numeric, reason text, customer_id uuid,
               company text, reissued_number bigint, reissued_on date)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz;
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select x.id, x.ro_id, x.invoice_number, shop_day(x.invoiced_at), shop_day(x.voided_at), x.total, x.reason,
         coalesce((x.snapshot->'job'->>'customer_id')::uuid, r.customer_id), c.display_name,
         nx.no, shop_day(nx.at)
  from invoice_voids x left join repair_orders r on r.id = x.ro_id
  -- the first invoice issued on the job after this void: a later voided one, or the one it has now
  left join lateral (
    select y.no, y.at from (
      select v2.invoice_number as no, v2.invoiced_at as at from invoice_voids v2 where v2.ro_id = x.ro_id and v2.invoiced_at > x.voided_at
      union all
      select r.invoice_number, r.invoiced_at where r.order_status = 'invoice' and r.invoiced_at > x.voided_at
    ) y order by y.at limit 1) nx on true
  left join customers c on c.id = coalesce((x.snapshot->'job'->>'customer_id')::uuid, r.customer_id)
  where (x.voided_at >= a and x.voided_at < b) or (x.invoiced_at >= a and x.invoiced_at < b)
  order by x.voided_at;
end $$;
revoke execute on function public.report_voids(date, date) from public, anon;
grant execute on function public.report_voids(date, date) to authenticated;

-- ===== Small one from the audit: a fixed search path on the report date check
alter function public.check_report_range(date, date) set search_path = public;
