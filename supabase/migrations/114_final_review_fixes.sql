-- Axle v2 · 114 final review (Oct 6) + Denny's decision: jobs can be closed without an invoice
-- (no approved work, no money on it, reason required; can be reopened)

-- ===== Close without invoice =====
alter table public.repair_orders add column closed_at timestamptz, add column close_reason text, add column closed_by uuid;
alter table public.repair_orders drop constraint ro_archive_after_invoice;
alter table public.repair_orders add constraint ro_archive_rule check (archived_at is null or order_status = 'invoice' or closed_at is not null);
alter table public.repair_orders add constraint ro_closed_is_estimate check (closed_at is null or order_status = 'estimate');

create or replace function public.close_job(p_ro uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype;
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required to close a job without an invoice'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status <> 'estimate' then raise exception 'Only an estimate can be closed without an invoice'; end if;
  if ro.closed_at is not null then return; end if;
  if exists (select 1 from ro_services where ro_id = p_ro and approval_status = 'approved') then
    raise exception 'This job has approved work. Invoice it, or decline/defer the work first.';
  end if;
  if coalesce((select sum(case when kind = 'payment' then amount else -amount end) from payments where ro_id = p_ro), 0) <> 0
     or exists (select 1 from credit_memos where applied_ro_id = p_ro) then
    raise exception 'This job has money on it. Refund the payments or unapply the credits first.';
  end if;
  update repair_orders set closed_at = now(), close_reason = trim(p_reason), closed_by = auth.uid(), archived_at = now() where id = p_ro;
end $$;

create or replace function public.reopen_job(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  update repair_orders set closed_at = null, close_reason = null, closed_by = null, archived_at = null where id = p_ro and closed_at is not null;
  if not found then raise exception 'Job not found or not closed'; end if;
end $$;

-- closed jobs drop out of settings re-pricing (they are left exactly as closed)
create or replace function public.reprice_open_estimates() returns trigger language plpgsql security definer set search_path = public as $$
declare j record;
begin
  if tg_table_name = 'shop_settings' then
    if (new.shop_supplies_type, new.shop_supplies_rate) is distinct from (old.shop_supplies_type, old.shop_supplies_rate) then
      update ro_job_fees f set kind = new.shop_supplies_type, value = new.shop_supplies_rate
      from repair_orders r
      where r.id = f.ro_id and r.order_status = 'estimate' and r.closed_at is null and f.is_shop_supplies and not f.manual_override
        and f.kind = old.shop_supplies_type and f.value = old.shop_supplies_rate;
    end if;
    if (new.tax_rate, new.pkp_status, new.shop_supplies_type, new.shop_supplies_rate, new.shop_supplies_base, new.shop_supplies_min, new.shop_supplies_max)
       is distinct from (old.tax_rate, old.pkp_status, old.shop_supplies_type, old.shop_supplies_rate, old.shop_supplies_base, old.shop_supplies_min, old.shop_supplies_max) then
      for j in select id from repair_orders where order_status = 'estimate' and closed_at is null loop perform recalc_repair_order(j.id); end loop;
    end if;
  else
    if new.tax_exempt is distinct from old.tax_exempt then
      for j in select id from repair_orders where order_status = 'estimate' and closed_at is null and customer_id = new.id loop perform recalc_repair_order(j.id); end loop;
    end if;
  end if;
  return null;
end $$;

-- ===== Stock: every PO delivery (stock or job PO) lands on the shelf; invoicing takes approved parts off the shelf =====
create or replace function public.po_item_stock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.qty_delivered = old.qty_delivered or new.catalog_item_id is null then return null; end if;
  if exists (select 1 from catalog_items where id = new.catalog_item_id and track_inventory) then
    insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id)
    values (new.catalog_item_id, new.qty_delivered - old.qty_delivered, 'po_delivery', new.id);
  end if;
  return null;
end $$;

create or replace view public.stock_levels with (security_invoker = true) as
select ci.id, ci.name, ci.code, ci.category_id, ci.supplier_id, ci.qty_on_hand, ci.reorder_point,
  coalesce((select sum(i.qty) from ro_service_items i join ro_services sv on sv.id = i.service_id join repair_orders r on r.id = sv.ro_id
            where i.catalog_item_id = ci.id and not i.stock_deducted and r.order_status = 'estimate' and r.closed_at is null
              and sv.approval_status in ('pending','approved')),0) as qty_on_estimates,
  coalesce((select sum(pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled) from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
            where pi.catalog_item_id = ci.id and po.status in ('ordered','partially_delivered')),0) as qty_on_order
from catalog_items ci where ci.item_type = 'part' and ci.track_inventory;

-- ===== Credits: where a credit came from; void credits and used credits can't be deleted =====
alter table public.credit_memos add column source text not null default 'manual' check (source in ('manual','void'));

create or replace function public.release_excess_credit(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_excess numeric; c record;
begin
  v_excess := -ro_open_balance(p_ro);
  if v_excess <= 0 then return; end if;
  for c in select * from credit_memos where applied_ro_id = p_ro order by applied_at desc nulls last, created_at desc for update loop
    exit when v_excess <= 0;
    if c.amount <= v_excess then
      update credit_memos set applied_ro_id = null, applied_at = null where id = c.id;
      v_excess := v_excess - c.amount;
    else
      update credit_memos set amount = amount - v_excess where id = c.id;
      insert into credit_memos (customer_id, amount, reason, created_by, source)
      values (c.customer_id, v_excess, coalesce(c.reason, 'Credit') || ' (released, job total lower)', c.created_by, c.source);
      v_excess := 0;
    end if;
  end loop;
end $$;

create or replace function public.unapply_credit(p_credit uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_ro uuid;
begin
  if auth.uid() is not null and not has_permission('record_payments') then raise exception 'Not allowed'; end if;
  select applied_ro_id into v_ro from credit_memos where id = p_credit for update;
  if v_ro is null then raise exception 'Credit not found or not applied'; end if;
  if auth.uid() is not null and (select order_status from repair_orders where id = v_ro) = 'invoice' and not has_permission('void_invoices') then
    raise exception 'Only an owner or admin can take a credit off an issued invoice';
  end if;
  update credit_memos set applied_ro_id = null, applied_at = null where id = p_credit;
end $$;

create or replace function public.guard_credit_delete() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user = 'authenticated' and (old.source <> 'manual' or old.applied_ro_id is not null or old.refunded_at is not null) then
    raise exception 'Only an unused, manually issued credit can be deleted';
  end if;
  return old;
end $$;
create trigger credit_memos_guard_delete before delete on public.credit_memos for each row execute function guard_credit_delete();

-- ===== Payments: the app can't undo an issued invoice's money without owner/admin rights, nor touch voided history =====
create or replace function public.guard_payment() returns trigger language plpgsql security invoker set search_path = public as $$
declare v_status text; v_closed timestamptz; v_cust uuid;
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    select order_status, closed_at into v_status, v_closed from repair_orders where id = new.ro_id;
    if v_closed is not null then raise exception 'This job is closed. Reopen it first.'; end if;
    if new.kind = 'refund' and v_status = 'invoice' and not has_permission('void_invoices') then
      raise exception 'Only an owner or admin can record a refund on an issued invoice';
    end if;
    return new;
  end if;
  if old.source <> 'manual' then raise exception 'This entry was made by the system and can''t be changed'; end if;
  if exists (select 1 from invoice_voids v where v.ro_id = old.ro_id and v.voided_at >= old.created_at) then
    raise exception 'This payment belongs to a voided invoice and is kept as history';
  end if;
  if (select order_status from repair_orders where id = old.ro_id) = 'invoice' and not has_permission('void_invoices') then
    raise exception 'Only an owner or admin can change a payment on an issued invoice';
  end if;
  if tg_op = 'UPDATE' and new.ro_id is distinct from old.ro_id then
    select customer_id, order_status into v_cust, v_status from repair_orders where id = new.ro_id;
    if v_cust is distinct from old.customer_id then raise exception 'A payment can only be moved to a job of the same company'; end if;
    if v_status = 'invoice' and not has_permission('void_invoices') then
      raise exception 'Only an owner or admin can change a payment on an issued invoice';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger payments_guard_insert before insert on public.payments for each row execute function guard_payment();

create or replace function public.set_payment_customer() returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- a payment belongs to its job's company when created or moved to another job; other moves (transfers) are done by the system
  if tg_op = 'INSERT' or new.ro_id is distinct from old.ro_id then
    select customer_id into new.customer_id from repair_orders where id = new.ro_id;
  end if;
  return new;
end $$;

-- ===== Approvals: can't be re-pointed; deleting one restores the previous decision (or pending) =====
create or replace function public.apply_approval() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_when = 'BEFORE' then
    if tg_op = 'UPDATE' and (new.ro_id is distinct from old.ro_id or new.service_id is distinct from old.service_id) then
      raise exception 'Record a new approval instead of moving this one';
    end if;
    if not exists (select 1 from ro_services where id = new.service_id and ro_id = new.ro_id) then
      raise exception 'That service belongs to a different job';
    end if;
    if tg_op = 'INSERT' then new.recorded_by := coalesce(auth.uid(), new.recorded_by); end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    update ro_services set approval_status = coalesce(
      (select decision from approvals where service_id = old.service_id order by decided_at desc, id desc limit 1), 'pending')
    where id = old.service_id;
    perform recalc_repair_order(old.ro_id);
    return null;
  end if;
  update ro_services set approval_status = new.decision where id = new.service_id and approval_status is distinct from new.decision;
  perform recalc_repair_order(new.ro_id);
  return null;
end $$;
create trigger approvals_check_update before update on public.approvals for each row execute function apply_approval();
create trigger approvals_apply_delete after delete on public.approvals for each row execute function apply_approval();

-- ===== Appointments follow their job; the match is checked only when the link changes =====
create or replace function public.check_appointment() returns trigger language plpgsql security definer set search_path = public as $$
declare r repair_orders%rowtype; v_changed boolean;
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
  v_changed := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    v_changed := (new.ro_id, new.vehicle_id, new.customer_id) is distinct from (old.ro_id, old.vehicle_id, old.customer_id);
  end if;
  if not v_changed then return new; end if;
  if new.ro_id is not null then
    select * into r from repair_orders where id = new.ro_id;
    new.vehicle_id := coalesce(new.vehicle_id, r.vehicle_id);
    new.customer_id := coalesce(new.customer_id, r.customer_id);
    if new.vehicle_id <> r.vehicle_id or new.customer_id <> r.customer_id then
      raise exception 'The appointment must have the same vehicle and company as its job';
    end if;
  elsif new.vehicle_id is not null then
    new.customer_id := coalesce(new.customer_id, (select customer_id from vehicles where id = new.vehicle_id));
    if new.customer_id <> (select customer_id from vehicles where id = new.vehicle_id) then
      raise exception 'That vehicle belongs to another company';
    end if;
  end if;
  return new;
end $$;

create or replace function public.job_appointments_follow() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update appointments set customer_id = new.customer_id, vehicle_id = new.vehicle_id
  where ro_id = new.id and (customer_id, vehicle_id) is distinct from (new.customer_id, new.vehicle_id);
  return null;
end $$;
create trigger job_appointments_follow after update of customer_id, vehicle_id on public.repair_orders for each row execute function job_appointments_follow();

create or replace function public.transfer_vehicle(p_vehicle uuid, p_to uuid, p_date date default null, p_odometer int default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from uuid;
begin
  if auth.uid() is not null and not has_permission('edit_customers') then raise exception 'Not allowed'; end if;
  select customer_id into v_from from vehicles where id = p_vehicle for update;
  if not found then raise exception 'Vehicle not found'; end if;
  if not exists (select 1 from customers where id = p_to) then raise exception 'Company not found'; end if;
  if v_from = p_to then return; end if;
  insert into vehicle_transfers (vehicle_id, from_customer_id, to_customer_id, transferred_at, odometer_km, note)
  values (p_vehicle, v_from, p_to, coalesce(p_date, local_date()), p_odometer, p_note);
  update vehicles set customer_id = p_to, mileage_km = coalesce(greatest(mileage_km, p_odometer), mileage_km) where id = p_vehicle;
  -- open jobs follow the vehicle (their payments, credits and linked appointments follow via triggers)
  update repair_orders set customer_id = p_to where vehicle_id = p_vehicle and order_status = 'estimate';
  -- future appointments not tied to a job move too; ones tied to an invoiced job stay with that job
  update appointments set customer_id = p_to
  where vehicle_id = p_vehicle and ro_id is null and start_time > now() and status not in ('cancelled','no_show') and customer_id is distinct from p_to;
end $$;

-- ===== Invoicing, void and credit functions (from 113, adjusted) =====
create or replace function public.convert_to_invoice(p_ro uuid) returns bigint language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; c customers%rowtype; st shop_settings%rowtype; v_inv bigint; v_cash numeric; v_total numeric;
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status = 'invoice' then return ro.invoice_number; end if;
  if ro.closed_at is not null then raise exception 'This job is closed. Reopen it first.'; end if;
  if exists (select 1 from ro_services where ro_id = p_ro and approval_status = 'pending') then
    raise exception 'Approve, decline or defer every service before invoicing';
  end if;
  if not exists (select 1 from ro_services where ro_id = p_ro and approval_status = 'approved') then
    raise exception 'Approve at least one service before invoicing';
  end if;
  perform recalc_repair_order(p_ro);                    -- final pricing while still an estimate
  select total into v_total from repair_orders where id = p_ro;
  select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) into v_cash from payments where ro_id = p_ro;
  if v_cash > v_total then
    raise exception 'Payments received (Rp %) are more than the invoice total (Rp %). Refund the difference first.',
      to_char(v_cash, 'FM999G999G999G990'), to_char(v_total, 'FM999G999G999G990');
  end if;
  perform release_excess_credit(p_ro);
  select * into c from customers where id = ro.customer_id;
  select * into st from shop_settings limit 1;
  v_inv := next_number('invoice');
  if exists (select 1 from invoice_voids where invoice_number = v_inv) then
    raise exception 'Invoice number % was already used (voided). Check the invoice counter in Settings.', v_inv;
  end if;
  update repair_orders set
    order_status = 'invoice', invoice_number = v_inv, invoiced_at = now(),
    due_date = local_date() + coalesce(c.payment_terms_days, st.default_payment_terms_days),
    workflow_status = 'invoiced',
    bill_to_snapshot = jsonb_build_object('display_name', c.display_name, 'legal_name', c.legal_name, 'npwp', c.npwp,
                                          'billing_address', c.billing_address, 'phone', c.phone, 'email', c.email,
                                          'contact', (select name from customer_contacts where customer_id = c.id order by is_primary desc limit 1),
                                          'vehicle', (select jsonb_build_object('plate', v.plate, 'make', v.make, 'model', v.model, 'year', v.year,
                                                                                'vin', v.vin, 'type', v.type) from vehicles v where v.id = ro.vehicle_id)),
    shop_snapshot = to_jsonb(st) - 'id'
  where id = p_ro;
  -- approved tracked parts come off the shelf (every delivery, stock or job PO, lands on the shelf first)
  with used as (
    select i.id, i.catalog_item_id, i.qty as q
    from ro_service_items i join ro_services sv on sv.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
    where sv.ro_id = p_ro and sv.approval_status = 'approved' and i.item_type = 'part'
      and ci.track_inventory and not i.stock_deducted
  ), moved as (
    insert into stock_movements (catalog_item_id, qty_change, reason, ro_service_item_id)
    select catalog_item_id, -q, 'used_on_job', id from used where q > 0 returning ro_service_item_id
  )
  update ro_service_items set stock_deducted = true where id in (select ro_service_item_id from moved);
  insert into cores (ro_service_item_id, ro_id, supplier_id, item_name, core_cost, qty)
  select i.id, p_ro, ci.supplier_id, i.name, ci.core_cost, i.qty
  from ro_service_items i join ro_services sv on sv.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
  where sv.ro_id = p_ro and i.item_type = 'part' and ci.has_core and sv.approval_status = 'approved'
    and not exists (select 1 from cores x where x.ro_service_item_id = i.id);
  perform recalc_repair_order(p_ro);                    -- invoice path: payments only
  return v_inv;
end $$;

create or replace function public.void_invoice(p_ro uuid, p_reason text) returns text language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; v_no text; v_cash numeric; v_credit uuid; v_bal numeric;
begin
  if auth.uid() is not null and not has_permission('void_invoices') then raise exception 'Not allowed'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required to void an invoice'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status <> 'invoice' then raise exception 'This job is not invoiced'; end if;
  insert into invoice_voids (ro_id, invoice_number, invoiced_at, total, reason, snapshot)
  values (p_ro, ro.invoice_number, ro.invoiced_at, ro.total, trim(p_reason), jsonb_build_object(
    'job', to_jsonb(ro),
    'concerns', (select coalesce(jsonb_agg(to_jsonb(c) order by c.position), '[]') from ro_concerns c where c.ro_id = p_ro),
    'services', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('items',
                   (select coalesce(jsonb_agg(to_jsonb(i) order by i.position), '[]') from ro_service_items i where i.service_id = s.id)) order by s.position), '[]')
                 from ro_services s where s.ro_id = p_ro),
    'job_fees', (select coalesce(jsonb_agg(to_jsonb(f)), '[]') from ro_job_fees f where f.ro_id = p_ro),
    'job_discounts', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from ro_job_discounts d where d.ro_id = p_ro),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from payments p where p.ro_id = p_ro),
    'credits', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from credit_memos m where m.applied_ro_id = p_ro)))
  returning invoice_no into v_no;
  update repair_orders set order_status = 'estimate', invoice_number = null, invoiced_at = null, due_date = null,
    bill_to_snapshot = null, shop_snapshot = null, faktur_pajak_number = null, workflow_status = 'completed', archived_at = null
  where id = p_ro;
  select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) into v_cash from payments where ro_id = p_ro;
  if v_cash > 0 then
    insert into payments (ro_id, customer_id, kind, method, amount, reference, source)
    values (p_ro, ro.customer_id, 'refund', 'other', v_cash, 'Moved to company credit (voided ' || v_no || ')', 'void_credit');
    insert into credit_memos (customer_id, amount, reason, source) values (ro.customer_id, v_cash, 'Payments on voided ' || v_no, 'void')
    returning id into v_credit;
    v_bal := greatest(ro_open_balance(p_ro), 0);
    if v_bal > 0 then perform apply_credit(v_credit, p_ro, least(v_cash, v_bal)); end if;
  end if;
  -- put back exactly what this job took from the shelf
  insert into stock_movements (catalog_item_id, qty_change, reason, ro_service_item_id, note)
  select m.catalog_item_id, -sum(m.qty_change), 'job_reversal', m.ro_service_item_id, 'Invoice ' || v_no || ' voided'
  from stock_movements m join ro_service_items i on i.id = m.ro_service_item_id join ro_services s on s.id = i.service_id
  where s.ro_id = p_ro and m.reason in ('used_on_job','job_reversal')
  group by m.catalog_item_id, m.ro_service_item_id having sum(m.qty_change) <> 0;
  update ro_service_items i set stock_deducted = false from ro_services s
  where s.id = i.service_id and s.ro_id = p_ro and i.stock_deducted;
  delete from cores where ro_id = p_ro and retrieval_status = 'to_be_retrieved' and return_status = 'to_be_returned';
  perform recalc_repair_order(p_ro);
  return v_no;
end $$;

create or replace function public.apply_credit(p_credit uuid, p_ro uuid, p_amount numeric default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare cm credit_memos%rowtype; v_amt numeric; v_new uuid;
begin
  if auth.uid() is not null and not has_permission('record_payments') then raise exception 'Not allowed'; end if;
  select * into cm from credit_memos where id = p_credit for update;
  if not found then raise exception 'Credit not found'; end if;
  if cm.applied_ro_id is not null then raise exception 'This credit is already applied'; end if;
  if cm.refunded_at is not null then raise exception 'This credit was refunded'; end if;
  perform 1 from repair_orders where id = p_ro for no key update;
  if (select closed_at from repair_orders where id = p_ro) is not null then raise exception 'This job is closed. Reopen it first.'; end if;
  v_amt := round(coalesce(p_amount, least(cm.amount, greatest(ro_open_balance(p_ro), 0))));
  if v_amt <= 0 then raise exception 'Nothing is due on this job'; end if;
  if v_amt > cm.amount then raise exception 'That is more than the credit available'; end if;
  if v_amt = cm.amount then
    update credit_memos set applied_ro_id = p_ro, applied_at = now() where id = p_credit;
    return p_credit;
  end if;
  update credit_memos set amount = amount - v_amt where id = p_credit;
  insert into credit_memos (customer_id, amount, reason, applied_ro_id, applied_at, created_by, source)
  values (cm.customer_id, v_amt, coalesce(cm.reason, 'Credit') || ' (part)', p_ro, now(), auth.uid(), cm.source)
  returning id into v_new;
  return v_new;
end $$;

create or replace function public.refund_credit(p_credit uuid, p_amount numeric default null, p_method text default 'transfer', p_reference text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare cm credit_memos%rowtype; v_amt numeric; v_id uuid;
begin
  if auth.uid() is not null and not has_permission('issue_credits') then raise exception 'Not allowed'; end if;
  select * into cm from credit_memos where id = p_credit for update;
  if not found then raise exception 'Credit not found'; end if;
  if cm.applied_ro_id is not null then raise exception 'Unapply this credit from its job first'; end if;
  if cm.refunded_at is not null then raise exception 'This credit was already refunded'; end if;
  v_amt := round(coalesce(p_amount, cm.amount));
  if v_amt <= 0 or v_amt > cm.amount then raise exception 'Enter an amount between 1 and the credit available'; end if;
  if v_amt < cm.amount then
    update credit_memos set amount = amount - v_amt where id = p_credit;
    insert into credit_memos (customer_id, amount, reason, created_by, refunded_at, refund_method, refund_reference, source)
    values (cm.customer_id, v_amt, coalesce(cm.reason, 'Credit') || ' (refunded part)', auth.uid(), now(), p_method, p_reference, cm.source)
    returning id into v_id;
    return v_id;
  end if;
  update credit_memos set refunded_at = now(), refund_method = p_method, refund_reference = p_reference where id = p_credit;
  return p_credit;
end $$;

-- apply_credit (above) also refuses a closed job
-- ===== Function access =====
revoke execute on function public.guard_credit_delete(), public.job_appointments_follow() from public, anon, authenticated;
revoke execute on function public.close_job(uuid, text), public.reopen_job(uuid) from public, anon;
grant execute on function public.close_job(uuid, text), public.reopen_job(uuid) to authenticated;
