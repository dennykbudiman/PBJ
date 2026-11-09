-- Axle v2 · 141: sublet work on a PO, and PO lines that stay connected to their job lines (Denny, Nov 7 and Nov 9, 2026)
--
--  18. Sublet lines can be ordered on a job's PO, from any supplier (a tyre shop supplies the tyres and fits them on
--      one PO). Part lines still go to parts suppliers only, and a sublet shop only gets POs for a job.
--      Sublet PO lines never touch stock and can't be returned.
--  19. A job line's cost fills its PO line while the PO line is still at Rp 0 or at the job's old cost, nothing on it
--      is paid and it isn't cancelled. (The other direction, PO → job, is 139's po_cost_to_job_line.)
--  20. A job line and its PO line stay in step: the name both ways (open jobs only; an issued invoice never changes),
--      the quantity both ways only while the PO is a draft. PO lines that aren't on the job can be added to it
--      (add_po_lines_to_job) or linked to a matching job line.
--
-- Safe to run more than once. Every UPDATE has a WHERE (Supabase loads safeupdate for app requests).

-- ===== 1. A PO line is a part or outside work ===================================================================
alter table public.purchase_order_items add column if not exists line_type text not null default 'part';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'po_item_line_type' and conrelid = 'public.purchase_order_items'::regclass) then
    alter table public.purchase_order_items add constraint po_item_line_type check (line_type in ('part', 'sublet'));
  end if;
end $$;
-- the app writes PO lines column by column (grants per column, as in 124)
grant select (line_type), insert (line_type), update (line_type) on public.purchase_order_items to authenticated;
-- PO lines view (from 131) with line_type added at the end
create or replace view public.purchase_order_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.po_id, t.catalog_item_id, t.ro_service_item_id, t.name, t.part_number,
       case when p.supplier then t.cost end as cost,
       case when p.supplier then t.core_cost end as core_cost,
       t.taxable, t.qty_ordered, t.qty_delivered, t.qty_cancelled, t.delivered_at, t.supplier_invoice_no,
       t.invoice_date, t.payment_due, t.paid_at, t.created_at, t.qty_paid,
       public.po_qty_returned(t.id) as qty_returned,
       t.line_type
from public.purchase_order_items t
cross join p
where (select public.is_staff());
revoke all on public.purchase_order_items_read from public, anon, authenticated;
grant select on public.purchase_order_items_read to authenticated;

-- ===== 2. The PO line guard (from 124 / 138), with sublet lines and first links after delivery ===================
create or replace function public.guard_po_item() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_po purchase_orders%rowtype; v_other text; v_job_item uuid; v_job_type text; v_found boolean; v_sup_type text;
        v_job_open boolean; v_taken boolean;
begin
  if tg_op = 'DELETE' then
    if old.qty_delivered > 0 then raise exception 'This line has deliveries and can''t be deleted. Return it to the supplier instead.'; end if;
    return old;
  end if;
  select * into v_po from purchase_orders where id = new.po_id;
  if tg_op = 'INSERT' and v_po.status = 'cancelled' then
    raise exception 'This PO is cancelled; add the part to a new PO';
  end if;
  new.name := btrim(new.name);
  if new.name = '' then raise exception 'Enter the part name'; end if;
  new.part_number := nullif(btrim(new.part_number), '');
  new.supplier_invoice_no := nullif(btrim(new.supplier_invoice_no), '');
  if tg_op = 'UPDATE' then
    if old.qty_delivered > 0 and new.catalog_item_id is distinct from old.catalog_item_id then
      raise exception 'This line has deliveries; its part can''t be changed';
    end if;
    -- a delivered line keeps its job line: linking it for the first time is fine (141: put a PO part on the job);
    -- moving it to another job line, or unlinking it while that job line still exists, is not. (When the job line is
    -- deleted, the link is cleared after the line is gone, so that still works.)
    if old.qty_delivered > 0 and old.ro_service_item_id is not null and new.ro_service_item_id is distinct from old.ro_service_item_id
       and (new.ro_service_item_id is not null or exists (select 1 from ro_service_items where id = old.ro_service_item_id)) then
      raise exception 'This line has deliveries; its job link can''t be changed';
    end if;
    if old.qty_delivered > 0 and new.line_type is distinct from old.line_type then
      raise exception 'This line has deliveries; it can''t change between part and sublet';
    end if;
    if new.qty_ordered > old.qty_ordered and (v_po.status = 'cancelled' or old.qty_cancelled > 0) then
      raise exception 'A cancelled line can''t be ordered again; add a new line';
    end if;
    if old.qty_paid > 0 and (new.cost <> old.cost or new.core_cost <> old.core_cost or new.taxable <> old.taxable) then
      raise exception 'This line has been paid; undo the payment before changing its price';
    end if;
  end if;
  if new.ro_service_item_id is not null and (tg_op = 'INSERT' or new.ro_service_item_id is distinct from old.ro_service_item_id
                                            or new.catalog_item_id is distinct from old.catalog_item_id
                                            or new.line_type is distinct from old.line_type) then
    -- lock the job line, so two orders for the same part can't both get through
    select i.catalog_item_id, i.item_type, true, i.stock_deducted, (ro.order_status = 'estimate' and ro.closed_at is null)
      into v_job_item, v_job_type, v_found, v_taken, v_job_open
      from ro_service_items i join ro_services sv on sv.id = i.service_id join repair_orders ro on ro.id = sv.ro_id
     where i.id = new.ro_service_item_id for update of i;
    if not coalesce(v_found, false) or v_job_type not in ('part', 'sublet') then
      raise exception 'Only part and sublet lines can be ordered';
    end if;
    if not v_job_open or v_taken then
      raise exception 'This job is invoiced or closed; its lines can''t be linked to a PO';
    end if;
    -- a PO line is what its job line is: a part, or outside work (a delivered line can't become the other kind by
    -- being linked, 142c)
    if tg_op = 'UPDATE' and old.qty_delivered > 0 and v_job_type is distinct from old.line_type then
      raise exception 'This line has deliveries; it can''t change between part and sublet';
    end if;
    new.line_type := v_job_type;
    -- a typed-in line added to the catalog after it arrived (138) may or may not have been counted into stock, so it
    -- can't be tied to a job line now: put the catalog part on the job instead (it comes off the shelf at invoicing)
    if new.qty_delivered > 0 and new.catalog_item_id is null
       and exists (select 1 from typed_part_links where line_id = new.id and source = 'po') then
      raise exception 'This part was added to the catalog after it arrived, so it can''t be linked to a job line. Add the catalog part to the job instead.';
    end if;
    -- the PO line is the same part as the job line it is for (what arrives is what the invoice takes off the shelf)
    if new.catalog_item_id is null and v_job_item is not null then
      if new.qty_delivered > 0 then raise exception 'A PO line must be the same part as the job line it is for'; end if;
      new.catalog_item_id := v_job_item;
    elsif new.catalog_item_id is distinct from v_job_item then
      raise exception 'A PO line must be the same part as the job line it is for';
    end if;
    if v_po.ro_id is null or v_po.ro_id is distinct from (select sv.ro_id from ro_service_items i join ro_services sv on sv.id = i.service_id where i.id = new.ro_service_item_id) then
      raise exception 'A PO line can only be linked to a part on the same job';
    end if;
    select po.po_number into v_other from ro_service_items i join purchase_order_items pi on pi.id = i.po_item_id join purchase_orders po on po.id = pi.po_id
    where i.id = new.ro_service_item_id and i.po_item_id <> new.id and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0;
    if found then raise exception 'This part is already on PO %', v_other; end if;
  end if;
  if new.line_type = 'sublet' then
    if new.catalog_item_id is not null then raise exception 'Outside work (sublet) can''t be a catalog part'; end if;
    if v_po.ro_id is null then raise exception 'Outside work (sublet) can only be ordered for a job'; end if;
    if new.core_cost <> 0 then raise exception 'Outside work (sublet) has no core charge'; end if;
  end if;
  if new.catalog_item_id is not null and (tg_op = 'INSERT' or new.catalog_item_id is distinct from old.catalog_item_id)
     and not exists (select 1 from catalog_items where id = new.catalog_item_id and item_type = 'part') then
    raise exception 'Only parts can go on a purchase order';
  end if;
  if new.line_type = 'part' and (tg_op = 'INSERT' or new.line_type is distinct from old.line_type) then
    select type into v_sup_type from suppliers where id = v_po.supplier_id;
    if v_sup_type = 'sublet' then raise exception 'A sublet shop can''t supply parts; put the part on a PO to a parts supplier'; end if;
  end if;
  if new.qty_ordered < new.qty_delivered + new.qty_cancelled then
    raise exception 'Ordered quantity can''t be less than delivered + cancelled';
  end if;
  return new;
end $$;

-- Outside work can't be added to the catalog (138's "add a typed-in part to the catalog" only takes parts)
create or replace function public.guard_typed_link_sublet() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'po' and exists (select 1 from purchase_order_items where id = new.line_id and line_type = 'sublet') then
    raise exception 'Outside work (sublet) can''t be added to the catalog';
  end if;
  return new;
end $$;
revoke execute on function public.guard_typed_link_sublet() from public, anon, authenticated;
drop trigger if exists typed_part_links_sublet on public.typed_part_links;
create trigger typed_part_links_sublet before insert or update on public.typed_part_links
  for each row execute function public.guard_typed_link_sublet();

-- ===== 3. Which suppliers a PO can go to ========================================================================
-- A sublet shop only for a job, and only while the PO has no part lines.
create or replace function public.guard_po_supplier_type() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select type from suppliers where id = new.supplier_id) is distinct from 'sublet' then return new; end if;
  if new.ro_id is null then raise exception 'A sublet shop can only get a PO for a job'; end if;
  if tg_op = 'UPDATE' and exists (select 1 from purchase_order_items where po_id = new.id and line_type = 'part') then
    raise exception 'A sublet shop can''t supply parts; this PO has parts on it';
  end if;
  return new;
end $$;
revoke execute on function public.guard_po_supplier_type() from public, anon, authenticated;
drop trigger if exists purchase_orders_supplier_type on public.purchase_orders;
create trigger purchase_orders_supplier_type before insert or update of supplier_id, ro_id on public.purchase_orders
  for each row execute function public.guard_po_supplier_type();
-- and a supplier only becomes a sublet shop while it has no stock POs and no part lines on any PO
create or replace function public.guard_supplier_type() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'sublet' and old.type is distinct from 'sublet'
     and exists (select 1 from purchase_orders po where po.supplier_id = new.id
                  and (po.ro_id is null or exists (select 1 from purchase_order_items i where i.po_id = po.id and i.line_type = 'part'))) then
    raise exception 'This supplier has POs with parts, so it can''t become a sublet shop';
  end if;
  return new;
end $$;
revoke execute on function public.guard_supplier_type() from public, anon, authenticated;
drop trigger if exists suppliers_type_guard on public.suppliers;
create trigger suppliers_type_guard before update of type on public.suppliers
  for each row execute function public.guard_supplier_type();

-- ===== 4. Outside work can't be returned to the supplier ========================================================
create or replace function public.guard_sublet_return() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.po_item_id is not null and exists (select 1 from purchase_order_items where id = new.po_item_id and line_type = 'sublet') then
    raise exception 'Outside work (sublet) can''t be returned to the supplier';
  end if;
  return new;
end $$;
revoke execute on function public.guard_sublet_return() from public, anon, authenticated;
drop trigger if exists returns_sublet_guard on public.returns;
create trigger returns_sublet_guard before insert or update of po_item_id on public.returns
  for each row execute function public.guard_sublet_return();

-- ===== 4b. A PO price fills the job line: 139's rule, now for sublet lines too ===================================
-- Only on open jobs. Cost follows while it is 0 (or still a cost taken from a PO line for it, e.g. one cancelled and
-- ordered again); price follows while it is 0 (or still such a suggestion), at the shop's default markup.
-- Prices typed on the job are kept. A PO cost that came from the job line itself (141, job_line_to_po) changes nothing
-- here: a new cost typed on the job never moves the job's price.
create or replace function public.po_cost_to_job_line() returns trigger language plpgsql security definer set search_path = public as $$
declare l ro_service_items%rowtype; v_m numeric; v_new numeric; v_prev numeric; v_cost numeric; v_price numeric; v_from_po boolean; v_sug boolean;
begin
  if new.ro_service_item_id is null or coalesce(new.cost, 0) <= 0 then return null; end if;
  if current_setting('axle.job_to_po', true) = 'on' then return null; end if;
  if tg_op = 'UPDATE' and new.cost is not distinct from old.cost and new.ro_service_item_id is not distinct from old.ro_service_item_id then
    return null;
  end if;
  select i.* into l from ro_service_items i where i.id = new.ro_service_item_id for update;
  if not found or l.item_type not in ('part', 'sublet') then return null; end if;
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

-- ===== 5. Job line → PO line (item 19 cost, item 20 name and draft quantity) =====================================
create or replace function public.job_line_to_po() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(left(btrim(coalesce(new.name, '')), 200));
begin
  if new.item_type not in ('part', 'sublet') then return null; end if;
  if not exists (select 1 from ro_services s join repair_orders ro on ro.id = s.ro_id
                  where s.id = new.service_id and ro.order_status = 'estimate' and ro.closed_at is null) then
    return null;
  end if;
  -- the name, on every PO line for it that isn't fully cancelled
  -- (a PO line holds 200 characters; both sides compare the same trimmed first 200)
  if new.name is distinct from old.name and v_name <> '' then
    update purchase_order_items set name = v_name
     where ro_service_item_id = new.id and qty_cancelled < qty_ordered and name is distinct from v_name;
  end if;
  -- the cost, on its current PO line, while that line is still at Rp 0 or at the job's old cost, unpaid and not cancelled
  if new.cost is distinct from old.cost then
    perform set_config('axle.job_to_po', 'on', true);
    update purchase_order_items p set cost = new.cost
     where p.id = new.po_item_id and p.ro_service_item_id = new.id
       and p.qty_paid = 0 and p.qty_cancelled < p.qty_ordered and p.cost is distinct from new.cost
       and (p.cost = 0 or p.cost = old.cost)
       and exists (select 1 from purchase_orders po where po.id = p.po_id and po.status <> 'cancelled');
    perform set_config('axle.job_to_po', 'off', true);
  end if;
  -- the quantity, only while the PO is still a draft (once ordered, the supplier has the number)
  if new.qty is distinct from old.qty and new.qty > 0 then
    update purchase_order_items p set qty_ordered = new.qty
     where p.ro_service_item_id = new.id and p.qty_delivered = 0 and p.qty_cancelled = 0 and p.qty_ordered is distinct from new.qty
       and exists (select 1 from purchase_orders po where po.id = p.po_id and po.status = 'draft');
  end if;
  return null;
end $$;
revoke execute on function public.job_line_to_po() from public, anon, authenticated;
drop trigger if exists ro_items_to_po on public.ro_service_items;
create trigger ro_items_to_po after update of name, cost, qty on public.ro_service_items
  for each row execute function public.job_line_to_po();

-- ===== 6. PO line → job line (item 20 name and draft quantity) ===================================================
create or replace function public.po_line_to_job() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ro uuid; v_changed boolean := false;
begin
  if new.ro_service_item_id is null or new.ro_service_item_id is distinct from old.ro_service_item_id then return null; end if;
  select s.ro_id into v_ro from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders ro on ro.id = s.ro_id
   where i.id = new.ro_service_item_id and ro.order_status = 'estimate' and ro.closed_at is null;
  if v_ro is null then return null; end if;
  -- (a job line name longer than a PO line can hold is kept as long as its trimmed first 200 characters match)
  if new.name is distinct from old.name then
    update ro_service_items set name = new.name where id = new.ro_service_item_id and btrim(left(btrim(name), 200)) is distinct from new.name;
  end if;
  if new.qty_ordered is distinct from old.qty_ordered and new.qty_delivered = 0 and new.qty_cancelled = 0
     and exists (select 1 from purchase_orders po where po.id = new.po_id and po.status = 'draft') then
    -- a fixed discount larger than the line at the new quantity is capped to it
    update ro_service_items set qty = new.qty_ordered, discount_amount = least(discount_amount, round(price * new.qty_ordered))
     where id = new.ro_service_item_id and qty is distinct from new.qty_ordered;
    v_changed := found;
  end if;
  -- the totals trigger skips writes made inside other triggers, so the job's totals are worked out here
  if v_changed then perform recalc_repair_order(v_ro); end if;
  return null;
end $$;
revoke execute on function public.po_line_to_job() from public, anon, authenticated;
drop trigger if exists po_items_to_job on public.purchase_order_items;
create trigger po_items_to_job after update of name, qty_ordered on public.purchase_order_items
  for each row execute function public.po_line_to_job();

-- ===== 7. Add PO lines that aren't on the job to one of its services =============================================
-- p_lines: lines of POs for one open job, not linked to a job line yet. p_service: a service on that job; or, with
-- p_service null, a new service named p_new_service (default "Part tambahan"). Each line becomes a job line with the
-- same name, part (or outside work), quantity still coming or kept (ordered − cancelled − returned) and cost; the price
-- is the catalog price for a catalog part, else cost × the default markup. The lines are linked from then on.
create or replace function public.add_po_lines_to_job(p_lines uuid[], p_service uuid default null, p_new_service text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_ro uuid; v_svc uuid; v_pos int; v_m numeric; l record; v_cat uuid; v_qty numeric; v_item uuid; n int := 0;
  v_desc text; v_price numeric; v_taxable boolean; v_showqty boolean; v_core numeric;
begin
  if not (has_permission('edit_jobs') and has_permission('manage_inventory')) then
    raise exception 'Only people who edit jobs and manage inventory can add PO parts to a job';
  end if;
  if p_lines is null or cardinality(p_lines) = 0 then raise exception 'Choose the PO lines to add'; end if;
  select distinct po.ro_id into v_ro from purchase_order_items pi join purchase_orders po on po.id = pi.po_id where pi.id = any (p_lines);
  if v_ro is null or (select count(distinct po.ro_id) from purchase_order_items pi join purchase_orders po on po.id = pi.po_id where pi.id = any (p_lines)) <> 1
     or (select count(*) from purchase_order_items where id = any (p_lines)) <> cardinality(array(select distinct unnest(p_lines))) then
    raise exception 'The lines must all be on POs for one job';
  end if;
  perform 1 from repair_orders where id = v_ro and order_status = 'estimate' and closed_at is null for update;
  if not found then raise exception 'This job is invoiced or closed; its parts can''t change'; end if;
  if p_service is not null then
    select id into v_svc from ro_services where id = p_service and ro_id = v_ro and approval_status in ('approved', 'pending');
    if v_svc is null then raise exception 'Choose a service on this job (approved or waiting)'; end if;
  else
    insert into ro_services (ro_id, name, position)
    values (v_ro, coalesce(nullif(left(btrim(coalesce(p_new_service, '')), 200), ''), 'Part tambahan'),
            (select coalesce(max(position), -1) + 1 from ro_services where ro_id = v_ro))
    returning id into v_svc;
  end if;
  v_m := coalesce((select default_markup_pct from shop_settings limit 1), 0);
  select coalesce(max(position), -1) + 1 into v_pos from ro_service_items where service_id = v_svc;
  for l in select pi.* from purchase_order_items pi where pi.id = any (p_lines) order by pi.created_at, pi.id for update loop
    if l.ro_service_item_id is not null then raise exception '"%" is already on the job', l.name; end if;
    v_qty := l.qty_ordered - l.qty_cancelled - po_qty_returned(l.id);
    if v_qty <= 0 then raise exception 'Nothing is left of "%" on its PO to add', l.name; end if;
    -- the job line is the PO line's own part (a typed-in line added to the catalog after it arrived is refused by
    -- guard_po_item when it is linked below)
    v_cat := l.catalog_item_id;
    v_desc := null; v_price := null; v_taxable := null; v_showqty := null; v_core := 0;
    if v_cat is not null then
      select description, nullif(price, 0), taxable, show_qty_price, case when has_core then coalesce(core_cost, 0) else 0 end
        into v_desc, v_price, v_taxable, v_showqty, v_core from catalog_items where id = v_cat;
    end if;
    insert into ro_service_items (service_id, position, item_type, catalog_item_id, name, description, cost, price, qty, taxable, show_qty_price, core_charge)
    values (v_svc, v_pos, l.line_type, v_cat, l.name, v_desc, l.cost, coalesce(v_price, round(l.cost * (1 + v_m / 100))),
            v_qty, coalesce(v_taxable, new_line_taxable()), coalesce(v_showqty, true), case when l.line_type = 'part' then v_core else 0 end)
    returning id into v_item;
    update purchase_order_items set ro_service_item_id = v_item where id = l.id;
    v_pos := v_pos + 1; n := n + 1;
  end loop;
  -- new work on the job: its status follows (e.g. back from Selesai)
  perform refresh_job_workflow(v_ro);
  return jsonb_build_object('added', n, 'service_id', v_svc);
end $$;
revoke execute on function public.add_po_lines_to_job(uuid[], uuid, text) from public, anon;
grant execute on function public.add_po_lines_to_job(uuid[], uuid, text) to authenticated;

-- ===== 8. "Menunggu apa": say when the job waits for outside work (139's jobs_waiting, plus the sublet flag) =======
create or replace function public.jobs_waiting(p_ids uuid[] default null)
returns table(ro_id uuid, kind text, info jsonb) language sql stable security definer set search_path = public as $$
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
           pi.line_type = 'sublet' as sublet, count(*) over (partition by p.ro_id) as n
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
      'sublet', case when po.sublet then true end,
      'draft_id', draft.po_id, 'draft_number', draft.po_number, 'drafts', draft.n))
  from j left join agg a on a.ro_id = j.id left join zero z on z.ro_id = j.id left join po on po.ro_id = j.id
    left join draft on draft.ro_id = j.id left join ap on ap.ro_id = j.id;
$$;
revoke execute on function public.jobs_waiting(uuid[]) from public, anon;
grant execute on function public.jobs_waiting(uuid[]) to authenticated;

-- ===== 9. Tanya Claude's PO lookup says which lines are outside work (140's tc_po, plus line_type) ===============
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
                'outside_work_sublet', case when i.line_type = 'sublet' then true end,
                'ordered', i.qty_ordered, 'received', i.qty_delivered, 'cancelled', i.qty_cancelled, 'returned', i.qty_returned,
                'paid_qty', i.qty_paid, 'received_at', i.delivered_at, 'supplier_invoice', i.supplier_invoice_no, 'paid_at', i.paid_at,
                'for_job_line', i.ro_service_item_id is not null,
                'shelf_count_shown_on_po', (select ci.qty_on_hand from catalog_items_read ci where ci.id = i.catalog_item_id and ci.track_inventory)))
                order by i.created_at)
                from purchase_order_items_read i where i.po_id = p.id)));
end $$;
revoke execute on function public.tc_po(text) from public, anon;
grant execute on function public.tc_po(text) to authenticated;
