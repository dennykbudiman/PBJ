-- Axle v2 · 112 third review + Denny's decisions (Oct 5, 22:40)
-- Decisions: (1) every service must be approved / declined / deferred before invoicing;
-- (2) a paid invoice can be voided: its payments stay on record and their value becomes a company credit,
--     applied to the corrected invoice (any excess stays as credit for that company);
-- (3) payments and credits can't exceed the balance due on an invoice (deposits on estimates are allowed);
-- (4) service advisors record technicians' hours worked (technicians are view-only).

-- ===== Permissions: Fleet managers get nothing through has_permission either (matches is_staff) =====
create or replace function public.has_permission(perm text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p join public.role_permissions rp on rp.role_id = p.role_id
                 left join public.roles r on r.id = p.role_id
                 where p.id = auth.uid() and p.status = 'active' and rp.permission_key = perm and coalesce(r.name, '') <> 'Fleet manager');
$$;

-- ===== Credits: capped at the balance, can be applied in part (split), released when a job is re-priced lower =====
create or replace function public.ro_open_balance(p_ro uuid, p_skip_credit uuid default null) returns numeric
language sql stable security definer set search_path = public as $$
  select r.total
       - coalesce((select sum(case when kind = 'payment' then amount else -amount end) from payments where ro_id = p_ro), 0)
       - coalesce((select sum(amount) from credit_memos where applied_ro_id = p_ro and id is distinct from p_skip_credit), 0)
  from repair_orders r where r.id = p_ro;
$$;

create or replace function public.check_credit_memo() returns trigger language plpgsql security definer set search_path = public as $$
declare v_bal numeric;
begin
  if new.applied_ro_id is not null then
    if (select customer_id from repair_orders where id = new.applied_ro_id) is distinct from new.customer_id then
      raise exception 'A credit can only be applied to a job of the same company';
    end if;
    if tg_op = 'INSERT' or new.applied_ro_id is distinct from old.applied_ro_id or new.amount > old.amount then
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

-- apply all or part of an unapplied credit to a job; a part splits the credit and the rest stays available
create or replace function public.apply_credit(p_credit uuid, p_ro uuid, p_amount numeric default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare cm credit_memos%rowtype; v_amt numeric; v_new uuid;
begin
  if auth.uid() is not null and not has_permission('record_payments') then raise exception 'Not allowed'; end if;
  select * into cm from credit_memos where id = p_credit for update;
  if not found then raise exception 'Credit not found'; end if;
  if cm.applied_ro_id is not null then raise exception 'This credit is already applied'; end if;
  perform 1 from repair_orders where id = p_ro for no key update;
  v_amt := coalesce(p_amount, least(cm.amount, greatest(ro_open_balance(p_ro), 0)));
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

create or replace function public.unapply_credit(p_credit uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('record_payments') then raise exception 'Not allowed'; end if;
  update credit_memos set applied_ro_id = null, applied_at = null where id = p_credit and applied_ro_id is not null;
  if not found then raise exception 'Credit not found or not applied'; end if;
end $$;

-- internal: credits applied beyond what is due are released back to the company (newest first, splitting if needed)
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
      insert into credit_memos (customer_id, amount, reason, created_by)
      values (c.customer_id, v_excess, coalesce(c.reason, 'Credit') || ' (released, job total lower)', c.created_by);
      v_excess := 0;
    end if;
  end loop;
end $$;

-- ===== recalc: per-job shop supplies rate; invoices can't be overpaid =====
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
           coalesce(sum(discount),0)
      into line_sum, line_taxable, c_p, c_l, c_o, c_f, c_disc
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

-- ===== Invoicing: every service decided; payments can't exceed the total; excess credits released; vehicle snapshot =====
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
  with used as (
    select i.id, i.catalog_item_id, i.qty
    from ro_service_items i join ro_services sv on sv.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
    where sv.ro_id = p_ro and sv.approval_status = 'approved' and i.item_type = 'part'
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
  where sv.ro_id = p_ro and i.item_type = 'part' and ci.has_core and sv.approval_status = 'approved'
    and not exists (select 1 from cores x where x.ro_service_item_id = i.id);
  perform recalc_repair_order(p_ro);                    -- invoice path: payments only
  return v_inv;
end $$;

-- ===== Void: a paid invoice can be voided; its payments become a company credit applied to the reopened job =====
create or replace function public.void_invoice(p_ro uuid, p_reason text) returns text language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; v_no text; v_cash numeric;
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
    bill_to_snapshot = null, shop_snapshot = null, faktur_pajak_number = null, workflow_status = 'completed'
  where id = p_ro;
  -- money received stays on record; its value moves into a company credit, applied straight back to this job
  select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) into v_cash from payments where ro_id = p_ro;
  if v_cash > 0 then
    insert into payments (ro_id, customer_id, kind, method, amount, reference)
    values (p_ro, ro.customer_id, 'refund', 'other', v_cash, 'Moved to company credit (voided ' || v_no || ')');
    insert into credit_memos (customer_id, amount, reason, applied_ro_id, applied_at)
    values (ro.customer_id, v_cash, 'Payments on voided ' || v_no, p_ro, now());
  end if;
  insert into stock_movements (catalog_item_id, qty_change, reason, ro_service_item_id, note)
  select i.catalog_item_id, i.qty, 'job_reversal', i.id, 'Invoice ' || v_no || ' voided'
  from ro_service_items i join ro_services s on s.id = i.service_id
  where s.ro_id = p_ro and i.stock_deducted and i.catalog_item_id is not null;
  update ro_service_items i set stock_deducted = false from ro_services s
  where s.id = i.service_id and s.ro_id = p_ro and i.stock_deducted;
  delete from cores where ro_id = p_ro and retrieval_status = 'to_be_retrieved' and return_status = 'to_be_returned';
  perform recalc_repair_order(p_ro);
  return v_no;
end $$;

-- ===== Issued invoices: printed header fields are locked too =====
create or replace function public.lock_invoice_header() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status = 'invoice' then
    if (new.odometer_in, new.odometer_out, new.recommendations) is distinct from (old.odometer_in, old.odometer_out, old.recommendations) then
      raise exception 'This job is invoiced. Void the invoice to make changes.';
    end if;
    if new.workflow_status not in ('invoiced','paid') then
      raise exception 'An invoiced job stays Invoiced (or Paid) on the board';
    end if;
  end if;
  return new;
end $$;
create trigger repair_orders_lock_invoice before update on public.repair_orders for each row execute function lock_invoice_header();

-- ===== Changing an estimate's company directly: payments follow the job, the old company's credits are released =====
create or replace function public.job_money_follows() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is distinct from old.customer_id then
    update credit_memos set applied_ro_id = null, applied_at = null where applied_ro_id = new.id and customer_id <> new.customer_id;
    update payments set customer_id = new.customer_id where ro_id = new.id and customer_id <> new.customer_id;
  end if;
  return null;
end $$;
create trigger job_money_follows after update of customer_id on public.repair_orders for each row execute function job_money_follows();

-- ===== Job PO ↔ job line links: only within the same job, set from the PO side only; unlinked job-PO parts go to stock =====
create or replace function public.guard_po_item() returns trigger language plpgsql security definer set search_path = public as $$
declare v_po_ro uuid;
begin
  if tg_op = 'DELETE' then
    if old.qty_delivered > 0 then raise exception 'This line has deliveries and can''t be deleted. Return it to the supplier instead.'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.qty_delivered > 0 and new.catalog_item_id is distinct from old.catalog_item_id then
      raise exception 'This line has deliveries; its part can''t be changed';
    end if;
    if old.qty_delivered > 0 and new.ro_service_item_id is distinct from old.ro_service_item_id then
      raise exception 'This line has deliveries; its job link can''t be changed';
    end if;
  end if;
  if new.qty_ordered < new.qty_delivered + new.qty_cancelled then
    raise exception 'Ordered quantity can''t be less than delivered + cancelled';
  end if;
  if new.ro_service_item_id is not null then
    select ro_id into v_po_ro from purchase_orders where id = new.po_id;
    if v_po_ro is null or v_po_ro is distinct from (select sv.ro_id from ro_service_items i join ro_services sv on sv.id = i.service_id where i.id = new.ro_service_item_id) then
      raise exception 'A PO line can only be linked to a part on the same job';
    end if;
  end if;
  return new;
end $$;
create trigger po_items_guard_insert before insert on public.purchase_order_items for each row execute function guard_po_item();

create or replace function public.po_item_stock() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid;
begin
  if new.qty_delivered = old.qty_delivered or new.catalog_item_id is null then return null; end if;
  select ro_id into v_ro from purchase_orders where id = new.po_id;
  -- stock POs, and job-PO lines not tied to a job line, go onto the shelf; linked job-PO parts go straight to the job
  if (v_ro is null or new.ro_service_item_id is null)
     and exists (select 1 from catalog_items where id = new.catalog_item_id and track_inventory) then
    insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id)
    values (new.catalog_item_id, new.qty_delivered - old.qty_delivered, 'po_delivery', new.id);
  end if;
  return null;
end $$;

-- ===== PO status: the system sets delivered / partially delivered; the app can only draft, order or cancel =====
create or replace function public.refresh_po_status() returns trigger language plpgsql security definer set search_path = public as $$
declare v_po uuid := coalesce(new.po_id, old.po_id); o numeric; d numeric; c numeric; cur text;
begin
  select coalesce(sum(qty_ordered),0), coalesce(sum(qty_delivered),0), coalesce(sum(qty_cancelled),0) into o, d, c
  from purchase_order_items where po_id = v_po;
  select status into cur from purchase_orders where id = v_po;
  if cur is null then return null; end if;
  if not (cur = 'draft' and d = 0 and c = 0) then
    update purchase_orders set status = case
        when o > 0 and c >= o then 'cancelled'
        when o > 0 and d + c >= o then 'delivered'
        when d > 0 then 'partially_delivered'
        when cur = 'cancelled' then 'cancelled'
        else 'ordered' end
    where id = v_po and status is distinct from (case
        when o > 0 and c >= o then 'cancelled'
        when o > 0 and d + c >= o then 'delivered'
        when d > 0 then 'partially_delivered'
        when cur = 'cancelled' then 'cancelled'
        else 'ordered' end);
  end if;
  update purchase_orders set payment_status = case
      when not exists (select 1 from purchase_order_items where po_id = v_po and qty_delivered > 0 and paid_at is null) and exists (select 1 from purchase_order_items where po_id = v_po and paid_at is not null) then 'paid'
      when exists (select 1 from purchase_order_items where po_id = v_po and paid_at is not null) then 'partial'
      else 'unpaid' end
  where id = v_po;
  return null;
end $$;

create or replace function public.guard_po_status() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'authenticated' then return new; end if;     -- system updates (deliveries) are always allowed
  if tg_op = 'INSERT' then
    if new.status not in ('draft','ordered') then raise exception 'A new PO starts as Draft or Ordered'; end if;
    return new;
  end if;
  if new.status = old.status then return new; end if;
  if old.status in ('partially_delivered','delivered') or new.status in ('partially_delivered','delivered') then
    raise exception 'Delivery status is set automatically from the delivered quantities';
  end if;
  if old.status = 'cancelled' then raise exception 'A cancelled PO can''t be reopened. Create a new PO.'; end if;
  return new;
end $$;
create trigger purchase_orders_status_guard before insert or update of status on public.purchase_orders for each row execute function guard_po_status();

create or replace function public.cancel_po_lines() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update purchase_order_items set qty_cancelled = qty_ordered - qty_delivered where po_id = new.id and qty_cancelled <> qty_ordered - qty_delivered;
  end if;
  return null;
end $$;
create trigger purchase_orders_cancel_lines after update of status on public.purchase_orders for each row execute function cancel_po_lines();

-- ===== Settings: valid values; open estimates follow settings changes =====
alter table public.shop_settings
  add constraint shop_settings_values check (
    tax_rate between 0 and 100 and shop_supplies_rate >= 0 and (shop_supplies_type <> 'percent' or shop_supplies_rate <= 100)
    and coalesce(shop_supplies_min, 0) >= 0 and coalesce(shop_supplies_max, 0) >= 0
    and (shop_supplies_min is null or shop_supplies_max is null or shop_supplies_min <= shop_supplies_max)
    and default_payment_terms_days >= 0 and due_soon_days >= 0 and due_soon_km >= 0);
create or replace function public.check_shop_settings() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone "%". Use a name like Asia/Jakarta, Asia/Makassar or Asia/Jayapura.', new.timezone;
  end if;
  return new;
end $$;
create trigger shop_settings_check before insert or update of timezone on public.shop_settings for each row execute function check_shop_settings();

create or replace function public.reprice_open_estimates() returns trigger language plpgsql security definer set search_path = public as $$
declare j record;
begin
  if tg_table_name = 'shop_settings' then
    -- jobs still on the old default shop supplies rate move to the new one (rates edited on a job are kept)
    if (new.shop_supplies_type, new.shop_supplies_rate) is distinct from (old.shop_supplies_type, old.shop_supplies_rate) then
      update ro_job_fees f set kind = new.shop_supplies_type, value = new.shop_supplies_rate
      from repair_orders r
      where r.id = f.ro_id and r.order_status = 'estimate' and f.is_shop_supplies and not f.manual_override
        and f.kind = old.shop_supplies_type and f.value = old.shop_supplies_rate;
    end if;
    if (new.tax_rate, new.pkp_status, new.shop_supplies_type, new.shop_supplies_rate, new.shop_supplies_base, new.shop_supplies_min, new.shop_supplies_max)
       is distinct from (old.tax_rate, old.pkp_status, old.shop_supplies_type, old.shop_supplies_rate, old.shop_supplies_base, old.shop_supplies_min, old.shop_supplies_max) then
      for j in select id from repair_orders where order_status = 'estimate' loop perform recalc_repair_order(j.id); end loop;
    end if;
  else  -- customers: tax exemption changed
    if new.tax_exempt is distinct from old.tax_exempt then
      for j in select id from repair_orders where order_status = 'estimate' and customer_id = new.id loop perform recalc_repair_order(j.id); end loop;
    end if;
  end if;
  return null;
end $$;
create trigger shop_settings_reprice after update on public.shop_settings for each row execute function reprice_open_estimates();
create trigger customers_reprice after update of tax_exempt on public.customers for each row execute function reprice_open_estimates();

create or replace function public.refresh_estimate(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  perform recalc_repair_order(p_ro);
end $$;

-- ===== More value checks =====
alter table public.ro_services add constraint ro_service_flat_price check (flat_price is null or flat_price >= 0);
alter table public.ro_service_items add constraint ro_item_core_charge check (core_charge >= 0 and (core_charge = 0 or item_type = 'part'));
alter table public.service_templates add constraint service_template_flat_price check (flat_price is null or flat_price >= 0);
alter table public.labor_rates add constraint labor_rate_values check (rate_per_hour >= 0);
alter table public.purchase_order_items add constraint po_item_values check (cost >= 0 and core_cost >= 0 and qty_delivered >= 0 and qty_cancelled >= 0);

-- ===== Links inside a job stay inside the job =====
create or replace function public.check_service_schedule() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.service_schedule_id is not null and not exists (
       select 1 from service_schedules ss join repair_orders r on r.vehicle_id = ss.vehicle_id
       where ss.id = new.service_schedule_id and r.id = new.ro_id) then
    raise exception 'That service schedule belongs to a different vehicle';
  end if;
  if new.concern_id is not null and not exists (select 1 from ro_concerns where id = new.concern_id and ro_id = new.ro_id) then
    raise exception 'That concern belongs to a different job';
  end if;
  return new;
end $$;
create trigger ro_services_concern_check before insert or update of concern_id on public.ro_services for each row execute function check_service_schedule();

-- approvals: must be for a service on the same job, and recording one sets the service's approval status
create or replace function public.apply_approval() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and tg_when = 'BEFORE' then
    if not exists (select 1 from ro_services where id = new.service_id and ro_id = new.ro_id) then
      raise exception 'That service belongs to a different job';
    end if;
    return new;
  end if;
  update ro_services set approval_status = new.decision where id = new.service_id and approval_status is distinct from new.decision;
  return null;
end $$;
create trigger approvals_check before insert on public.approvals for each row execute function apply_approval();
create trigger approvals_apply after insert on public.approvals for each row execute function apply_approval();

-- appointments: company / vehicle filled from the job or vehicle, and must agree
create or replace function public.check_appointment() returns trigger language plpgsql security definer set search_path = public as $$
declare r repair_orders%rowtype;
begin
  if new.ro_id is not null then
    select * into r from repair_orders where id = new.ro_id;
    new.vehicle_id := coalesce(new.vehicle_id, r.vehicle_id);
    new.customer_id := coalesce(new.customer_id, r.customer_id);
    if new.vehicle_id <> r.vehicle_id then raise exception 'The appointment vehicle doesn''t match the job'; end if;
  end if;
  if new.vehicle_id is not null then
    new.customer_id := coalesce(new.customer_id, (select customer_id from vehicles where id = new.vehicle_id));
    if tg_op = 'INSERT' and new.customer_id <> (select customer_id from vehicles where id = new.vehicle_id) then
      raise exception 'That vehicle belongs to another company';
    end if;
  end if;
  return new;
end $$;
create trigger appointments_check before insert or update of ro_id, vehicle_id, customer_id on public.appointments for each row execute function check_appointment();

-- ===== Service schedules also update when a service is added as completed or linked after completion =====
create or replace function public.on_service_completed() returns trigger language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; km int; v_was_done boolean;
begin
  v_was_done := false;
  if tg_op = 'UPDATE' then
    v_was_done := old.work_status = 'completed' and old.service_schedule_id is not distinct from new.service_schedule_id;
  end if;
  if new.work_status = 'completed' and not v_was_done then
    new.completed_at := coalesce(new.completed_at, now());
    select * into ro from repair_orders where id = new.ro_id;
    km := coalesce(ro.odometer_out, ro.odometer_in, (select mileage_km from vehicles where id = ro.vehicle_id));
    if new.service_schedule_id is not null then
      update service_schedules set
        last_done_km = case when km is null then last_done_km else greatest(coalesce(last_done_km, 0), km) end,
        last_done_date = greatest(coalesce(last_done_date, local_date()), local_date())
      where id = new.service_schedule_id;
    end if;
    if km is not null then update vehicles set mileage_km = greatest(coalesce(mileage_km,0), km) where id = ro.vehicle_id; end if;
  end if;
  return new;
end $$;
create trigger ro_services_completed_more before insert or update of service_schedule_id on public.ro_services for each row execute function on_service_completed();

-- ===== Transfers also move future appointments =====
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
  -- open jobs follow the vehicle (job_money_follows releases the old company's credits and moves payments)
  update repair_orders set customer_id = p_to where vehicle_id = p_vehicle and order_status = 'estimate';
  update appointments set customer_id = p_to
  where vehicle_id = p_vehicle and start_time > now() and status not in ('cancelled','no_show') and customer_id is distinct from p_to;
end $$;

-- ===== Balances per company (for the company page and reports) =====
create or replace view public.customer_balances with (security_invoker = true) as
select c.id as customer_id, c.display_name,
  coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0), 0) as balance_due,
  coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0 and r.due_date < local_date()), 0) as overdue,
  count(r.id) filter (where r.order_status = 'invoice' and r.balance > 0) as open_invoices,
  coalesce((select sum(amount) from credit_memos m where m.customer_id = c.id and m.applied_ro_id is null), 0) as available_credit
from customers c left join repair_orders r on r.customer_id = c.id
group by c.id, c.display_name;

create index if not exists repair_orders_invoiced_idx on public.repair_orders (invoiced_at desc) where order_status = 'invoice';
create index if not exists repair_orders_customer_idx on public.repair_orders (customer_id, created_at desc);
create index if not exists credit_memos_unapplied_idx on public.credit_memos (customer_id) where applied_ro_id is null;

-- ===== Storage: logo can be replaced / removed by settings editors; only job editors upload attachments =====
create policy "logo read" on storage.objects for select using (bucket_id = 'shop-assets');
create policy "logo delete" on storage.objects for delete using (bucket_id = 'shop-assets' and public.has_permission('edit_settings'));
alter policy "attachments write" on storage.objects with check (bucket_id = 'attachments' and public.has_permission('edit_jobs'));

-- ===== Job lines: the PO link is set from the PO side only =====
revoke insert, update on public.ro_service_items from authenticated;
grant insert (id, service_id, position, item_type, catalog_item_id, name, description, cost, price, qty, hours_worked, discount_pct, discount_amount,
  taxable, core_charge, show_qty_price) on public.ro_service_items to authenticated;
grant update (position, item_type, catalog_item_id, name, description, cost, price, qty, hours_worked, discount_pct, discount_amount,
  taxable, core_charge, show_qty_price) on public.ro_service_items to authenticated;

-- ===== Performance: evaluate is_staff() / has_permission() once per query instead of once per row =====
do $$
declare p record; q text; w text; pat constant text := '(?<!SELECT )(is_staff\(\)|has_permission\(''[a-z_]+''::text\))';
begin
  for p in select schemaname, tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    q := regexp_replace(p.qual, pat, '(select \1)', 'g');
    w := regexp_replace(p.with_check, pat, '(select \1)', 'g');
    if q is distinct from p.qual or w is distinct from p.with_check then
      execute format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename)
        || case when q is not null then format(' using (%s)', q) else '' end
        || case when w is not null then format(' with check (%s)', w) else '' end;
    end if;
  end loop;
end $$;

-- ===== Function access =====
revoke execute on function public.lock_invoice_header(), public.job_money_follows(), public.guard_po_status(), public.cancel_po_lines(),
  public.check_shop_settings(), public.reprice_open_estimates(), public.apply_approval(), public.check_appointment(),
  public.release_excess_credit(uuid) from public, anon, authenticated;
revoke execute on function public.ro_open_balance(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.apply_credit(uuid, uuid, numeric), public.unapply_credit(uuid), public.refresh_estimate(uuid) from public, anon;
grant execute on function public.apply_credit(uuid, uuid, numeric), public.unapply_credit(uuid), public.refresh_estimate(uuid) to authenticated;
revoke execute on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated;
