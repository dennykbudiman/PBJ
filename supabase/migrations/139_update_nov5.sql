-- Axle v2 · 139 Updates of Nov 5, 2026 (Denny, after the advisor simulation)
--
-- 1. Stock fix: a typed-in part received on a job's PO and only then added to the catalog ended at −1 after invoicing
--    (the receipt wasn't counted, but the job line came off the shelf). That receipt now always goes into stock.
-- 2. A job's PO price fills the job line: when a PO line for a job line gets a cost, the job line's cost and price
--    (cost × default markup) follow while they are still 0 (or still the previous suggestion).
-- 3. Each complaint added to a job makes a service of the same name, linked to it (shop setting, on).
-- 4. The job's "Alur kerja" moves by itself (shop setting, on): km in → Sudah datang, work started → Dikerjakan,
--    part on order → Menunggu part, all work done → Selesai. Moving a job to Selesai by hand finishes its services.
-- 5. Km out is no longer needed to invoice.
-- 6. (Nov 6) Hari ini page (day_summary), what each open job waits for (jobs_waiting), stock card per part
--    (stock_card), and a unit for parts (catalog_items.unit).
--
-- Run once in the SQL Editor, after 138. Safe to re-run.

-- Shop settings -------------------------------------------------------------------------------------------------------
alter table public.shop_settings add column if not exists auto_concern_services boolean not null default true;
alter table public.shop_settings add column if not exists auto_workflow boolean not null default true;
grant update (auto_concern_services, auto_workflow) on public.shop_settings to authenticated;

-- 1. Typed-in parts into the catalog: receipts for open job lines always count ----------------------------------------
-- Same as 138, plus: a received PO line whose job line is added in the same go (and is on an open job, so it switches
-- to the catalog part and comes off the shelf at invoicing) puts what came in into stock, whatever the stock choice.
-- That is a documented delivery, not a stock correction, so it doesn't need adjust_stock. A received PO line and its
-- open job line can only be added together (one without the other would leave the delivery uncounted).
create or replace function public.link_typed_part(p_item uuid, p_job_lines uuid[], p_po_lines uuid[], p_count boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_received numeric := 0; v_used numeric := 0; v_change numeric := 0; v_auto numeric := 0; v_jobs int := 0; v_pos int := 0;
  v_open uuid[] := '{}'; v_got numeric; v_tracked boolean;
  r record;
begin
  if not has_permission('edit_catalog') then raise exception 'Only people who edit the catalog can add parts to it'; end if;
  if not exists (select 1 from catalog_items where id = p_item and item_type = 'part') then raise exception 'Part not found'; end if;
  p_job_lines := coalesce(p_job_lines, '{}'); p_po_lines := coalesce(p_po_lines, '{}');
  if cardinality(p_job_lines) + cardinality(p_po_lines) = 0 then raise exception 'Choose the lines to add'; end if;
  if exists (select 1 from typed_part_links where line_id = any(p_job_lines || p_po_lines)) then
    raise exception 'Some of these lines were already added to the catalog';
  end if;
  select track_inventory into v_tracked from catalog_items where id = p_item;

  -- job lines: typed-in parts only
  for r in select i.id, i.qty, i.po_item_id, i.catalog_item_id, i.item_type, ro.order_status
             from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders ro on ro.id = s.ro_id
            where i.id = any(p_job_lines) for update of i loop
    if r.item_type <> 'part' or r.catalog_item_id is not null then raise exception 'Only typed-in parts can be added to the catalog'; end if;
    -- already used: on an invoiced job. Lines on open jobs switch to the catalog part and come off the shelf when their
    -- job is invoiced (every approved catalog line does, also one covered by a PO delivery).
    if r.order_status = 'invoice' then v_used := v_used + r.qty; end if;
    if r.order_status <> 'invoice' then
      if exists (select 1 from purchase_order_items pi where pi.ro_service_item_id = r.id and pi.qty_delivered > 0
                   and pi.catalog_item_id is null and not (pi.id = any(p_po_lines))
                   and not exists (select 1 from typed_part_links k where k.line_id = pi.id)) then
        raise exception 'Add the job line together with its received PO line';
      end if;
      update ro_service_items set catalog_item_id = p_item where id = r.id;
      v_open := v_open || r.id;
    end if;
    v_jobs := v_jobs + 1;
  end loop;
  if v_jobs <> cardinality(p_job_lines) then raise exception 'A job line was not found'; end if;

  -- PO lines: typed-in parts only; a line still waiting for part of its delivery must be received or cancelled first
  for r in select pi.id, pi.qty_delivered, pi.qty_ordered, pi.qty_cancelled, pi.catalog_item_id, pi.ro_service_item_id,
                  pi.delivered_at, pi.created_at, ji.catalog_item_id as job_item, jro.order_status as job_status
             from purchase_order_items pi
             left join ro_service_items ji on ji.id = pi.ro_service_item_id
             left join ro_services js on js.id = ji.service_id
             left join repair_orders jro on jro.id = js.ro_id
            where pi.id = any(p_po_lines) for update of pi loop
    if r.catalog_item_id is not null then raise exception 'Only typed-in parts can be added to the catalog'; end if;
    if r.qty_delivered > 0 and r.qty_ordered - r.qty_delivered - r.qty_cancelled > 0 then
      raise exception 'Receive or cancel the rest of a PO line before adding it to the catalog';
    end if;
    if r.qty_delivered > 0 and r.ro_service_item_id is not null and not (r.ro_service_item_id = any(v_open))
       and r.job_status = 'estimate' and r.job_item is null then
      raise exception 'Add the job line together with its received PO line';
    end if;
    if r.qty_delivered > 0 then
      v_got := r.qty_delivered - po_qty_returned(r.id);
      -- for an open job line added now (or one already switched to this part earlier): on the shelf now, off at invoicing
      if r.ro_service_item_id = any(v_open) or (r.job_status = 'estimate' and r.job_item = p_item) then
        if v_tracked and v_got <> 0 then
          insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id, note, created_at)
          values (p_item, v_got, 'po_delivery', r.id, 'Part di luar katalog ditambahkan: sudah datang untuk pekerjaan yang masih terbuka',
                  case when r.delivered_at is null or r.delivered_at >= local_date() then now()
                       else (r.delivered_at + time '12:00') at time zone coalesce((select timezone from shop_settings limit 1), 'Asia/Makassar') end);
        end if;
        v_auto := v_auto + v_got;
      else
        v_received := v_received + v_got;
      end if;
    elsif r.ro_service_item_id is null
       or (select catalog_item_id from ro_service_items where id = r.ro_service_item_id) = p_item then
      update purchase_order_items set catalog_item_id = p_item where id = r.id;
    else
      -- it is for a job line that stays typed-in: its delivery would never reach stock
      raise exception 'A PO line still to come is for a job line that isn''t added with it; add them together';
    end if;
    v_pos := v_pos + 1;
  end loop;
  if v_pos <> cardinality(p_po_lines) then raise exception 'A PO line was not found'; end if;

  v_change := round(v_received - v_used, 2);
  if p_count and v_change <> 0 then
    if not has_permission('adjust_stock') then
      raise exception 'Only an Owner or Admin can put these parts into stock; choose "start at 0" or ask them';
    end if;
    if not v_tracked then
      raise exception 'Stock is not tracked for this part';
    end if;
    insert into stock_movements (catalog_item_id, qty_change, reason, note)
    values (p_item, v_change, 'adjustment', format('Part di luar katalog ditambahkan: %s diterima lewat PO, %s terpakai', v_received, v_used));
  end if;

  insert into typed_part_links (line_id, source, catalog_item_id)
  select x, 'job', p_item from unnest(p_job_lines) x
  union all select x, 'po', p_item from unnest(p_po_lines) x;

  return jsonb_build_object('job_lines', v_jobs, 'po_lines', v_pos, 'received', v_received, 'used', v_used,
                            'for_open_jobs', case when v_tracked then v_auto else 0 end,
                            'stock_change', (case when p_count then v_change else 0 end) + (case when v_tracked then v_auto else 0 end));
end;
$$;
revoke execute on function public.link_typed_part(uuid, uuid[], uuid[], boolean) from public, anon;
grant execute on function public.link_typed_part(uuid, uuid[], uuid[], boolean) to authenticated;

-- 2. A job's PO price fills the job line ------------------------------------------------------------------------------
-- Only on open jobs, only part lines. Cost follows while it is 0 (or still a cost taken from a PO line for it, e.g. one
-- cancelled and ordered again); price follows while it is 0 (or still such a suggestion), at the shop's default markup.
-- Prices typed on the job are kept.
create or replace function public.po_cost_to_job_line() returns trigger language plpgsql security definer set search_path = public as $$
declare l ro_service_items%rowtype; v_m numeric; v_new numeric; v_prev numeric; v_cost numeric; v_price numeric; v_from_po boolean; v_sug boolean;
begin
  if new.ro_service_item_id is null or coalesce(new.cost, 0) <= 0 then return null; end if;
  if tg_op = 'UPDATE' and new.cost is not distinct from old.cost and new.ro_service_item_id is not distinct from old.ro_service_item_id then
    return null;
  end if;
  select i.* into l from ro_service_items i where i.id = new.ro_service_item_id for update;
  if not found or l.item_type <> 'part' then return null; end if;
  if not exists (select 1 from ro_services s join repair_orders ro on ro.id = s.ro_id
                  where s.id = l.service_id and ro.order_status = 'estimate' and ro.closed_at is null) then
    return null;
  end if;
  v_m := coalesce((select default_markup_pct from shop_settings limit 1), 0);
  v_new := round(new.cost * (1 + v_m / 100));
  v_prev := case when tg_op = 'UPDATE' and coalesce(old.cost, 0) > 0 and old.ro_service_item_id is not distinct from new.ro_service_item_id
                 then old.cost end;
  -- the job line's cost / price still came from a PO line for it (this one before the change, or another one)
  v_from_po := l.cost = v_prev
               or exists (select 1 from purchase_order_items o where o.ro_service_item_id = l.id and o.id <> new.id and o.cost = l.cost);
  v_sug := l.price = round(v_prev * (1 + v_m / 100))
           or exists (select 1 from purchase_order_items o where o.ro_service_item_id = l.id and o.id <> new.id and round(o.cost * (1 + v_m / 100)) = l.price);
  v_cost := case when coalesce(l.cost, 0) = 0 or coalesce(v_from_po, false) then new.cost else l.cost end;
  v_price := case when coalesce(l.price, 0) = 0 or coalesce(v_sug, false) then v_new else l.price end;
  if v_cost is distinct from l.cost or v_price is distinct from l.price then
    update ro_service_items set cost = v_cost, price = v_price where id = l.id;
    -- the totals trigger skips writes made inside other triggers, so the job's totals are worked out here
    perform recalc_repair_order((select ro_id from ro_services where id = l.service_id));
  end if;
  return null;
end $$;
revoke execute on function public.po_cost_to_job_line() from public, anon, authenticated;
drop trigger if exists po_items_cost_to_job on public.purchase_order_items;
create trigger po_items_cost_to_job after insert or update of cost, ro_service_item_id on public.purchase_order_items
  for each row execute function public.po_cost_to_job_line();

-- 3. Complaints make services ------------------------------------------------------------------------------------------
-- The service takes the complaint's words (first letter capital). A service of that name already on the job is linked
-- to the complaint instead of making a second one. While the service is untouched (same name, no lines, no package,
-- not done), editing the complaint renames it; removing the complaint removes it if it also isn't started and has no
-- mechanic.
create or replace function public.concern_service_name(p_text text) returns text language sql immutable set search_path = public as $$
  select left(upper(left(t, 1)) || substr(t, 2), 200) from (select regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g') as t) x
$$;

create or replace function public.concern_to_service() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not coalesce((select auto_concern_services from shop_settings limit 1), false) then return null; end if;
    if concern_service_name(new.text) = '' then return null; end if;
    if (select order_status from repair_orders where id = new.ro_id) is distinct from 'estimate' then return null; end if;
    if exists (select 1 from ro_services where concern_id = new.id) then return null; end if;
    if exists (select 1 from ro_services where ro_id = new.ro_id and lower(btrim(name)) = lower(concern_service_name(new.text))) then
      update ro_services set concern_id = new.id
       where id = (select id from ro_services where ro_id = new.ro_id and lower(btrim(name)) = lower(concern_service_name(new.text))
                     and concern_id is null order by position limit 1);
      return null;
    end if;
    insert into ro_services (ro_id, name, concern_id, position)
    values (new.ro_id, concern_service_name(new.text), new.id,
            coalesce((select max(position) + 1 from ro_services where ro_id = new.ro_id), 0));
  elsif tg_op = 'UPDATE' then
    if new.text is distinct from old.text and concern_service_name(new.text) <> '' then
      update ro_services s set name = concern_service_name(new.text)
       where s.concern_id = new.id and s.name = concern_service_name(old.text) and s.template_id is null
         and s.work_status <> 'completed' and not exists (select 1 from ro_service_items i where i.service_id = s.id);
    end if;
  end if;
  return null;
end $$;
revoke execute on function public.concern_to_service() from public, anon, authenticated;
drop trigger if exists ro_concerns_make_service on public.ro_concerns;
create trigger ro_concerns_make_service after insert or update of text on public.ro_concerns
  for each row execute function public.concern_to_service();

create or replace function public.concern_drop_service() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    delete from ro_services s
     where s.concern_id = old.id and s.name = concern_service_name(old.text) and s.template_id is null
       and s.work_status = 'todo' and s.technician_id is null
       and not exists (select 1 from ro_service_items i where i.service_id = s.id);
  exception when others then null;   -- something else still points at it: keep the service
  end;
  return old;
end $$;
revoke execute on function public.concern_drop_service() from public, anon, authenticated;
drop trigger if exists ro_concerns_drop_service on public.ro_concerns;
create trigger ro_concerns_drop_service before delete on public.ro_concerns
  for each row execute function public.concern_drop_service();

-- 4. Alur kerja moves by itself ---------------------------------------------------------------------------------------
-- Worked out from the job, once the truck is here (km in recorded, or already Sudah datang or later): all approved
-- work done → Selesai (empty services, e.g. a complaint that needed nothing, don't count); a part still to come on an ordered PO → Menunggu part; a mechanic on approved work or work
-- started → Dikerjakan; otherwise Sudah datang. An estimate or a booked job whose truck isn't here stays as it is.
-- "Menunggu part" set by hand (no PO for the job) is kept until the work is done. Only open, unclosed estimates; the
-- status can still be set by hand.
create or replace function public.refresh_job_workflow(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; n_appr int; n_done int; v_started boolean; v_waiting boolean; v_had_po boolean; v_target text;
begin
  if p_ro is null or not coalesce((select auto_workflow from shop_settings limit 1), false) then return; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found or ro.order_status <> 'estimate' or ro.closed_at is not null then return; end if;
  if ro.odometer_in is null and ro.workflow_status not in ('arrived', 'in_progress', 'waiting_parts', 'completed') then return; end if;
  -- services nobody worked on (no lines, not started, no mechanic, no package) don't count: they hold nothing to do
  -- and are removed when the invoice is made
  select count(*) filter (where approval_status = 'approved'),
         count(*) filter (where approval_status = 'approved' and work_status = 'completed'),
         coalesce(bool_or(approval_status = 'approved' and (work_status <> 'todo' or technician_id is not null)), false)
    into n_appr, n_done, v_started
    from ro_services s where s.ro_id = p_ro
     and (s.work_status <> 'todo' or s.technician_id is not null or s.template_id is not null
          or exists (select 1 from ro_service_items i where i.service_id = s.id));
  v_waiting := exists (select 1 from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
                        where po.ro_id = p_ro and po.status in ('ordered', 'partially_delivered')
                          and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0);
  v_had_po := exists (select 1 from purchase_orders po where po.ro_id = p_ro and po.status <> 'draft');
  v_target := case
    when n_appr > 0 and n_done = n_appr then 'completed'
    when v_waiting then 'waiting_parts'
    when ro.workflow_status = 'waiting_parts' and not v_had_po then 'waiting_parts'
    when v_started then 'in_progress'
    else 'arrived' end;
  if v_target is distinct from ro.workflow_status then
    perform set_config('axle.auto_workflow', 'on', true);
    update repair_orders set workflow_status = v_target where id = p_ro;
    perform set_config('axle.auto_workflow', 'off', true);
  end if;
end $$;
revoke execute on function public.refresh_job_workflow(uuid) from public, anon, authenticated;

create or replace function public.trg_refresh_job_workflow() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'ro_services' then
    perform refresh_job_workflow(coalesce(new.ro_id, old.ro_id));
    if tg_op = 'UPDATE' and new.ro_id is distinct from old.ro_id then perform refresh_job_workflow(old.ro_id); end if;
  elsif tg_table_name = 'repair_orders' then
    perform refresh_job_workflow(new.id);
  elsif tg_table_name = 'purchase_orders' then
    perform refresh_job_workflow(coalesce(new.ro_id, old.ro_id));
  elsif tg_table_name = 'purchase_order_items' then
    perform refresh_job_workflow((select ro_id from purchase_orders where id = coalesce(new.po_id, old.po_id)));
  end if;
  return null;
end $$;
revoke execute on function public.trg_refresh_job_workflow() from public, anon, authenticated;

drop trigger if exists ro_services_workflow on public.ro_services;
create trigger ro_services_workflow after insert or delete or update of work_status, technician_id, approval_status on public.ro_services
  for each row execute function public.trg_refresh_job_workflow();
drop trigger if exists repair_orders_workflow_km on public.repair_orders;
create trigger repair_orders_workflow_km after insert or update of odometer_in on public.repair_orders
  for each row when (new.odometer_in is not null) execute function public.trg_refresh_job_workflow();
drop trigger if exists purchase_orders_workflow on public.purchase_orders;
create trigger purchase_orders_workflow after update of status on public.purchase_orders
  for each row when (new.ro_id is not null) execute function public.trg_refresh_job_workflow();
drop trigger if exists po_items_workflow on public.purchase_order_items;
create trigger po_items_workflow after insert or delete or update of qty_ordered, qty_delivered, qty_cancelled on public.purchase_order_items
  for each row execute function public.trg_refresh_job_workflow();

-- Moving a job to Selesai by hand (job page or board) finishes its approved work, so the two agree (services nobody
-- worked on are left alone; the invoice removes them).
create or replace function public.job_completed_finishes_services() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('axle.auto_workflow', true) = 'on' then return null; end if;
  if not coalesce((select auto_workflow from shop_settings limit 1), false) then return null; end if;
  update ro_services s set work_status = 'completed'
   where s.ro_id = new.id and s.approval_status = 'approved' and s.work_status <> 'completed'
     and (s.work_status <> 'todo' or s.technician_id is not null or s.template_id is not null
          or exists (select 1 from ro_service_items i where i.service_id = s.id));
  return null;
end $$;
revoke execute on function public.job_completed_finishes_services() from public, anon, authenticated;
drop trigger if exists repair_orders_completed_services on public.repair_orders;
create trigger repair_orders_completed_services after update of workflow_status on public.repair_orders
  for each row when (new.workflow_status = 'completed' and old.workflow_status is distinct from 'completed' and new.order_status = 'estimate')
  execute function public.job_completed_finishes_services();

-- A package put on an existing service (e.g. one made from a complaint) links the vehicle's schedule for it, as a
-- package added as a new service does.
drop trigger if exists ro_services_0_link_schedule_upd on public.ro_services;
create trigger ro_services_0_link_schedule_upd before update of template_id on public.ro_services
  for each row when (new.template_id is distinct from old.template_id) execute function public.link_service_schedule();

-- 5. Km out no longer needed to invoice (Denny, Nov 5) -----------------------------------------------------------------
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.convert_to_invoice(uuid)'::regprocedure);
  changed := replace(src,
    E'  -- Denny, Oct 7: an invoice needs the km out and a technician on every approved service\n  if ro.odometer_out is null then raise exception ''Enter the km out before invoicing''; end if;\n  if ro.odometer_in is not null and ro.odometer_out < ro.odometer_in then raise exception ''The km out can''''t be lower than the km in''; end if;\n',
    E'  -- Denny, Oct 7: an invoice needs a technician on every approved service (km out no longer needed: Nov 5)\n');
  if changed = src then
    if position('Enter the km out before invoicing' in src) > 0 then raise exception 'convert_to_invoice: km out check not found as expected'; end if;
  else
    execute changed;
  end if;
end $$;

-- 6. Hari ini, "Menunggu apa" and the stock card (Denny, Nov 6, from the previews) ------------------------------------
-- A unit for a part ("L", "pcs", "set"), shown next to its quantities on the stock card, stock list and Hari ini.
alter table public.catalog_items add column if not exists unit text;
do $$ begin
  alter table public.catalog_items add constraint catalog_items_unit_len check (char_length(unit) <= 12);
exception when duplicate_object then null; end $$;
grant select (unit), insert (unit), update (unit) on public.catalog_items to authenticated;

create or replace view public.catalog_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.item_type, t.name, t.code, t.description, t.category_id, t.supplier_id, t.brand,
  case when p.costs then t.cost else null::numeric end as cost,
  case when p.money then t.price else null::numeric end as price,
  case when p.costs then t.markup_pct else null::numeric end as markup_pct,
  t.default_qty, t.labor_hours, t.labor_rate_id, t.fee_kind,
  case when p.money then t.fee_value else null::numeric end as fee_value,
  t.taxable, t.show_on_invoice, t.show_qty_price, t.track_inventory, t.qty_on_hand, t.reorder_point, t.has_core,
  case when p.costs then t.core_cost else null::numeric end as core_cost,
  t.tire_size, t.notes, t.active, t.created_at, t.updated_at,
  t.alt_numbers, t.fits, t.unit
from public.catalog_items t cross join p
where (select public.is_staff());
revoke all on public.catalog_items_read from public, anon;
grant select on public.catalog_items_read to authenticated;

-- What each open job is waiting for: one reason per job, the first that holds, in this order:
--   pickup (invoiced, not picked up) · not_arrived (no km in yet) · approval (services waiting for a yes) ·
--   part (PO line still to arrive, or set to Menunggu part by hand) · po_draft (PO made, not sent) ·
--   no_work (no service with anything in it) · no_tech · work (services not finished) · zero_price (part at Rp 0) · ready.
-- Services nobody touched (no lines, mechanic or package, still to do) don't count, as for the status moving by itself.
create or replace function public.jobs_waiting(p_ids uuid[] default null)
returns table (ro_id uuid, kind text, info jsonb)
language sql stable security definer set search_path = public as $$
  with j as (
    select r.id, r.order_status, r.workflow_status, r.odometer_in from repair_orders r
     where (select is_staff()) and r.archived_at is null and r.closed_at is null and (p_ids is null or r.id = any (p_ids))),
  sv as (
    select s.ro_id, s.id, s.name, s.position, s.approval_status, s.work_status, s.technician_id, s.flat_price,
           (s.work_status <> 'todo' or s.technician_id is not null or s.template_id is not null
            or exists (select 1 from ro_service_items i where i.service_id = s.id)) as live
      from ro_services s where s.ro_id in (select id from j)),
  agg as (
    select sv.ro_id,
           count(*) filter (where approval_status = 'pending' and live) as pending,
           count(*) filter (where approval_status = 'approved' and live) as appr,
           count(*) filter (where approval_status = 'approved' and live and technician_id is null and work_status <> 'completed') as no_tech,
           count(*) filter (where approval_status = 'approved' and live and work_status <> 'completed') as open,
           (array_agg(name order by position, id) filter (where approval_status = 'approved' and live and work_status <> 'completed'))[1] as open_name,
           (array_agg(technician_id order by position, id) filter (where approval_status = 'approved' and live and work_status <> 'completed' and technician_id is not null))[1] as open_tech
      from sv group by sv.ro_id),
  zero as (
    select sv.ro_id, count(*) as n from sv join ro_service_items i on i.service_id = sv.id
     where sv.approval_status = 'approved' and sv.flat_price is null and i.item_type = 'part' and i.price = 0
     group by sv.ro_id),
  po as (
    select distinct on (p.ro_id) p.ro_id, p.id as po_id, p.po_number, p.ordered_at, sp.name as supplier, pi.name as part,
           count(*) over (partition by p.ro_id) as n
      from purchase_orders p join purchase_order_items pi on pi.po_id = p.id left join suppliers sp on sp.id = p.supplier_id
     where p.ro_id in (select id from j) and p.status in ('ordered', 'partially_delivered')
       and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0
     order by p.ro_id, p.ordered_at nulls last, pi.created_at, pi.id),
  draft as (
    select distinct on (p.ro_id) p.ro_id, p.id as po_id, p.po_number, count(*) over (partition by p.ro_id) as n
      from purchase_orders p
     where p.ro_id in (select id from j) and p.status = 'draft' and exists (select 1 from purchase_order_items pi where pi.po_id = p.id)
     order by p.ro_id, p.created_at, p.id),
  ap as (
    select distinct on (a.ro_id) a.ro_id, a.start_time from appointments a
     where a.ro_id in (select id from j) and a.status in ('requested', 'scheduled', 'confirmed') and a.end_time > now()
     order by a.ro_id, a.start_time, a.id)
  select j.id,
    case
      when j.order_status <> 'estimate' then 'pickup'
      when j.odometer_in is null and j.workflow_status in ('estimate', 'scheduled') then 'not_arrived'
      when coalesce(a.pending, 0) > 0 then 'approval'
      when po.ro_id is not null or j.workflow_status = 'waiting_parts' and draft.ro_id is null then 'part'
      when draft.ro_id is not null then 'po_draft'
      when coalesce(a.appr, 0) = 0 then 'no_work'
      when a.no_tech > 0 then 'no_tech'
      when a.open > 0 then 'work'
      when coalesce(z.n, 0) > 0 then 'zero_price'
      else 'ready' end,
    jsonb_strip_nulls(jsonb_build_object(
      'pending', nullif(a.pending, 0), 'no_tech', nullif(a.no_tech, 0), 'open', nullif(a.open, 0), 'open_name', a.open_name,
      'tech', (select name from profiles where id = a.open_tech), 'zero', z.n, 'appt', ap.start_time,
      'po_id', po.po_id, 'po_number', po.po_number, 'supplier', po.supplier, 'part', po.part, 'parts', po.n, 'ordered_at', po.ordered_at,
      'draft_id', draft.po_id, 'draft_number', draft.po_number, 'drafts', draft.n))
  from j left join agg a on a.ro_id = j.id left join zero z on z.ro_id = j.id left join po on po.ro_id = j.id
    left join draft on draft.ro_id = j.id left join ap on ap.ro_id = j.id;
$$;
revoke execute on function public.jobs_waiting(uuid[]) from public, anon;
grant execute on function public.jobs_waiting(uuid[]) to authenticated;

-- Supplier bills still owed, with their due dates (same reckoning as the dashboard and Bills tab).
create or replace function public.supplier_bills_owed() returns table (amt numeric, due date)
language sql stable security definer set search_path = public as $$
  select po_line_amount(pi.cost, pi.core_cost, pi.qty_delivered - po_qty_returned(pi.id) - pi.qty_paid, pi.taxable, po.tax_rate),
         coalesce(pi.payment_due, coalesce(pi.invoice_date, pi.delivered_at) + coalesce(po.payment_terms_days, s.payment_terms_days, 0))
    from purchase_order_items pi join purchase_orders po on po.id = pi.po_id left join suppliers s on s.id = po.supplier_id
   where pi.qty_delivered - po_qty_returned(pi.id) > pi.qty_paid;
$$;
revoke execute on function public.supplier_bills_owed() from public, anon, authenticated;

-- Hari ini: one day in the shop. Money only for people who see reports, part values and bills only for people who see
-- costs (or pay supplier bills); what's still in the shop only for today.
create or replace function public.day_summary(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  today date := local_date(); d date := least(coalesce(p_day, local_date()), local_date());
  t0 timestamptz; t1 timestamptz;
  v_money boolean := has_permission('view_reports'); v_costs boolean := has_permission('view_costs');
  v_bills boolean := has_permission('view_costs') or has_permission('pay_supplier_bills');
  out jsonb; v_next date;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  t0 := shop_start(d); t1 := shop_start(d + 1);
  out := jsonb_build_object(
    'day', d, 'today', today, 'money', v_money, 'costs', v_costs,
    'opened', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'job_number', r.job_number, 'plate', v.plate, 'company', c.display_name)
                                         order by r.created_at, r.id), '[]')
                 from repair_orders r left join vehicles v on v.id = r.vehicle_id left join customers c on c.id = r.customer_id
                where r.created_at >= t0 and r.created_at < t1),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'invoice_number', r.invoice_number, 'job_number', r.job_number,
                                                              'at', r.invoiced_at, 'plate', v.plate, 'company', c.display_name,
                                                              'total', case when v_money then r.total end) order by r.invoiced_at, r.id), '[]')
                   from repair_orders r left join vehicles v on v.id = r.vehicle_id left join customers c on c.id = r.customer_id
                  where r.order_status = 'invoice' and r.invoiced_at >= t0 and r.invoiced_at < t1),
    'invoiced_total', case when v_money then (select coalesce(sum(total), 0) from repair_orders
                                               where order_status = 'invoice' and invoiced_at >= t0 and invoiced_at < t1) end,
    'received', case when v_money then net_received(t0, t1) end,
    -- catalog parts taken off the shelf by jobs invoiced that day (less any put back by reopening)
    'parts_out', (select coalesce(jsonb_agg(to_jsonb(q) order by q.name), '[]') from (
                    select ci.id, ci.name, ci.unit, -sum(m.qty_change) as qty, ci.qty_on_hand as on_hand, count(distinct s.ro_id) as jobs
                      from stock_movements m join catalog_items ci on ci.id = m.catalog_item_id
                      left join ro_service_items i on i.id = m.ro_service_item_id left join ro_services s on s.id = i.service_id
                     where m.reason in ('used_on_job', 'job_reversal') and m.created_at >= t0 and m.created_at < t1
                     group by ci.id having sum(m.qty_change) <> 0) q),
    -- PO deliveries of that day, one by one from the activity log (a line delivered in parts shows each part on its own
    -- day; a delivery entered later counts on the delivery date it was given)
    'parts_in', (select coalesce(jsonb_agg(jsonb_build_object('po_id', p.id, 'po_number', p.po_number, 'supplier', sp.name, 'name', pi.name,
                                                              'qty', x.qty, 'unit', ci.unit, 'ro_id', p.ro_id, 'job_number', r.job_number,
                                                              'value', case when v_costs then po_line_amount(pi.cost, pi.core_cost, x.qty, pi.taxable, p.tax_rate) end)
                                           order by p.po_number, pi.created_at, pi.id), '[]')
                   from (select a.entity_id as id,
                                sum((a.changes->'qty_delivered'->>1)::numeric - coalesce((a.changes->'qty_delivered'->>0)::numeric, 0)) as qty
                           from activity_log a
                          where a.entity_type = 'purchase_order_items' and a.action = 'update' and a.changes ? 'qty_delivered'
                            and a.created_at >= t0 - interval '1 day'
                            and coalesce((a.changes->'delivered_at'->>1)::date, shop_day(a.created_at)) = d
                          group by a.entity_id) x
                   join purchase_order_items pi on pi.id = x.id join purchase_orders p on p.id = pi.po_id
                   left join suppliers sp on sp.id = p.supplier_id left join catalog_items ci on ci.id = pi.catalog_item_id
                   left join repair_orders r on r.id = p.ro_id
                  where x.qty <> 0));
  if d = today then
    out := out || jsonb_build_object('in_shop', (
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'job_number', r.job_number, 'plate', v.plate,
                                                   'vehicle', nullif(concat_ws(' ', v.make, v.model), ''), 'company', c.display_name,
                                                   'status', r.workflow_status, 'kind', w.kind, 'info', w.info)
                                order by array_position(array['invoiced', 'paid', 'completed', 'waiting_parts', 'in_progress', 'arrived', 'scheduled', 'estimate'], r.workflow_status), r.job_number), '[]')
        from repair_orders r left join vehicles v on v.id = r.vehicle_id left join customers c on c.id = r.customer_id
        left join jobs_waiting() w on w.ro_id = r.id
       -- trucks that are here, counted as on the dashboard ("Di bengkel"): open jobs from Sudah datang to Selesai
       where r.order_status = 'estimate' and r.closed_at is null and r.archived_at is null
         and r.workflow_status in ('arrived', 'in_progress', 'waiting_parts', 'completed')));
  end if;
  if v_bills then
    select min(due) into v_next from supplier_bills_owed() where due > today + 7;
    out := out || jsonb_build_object('bills', (
      select jsonb_build_object('overdue', coalesce(sum(amt) filter (where due < today), 0),
                                'due_7', coalesce(sum(amt) filter (where due between today and today + 7), 0),
                                'next_due', v_next, 'next_amount', coalesce(sum(amt) filter (where due = v_next), 0))
        from supplier_bills_owed()));
  end if;
  return out;
end $$;
revoke execute on function public.day_summary(date) from public, anon;
grant execute on function public.day_summary(date) to authenticated;

-- Stock card for one part: what's here, what jobs used lately, what open estimates and POs will change, and the
-- latest 300 movements with the job, invoice, vehicle or PO behind each and the balance after it.
create or replace function public.stock_card(p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare it catalog_items%rowtype; t0 timestamptz := shop_start(local_date()); w0 timestamptz := shop_start(local_date() - 6);
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  select * into it from catalog_items where id = p_item and item_type = 'part';
  if not found then raise exception 'Part not found'; end if;
  return jsonb_build_object(
    'item', jsonb_build_object('id', it.id, 'name', it.name, 'code', it.code, 'brand', it.brand, 'unit', it.unit, 'active', it.active,
                               'track_inventory', it.track_inventory, 'qty_on_hand', it.qty_on_hand, 'reorder_point', it.reorder_point,
                               'supplier', (select name from suppliers where id = it.supplier_id)),
    'used_today', (select coalesce(-sum(qty_change), 0) from stock_movements
                    where catalog_item_id = p_item and reason in ('used_on_job', 'job_reversal') and created_at >= t0),
    'used_7d', (select coalesce(-sum(qty_change), 0) from stock_movements
                 where catalog_item_id = p_item and reason in ('used_on_job', 'job_reversal') and created_at >= w0),
    'jobs_7d', (select count(distinct s.ro_id) from stock_movements m join ro_service_items i on i.id = m.ro_service_item_id
                  join ro_services s on s.id = i.service_id
                 where m.catalog_item_id = p_item and m.reason = 'used_on_job' and m.created_at >= w0),
    'on_estimates', (select coalesce(jsonb_agg(jsonb_build_object('ro_id', r.id, 'job_number', r.job_number, 'plate', v.plate, 'qty', q.qty)
                                               order by r.job_number), '[]')
                       from (select s.ro_id, sum(i.qty) as qty from ro_service_items i join ro_services s on s.id = i.service_id
                               join repair_orders r on r.id = s.ro_id
                              where i.catalog_item_id = p_item and not i.stock_deducted and r.order_status = 'estimate' and r.closed_at is null
                                and s.approval_status in ('pending', 'approved')
                              group by s.ro_id) q
                       join repair_orders r on r.id = q.ro_id left join vehicles v on v.id = r.vehicle_id),
    'on_order', (select coalesce(jsonb_agg(jsonb_build_object('po_id', p.id, 'po_number', p.po_number, 'supplier', sp.name,
                                                              'qty', pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled, 'ordered_at', p.ordered_at)
                                           order by p.ordered_at nulls last, p.po_number), '[]')
                   from purchase_order_items pi join purchase_orders p on p.id = pi.po_id left join suppliers sp on sp.id = p.supplier_id
                  where pi.catalog_item_id = p_item and p.status in ('ordered', 'partially_delivered')
                    and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0),
    'moves_total', (select count(*) from stock_movements where catalog_item_id = p_item),
    -- stock from before the history began (e.g. set when the part was imported)
    'start', it.qty_on_hand - (select coalesce(sum(qty_change), 0) from stock_movements where catalog_item_id = p_item),
    'moves', (select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc, x.id desc), '[]') from (
                select m.id, m.created_at as at, m.reason, m.qty_change as qty, m.note,
                       it.qty_on_hand - coalesce(sum(m.qty_change) over (order by m.created_at desc, m.id desc
                                                                         rows between unbounded preceding and 1 preceding), 0) as balance,
                       pr.name as who, r.id as ro_id, r.job_number, r.invoice_number, v.plate,
                       p.id as po_id, p.po_number, sp.name as supplier
                  from stock_movements m
                  left join profiles pr on pr.id = m.created_by
                  left join ro_service_items i on i.id = m.ro_service_item_id left join ro_services s on s.id = i.service_id
                  left join repair_orders r on r.id = s.ro_id left join vehicles v on v.id = r.vehicle_id
                  left join returns rt on rt.id = m.return_id
                  left join purchase_order_items pi on pi.id = coalesce(m.po_item_id, rt.po_item_id) left join purchase_orders p on p.id = pi.po_id
                  left join suppliers sp on sp.id = coalesce(p.supplier_id, rt.supplier_id)
                 where m.catalog_item_id = p_item
                 order by m.created_at desc, m.id desc limit 300) x));
end $$;
revoke execute on function public.stock_card(uuid) from public, anon;
grant execute on function public.stock_card(uuid) to authenticated;
