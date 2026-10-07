-- Axle v2 · 127 more reports (stage 9b): profit, technicians, fleet spend, inventory, service compliance
-- Read-only reports, plus one small addition: when a scheduled service is completed, what it was due at is kept
-- (service_schedule_log), so "done on time / late" can be reported from now on.
--   report_profit(from, to)          per invoice: sales by kind and the cost of the parts and sublet on it   (view_reports + view_costs)
--   report_technicians(from, to)     per service on invoices: technician, hours charged, hours worked, labor  (view_reports)
--   report_fleet(from, to)           per invoice: the vehicle, its km reading and what was spent              (view_reports)
--   report_inventory(from, to)       per stocked item: on hand, value at cost, used / received in the period  (view_reports + view_costs)
--   report_service_status()          every active service schedule and its state today; vehicles with none    (view_reports)
--   report_service_done(from, to)    scheduled services completed in the period, on time or late              (view_reports)
-- Invoices are counted on their invoice date in shop time and voided ones are left out, as in the sales report.

-- ===== keep what a scheduled service was due at when it is done
create table if not exists public.service_schedule_log (
  id uuid primary key default gen_random_uuid(),
  ro_service_id uuid not null references public.ro_services(id) on delete cascade deferrable initially deferred,
  schedule_id uuid references public.service_schedules(id) on delete set null,
  ro_id uuid not null references public.repair_orders(id) on delete cascade deferrable initially deferred,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  due_km int,            -- what the schedule said just before this service was done (empty: first time / no due yet)
  due_date date,
  done_km int,           -- km on the job (km out, else km in, else the vehicle's km)
  done_date date,        -- shop day it was completed
  created_at timestamptz not null default now()
);
-- One record per service and schedule; the first one is kept (see on_service_completed).
create unique index if not exists service_schedule_log_service_schedule on public.service_schedule_log (ro_service_id, schedule_id);
create index if not exists service_schedule_log_done_idx on public.service_schedule_log (done_date);
create index if not exists service_schedule_log_schedule_idx on public.service_schedule_log (schedule_id);
create index if not exists service_schedule_log_ro_idx on public.service_schedule_log (ro_id);
create index if not exists service_schedule_log_vehicle_idx on public.service_schedule_log (vehicle_id);
alter table public.service_schedule_log enable row level security;   -- read only through the report functions
revoke all on public.service_schedule_log from public, anon, authenticated;

create or replace function public.on_service_completed() returns trigger language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; km int; v_newly boolean; tp service_templates%rowtype; v_km int; v_months int; v_day date;
        v_due_km int; v_due_date date; v_started boolean := false;
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
      select next_due_km, next_due_date into v_due_km, v_due_date from service_schedules where id = new.service_schedule_id;
    end if;
    -- The first record for a service and schedule is kept: completing it again, or linking it away and back,
    -- would otherwise see a due point this same service has already moved on.
    insert into service_schedule_log (ro_service_id, schedule_id, ro_id, vehicle_id, due_km, due_date, done_km, done_date)
    values (new.id, new.service_schedule_id, new.ro_id, ro.vehicle_id, v_due_km, v_due_date, km, v_day)
    on conflict (ro_service_id, schedule_id) do nothing;
    update service_schedules set
      last_done_km = case when km is null then last_done_km else greatest(coalesce(last_done_km, 0), km) end,
      last_done_date = greatest(coalesce(last_done_date, v_day), v_day)
    where id = new.service_schedule_id;
  end if;
  if v_newly and km is not null then update vehicles set mileage_km = greatest(coalesce(mileage_km,0), km) where id = ro.vehicle_id; end if;
  return new;
end $$;

create index if not exists stock_movements_created_at_idx on public.stock_movements (created_at);

-- ===== profit
-- Cost = the cost price on each part and sublet line of the invoice (as it was when invoiced) × qty.
-- Core charges are passed on at cost (charged and paid alike), so they are added on both sides.
-- Labor and fees have no cost here (wages aren't recorded in Axle).
-- (Dates are turned into shop days with the time zone read once: a per-row function call is slow on big periods.)
create or replace function public.report_profit(p_from date, p_to date)
returns table (ro_id uuid, invoice_number bigint, invoiced_on date, job_number bigint, customer_id uuid, company text, plate text,
               parts numeric, parts_cost numeric, sublet numeric, sublet_cost numeric, labor numeric, fees numeric, discounts numeric,
               subtotal numeric, no_cost_lines int)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
begin
  if not (has_permission('view_reports') and has_permission('view_costs')) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  with inv as (
    select * from repair_orders r where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
  ), k as (
    select s.ro_id,
           round(sum(coalesce(i.cost, 0) * i.qty + coalesce(i.core_charge, 0) * i.qty) filter (where i.item_type = 'part')) as parts_cost,
           round(sum(coalesce(i.cost, 0) * i.qty) filter (where i.item_type = 'sublet')) as sublet_cost,
           count(*) filter (where i.item_type in ('part', 'sublet') and coalesce(i.cost, 0) = 0 and i.qty > 0 and i.net > 0) as no_cost
    from inv join ro_services s on s.ro_id = inv.id join ro_service_items i on i.service_id = s.id
    where s.approval_status in ('pending', 'approved')
    group by s.ro_id
  )
  select r.id, r.invoice_number, (r.invoiced_at at time zone tz)::date, r.job_number, r.customer_id, c.display_name, v.plate,
         r.parts_total, coalesce(k.parts_cost, 0), r.other_total, coalesce(k.sublet_cost, 0), r.labor_total,
         r.service_fees_total + r.job_fees_total, r.service_discount_total + r.job_discount_total, r.subtotal,
         coalesce(k.no_cost, 0)::int
  from inv r
  left join k on k.ro_id = r.id
  left join customers c on c.id = r.customer_id
  left join vehicles v on v.id = r.vehicle_id
  order by r.invoiced_at, r.invoice_number;
end $$;

-- ===== technicians
-- One row per service on the invoices. Labor = the service's labor lines after line discounts, before service and
-- job discounts (the same as Labor in the sales report). A flat-priced service's labor is its share of the flat price,
-- worked out exactly as the invoice did (each kind rounded, the rounding left-over to the biggest kind).
-- Hours charged = qty on labor lines; hours worked = what was typed in "Hours worked" (empty when not typed).
create or replace function public.report_technicians(p_from date, p_to date)
returns table (ro_id uuid, invoice_number bigint, invoiced_on date, job_number bigint, customer_id uuid, company text, plate text,
               service_id uuid, service_name text, technician_id uuid, technician text,
               hours_sold numeric, hours_worked numeric, hours_sold_timed numeric, labor numeric)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  with inv as (
    select * from repair_orders r where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
  ), x as (
    select i.service_id,
           sum(i.qty) filter (where i.item_type = 'labor') as hours_sold,
           sum(i.hours_worked) filter (where i.item_type = 'labor' and i.hours_worked is not null) as hours_worked,
           sum(i.qty) filter (where i.item_type = 'labor' and i.hours_worked is not null) as hours_sold_timed,
           coalesce(sum(i.net + round(coalesce(i.core_charge, 0) * i.qty)) filter (where i.item_type = 'part'), 0) as p,
           coalesce(sum(i.net) filter (where i.item_type = 'labor'), 0) as l,
           coalesce(sum(i.net) filter (where i.item_type = 'sublet'), 0) as o,
           coalesce(sum(i.net) filter (where i.item_type = 'fee'), 0) as f,
           coalesce(sum(i.net + round(coalesce(i.core_charge, 0) * i.qty)), 0) as line_sum
    from inv join ro_services s on s.ro_id = inv.id join ro_service_items i on i.service_id = s.id
    group by i.service_id
  )
  select r.id, r.invoice_number, (r.invoiced_at at time zone tz)::date, r.job_number, r.customer_id, c.display_name, v.plate,
         s.id, s.name, s.technician_id, p.name,
         coalesce(x.hours_sold, 0), x.hours_worked, coalesce(x.hours_sold_timed, 0),
         case when s.flat_price is null then coalesce(x.l, 0)
              when coalesce(x.line_sum, 0) <= 0 then s.flat_price
              when not (q.rp >= greatest(q.rl, q.ro, q.rf)) and q.rl >= greatest(q.ro, q.rf)
                then q.rl + (s.flat_price - (q.rp + q.rl + q.ro + q.rf))
              else q.rl end
  from inv r
  join ro_services s on s.ro_id = r.id and s.approval_status in ('pending', 'approved')
  left join x on x.service_id = s.id
  left join lateral (
    select round(x.p * k.k) as rp, round(x.l * k.k) as rl, round(x.o * k.k) as ro, round(x.f * k.k) as rf
    from (select s.flat_price / nullif(x.line_sum, 0) as k) k
  ) q on true
  left join profiles p on p.id = s.technician_id
  left join customers c on c.id = r.customer_id
  left join vehicles v on v.id = r.vehicle_id
  order by r.invoiced_at, r.invoice_number, s.position, s.id;
end $$;

-- ===== fleet spend
create or replace function public.report_fleet(p_from date, p_to date)
returns table (ro_id uuid, invoice_number bigint, invoiced_on date, job_number bigint, customer_id uuid, company text,
               vehicle_id uuid, plate text, make text, model text, year int, vehicle_type text, km int,
               parts numeric, labor numeric, sublet numeric, fees numeric, discounts numeric, subtotal numeric, tax numeric, total numeric)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select r.id, r.invoice_number, (r.invoiced_at at time zone tz)::date, r.job_number, r.customer_id, c.display_name,
         r.vehicle_id, v.plate, v.make, v.model, v.year, v.type, coalesce(r.odometer_out, r.odometer_in),
         r.parts_total, r.labor_total, r.other_total, r.service_fees_total + r.job_fees_total,
         r.service_discount_total + r.job_discount_total, r.subtotal, r.tax_total, r.total
  from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
  where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
  order by c.display_name, v.plate, r.invoiced_at, r.id;
end $$;

-- ===== inventory
-- Every item kept in stock. Value = on hand × the catalog cost today.
-- Used = taken off for jobs in the period and still standing: when an invoice is voided its parts go back to the shelf,
-- and that usage and its reversal both drop out (if the job is invoiced again, the new usage counts on its new date).
-- Usage whose job line no longer exists was necessarily voided first (invoiced lines can't be deleted), so it is out too.
-- Used value = qty × the cost on the job line.
drop function if exists public.report_inventory(date, date);
create or replace function public.report_inventory(p_from date, p_to date)
returns table (item_id uuid, name text, code text, brand text, category text, supplier text, active boolean,
               qty_on_hand numeric, reorder_point numeric, cost numeric, value numeric,
               used_qty numeric, used_value numeric, received_qty numeric, adjusted_qty numeric,
               last_used date, last_received date, last_stocked date)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
begin
  if not (has_permission('view_reports') and has_permission('view_costs')) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  with rev as (
    select m.ro_service_item_id, max(m.created_at) as last_rev
    from stock_movements m where m.reason = 'job_reversal' and m.ro_service_item_id is not null
    group by m.ro_service_item_id
  ), standing as (
    select m.catalog_item_id, m.qty_change, m.created_at, m.ro_service_item_id
    from stock_movements m left join rev on rev.ro_service_item_id = m.ro_service_item_id
    where m.reason = 'used_on_job' and m.ro_service_item_id is not null and (rev.last_rev is null or m.created_at > rev.last_rev)
  ), used as (
    select u.catalog_item_id as id, -sum(u.qty_change) as used_qty,
           round(-sum(u.qty_change * coalesce(i.cost, ci.cost, 0))) as used_value
    from standing u join catalog_items ci on ci.id = u.catalog_item_id left join ro_service_items i on i.id = u.ro_service_item_id
    where u.created_at >= a and u.created_at < b
    group by u.catalog_item_id
  ), io as (
    select m.catalog_item_id as id,
           sum(m.qty_change) filter (where m.reason = 'po_delivery') as received_qty,
           sum(m.qty_change) filter (where m.reason in ('opening', 'adjustment', 'return')) as adjusted_qty
    from stock_movements m where m.created_at >= a and m.created_at < b and m.reason in ('po_delivery', 'opening', 'adjustment', 'return')
    group by m.catalog_item_id
  ), last_use as (
    select u.catalog_item_id as id, max(u.created_at) as at from standing u group by u.catalog_item_id
  ), last_in as (
    select m.catalog_item_id as id,
           max(m.created_at) filter (where m.reason = 'po_delivery') as received_at,
           max(m.created_at) as stocked_at
    from stock_movements m where m.qty_change > 0 and m.reason in ('opening', 'po_delivery', 'adjustment', 'return')
    group by m.catalog_item_id
  )
  select ci.id, ci.name, ci.code, ci.brand, cat.name, s.name, ci.active,
         ci.qty_on_hand, ci.reorder_point, ci.cost, round(greatest(ci.qty_on_hand, 0) * coalesce(ci.cost, 0)),
         coalesce(used.used_qty, 0), coalesce(used.used_value, 0), coalesce(io.received_qty, 0), coalesce(io.adjusted_qty, 0),
         (last_use.at at time zone tz)::date, (last_in.received_at at time zone tz)::date, (last_in.stocked_at at time zone tz)::date
  from catalog_items ci
  left join categories cat on cat.id = ci.category_id
  left join suppliers s on s.id = ci.supplier_id
  left join used on used.id = ci.id
  left join io on io.id = ci.id
  left join last_use on last_use.id = ci.id
  left join last_in on last_in.id = ci.id
  where ci.track_inventory and (ci.active or ci.qty_on_hand <> 0 or used.id is not null or io.id is not null)
  order by ci.name, ci.id;
end $$;

-- ===== service compliance
-- Status today uses the same rules and "due soon" settings as the reminders bell.
create or replace function public.report_service_status()
returns table (schedule_id uuid, name text, vehicle_id uuid, plate text, make text, model text, customer_id uuid, company text,
               mileage_km int, interval_km int, interval_months int, last_done_km int, last_done_date date,
               next_due_km int, next_due_date date, status text, km_over int, days_over int)
language plpgsql stable security definer set search_path = public as $$
declare v_soon_km int; v_soon_days int; d date := local_date();
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  select coalesce(due_soon_km, 1000), coalesce(due_soon_days, 14) into v_soon_km, v_soon_days from shop_settings limit 1;
  v_soon_km := coalesce(v_soon_km, 1000); v_soon_days := coalesce(v_soon_days, 14);
  return query
  select * from (
    select ss.id, ss.name, v.id, v.plate, v.make, v.model, v.customer_id, c.display_name,
           v.mileage_km, ss.interval_km, ss.interval_months, ss.last_done_km, ss.last_done_date, ss.next_due_km, ss.next_due_date,
           case
             when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km) or (ss.next_due_date is not null and d >= ss.next_due_date) then 'overdue'
             when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km - v_soon_km)
               or (ss.next_due_date is not null and d >= ss.next_due_date - v_soon_days) then 'due_soon'
             else 'ok' end,
           case when ss.next_due_km is not null and v.mileage_km >= ss.next_due_km then v.mileage_km - ss.next_due_km end,
           case when ss.next_due_date is not null and d >= ss.next_due_date then d - ss.next_due_date end
    from service_schedules ss join vehicles v on v.id = ss.vehicle_id left join customers c on c.id = v.customer_id
    where ss.active and v.status not in ('sold', 'inactive')
    union all
    -- vehicles in use, of companies still active, with no schedule switched on
    select null, null, v.id, v.plate, v.make, v.model, v.customer_id, c.display_name, v.mileage_km,
           null, null, null, null, null, null, 'none', null, null
    from vehicles v left join customers c on c.id = v.customer_id
    where v.status not in ('sold', 'inactive') and coalesce(c.active, true)
      and not exists (select 1 from service_schedules ss where ss.vehicle_id = v.id and ss.active)
  ) z
  order by 8, 4, 2, 3, 1;
end $$;

-- Scheduled services completed in the period, while the service is still marked completed and still linked to that
-- schedule. Shown under the company the job was for. on_time: true / false, or null when nothing was due yet or it
-- can't be compared (no km reading against a km-only due point). Done exactly at the due point counts as on time.
create or replace function public.report_service_done(p_from date, p_to date)
returns table (ro_service_id uuid, ro_id uuid, job_number bigint, invoice_number bigint, vehicle_id uuid, plate text, customer_id uuid, company text,
               schedule_id uuid, name text, due_km int, due_date date, done_km int, done_date date,
               on_time boolean, km_late int, days_late int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  return query
  with l as (
    -- one record per service: the one for its current schedule (after a schedule is deleted, the earliest)
    select distinct on (x.ro_service_id) x.*
    from service_schedule_log x
    join ro_services s on s.id = x.ro_service_id and s.work_status = 'completed' and s.service_schedule_id is not distinct from x.schedule_id
    where x.done_date between p_from and p_to
    order by x.ro_service_id, x.created_at, x.id
  )
  select l.ro_service_id, l.ro_id, r.job_number, r.invoice_number, l.vehicle_id, v.plate, r.customer_id, c.display_name,
         l.schedule_id, coalesce(ss.name, s.name), l.due_km, l.due_date, l.done_km, l.done_date,
         case
           when (l.due_km is not null and l.done_km is not null and l.done_km > l.due_km)
             or (l.due_date is not null and l.done_date > l.due_date) then false
           when (l.due_km is not null and l.done_km is not null) or l.due_date is not null then true
           else null end,
         case when l.due_km is not null and l.done_km > l.due_km then l.done_km - l.due_km end,
         case when l.due_date is not null and l.done_date > l.due_date then l.done_date - l.due_date end
  from l
  join ro_services s on s.id = l.ro_service_id
  join repair_orders r on r.id = l.ro_id
  left join service_schedules ss on ss.id = l.schedule_id
  left join vehicles v on v.id = l.vehicle_id
  left join customers c on c.id = r.customer_id
  order by l.done_date, v.plate, l.id;
end $$;

-- ===== one call per report
-- The API returns at most 1.000 rows per request ("Max rows"). A report returned as one JSON value isn't cut off,
-- and runs once (paging would run the whole report again for every page). Each report still checks permissions itself.
create or replace function public.report_rows(p_report text, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare out jsonb;
begin
  case p_report
    when 'report_sales' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_sales(p_from, p_to) with ordinality t;
    when 'report_voids' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_voids(p_from, p_to) with ordinality t;
    when 'report_aging' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_aging() with ordinality t;
    when 'report_open_credits' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_open_credits() with ordinality t;
    when 'report_payments' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_payments(p_from, p_to) with ordinality t;
    when 'report_profit' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_profit(p_from, p_to) with ordinality t;
    when 'report_technicians' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_technicians(p_from, p_to) with ordinality t;
    when 'report_fleet' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_fleet(p_from, p_to) with ordinality t;
    when 'report_inventory' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_inventory(p_from, p_to) with ordinality t;
    when 'report_service_status' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_service_status() with ordinality t;
    when 'report_service_done' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_service_done(p_from, p_to) with ordinality t;
    else raise exception 'Unknown report';
  end case;
  return coalesce(out, '[]'::jsonb);
end $$;
revoke execute on function public.report_rows(text, date, date) from public, anon;
grant execute on function public.report_rows(text, date, date) to authenticated;

revoke execute on function public.report_profit(date, date), public.report_technicians(date, date), public.report_fleet(date, date),
  public.report_inventory(date, date), public.report_service_status(), public.report_service_done(date, date) from public, anon;
grant execute on function public.report_profit(date, date), public.report_technicians(date, date), public.report_fleet(date, date),
  public.report_inventory(date, date), public.report_service_status(), public.report_service_done(date, date) to authenticated;
revoke execute on function public.on_service_completed() from public, anon, authenticated;
