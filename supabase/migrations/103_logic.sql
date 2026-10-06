-- Axle v2 · 103 business logic: numbering, money recalculation, invoicing, stock, schedules, transfers
-- ---------- Numbering ----------
create or replace function public.set_job_number() returns trigger language plpgsql as $$
begin
  if new.job_number is null then new.job_number := next_number('job'); end if;
  return new;
end $$;
create trigger repair_orders_job_number before insert on public.repair_orders for each row execute function set_job_number();

create or replace function public.set_po_number() returns trigger language plpgsql security definer set search_path = public as $$
declare jn bigint; n int;
begin
  if new.po_number is not null then return new; end if;
  if new.ro_id is null then
    new.po_number := 'P' || next_number('stock_po');
  else
    select job_number into jn from repair_orders where id = new.ro_id for update;   -- lock the job while numbering its POs
    select count(*) into n from purchase_orders where ro_id = new.ro_id;
    new.po_number := jn || '-' || (101 + n);
  end if;
  return new;
end $$;
create trigger purchase_orders_number before insert on public.purchase_orders for each row execute function set_po_number();

-- ---------- Money ----------
create or replace function public.recalc_repair_order(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
declare
  s record; st shop_settings%rowtype; ro repair_orders%rowtype;
  v_parts numeric := 0; v_labor numeric := 0; v_other numeric := 0; v_fees numeric := 0;
  v_item_disc numeric := 0; v_svc_disc numeric := 0; v_taxable numeric := 0;
  v_job_fees numeric := 0; v_job_disc numeric := 0; v_pre numeric; v_base numeric; v_amt numeric;
  v_subtotal numeric; v_tax numeric; v_paid numeric; v_total numeric; v_taxable_fees numeric := 0;
  svc_total numeric; svc_disc numeric; svc_taxable numeric;
  f record; d record;
begin
  select * into ro from repair_orders where id = p_ro;
  if not found then return; end if;
  select * into st from shop_settings limit 1;

  -- services and their lines
  for s in select * from ro_services where ro_id = p_ro loop
    select coalesce(sum(net),0),
           coalesce(sum(net) filter (where taxable),0)
      into svc_total, svc_taxable
      from ro_service_items where service_id = s.id;
    if s.flat_price is not null then svc_total := s.flat_price; end if;
    svc_disc := case when s.discount_pct > 0 then round(svc_total * s.discount_pct / 100) else least(s.discount_amount, svc_total) end;
    update ro_services set service_total = svc_total, service_discount = svc_disc, service_net = svc_total - svc_disc where id = s.id;
    v_svc_disc := v_svc_disc + svc_disc;
    if svc_total > 0 then v_taxable := v_taxable + svc_taxable * (svc_total - svc_disc) / svc_total; end if;
  end loop;

  select coalesce(sum(i.net) filter (where i.item_type = 'part'),0),
         coalesce(sum(i.net) filter (where i.item_type = 'labor'),0),
         coalesce(sum(i.net) filter (where i.item_type = 'sublet'),0),
         coalesce(sum(i.net) filter (where i.item_type = 'fee'),0),
         coalesce(sum(i.discount),0)
    into v_parts, v_labor, v_other, v_fees, v_item_disc
    from ro_service_items i join ro_services sv on sv.id = i.service_id where sv.ro_id = p_ro;
  -- flat-rate services: their price replaces the line sum, booked as labor difference
  select v_labor + coalesce(sum(sv.flat_price - coalesce((select sum(net) from ro_service_items where service_id = sv.id),0)),0)
    into v_labor from ro_services sv where sv.ro_id = p_ro and sv.flat_price is not null;

  -- job-level fees (shop supplies etc.)
  for f in select * from ro_job_fees where ro_id = p_ro loop
    if f.manual_override then
      v_amt := f.amount;
    elsif f.is_shop_supplies then
      v_base := case st.shop_supplies_base when 'parts' then v_parts when 'labor' then v_labor else v_parts + v_labor end;
      v_amt := case when st.shop_supplies_type = 'fixed' then st.shop_supplies_rate else round(v_base * st.shop_supplies_rate / 100) end;
      if st.shop_supplies_min is not null then v_amt := greatest(v_amt, st.shop_supplies_min); end if;
      if st.shop_supplies_max is not null then v_amt := least(v_amt, st.shop_supplies_max); end if;
      if v_base = 0 then v_amt := 0; end if;
    elsif f.kind = 'percent' then
      v_amt := round((v_parts + v_labor) * f.value / 100);
    else
      v_amt := round(f.value);
    end if;
    update ro_job_fees set amount = v_amt where id = f.id and amount is distinct from v_amt;
    v_job_fees := v_job_fees + v_amt;
    if f.taxable then v_taxable_fees := v_taxable_fees + v_amt; end if;
  end loop;

  v_pre := v_parts + v_labor + v_other + v_fees - v_svc_disc + v_job_fees;

  -- job-level discounts
  for d in select * from ro_job_discounts where ro_id = p_ro loop
    v_amt := case when d.kind = 'percent' then round(v_pre * d.value / 100) else round(d.value) end;
    if d.max_amount is not null then v_amt := least(v_amt, d.max_amount); end if;
    v_amt := least(v_amt, greatest(v_pre - v_job_disc, 0));
    update ro_job_discounts set amount = v_amt where id = d.id and amount is distinct from v_amt;
    v_job_disc := v_job_disc + v_amt;
  end loop;

  v_subtotal := v_pre - v_job_disc;
  v_taxable := v_taxable + v_taxable_fees;
  if v_pre > 0 then v_taxable := v_taxable * (v_pre - v_job_disc) / v_pre; end if;
  v_taxable := round(v_taxable);
  if exists (select 1 from customers where id = ro.customer_id and tax_exempt) then v_taxable := 0; end if;
  v_tax := round(v_taxable * st.tax_rate / 100);
  v_total := v_subtotal + v_tax;

  select coalesce(sum(case when kind = 'payment' then amount else -amount end),0) into v_paid from payments where ro_id = p_ro;
  select v_paid + coalesce(sum(amount),0) into v_paid from credit_memos where applied_ro_id = p_ro;

  update repair_orders set
    parts_total = v_parts, labor_total = v_labor, other_total = v_other, service_fees_total = v_fees,
    item_discount_total = v_item_disc, service_discount_total = v_svc_disc,
    job_fees_total = v_job_fees, job_discount_total = v_job_disc,
    subtotal = v_subtotal, taxable_base = v_taxable, tax_total = v_tax, total = v_total,
    paid_total = v_paid, balance = v_total - v_paid,
    payment_status = case when v_paid >= v_total and v_total > 0 then 'paid' when v_paid > 0 then 'partial' else 'unpaid' end,
    workflow_status = case when order_status = 'invoice' and v_paid >= v_total and v_total > 0 then 'paid'
                           when order_status = 'invoice' and workflow_status = 'paid' and v_paid < v_total then 'invoiced'
                           else workflow_status end
  where id = p_ro;
end $$;

create or replace function public.trg_recalc() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid; v_old uuid;
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- ignore updates made by recalc itself
  if tg_table_name = 'ro_service_items' then
    select ro_id into v_ro from ro_services where id = coalesce(new.service_id, old.service_id);
  elsif tg_table_name = 'credit_memos' then
    v_ro := coalesce(new.applied_ro_id, old.applied_ro_id);
    if tg_op = 'UPDATE' and old.applied_ro_id is distinct from new.applied_ro_id then v_old := old.applied_ro_id; end if;
  elsif tg_table_name = 'repair_orders' then
    v_ro := new.id;
  else
    v_ro := coalesce(new.ro_id, old.ro_id);
  end if;
  if v_ro is not null then perform recalc_repair_order(v_ro); end if;
  if v_old is not null then perform recalc_repair_order(v_old); end if;
  return null;
end $$;

create trigger recalc_items after insert or update or delete on public.ro_service_items for each row execute function trg_recalc();
create trigger recalc_services after insert or update or delete on public.ro_services for each row execute function trg_recalc();
create trigger recalc_job_fees after insert or update or delete on public.ro_job_fees for each row execute function trg_recalc();
create trigger recalc_job_discounts after insert or update or delete on public.ro_job_discounts for each row execute function trg_recalc();
create trigger recalc_payments after insert or update or delete on public.payments for each row execute function trg_recalc();
create trigger recalc_credits after insert or update or delete on public.credit_memos for each row execute function trg_recalc();
create trigger recalc_customer_change after update of customer_id on public.repair_orders for each row execute function trg_recalc();

-- New job: add the shop supplies fee from settings
create or replace function public.add_shop_supplies() returns trigger language plpgsql security definer set search_path = public as $$
declare st shop_settings%rowtype;
begin
  select * into st from shop_settings limit 1;
  if st.shop_supplies_enabled then
    insert into ro_job_fees (ro_id, name, kind, value, taxable, is_shop_supplies)
    values (new.id, 'Shop supplies', st.shop_supplies_type, st.shop_supplies_rate, st.shop_supplies_taxable, true);
  end if;
  return null;
end $$;
create trigger repair_orders_shop_supplies after insert on public.repair_orders for each row execute function add_shop_supplies();

-- ---------- Invoicing ----------
create or replace function public.convert_to_invoice(p_ro uuid) returns bigint language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; c customers%rowtype; st shop_settings%rowtype; v_inv bigint;
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status = 'invoice' then return ro.invoice_number; end if;
  select * into c from customers where id = ro.customer_id;
  select * into st from shop_settings limit 1;
  v_inv := next_number('invoice');
  update repair_orders set
    order_status = 'invoice', invoice_number = v_inv, invoiced_at = now(),
    due_date = current_date + coalesce(c.payment_terms_days, st.default_payment_terms_days),
    workflow_status = 'invoiced',
    bill_to_snapshot = jsonb_build_object('display_name', c.display_name, 'legal_name', c.legal_name, 'npwp', c.npwp,
                                          'billing_address', c.billing_address, 'phone', c.phone, 'email', c.email,
                                          'contact', (select name from customer_contacts where customer_id = c.id order by is_primary desc limit 1)),
    shop_snapshot = to_jsonb(st) - 'id'
  where id = p_ro;
  -- take used stock parts out of inventory
  insert into stock_movements (catalog_item_id, qty_change, reason, ro_service_item_id)
  select i.catalog_item_id, -i.qty, 'used_on_job', i.id
  from ro_service_items i join ro_services sv on sv.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
  where sv.ro_id = p_ro and i.item_type = 'part' and ci.track_inventory and not i.stock_deducted and i.po_item_id is null
    and sv.approval_status <> 'declined';
  update ro_service_items i set stock_deducted = true
  from ro_services sv where sv.id = i.service_id and sv.ro_id = p_ro and i.item_type = 'part' and i.po_item_id is null;
  -- core charges on parts used become core returns to track
  insert into cores (ro_service_item_id, ro_id, supplier_id, item_name, core_cost, qty)
  select i.id, p_ro, ci.supplier_id, i.name, ci.core_cost, i.qty
  from ro_service_items i join ro_services sv on sv.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
  where sv.ro_id = p_ro and i.item_type = 'part' and ci.has_core and sv.approval_status <> 'declined'
    and not exists (select 1 from cores x where x.ro_service_item_id = i.id);
  perform recalc_repair_order(p_ro);
  return v_inv;
end $$;

-- ---------- Stock ----------
create or replace function public.apply_stock_movement() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update catalog_items set qty_on_hand = qty_on_hand + new.qty_change where id = new.catalog_item_id;
  return null;
end $$;
create trigger stock_movements_apply after insert on public.stock_movements for each row execute function apply_stock_movement();

create or replace view public.stock_levels with (security_invoker = true) as
select ci.id, ci.name, ci.code, ci.category_id, ci.supplier_id, ci.qty_on_hand, ci.reorder_point,
  coalesce((select sum(i.qty) from ro_service_items i join ro_services sv on sv.id = i.service_id join repair_orders r on r.id = sv.ro_id
            where i.catalog_item_id = ci.id and not i.stock_deducted and i.po_item_id is null and r.order_status = 'estimate'
              and sv.approval_status <> 'declined'),0) as qty_on_estimates,
  coalesce((select sum(pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled) from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
            where pi.catalog_item_id = ci.id and po.status in ('ordered','partially_delivered')),0) as qty_on_order
from catalog_items ci where ci.item_type = 'part' and ci.track_inventory;

-- ---------- Purchase orders ----------
create or replace function public.mark_po_items_delivered(p_items uuid[], p_delivered date, p_invoice_no text, p_invoice_date date, p_due date)
returns void language plpgsql security definer set search_path = public as $$
declare it record;
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  for it in select pi.*, po.ro_id from purchase_order_items pi join purchase_orders po on po.id = pi.po_id where pi.id = any(p_items) loop
    update purchase_order_items set qty_delivered = qty_ordered - qty_cancelled, delivered_at = p_delivered,
      supplier_invoice_no = p_invoice_no, invoice_date = p_invoice_date, payment_due = p_due where id = it.id;
    if it.ro_id is null and it.catalog_item_id is not null and (it.qty_ordered - it.qty_cancelled - it.qty_delivered) > 0 then
      insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id)
      values (it.catalog_item_id, it.qty_ordered - it.qty_cancelled - it.qty_delivered, 'po_delivery', it.id);
    end if;
  end loop;
end $$;

create or replace function public.mark_po_items_cancelled(p_items uuid[]) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  update purchase_order_items set qty_cancelled = qty_ordered - qty_delivered where id = any(p_items);
end $$;

create or replace function public.refresh_po_status() returns trigger language plpgsql security definer set search_path = public as $$
declare v_po uuid := coalesce(new.po_id, old.po_id); o numeric; d numeric; c numeric; cur text;
begin
  select coalesce(sum(qty_ordered),0), coalesce(sum(qty_delivered),0), coalesce(sum(qty_cancelled),0) into o, d, c
  from purchase_order_items where po_id = v_po;
  select status into cur from purchase_orders where id = v_po;
  if cur = 'draft' then return null; end if;
  update purchase_orders set status = case
      when o > 0 and c >= o then 'cancelled'
      when o > 0 and d + c >= o then 'delivered'
      when d > 0 then 'partially_delivered'
      else 'ordered' end
  where id = v_po;
  update purchase_orders set payment_status = case
      when not exists (select 1 from purchase_order_items where po_id = v_po and qty_delivered > 0 and paid_at is null) and exists (select 1 from purchase_order_items where po_id = v_po and paid_at is not null) then 'paid'
      when exists (select 1 from purchase_order_items where po_id = v_po and paid_at is not null) then 'partial'
      else 'unpaid' end
  where id = v_po;
  return null;
end $$;
create trigger po_items_status after insert or update or delete on public.purchase_order_items for each row execute function refresh_po_status();

-- ---------- Service completion → preventive maintenance ----------
create or replace function public.on_service_completed() returns trigger language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; km int;
begin
  if new.work_status = 'completed' and old.work_status is distinct from 'completed' then
    new.completed_at := coalesce(new.completed_at, now());
    select * into ro from repair_orders where id = new.ro_id;
    km := coalesce(ro.odometer_out, ro.odometer_in);
    if new.service_schedule_id is not null then
      update service_schedules set last_done_km = coalesce(km, last_done_km), last_done_date = current_date where id = new.service_schedule_id;
    end if;
    if km is not null then update vehicles set mileage_km = greatest(coalesce(mileage_km,0), km) where id = ro.vehicle_id; end if;
  end if;
  return new;
end $$;
create trigger ro_services_completed before update of work_status on public.ro_services for each row execute function on_service_completed();

-- ---------- Vehicle transfer ----------
create or replace function public.transfer_vehicle(p_vehicle uuid, p_to uuid, p_date date default current_date, p_odometer int default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from uuid;
begin
  if auth.uid() is not null and not has_permission('edit_customers') then raise exception 'Not allowed'; end if;
  select customer_id into v_from from vehicles where id = p_vehicle for update;
  if v_from = p_to then return; end if;
  insert into vehicle_transfers (vehicle_id, from_customer_id, to_customer_id, transferred_at, odometer_km, note)
  values (p_vehicle, v_from, p_to, p_date, p_odometer, p_note);
  update vehicles set customer_id = p_to, mileage_km = coalesce(greatest(mileage_km, p_odometer), mileage_km) where id = p_vehicle;
  update repair_orders set customer_id = p_to where vehicle_id = p_vehicle and order_status = 'estimate';   -- open jobs follow the vehicle
end $$;

-- ---------- Service due view ----------
create or replace view public.service_due with (security_invoker = true) as
select ss.*, v.plate, v.customer_id, v.mileage_km,
  ss.next_due_km - v.mileage_km as km_left,
  ss.next_due_date - current_date as days_left,
  case
    when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km) or (ss.next_due_date is not null and current_date >= ss.next_due_date) then 'overdue'
    when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km - (select due_soon_km from shop_settings limit 1))
      or (ss.next_due_date is not null and current_date >= ss.next_due_date - (select due_soon_days from shop_settings limit 1)) then 'due_soon'
    else 'ok' end as due_status
from service_schedules ss join vehicles v on v.id = ss.vehicle_id where ss.active;

-- ---------- Activity log on key tables ----------
do $$ declare t text; begin
  foreach t in array array['customers','customer_contacts','vehicles','catalog_items','suppliers','discounts','service_templates',
    'repair_orders','ro_services','ro_service_items','ro_job_fees','ro_job_discounts','approvals','payments','credit_memos',
    'appointments','purchase_orders','purchase_order_items','returns','cores','shop_settings','service_schedules'] loop
    if t <> 'shop_settings' then
      execute format('create trigger log_%1$s after insert or update or delete on public.%1$I for each row execute function log_activity()', t);
    end if;
  end loop;
end $$;
