-- Axle v2 · 110 fixes from the second review (Oct 5)

-- ===== #1 · an invoice can't be re-priced by a line saved while it's being invoiced =====
-- the lock check now waits for (and sees) an in-progress invoicing; recalc locks the job row too
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
    -- #11 service_schedule_id: deleting a schedule sets it to null on old invoiced services
    when 'ro_services' then array['technician_id','work_status','completed_at','service_total','service_discount','service_net','service_schedule_id']
    when 'ro_service_items' then array['stock_deducted','po_item_id','hours_worked','amount','discount','net']   -- generated columns aren't filled yet in a BEFORE trigger; their inputs are compared
    else array[]::text[] end;
  o := to_jsonb(old) - allowed; n := to_jsonb(new) - allowed;
  if o is distinct from n then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
  return new;
end $$;

-- ===== recalc: #1 row lock, #8 flat-price split across categories (never negative fees), core charges billed, #13 refunds ≤ payments =====
create or replace function public.recalc_repair_order(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
declare
  s record; st shop_settings%rowtype; ro repair_orders%rowtype;
  v_parts numeric := 0; v_labor numeric := 0; v_other numeric := 0; v_fees numeric := 0;
  v_item_disc numeric := 0; v_svc_disc numeric := 0; v_taxable numeric := 0;
  v_job_fees numeric := 0; v_job_disc numeric := 0; v_pre numeric; v_base numeric; v_amt numeric;
  v_subtotal numeric; v_tax numeric; v_paid numeric; v_total numeric; v_taxable_fees numeric := 0; v_rate numeric;
  line_sum numeric; line_taxable numeric; svc_total numeric; svc_disc numeric; svc_taxable numeric;
  c_p numeric; c_l numeric; c_o numeric; c_f numeric; c_disc numeric; k numeric; rem numeric;
  f record; d record;
begin
  select * into ro from repair_orders where id = p_ro for no key update;
  if not found then return; end if;

  select coalesce(sum(case when kind = 'payment' then amount else -amount end),0) into v_paid from payments where ro_id = p_ro;
  if v_paid < 0 then raise exception 'Refunds can''t be more than the payments received on this job'; end if;
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
    -- line value = net + core charge (per unit × qty)
    select coalesce(sum(net + round(core_charge * qty)),0),
           coalesce(sum(net + round(core_charge * qty)) filter (where taxable),0),
           coalesce(sum(net + round(core_charge * qty)) filter (where item_type = 'part'),0),
           coalesce(sum(net) filter (where item_type = 'labor'),0),
           coalesce(sum(net) filter (where item_type = 'sublet'),0),
           coalesce(sum(net) filter (where item_type = 'fee'),0),
           coalesce(sum(discount),0)
      into line_sum, line_taxable, c_p, c_l, c_o, c_f, c_disc
      from ro_service_items where service_id = s.id;
    if s.flat_price is not null then
      if line_sum > 0 then
        -- flat price spread over the categories in proportion to the lines; rounding remainder to the largest
        k := s.flat_price / line_sum;
        c_p := round(c_p * k); c_l := round(c_l * k); c_o := round(c_o * k); c_f := round(c_f * k);
        rem := s.flat_price - (c_p + c_l + c_o + c_f);
        if c_p >= greatest(c_l, c_o, c_f) then c_p := c_p + rem; elsif c_l >= greatest(c_o, c_f) then c_l := c_l + rem;
        elsif c_o >= c_f then c_o := c_o + rem; else c_f := c_f + rem; end if;
        line_taxable := line_taxable * k;
      else
        c_p := 0; c_l := s.flat_price; c_o := 0; c_f := 0; line_taxable := 0;
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
      v_base := greatest(case st.shop_supplies_base when 'parts' then v_parts when 'labor' then v_labor else v_parts + v_labor end, 0);
      v_amt := case when st.shop_supplies_type = 'fixed' then st.shop_supplies_rate else round(v_base * st.shop_supplies_rate / 100) end;
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

-- #13 an invoice is only "paid" on the board when it is actually paid
alter table public.repair_orders add constraint ro_paid_means_paid check (workflow_status <> 'paid' or payment_status = 'paid');

-- ===== invoicing: #5 parts bought on a job PO never also leave shelf stock; #10 never reuse a voided number =====
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
  if exists (select 1 from invoice_voids where invoice_number = v_inv) then
    raise exception 'Invoice number % was already used (voided). Check the invoice counter in Settings.', v_inv;
  end if;
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
      and not exists (select 1 from purchase_order_items pi where pi.ro_service_item_id = i.id)
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

-- ===== #2 · void puts everything back: stock returns to the shelf, untouched cores are removed; re-invoicing starts clean =====
create or replace function public.void_invoice(p_ro uuid, p_reason text) returns text language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; v_no text;
begin
  if auth.uid() is not null and not has_permission('void_invoices') then raise exception 'Not allowed'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required to void an invoice'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status <> 'invoice' then raise exception 'This job is not invoiced'; end if;
  if ro.paid_total <> 0 then
    raise exception 'Refund or move the payments on this invoice before voiding it';
  end if;
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
  insert into stock_movements (catalog_item_id, qty_change, reason, ro_service_item_id, note)
  select i.catalog_item_id, i.qty, 'job_reversal', i.id, 'Invoice ' || v_no || ' voided'
  from ro_service_items i join ro_services s on s.id = i.service_id
  where s.ro_id = p_ro and i.stock_deducted and i.catalog_item_id is not null;
  update ro_service_items i set stock_deducted = false from ro_services s
  where s.id = i.service_id and s.ro_id = p_ro and i.stock_deducted;
  -- cores not yet retrieved or returned are recreated (once) at re-invoicing
  delete from cores where ro_id = p_ro and retrieval_status = 'to_be_retrieved' and return_status = 'to_be_returned';
  perform recalc_repair_order(p_ro);
  return v_no;
end $$;

-- ===== #3 · purchase orders: stock follows qty_delivered (locked, never twice), partial deliveries, no deleting delivered lines =====
create or replace function public.po_item_stock() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid;
begin
  if new.qty_delivered = old.qty_delivered or new.catalog_item_id is null then return null; end if;
  select ro_id into v_ro from purchase_orders where id = new.po_id;
  if v_ro is null and exists (select 1 from catalog_items where id = new.catalog_item_id and track_inventory) then
    insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id)
    values (new.catalog_item_id, new.qty_delivered - old.qty_delivered, 'po_delivery', new.id);
  end if;
  return null;
end $$;
create trigger po_items_stock after update of qty_delivered on public.purchase_order_items for each row execute function po_item_stock();

create or replace function public.guard_po_item() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.qty_delivered > 0 then raise exception 'This line has deliveries and can''t be deleted. Return it to the supplier instead.'; end if;
    return old;
  end if;
  if old.qty_delivered > 0 and new.catalog_item_id is distinct from old.catalog_item_id then
    raise exception 'This line has deliveries; its part can''t be changed';
  end if;
  if new.qty_ordered < new.qty_delivered + new.qty_cancelled then
    raise exception 'Ordered quantity can''t be less than delivered + cancelled';
  end if;
  return new;
end $$;
create trigger po_items_guard before update or delete on public.purchase_order_items for each row execute function guard_po_item();

-- #5 the job line always points at its PO line (one link, kept in sync)
create or replace function public.sync_po_item_link() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.ro_service_item_id is not null and old.ro_service_item_id is distinct from new.ro_service_item_id then
    update ro_service_items set po_item_id = null where id = old.ro_service_item_id and po_item_id = new.id;
  end if;
  if new.ro_service_item_id is not null then
    update ro_service_items set po_item_id = new.id where id = new.ro_service_item_id and po_item_id is distinct from new.id;
  end if;
  return null;
end $$;
create trigger po_items_link after insert or update of ro_service_item_id on public.purchase_order_items for each row execute function sync_po_item_link();

create or replace function public.mark_po_items_delivered(p_items uuid[], p_delivered date, p_invoice_no text, p_invoice_date date, p_due date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  -- row locks make a double-click harmless: the second update finds nothing left to deliver
  update purchase_order_items set qty_delivered = qty_ordered - qty_cancelled, delivered_at = coalesce(p_delivered, local_date()),
    supplier_invoice_no = coalesce(p_invoice_no, supplier_invoice_no), invoice_date = coalesce(p_invoice_date, invoice_date),
    payment_due = coalesce(p_due, payment_due)
  where id = any(p_items) and qty_delivered < qty_ordered - qty_cancelled;
end $$;

create or replace function public.deliver_po_item(p_item uuid, p_qty numeric, p_delivered date default null, p_invoice_no text default null,
  p_invoice_date date default null, p_due date default null) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity delivered'; end if;
  update purchase_order_items set qty_delivered = qty_delivered + p_qty, delivered_at = coalesce(p_delivered, local_date()),
    supplier_invoice_no = coalesce(p_invoice_no, supplier_invoice_no), invoice_date = coalesce(p_invoice_date, invoice_date),
    payment_due = coalesce(p_due, payment_due)
  where id = p_item;
  if not found then raise exception 'PO line not found'; end if;
end $$;

create or replace function public.mark_po_items_cancelled(p_items uuid[]) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  update purchase_order_items set qty_cancelled = qty_ordered - qty_delivered where id = any(p_items) and qty_cancelled <> qty_ordered - qty_delivered;
end $$;

-- returns to supplier take the parts out of stock once, when shipped
alter table public.stock_movements add column return_id uuid references public.returns(id) on delete set null;
create index stock_movements_return_idx on public.stock_movements (return_id);
create or replace function public.return_stock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'inventory' and new.catalog_item_id is not null and new.status in ('shipped','delivered','refunded')
     and exists (select 1 from catalog_items where id = new.catalog_item_id and track_inventory)
     and not exists (select 1 from stock_movements where return_id = new.id) then
    insert into stock_movements (catalog_item_id, qty_change, reason, return_id, note)
    values (new.catalog_item_id, -new.qty, 'return', new.id, 'Returned to supplier');
  end if;
  return null;
end $$;
create trigger returns_stock after insert or update of status on public.returns for each row execute function return_stock();
create or replace function public.guard_return() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from stock_movements where return_id = old.id) then
    if tg_op = 'DELETE' then raise exception 'This return has already left stock and can''t be deleted'; end if;
    if new.qty <> old.qty or new.catalog_item_id is distinct from old.catalog_item_id then
      raise exception 'This return has already left stock; its part and quantity can''t be changed';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger returns_guard before update or delete on public.returns for each row execute function guard_return();

-- ===== #4 · the stock ledger is append-only; the app may only add opening stock and manual adjustments =====
create or replace function public.guard_stock_movement() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  -- current_user is 'authenticated' only for writes coming straight from the app (not from database functions)
  if current_user = 'authenticated' and new.reason not in ('opening','adjustment') then
    raise exception 'Stock for jobs, deliveries and returns is moved automatically';
  end if;
  return new;
end $$;
create trigger stock_movements_guard before insert on public.stock_movements for each row execute function guard_stock_movement();

-- ===== #6 / #7 · vehicles change company only through a transfer; the old company's credits don't follow =====
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
  -- credits belong to the old company: unapply them from the jobs that move (they stay available to that company)
  update credit_memos set applied_ro_id = null, applied_at = null
  where applied_ro_id in (select id from repair_orders where vehicle_id = p_vehicle and order_status = 'estimate');
  update vehicles set customer_id = p_to, mileage_km = coalesce(greatest(mileage_km, p_odometer), mileage_km) where id = p_vehicle;
  update repair_orders set customer_id = p_to where vehicle_id = p_vehicle and order_status = 'estimate';   -- open jobs follow the vehicle
  update payments set customer_id = p_to where ro_id in (select id from repair_orders where vehicle_id = p_vehicle and order_status = 'estimate');
end $$;

-- ===== #9 · technicians: only active staff; without edit_jobs they can only progress their own work =====
alter policy "technician updates own services" on public.ro_services
  using (is_staff() and technician_id = (select auth.uid())) with check (is_staff() and technician_id = (select auth.uid()));
alter policy "technician updates own inspections" on public.ro_inspections
  using (is_staff() and technician_id = (select auth.uid())) with check (is_staff() and technician_id = (select auth.uid()));
create or replace function public.limit_service_edit() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user = 'authenticated' and not has_permission('edit_jobs')
     and (to_jsonb(old) - array['work_status','completed_at','service_total','service_discount','service_net'])
         is distinct from (to_jsonb(new) - array['work_status','completed_at','service_total','service_discount','service_net']) then
    raise exception 'You can only update the work status of your services';
  end if;
  return new;
end $$;
create trigger ro_services_limit_edit before update on public.ro_services for each row execute function limit_service_edit();

-- invited / disabled users can't edit their profile (e.g. claim a username)
alter policy "own profile update" on public.profiles using (is_staff() and id = (select auth.uid())) with check (is_staff() and id = (select auth.uid()));

-- ===== #12 · completing a service without an odometer reading uses the vehicle's current km =====
create or replace function public.on_service_completed() returns trigger language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; km int;
begin
  if new.work_status = 'completed' and old.work_status is distinct from 'completed' then
    new.completed_at := coalesce(new.completed_at, now());
    select * into ro from repair_orders where id = new.ro_id;
    km := coalesce(ro.odometer_out, ro.odometer_in, (select mileage_km from vehicles where id = ro.vehicle_id));
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

-- ===== write access: system tables and columns =====
-- stock ledger: insert only (opening / adjustment, enforced above)
revoke insert, update, delete on public.stock_movements from authenticated;
grant insert (id, catalog_item_id, qty_change, reason, note) on public.stock_movements to authenticated;
-- PO lines: deliveries and cancellations go through deliver_po_item / mark_po_items_*
revoke insert, update on public.purchase_order_items from authenticated;
grant insert (id, po_id, catalog_item_id, ro_service_item_id, name, part_number, cost, core_cost, taxable, qty_ordered,
  supplier_invoice_no, invoice_date, payment_due) on public.purchase_order_items to authenticated;
grant update (catalog_item_id, ro_service_item_id, name, part_number, cost, core_cost, taxable, qty_ordered,
  supplier_invoice_no, invoice_date, payment_due, paid_at, delivered_at) on public.purchase_order_items to authenticated;
-- vehicles: company changes only through transfer_vehicle; transfer history can't be written directly
revoke update on public.vehicles from authenticated;
grant update (plate, make, model, year, vin, type, fuel_type, status, mileage_km, notes) on public.vehicles to authenticated;
revoke insert, update, delete on public.vehicle_transfers from authenticated;
-- counters: only next_value, only forward; shop settings row can't be removed; role names are fixed
revoke insert, update, delete on public.number_sequences from authenticated;
grant update (next_value) on public.number_sequences to authenticated;
revoke insert, delete on public.shop_settings from authenticated;
revoke update on public.roles from authenticated;
-- void records are written only by void_invoice
revoke insert, update, delete on public.invoice_voids from authenticated;

-- function access
revoke execute on function public.po_item_stock(), public.guard_po_item(), public.sync_po_item_link(), public.return_stock(), public.guard_return(),
  public.guard_stock_movement(), public.limit_service_edit() from public, anon, authenticated;
revoke execute on function public.deliver_po_item(uuid, numeric, date, text, date, date) from public, anon;
grant execute on function public.deliver_po_item(uuid, numeric, date, text, date, date) to authenticated;
revoke execute on function public.recalc_repair_order(uuid) from public, anon, authenticated;
