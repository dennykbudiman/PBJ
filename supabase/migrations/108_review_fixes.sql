-- Axle v2 · 108 fixes from the Oct 5 review (independent reviewer + self-review)

-- ===== Local date (shop timezone, default Asia/Jakarta) instead of UTC current_date =====
create or replace function public.local_date() returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce((select timezone from public.shop_settings limit 1), 'Asia/Jakarta'))::date;
$$;
alter table public.vehicle_transfers alter column transferred_at set default public.local_date();
alter table public.supplier_payments alter column paid_at set default public.local_date();
alter table public.returns alter column marked_at set default public.local_date();
alter table public.cores alter column marked_at set default public.local_date();

-- ===== C1 · sign-up can't choose its own role; new accounts start inactive =====
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare v_role uuid;
begin
  -- raw_app_meta_data can only be set server-side (service role / invite function); raw_user_meta_data is user-controlled
  select id into v_role from public.roles where name = new.raw_app_meta_data->>'role';
  insert into public.profiles (id, name, username, role_id, status)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), new.raw_app_meta_data->>'username',
          coalesce(v_role, (select id from public.roles where name = 'Viewer')),
          case when v_role is not null then 'active' else 'invited' end);
  return new;
end $$;
create unique index profiles_username_lower on public.profiles (lower(username));
-- invited / disabled users can still read their own profile (so the app can say "waiting for approval")
create policy "read own profile" on public.profiles for select using (id = auth.uid());

-- Fleet managers (future external approvers) are not staff: no access to other companies' data until per-company access exists
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p left join public.roles r on r.id = p.role_id
                 where p.id = auth.uid() and p.status = 'active' and coalesce(r.name, '') <> 'Fleet manager');
$$;

-- ===== Money: C3 invoiced jobs keep their totals, C4 declined/deferred not billed, H1 flat-rate tax share, non-PKP = no PPN =====
create or replace function public.recalc_repair_order(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
declare
  s record; st shop_settings%rowtype; ro repair_orders%rowtype;
  v_parts numeric := 0; v_labor numeric := 0; v_other numeric := 0; v_fees numeric := 0;
  v_item_disc numeric := 0; v_svc_disc numeric := 0; v_taxable numeric := 0;
  v_job_fees numeric := 0; v_job_disc numeric := 0; v_pre numeric; v_base numeric; v_amt numeric;
  v_subtotal numeric; v_tax numeric; v_paid numeric; v_total numeric; v_taxable_fees numeric := 0; v_rate numeric;
  line_sum numeric; line_taxable numeric; svc_total numeric; svc_disc numeric; svc_taxable numeric;
  f record; d record;
begin
  select * into ro from repair_orders where id = p_ro;
  if not found then return; end if;

  select coalesce(sum(case when kind = 'payment' then amount else -amount end),0) into v_paid from payments where ro_id = p_ro;
  select v_paid + coalesce(sum(amount),0) into v_paid from credit_memos where applied_ro_id = p_ro;

  if ro.order_status = 'invoice' then
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
    select coalesce(sum(net),0), coalesce(sum(net) filter (where taxable),0) into line_sum, line_taxable
      from ro_service_items where service_id = s.id;
    svc_total := coalesce(s.flat_price, line_sum);
    svc_taxable := case when s.flat_price is null then line_taxable
                        when line_sum > 0 then line_taxable * s.flat_price / line_sum else 0 end;
    svc_disc := case when s.discount_pct > 0 then round(svc_total * s.discount_pct / 100) else least(s.discount_amount, svc_total) end;
    update ro_services set service_total = svc_total, service_discount = svc_disc, service_net = svc_total - svc_disc
      where id = s.id and (service_total, service_discount, service_net) is distinct from (svc_total, svc_disc, svc_total - svc_disc);
    if s.approval_status in ('pending','approved') then
      v_svc_disc := v_svc_disc + svc_disc;
      if svc_total > 0 then v_taxable := v_taxable + svc_taxable * (svc_total - svc_disc) / svc_total; end if;
    end if;
  end loop;

  select coalesce(sum(i.net) filter (where i.item_type = 'part'),0),
         coalesce(sum(i.net) filter (where i.item_type = 'labor'),0),
         coalesce(sum(i.net) filter (where i.item_type = 'sublet'),0),
         coalesce(sum(i.net) filter (where i.item_type = 'fee'),0),
         coalesce(sum(i.discount),0)
    into v_parts, v_labor, v_other, v_fees, v_item_disc
    from ro_service_items i join ro_services sv on sv.id = i.service_id
   where sv.ro_id = p_ro and sv.approval_status in ('pending','approved');
  select v_labor + coalesce(sum(sv.flat_price - coalesce((select sum(net) from ro_service_items where service_id = sv.id),0)),0)
    into v_labor from ro_services sv where sv.ro_id = p_ro and sv.flat_price is not null and sv.approval_status in ('pending','approved');

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

-- H2 · a row moved to another job recalculates both jobs
create or replace function public.trg_recalc() returns trigger language plpgsql security definer set search_path = public as $$
declare v_new uuid; v_old uuid;
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- ignore writes made by recalc itself
  if tg_table_name = 'ro_service_items' then
    if tg_op <> 'DELETE' then select ro_id into v_new from ro_services where id = new.service_id; end if;
    if tg_op <> 'INSERT' then select ro_id into v_old from ro_services where id = old.service_id; end if;
  elsif tg_table_name = 'credit_memos' then
    if tg_op <> 'DELETE' then v_new := new.applied_ro_id; end if;
    if tg_op <> 'INSERT' then v_old := old.applied_ro_id; end if;
  elsif tg_table_name = 'repair_orders' then
    v_new := new.id;
  else
    if tg_op <> 'DELETE' then v_new := new.ro_id; end if;
    if tg_op <> 'INSERT' then v_old := old.ro_id; end if;
  end if;
  if v_new is not null then perform recalc_repair_order(v_new); end if;
  if v_old is not null and v_old is distinct from v_new then perform recalc_repair_order(v_old); end if;
  return null;
end $$;

-- ===== Invoicing: price first, then lock; only billable tracked parts leave stock =====
create or replace function public.convert_to_invoice(p_ro uuid) returns bigint language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; c customers%rowtype; st shop_settings%rowtype; v_inv bigint;
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status = 'invoice' then return ro.invoice_number; end if;
  if not exists (select 1 from ro_services where ro_id = p_ro and approval_status in ('pending','approved')) then
    raise exception 'Add at least one approved service before invoicing';
  end if;
  perform recalc_repair_order(p_ro);                    -- final pricing while still an estimate
  select * into c from customers where id = ro.customer_id;
  select * into st from shop_settings limit 1;
  v_inv := next_number('invoice');
  update repair_orders set
    order_status = 'invoice', invoice_number = v_inv, invoiced_at = now(),
    due_date = local_date() + coalesce(c.payment_terms_days, st.default_payment_terms_days),
    workflow_status = 'invoiced',
    bill_to_snapshot = jsonb_build_object('display_name', c.display_name, 'legal_name', c.legal_name, 'npwp', c.npwp,
                                          'billing_address', c.billing_address, 'phone', c.phone, 'email', c.email,
                                          'contact', (select name from customer_contacts where customer_id = c.id order by is_primary desc limit 1)),
    shop_snapshot = to_jsonb(st) - 'id'
  where id = p_ro;
  with used as (
    select i.id, i.catalog_item_id, i.qty
    from ro_service_items i join ro_services sv on sv.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
    where sv.ro_id = p_ro and sv.approval_status in ('pending','approved') and i.item_type = 'part'
      and ci.track_inventory and not i.stock_deducted and i.po_item_id is null
  ), moved as (
    insert into stock_movements (catalog_item_id, qty_change, reason, ro_service_item_id)
    select catalog_item_id, -qty, 'used_on_job', id from used returning ro_service_item_id
  )
  update ro_service_items set stock_deducted = true where id in (select ro_service_item_id from moved);
  insert into cores (ro_service_item_id, ro_id, supplier_id, item_name, core_cost, qty)
  select i.id, p_ro, ci.supplier_id, i.name, ci.core_cost, i.qty
  from ro_service_items i join ro_services sv on sv.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
  where sv.ro_id = p_ro and i.item_type = 'part' and ci.has_core and sv.approval_status in ('pending','approved')
    and not exists (select 1 from cores x where x.ro_service_item_id = i.id);
  perform recalc_repair_order(p_ro);                    -- invoice path: payments only
  return v_inv;
end $$;

create or replace function public.void_invoice(p_ro uuid, p_reason text) returns text language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; v_no text;
begin
  if auth.uid() is not null and not has_permission('void_invoices') then raise exception 'Not allowed'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required to void an invoice'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status <> 'invoice' then raise exception 'This job is not invoiced'; end if;
  if ro.paid_total > 0 then raise exception 'Refund or move the payments on this invoice before voiding it'; end if;
  insert into invoice_voids (ro_id, invoice_number, invoiced_at, total, reason, snapshot)
  values (p_ro, ro.invoice_number, ro.invoiced_at, ro.total, trim(p_reason), jsonb_build_object(
    'job', to_jsonb(ro),
    'concerns', (select coalesce(jsonb_agg(to_jsonb(c) order by c.position), '[]') from ro_concerns c where c.ro_id = p_ro),
    'services', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('items',
                   (select coalesce(jsonb_agg(to_jsonb(i) order by i.position), '[]') from ro_service_items i where i.service_id = s.id)) order by s.position), '[]')
                 from ro_services s where s.ro_id = p_ro),
    'job_fees', (select coalesce(jsonb_agg(to_jsonb(f)), '[]') from ro_job_fees f where f.ro_id = p_ro),
    'job_discounts', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from ro_job_discounts d where d.ro_id = p_ro),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from payments p where p.ro_id = p_ro)))
  returning invoice_no into v_no;
  update repair_orders set order_status = 'estimate', invoice_number = null, invoiced_at = null, due_date = null,
    bill_to_snapshot = null, shop_snapshot = null, faktur_pajak_number = null, workflow_status = 'completed'
  where id = p_ro;
  perform recalc_repair_order(p_ro);
  return v_no;
end $$;

-- ===== C2 · invoiced jobs are locked =====
create or replace function public.lock_invoiced_job() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid; v_status text; allowed text[]; o jsonb; n jsonb;
begin
  if tg_table_name = 'ro_service_items' then
    if tg_op = 'DELETE' then select ro_id into v_ro from ro_services where id = old.service_id;
    else select ro_id into v_ro from ro_services where id = new.service_id; end if;
  elsif tg_op = 'DELETE' then v_ro := old.ro_id;
  else v_ro := new.ro_id; end if;
  select order_status into v_status from repair_orders where id = v_ro;
  if v_status is distinct from 'invoice' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op <> 'UPDATE' then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
  allowed := case tg_table_name
    when 'ro_services' then array['technician_id','work_status','completed_at','service_total','service_discount','service_net']
    when 'ro_service_items' then array['stock_deducted','po_item_id','hours_worked','amount','discount','net']   -- generated columns aren't filled yet in a BEFORE trigger; their inputs are compared
    else array[]::text[] end;
  o := to_jsonb(old) - allowed; n := to_jsonb(new) - allowed;
  if o is distinct from n then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
  return new;
end $$;
create trigger lock_ro_services before insert or update or delete on public.ro_services for each row execute function lock_invoiced_job();
create trigger lock_ro_service_items before insert or update or delete on public.ro_service_items for each row execute function lock_invoiced_job();
create trigger lock_ro_job_fees before insert or update or delete on public.ro_job_fees for each row execute function lock_invoiced_job();
create trigger lock_ro_job_discounts before insert or update or delete on public.ro_job_discounts for each row execute function lock_invoiced_job();
create trigger lock_ro_concerns before insert or update or delete on public.ro_concerns for each row execute function lock_invoiced_job();

-- job ↔ vehicle ↔ company consistency; invoiced jobs can't change company/vehicle
create or replace function public.check_repair_order() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.order_status = 'invoice' and new.order_status = 'invoice'
     and (new.customer_id is distinct from old.customer_id or new.vehicle_id is distinct from old.vehicle_id) then
    raise exception 'This job is invoiced. Void the invoice to make changes.';
  end if;
  if new.order_status = 'estimate' and not exists (select 1 from vehicles where id = new.vehicle_id and customer_id = new.customer_id) then
    raise exception 'This vehicle belongs to another company';
  end if;
  return new;
end $$;
create trigger repair_orders_check before insert or update of customer_id, vehicle_id on public.repair_orders for each row execute function check_repair_order();
create or replace function public.protect_invoiced_job() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' then raise exception 'An invoiced job can''t be deleted. Void the invoice first.'; end if;
  return old;
end $$;
create trigger repair_orders_no_delete_invoiced before delete on public.repair_orders for each row execute function protect_invoiced_job();
alter table public.repair_orders add constraint ro_workflow_matches_order
  check (order_status = 'invoice' or workflow_status not in ('invoiced','paid'));

-- ===== H4 · payments & credits stay with the right company =====
create or replace function public.set_payment_customer() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select customer_id into new.customer_id from repair_orders where id = new.ro_id;
  return new;
end $$;
create trigger payments_customer before insert or update of ro_id, customer_id on public.payments for each row execute function set_payment_customer();

create or replace function public.check_credit_memo() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.applied_ro_id is not null then
    if (select customer_id from repair_orders where id = new.applied_ro_id) is distinct from new.customer_id then
      raise exception 'A credit can only be applied to a job of the same company';
    end if;
    new.applied_at := coalesce(new.applied_at, now());
  end if;
  return new;
end $$;
create trigger credit_memos_check before insert or update on public.credit_memos for each row execute function check_credit_memo();
insert into public.role_permissions (role_id, permission_key)
select id, 'issue_credits' from public.roles where name in ('Owner','Admin') on conflict do nothing;
alter policy "edit credit_memos" on public.credit_memos using (has_permission('issue_credits')) with check (has_permission('issue_credits'));

create or replace function public.transfer_vehicle(p_vehicle uuid, p_to uuid, p_date date default null, p_odometer int default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from uuid;
begin
  if auth.uid() is not null and not has_permission('edit_customers') then raise exception 'Not allowed'; end if;
  select customer_id into v_from from vehicles where id = p_vehicle for update;
  if v_from = p_to then return; end if;
  insert into vehicle_transfers (vehicle_id, from_customer_id, to_customer_id, transferred_at, odometer_km, note)
  values (p_vehicle, v_from, p_to, coalesce(p_date, local_date()), p_odometer, p_note);
  update vehicles set customer_id = p_to, mileage_km = coalesce(greatest(mileage_km, p_odometer), mileage_km) where id = p_vehicle;
  update repair_orders set customer_id = p_to where vehicle_id = p_vehicle and order_status = 'estimate';   -- open jobs follow the vehicle
  update payments set customer_id = p_to where ro_id in (select id from repair_orders where vehicle_id = p_vehicle and order_status = 'estimate');
end $$;

-- ===== H5 · counters only move forward =====
create or replace function public.guard_number_sequence() returns trigger language plpgsql as $$
begin
  if new.next_value < old.next_value then raise exception 'Numbers can only move forward (current next number: %)', old.next_value; end if;
  return new;
end $$;
create trigger number_sequences_forward before update on public.number_sequences for each row execute function guard_number_sequence();

-- stock PO numbers never truncate after 99,999
create or replace function public.set_po_number() returns trigger language plpgsql security definer set search_path = public as $$
declare jn text; n int; sp bigint;
begin
  if new.ro_id is null then
    sp := next_number('stock_po');
    new.po_number := '9' || case when sp < 100000 then lpad(sp::text, 5, '0') else sp::text end;
  else
    select lpad(job_number::text, 6, '0') into jn from repair_orders where id = new.ro_id for update;
    select coalesce(max(split_part(po_number, '-', 2)::int), 100) into n
      from purchase_orders where ro_id = new.ro_id and po_number ~ ('^' || jn || '-[0-9]+$');
    new.po_number := jn || '-' || (n + 1);
  end if;
  return new;
end $$;

-- ===== M1 · sane values =====
alter table public.ro_service_items
  add constraint ro_item_values check (price >= 0 and cost >= 0 and qty >= 0 and discount_pct between 0 and 100
                                       and discount_amount >= 0 and discount_amount <= round(price * qty));
alter table public.ro_services add constraint ro_service_discount check (discount_pct between 0 and 100 and discount_amount >= 0);
alter table public.ro_job_discounts add constraint ro_job_discount_values check (value >= 0 and (kind <> 'percent' or value <= 100));
alter table public.ro_job_fees add constraint ro_job_fee_values check (value >= 0 and amount >= 0);
alter table public.catalog_items add constraint catalog_values check (cost >= 0 and price >= 0 and core_cost >= 0);

-- ===== M2 · stock goes back when a deducted part is removed or reduced (only possible after a void) =====
create or replace function public.reverse_job_stock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not old.stock_deducted or old.catalog_item_id is null then return null; end if;
  if tg_op = 'DELETE' then
    insert into stock_movements (catalog_item_id, qty_change, reason, note) values (old.catalog_item_id, old.qty, 'job_reversal', 'Line removed after void');
  elsif new.qty <> old.qty then
    insert into stock_movements (catalog_item_id, qty_change, reason, ro_service_item_id, note)
    values (old.catalog_item_id, old.qty - new.qty, 'job_reversal', new.id, 'Quantity changed after void');
  end if;
  return null;
end $$;
create trigger ro_items_reverse_stock after update of qty or delete on public.ro_service_items for each row execute function reverse_job_stock();

create or replace view public.stock_levels with (security_invoker = true) as
select ci.id, ci.name, ci.code, ci.category_id, ci.supplier_id, ci.qty_on_hand, ci.reorder_point,
  coalesce((select sum(i.qty) from ro_service_items i join ro_services sv on sv.id = i.service_id join repair_orders r on r.id = sv.ro_id
            where i.catalog_item_id = ci.id and not i.stock_deducted and i.po_item_id is null and r.order_status = 'estimate'
              and sv.approval_status in ('pending','approved')),0) as qty_on_estimates,
  coalesce((select sum(pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled) from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
            where pi.catalog_item_id = ci.id and po.status in ('ordered','partially_delivered')),0) as qty_on_order
from catalog_items ci where ci.item_type = 'part' and ci.track_inventory;

-- ===== M3 · activity log: payment amounts and shop settings are logged =====
create or replace function public.log_activity() returns trigger language plpgsql security definer set search_path = public as $$
declare diff jsonb; v_id uuid; skip text[];
begin
  skip := array['updated_at','parts_total','labor_total','other_total','service_fees_total','item_discount_total','service_discount_total',
                'job_fees_total','job_discount_total','subtotal','taxable_base','tax_total','total','paid_total','balance',
                'service_total','service_discount','service_net','qty_on_hand'];
  if tg_table_name in ('ro_job_fees','ro_job_discounts','ro_service_items') then skip := skip || array['amount','discount','net']; end if;
  if tg_table_name = 'shop_settings' then v_id := '00000000-0000-0000-0000-000000000000';
  elsif tg_op = 'DELETE' then v_id := (to_jsonb(old)->>'id')::uuid;
  else v_id := (to_jsonb(new)->>'id')::uuid; end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value and n.key <> all(skip);
    if diff is null then return new; end if;
    insert into public.activity_log (entity_type, entity_id, action, changes) values (tg_table_name, v_id, 'update', diff);
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.activity_log (entity_type, entity_id, action) values (tg_table_name, v_id, 'create');
    return new;
  else
    insert into public.activity_log (entity_type, entity_id, action, changes) values (tg_table_name, v_id, 'delete', to_jsonb(old));
    return old;
  end if;
end $$;
create trigger log_shop_settings after update on public.shop_settings for each row execute function log_activity();

-- ===== M4 · schedule must belong to the job's vehicle; completing without km never moves km backwards =====
create or replace function public.check_service_schedule() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.service_schedule_id is not null and not exists (
       select 1 from service_schedules ss join repair_orders r on r.vehicle_id = ss.vehicle_id
       where ss.id = new.service_schedule_id and r.id = new.ro_id) then
    raise exception 'That service schedule belongs to a different vehicle';
  end if;
  return new;
end $$;
create trigger ro_services_schedule_check before insert or update of service_schedule_id on public.ro_services for each row execute function check_service_schedule();

create or replace function public.on_service_completed() returns trigger language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; km int;
begin
  if new.work_status = 'completed' and old.work_status is distinct from 'completed' then
    new.completed_at := coalesce(new.completed_at, now());
    select * into ro from repair_orders where id = new.ro_id;
    km := coalesce(ro.odometer_out, ro.odometer_in);
    if new.service_schedule_id is not null then
      update service_schedules set
        last_done_km = case when km is null then last_done_km else greatest(coalesce(last_done_km, 0), km) end,
        last_done_date = local_date()
      where id = new.service_schedule_id;
    end if;
    if km is not null then update vehicles set mileage_km = greatest(coalesce(mileage_km,0), km) where id = ro.vehicle_id; end if;
  end if;
  return new;
end $$;

-- service due uses the shop's local date
create or replace view public.service_due with (security_invoker = true) as
select ss.*, v.plate, v.customer_id, v.mileage_km,
  ss.next_due_km - v.mileage_km as km_left,
  ss.next_due_date - local_date() as days_left,
  case
    when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km) or (ss.next_due_date is not null and local_date() >= ss.next_due_date) then 'overdue'
    when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km - (select due_soon_km from shop_settings limit 1))
      or (ss.next_due_date is not null and local_date() >= ss.next_due_date - (select due_soon_days from shop_settings limit 1)) then 'due_soon'
    else 'ok' end as due_status
from service_schedules ss join vehicles v on v.id = ss.vehicle_id where ss.active;

-- broadcast notifications can't be edited by staff (per-user read tracking comes later)
alter policy "mark own notifications read" on public.notifications using (is_staff() and user_id = auth.uid());

-- ===== M7 · indexes =====
create index if not exists payments_ro_idx on public.payments (ro_id);
create index if not exists credit_memos_ro_idx on public.credit_memos (applied_ro_id);
create index if not exists ro_job_fees_ro_idx on public.ro_job_fees (ro_id);
create index if not exists ro_job_discounts_ro_idx on public.ro_job_discounts (ro_id);
create index if not exists purchase_orders_ro_idx on public.purchase_orders (ro_id);
create index if not exists cores_item_idx on public.cores (ro_service_item_id);
create index if not exists ro_items_catalog_idx on public.ro_service_items (catalog_item_id);
create index if not exists po_items_catalog_idx on public.purchase_order_items (catalog_item_id);
create index if not exists ro_concerns_ro_idx on public.ro_concerns (ro_id);
create index if not exists approvals_ro_idx on public.approvals (ro_id);
create index if not exists appointments_ro_idx on public.appointments (ro_id);
create index if not exists ro_inspections_ro_idx on public.ro_inspections (ro_id);

-- ===== C2/H5/M3 · column-level write access: system-managed columns can't be written from the app =====
revoke all on all tables in schema public from anon;
revoke insert, update on public.repair_orders, public.ro_services, public.ro_service_items, public.ro_job_fees, public.ro_job_discounts,
  public.payments, public.credit_memos, public.catalog_items, public.purchase_orders, public.activity_log, public.invoice_voids from authenticated;
grant insert (id, customer_id, vehicle_id, odometer_in, odometer_out, workflow_status, priority, tags, service_advisor_id, shop_notes, recommendations, print_language)
  on public.repair_orders to authenticated;
grant update (customer_id, vehicle_id, odometer_in, odometer_out, workflow_status, priority, tags, service_advisor_id, shop_notes, recommendations,
  print_language, archived_at, faktur_pajak_number, due_date) on public.repair_orders to authenticated;
grant insert (id, ro_id, position, name, notes_external, technician_id, concern_id, approval_status, work_status, completed_at, template_id, checklist_id,
  service_schedule_id, flat_price, discount_pct, discount_amount) on public.ro_services to authenticated;
grant update (position, name, notes_external, technician_id, concern_id, approval_status, work_status, completed_at, template_id, checklist_id,
  service_schedule_id, flat_price, discount_pct, discount_amount) on public.ro_services to authenticated;
grant insert (id, service_id, position, item_type, catalog_item_id, name, description, cost, price, qty, hours_worked, discount_pct, discount_amount,
  taxable, core_charge, show_qty_price, po_item_id) on public.ro_service_items to authenticated;
grant update (position, item_type, catalog_item_id, name, description, cost, price, qty, hours_worked, discount_pct, discount_amount,
  taxable, core_charge, show_qty_price, po_item_id) on public.ro_service_items to authenticated;
grant insert (id, ro_id, name, kind, value, taxable, manual_override, amount) on public.ro_job_fees to authenticated;
grant update (name, kind, value, taxable, manual_override, amount) on public.ro_job_fees to authenticated;
grant insert (id, ro_id, discount_id, name, kind, value, max_amount) on public.ro_job_discounts to authenticated;
grant update (name, kind, value, max_amount) on public.ro_job_discounts to authenticated;
grant insert (id, ro_id, kind, method, amount, paid_at, reference, receipt_number) on public.payments to authenticated;
grant update (ro_id, kind, method, amount, paid_at, reference, receipt_number) on public.payments to authenticated;
grant insert (id, customer_id, amount, reason, applied_ro_id, applied_at) on public.credit_memos to authenticated;
grant update (reason, applied_ro_id, applied_at) on public.credit_memos to authenticated;
grant insert (id, item_type, name, code, description, category_id, supplier_id, brand, cost, price, markup_pct, default_qty, labor_hours, labor_rate_id,
  fee_kind, fee_value, taxable, show_on_invoice, show_qty_price, track_inventory, reorder_point, has_core, core_cost, tire_size, notes, active)
  on public.catalog_items to authenticated;
grant update (item_type, name, code, description, category_id, supplier_id, brand, cost, price, markup_pct, default_qty, labor_hours, labor_rate_id,
  fee_kind, fee_value, taxable, show_on_invoice, show_qty_price, track_inventory, reorder_point, has_core, core_cost, tire_size, notes, active)
  on public.catalog_items to authenticated;
grant insert (id, supplier_id, ro_id, payment_terms_days, notes, status, ordered_at) on public.purchase_orders to authenticated;
grant update (supplier_id, payment_terms_days, notes, status, ordered_at) on public.purchase_orders to authenticated;

-- function grants for the new helpers
revoke execute on function public.lock_invoiced_job(), public.check_repair_order(), public.set_payment_customer(), public.check_credit_memo(),
  public.guard_number_sequence(), public.reverse_job_stock(), public.check_service_schedule(), public.protect_invoiced_job() from public, anon, authenticated;
revoke execute on function public.local_date() from public, anon;
grant execute on function public.local_date() to authenticated;
revoke execute on function public.recalc_repair_order(uuid), public.trg_recalc(), public.log_activity(), public.on_service_completed(),
  public.set_po_number(), public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.transfer_vehicle(uuid,uuid,date,int,text) from public, anon;
grant execute on function public.transfer_vehicle(uuid,uuid,date,int,text) to authenticated;
