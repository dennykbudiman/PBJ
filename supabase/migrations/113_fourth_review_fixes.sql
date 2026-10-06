-- Axle v2 · 113 fourth review (Oct 5, 23:30)

-- ===== Credits: capped only on issued invoices (estimates may hold deposits/credits; the excess is released at invoicing);
--       whole-rupiah splits; a company credit can be refunded as money =====
alter table public.credit_memos add column refunded_at timestamptz, add column refund_method text, add column refund_reference text;

create or replace function public.check_credit_memo() returns trigger language plpgsql security definer set search_path = public as $$
declare v_bal numeric; v_status text;
begin
  if new.applied_ro_id is not null then
    if new.refunded_at is not null then raise exception 'This credit was refunded and can''t be applied'; end if;
    if (select customer_id from repair_orders where id = new.applied_ro_id) is distinct from new.customer_id then
      raise exception 'A credit can only be applied to a job of the same company';
    end if;
    select order_status into v_status from repair_orders where id = new.applied_ro_id;
    if v_status = 'invoice' and (tg_op = 'INSERT' or new.applied_ro_id is distinct from old.applied_ro_id or new.amount > old.amount) then
      v_bal := ro_open_balance(new.applied_ro_id, new.id);
      if new.amount > v_bal then
        raise exception 'This credit (Rp %) is more than the balance due (Rp %). Apply part of it instead.',
          to_char(new.amount, 'FM999G999G999G990'), to_char(greatest(v_bal, 0), 'FM999G999G999G990');
      end if;
    end if;
    new.applied_at := coalesce(new.applied_at, now());
  else
    new.applied_at := null;
  end if;
  return new;
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
  v_amt := round(coalesce(p_amount, least(cm.amount, greatest(ro_open_balance(p_ro), 0))));
  if v_amt <= 0 then raise exception 'Nothing is due on this job'; end if;
  if v_amt > cm.amount then raise exception 'That is more than the credit available'; end if;
  if v_amt = cm.amount then
    update credit_memos set applied_ro_id = p_ro, applied_at = now() where id = p_credit;
    return p_credit;
  end if;
  update credit_memos set amount = amount - v_amt where id = p_credit;
  insert into credit_memos (customer_id, amount, reason, applied_ro_id, applied_at, created_by)
  values (cm.customer_id, v_amt, coalesce(cm.reason, 'Credit') || ' (part)', p_ro, now(), auth.uid())
  returning id into v_new;
  return v_new;
end $$;

-- give an unused company credit back as money (all or part)
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
    insert into credit_memos (customer_id, amount, reason, created_by, refunded_at, refund_method, refund_reference)
    values (cm.customer_id, v_amt, coalesce(cm.reason, 'Credit') || ' (refunded part)', auth.uid(), now(), p_method, p_reference)
    returning id into v_id;
    return v_id;
  end if;
  update credit_memos set refunded_at = now(), refund_method = p_method, refund_reference = p_reference where id = p_credit;
  return p_credit;
end $$;

create or replace view public.customer_balances with (security_invoker = true) as
select c.id as customer_id, c.display_name,
  coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0), 0) as balance_due,
  coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0 and r.due_date < local_date()), 0) as overdue,
  count(r.id) filter (where r.order_status = 'invoice' and r.balance > 0) as open_invoices,
  coalesce((select sum(amount) from credit_memos m where m.customer_id = c.id and m.applied_ro_id is null and m.refunded_at is null), 0) as available_credit
from customers c left join repair_orders r on r.customer_id = c.id
group by c.id, c.display_name;

-- ===== Payments: system rows are fixed; on an issued invoice only owners/admins may edit or delete a payment =====
alter table public.payments add column source text not null default 'manual' check (source in ('manual','void_credit'));
create or replace function public.guard_payment() returns trigger language plpgsql security invoker set search_path = public as $$
declare v_ro uuid;
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if old.source <> 'manual' then raise exception 'This entry was made by the system and can''t be changed'; end if;
  v_ro := old.ro_id;
  if (select order_status from repair_orders where id = v_ro) = 'invoice' and not has_permission('void_invoices') then
    raise exception 'Only an owner or admin can change a payment on an issued invoice';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger payments_guard before update or delete on public.payments for each row execute function guard_payment();

-- ===== Job PO links: shelf stock is used for whatever the PO doesn't cover; parts delivered for declined work go to the shelf =====
-- quantity of a job line covered by its job PO lines (ordered minus cancelled), excluding PO lines whose parts went to the shelf
create or replace function public.po_covered_qty(p_item uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(pi.qty_ordered - pi.qty_cancelled), 0) from purchase_order_items pi
  where pi.ro_service_item_id = p_item
    and not exists (select 1 from stock_movements m where m.po_item_id = pi.id and m.reason = 'po_delivery');
$$;

create or replace function public.po_item_stock() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid;
begin
  if new.qty_delivered = old.qty_delivered or new.catalog_item_id is null then return null; end if;
  select ro_id into v_ro from purchase_orders where id = new.po_id;
  -- stock POs, job-PO lines not tied to a job line, and lines already redirected to the shelf go onto the shelf
  if (v_ro is null or new.ro_service_item_id is null
      or exists (select 1 from stock_movements m where m.po_item_id = new.id and m.reason = 'po_delivery'))
     and exists (select 1 from catalog_items where id = new.catalog_item_id and track_inventory) then
    insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id)
    values (new.catalog_item_id, new.qty_delivered - old.qty_delivered, 'po_delivery', new.id);
  end if;
  return null;
end $$;

-- a fully cancelled, undelivered PO line no longer covers its job line
create or replace function public.sync_po_item_link() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.ro_service_item_id is not null and old.ro_service_item_id is distinct from new.ro_service_item_id then
    update ro_service_items set po_item_id = null where id = old.ro_service_item_id and po_item_id = new.id;
  end if;
  if new.ro_service_item_id is not null then
    if new.qty_delivered = 0 and new.qty_cancelled >= new.qty_ordered then
      update ro_service_items set po_item_id = null where id = new.ro_service_item_id and po_item_id = new.id;
    else
      update ro_service_items set po_item_id = new.id where id = new.ro_service_item_id and po_item_id is distinct from new.id;
    end if;
  end if;
  return null;
end $$;
create trigger po_items_link_cancel after update of qty_cancelled on public.purchase_order_items for each row execute function sync_po_item_link();

create or replace view public.stock_levels with (security_invoker = true) as
select ci.id, ci.name, ci.code, ci.category_id, ci.supplier_id, ci.qty_on_hand, ci.reorder_point,
  coalesce((select sum(greatest(i.qty - po_covered_qty(i.id), 0)) from ro_service_items i join ro_services sv on sv.id = i.service_id join repair_orders r on r.id = sv.ro_id
            where i.catalog_item_id = ci.id and not i.stock_deducted and r.order_status = 'estimate'
              and sv.approval_status in ('pending','approved')),0) as qty_on_estimates,
  coalesce((select sum(pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled) from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
            where pi.catalog_item_id = ci.id and po.status in ('ordered','partially_delivered')),0) as qty_on_order
from catalog_items ci where ci.item_type = 'part' and ci.track_inventory;

create or replace function public.convert_to_invoice(p_ro uuid) returns bigint language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; c customers%rowtype; st shop_settings%rowtype; v_inv bigint; v_cash numeric; v_total numeric;
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status = 'invoice' then return ro.invoice_number; end if;
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
  -- parts delivered on a job PO for work that was declined / deferred go onto the shelf
  insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id, note)
  select pi.catalog_item_id, pi.qty_delivered, 'po_delivery', pi.id, 'Job part not used (service not approved)'
  from purchase_order_items pi join ro_service_items i on i.id = pi.ro_service_item_id join ro_services sv on sv.id = i.service_id
  join catalog_items ci on ci.id = pi.catalog_item_id
  where sv.ro_id = p_ro and sv.approval_status <> 'approved' and pi.qty_delivered > 0 and ci.track_inventory
    and not exists (select 1 from stock_movements m where m.po_item_id = pi.id and m.reason = 'po_delivery');
  -- approved tracked parts: take from the shelf whatever the job PO doesn't cover
  with used as (
    select i.id, i.catalog_item_id, greatest(i.qty - po_covered_qty(i.id), 0) as q
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

-- ===== Void: reverses exactly what was taken from stock; payments' value becomes a company credit applied up to what's due
--       (any remainder stays available to the company); the job comes back on the board =====
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
    insert into credit_memos (customer_id, amount, reason) values (ro.customer_id, v_cash, 'Payments on voided ' || v_no)
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

-- ===== Only invoiced jobs can be archived (picked up) =====
alter table public.repair_orders add constraint ro_archive_after_invoice check (archived_at is null or order_status = 'invoice');

-- ===== Changing an estimate's company: only money received since the last void moves with it =====
create or replace function public.job_money_follows() returns trigger language plpgsql security definer set search_path = public as $$
declare v_since timestamptz;
begin
  if new.customer_id is distinct from old.customer_id then
    select max(voided_at) into v_since from invoice_voids where ro_id = new.id;
    update credit_memos set applied_ro_id = null, applied_at = null where applied_ro_id = new.id and customer_id <> new.customer_id;
    update payments set customer_id = new.customer_id
    where ro_id = new.id and customer_id <> new.customer_id and (v_since is null or created_at > v_since);
  end if;
  return null;
end $$;

create or replace function public.set_payment_customer() returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- new payments always belong to the job's company; an explicit move by job_money_follows is kept
  if tg_op = 'INSERT' or new.ro_id is distinct from old.ro_id or current_user = 'authenticated' then
    select customer_id into new.customer_id from repair_orders where id = new.ro_id;
  end if;
  return new;
end $$;

-- ===== Approvals: recording or changing one sets the service status and re-prices the job; recorder is the signed-in user =====
create or replace function public.apply_approval() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_when = 'BEFORE' then
    if not exists (select 1 from ro_services where id = new.service_id and ro_id = new.ro_id) then
      raise exception 'That service belongs to a different job';
    end if;
    if tg_op = 'INSERT' then new.recorded_by := coalesce(auth.uid(), new.recorded_by); end if;
    return new;
  end if;
  update ro_services set approval_status = new.decision where id = new.service_id and approval_status is distinct from new.decision;
  perform recalc_repair_order(new.ro_id);
  return null;
end $$;
create trigger approvals_apply_update after update of decision on public.approvals for each row execute function apply_approval();

-- ===== Appointments: linked to a job → same vehicle and company as the job; otherwise the vehicle must belong to the company =====
create or replace function public.check_appointment() returns trigger language plpgsql security definer set search_path = public as $$
declare r repair_orders%rowtype;
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
  if new.ro_id is not null then
    select * into r from repair_orders where id = new.ro_id;
    new.vehicle_id := coalesce(new.vehicle_id, r.vehicle_id);
    new.customer_id := coalesce(new.customer_id, r.customer_id);
    if new.vehicle_id <> r.vehicle_id or new.customer_id <> r.customer_id then
      raise exception 'The appointment must have the same vehicle and company as its job';
    end if;
  elsif new.vehicle_id is not null then
    new.customer_id := coalesce(new.customer_id, (select customer_id from vehicles where id = new.vehicle_id));
    if new.customer_id <> (select customer_id from vehicles where id = new.vehicle_id)
       and (tg_op = 'INSERT' or new.vehicle_id is distinct from old.vehicle_id or new.customer_id is distinct from old.customer_id) then
      raise exception 'That vehicle belongs to another company';
    end if;
  end if;
  return new;
end $$;

-- ===== Function access =====
revoke execute on function public.guard_payment() from public, anon, authenticated;
-- used by the stock_levels view (security invoker), so signed-in users need it; it only returns a quantity
revoke execute on function public.po_covered_qty(uuid) from public, anon;
grant execute on function public.po_covered_qty(uuid) to authenticated;
revoke execute on function public.refund_credit(uuid, numeric, text, text) from public, anon;
grant execute on function public.refund_credit(uuid, numeric, text, text) to authenticated;
