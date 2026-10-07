-- Axle v2 · 124 inventory & purchase orders (stage 7)
-- 1. POs keep the tax rate they were raised with, stamp the order date, and only a draft can be deleted.
--    The supplier can't change once something has been delivered. No lines can be added to a cancelled PO.
-- 2. Supplier payments go through pay_po_items() / undo_supplier_payment(): the amount is worked out here
--    from the delivered, unpaid quantity (cost + core + tax), never typed in. PO lines remember how much is paid.
-- 3. Returns to the supplier: tidy grants, forward-only status (marked → shipped → delivered → refunded) with dates,
--    no more back than was delivered on the PO line, and the stock leaves the shelf when shipped (stock or job returns).
-- 4. Cores: created by invoicing only; the app can move them along (retrieved → marked → shipped → delivered → refunded).
-- Rows that already exist are backfilled first (tax rate, order date, paid quantity, step dates), so nothing old
-- picks up today's date or a 0% tax rate later.

-- ===== 1. purchase orders
alter table public.purchase_orders add column if not exists tax_rate numeric(5,2) not null default 0;
update public.purchase_orders set tax_rate = coalesce((select tax_rate from public.shop_settings limit 1), 0) where tax_rate = 0;
update public.purchase_orders set ordered_at = created_at where ordered_at is null and status <> 'draft';
alter table public.purchase_orders add constraint po_terms_range check (payment_terms_days is null or payment_terms_days between 0 and 365);
alter table public.purchase_orders add constraint po_notes_length check (notes is null or length(notes) <= 2000);

create or replace function public.stamp_purchase_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.tax_rate := coalesce((select tax_rate from shop_settings limit 1), 0);
  end if;
  -- ordered (or received straight from a draft): the PO has an order date from then on
  if new.status <> 'draft' and new.status <> 'cancelled' and new.ordered_at is null then new.ordered_at := now(); end if;
  if new.notes is not null then new.notes := nullif(btrim(new.notes), ''); end if;
  return new;
end $$;
drop trigger if exists purchase_orders_stamp on public.purchase_orders;
create trigger purchase_orders_stamp before insert or update on public.purchase_orders
  for each row execute function public.stamp_purchase_order();

create or replace function public.guard_po_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'Only a draft PO can be deleted. Cancel it instead.'; end if;
    return old;
  end if;
  if new.supplier_id is distinct from old.supplier_id
     and exists (select 1 from purchase_order_items where po_id = new.id and qty_delivered > 0) then
    raise exception 'Parts on this PO have been delivered; its supplier can''t change';
  end if;
  return new;
end $$;
drop trigger if exists purchase_orders_guard on public.purchase_orders;
create trigger purchase_orders_guard before update or delete on public.purchase_orders
  for each row execute function public.guard_po_row();

-- ===== PO lines
alter table public.purchase_order_items add column if not exists qty_paid numeric(10,2) not null default 0;
update public.purchase_order_items set qty_paid = qty_delivered where paid_at is not null and qty_paid = 0;
alter table public.purchase_order_items add constraint po_item_paid_range check (qty_paid >= 0 and qty_paid <= qty_delivered);
alter table public.purchase_order_items add constraint po_item_limits check (qty_ordered <= 100000);
alter table public.purchase_order_items add constraint po_item_texts check (length(name) between 1 and 200 and (part_number is null or length(part_number) <= 100)
  and (supplier_invoice_no is null or length(supplier_invoice_no) <= 100));
revoke update (paid_at) on public.purchase_order_items from authenticated;

create or replace function public.guard_po_item() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_po purchase_orders%rowtype; v_other text; v_job_item uuid; v_found boolean;
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
    -- unlinking (the job line was deleted) is fine; linking to another job line after a delivery is not
    if old.qty_delivered > 0 and new.ro_service_item_id is distinct from old.ro_service_item_id and new.ro_service_item_id is not null then
      raise exception 'This line has deliveries; its job link can''t be changed';
    end if;
    if new.qty_ordered > old.qty_ordered and (v_po.status = 'cancelled' or old.qty_cancelled > 0) then
      raise exception 'A cancelled line can''t be ordered again; add a new line';
    end if;
    if old.qty_paid > 0 and (new.cost <> old.cost or new.core_cost <> old.core_cost or new.taxable <> old.taxable) then
      raise exception 'This line has been paid; undo the payment before changing its price';
    end if;
  end if;
  if new.catalog_item_id is not null and (tg_op = 'INSERT' or new.catalog_item_id is distinct from old.catalog_item_id)
     and not exists (select 1 from catalog_items where id = new.catalog_item_id and item_type = 'part') then
    raise exception 'Only parts can go on a purchase order';
  end if;
  if new.qty_ordered < new.qty_delivered + new.qty_cancelled then
    raise exception 'Ordered quantity can''t be less than delivered + cancelled';
  end if;
  if new.ro_service_item_id is not null and (tg_op = 'INSERT' or new.ro_service_item_id is distinct from old.ro_service_item_id
                                            or new.catalog_item_id is distinct from old.catalog_item_id) then
    -- lock the job line, so two orders for the same part can't both get through
    select catalog_item_id, true into v_job_item, v_found from ro_service_items where id = new.ro_service_item_id for update;
    -- the PO line is the same part as the job line it is for (what arrives is what the invoice takes off the shelf)
    if new.catalog_item_id is null and v_job_item is not null then new.catalog_item_id := v_job_item;
    elsif new.catalog_item_id is distinct from v_job_item then
      raise exception 'A PO line must be the same part as the job line it is for';
    end if;
    if v_po.ro_id is null or v_po.ro_id is distinct from (select sv.ro_id from ro_service_items i join ro_services sv on sv.id = i.service_id where i.id = new.ro_service_item_id) then
      raise exception 'A PO line can only be linked to a part on the same job';
    end if;
    if not exists (select 1 from ro_service_items where id = new.ro_service_item_id and item_type = 'part') then
      raise exception 'Only part lines can be ordered';
    end if;
    select po.po_number into v_other from ro_service_items i join purchase_order_items pi on pi.id = i.po_item_id join purchase_orders po on po.id = pi.po_id
    where i.id = new.ro_service_item_id and i.po_item_id <> new.id and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0;
    if found then raise exception 'This part is already on PO %', v_other; end if;
  end if;
  return new;
end $$;

-- payment status follows the paid quantities
create or replace function public.refresh_po_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_po uuid := coalesce(new.po_id, old.po_id); o numeric; d numeric; c numeric; cur text; v_new text; v_pay text;
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
  v_pay := case
      when exists (select 1 from purchase_order_items where po_id = v_po and qty_paid > 0)
           and not exists (select 1 from purchase_order_items where po_id = v_po and qty_delivered > qty_paid) then 'paid'
      when exists (select 1 from purchase_order_items where po_id = v_po and qty_paid > 0) then 'partial'
      else 'unpaid' end;
  update purchase_orders set payment_status = v_pay where id = v_po and payment_status is distinct from v_pay;
  return null;
end $$;

-- ===== 2. supplier payments
-- One line's amount for a quantity: cost + core, plus tax on the cost when the line is taxable. The app uses the same sum.
create or replace function public.po_line_amount(p_cost numeric, p_core numeric, p_qty numeric, p_taxable boolean, p_rate numeric)
returns numeric language sql immutable set search_path = public as $$
  select round(p_cost * p_qty) + round(p_core * p_qty) + case when p_taxable then round(p_cost * p_qty * coalesce(p_rate, 0) / 100) else 0 end
$$;

alter table public.supplier_payments add column if not exists lines jsonb not null default '[]';
alter table public.supplier_payments drop constraint if exists supplier_payments_amount_check;
alter table public.supplier_payments add constraint supplier_payments_amount_check check (amount >= 0);
alter table public.supplier_payments add constraint supplier_payments_method check (method is null or method in ('transfer','cash','card','giro','other'));
alter table public.supplier_payments add constraint supplier_payments_reference_length check (reference is null or length(reference) <= 200);
revoke insert, update, delete on public.supplier_payments from authenticated;
drop trigger if exists log_supplier_payments on public.supplier_payments;
create trigger log_supplier_payments after insert or delete or update on public.supplier_payments
  for each row execute function public.log_activity();

-- p_expected: the total the person saw. If more was received meanwhile, the payment is refused instead of
-- quietly paying a different amount. Returns the amount paid.
create or replace function public.pay_po_items(p_items uuid[], p_paid_at date, p_method text, p_reference text, p_expected numeric default null) returns numeric
language plpgsql security definer set search_path = public as $$
declare n int; v_sup uuid; v_amt numeric := 0; v_lines jsonb := '[]'; r record; a numeric; v_id uuid; v_date date := coalesce(p_paid_at, local_date());
begin
  if not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  if p_items is null or cardinality(p_items) = 0 then raise exception 'Pick at least one delivered line to pay'; end if;
  if v_date > local_date() then raise exception 'The payment date can''t be in the future'; end if;
  if p_method is not null and p_method not in ('transfer','cash','card','giro','other') then raise exception 'Unknown payment method'; end if;
  perform 1 from purchase_order_items where id = any(p_items) order by id for update;
  select count(distinct po.supplier_id), min(po.supplier_id::text)::uuid into n, v_sup
  from purchase_order_items i join purchase_orders po on po.id = i.po_id
  where i.id = any(p_items) and i.qty_delivered > i.qty_paid;
  if n = 0 then raise exception 'Nothing left to pay on these lines'; end if;
  if n > 1 then raise exception 'Pay one supplier at a time'; end if;
  for r in select i.id, i.qty_delivered - i.qty_paid as q, i.cost, i.core_cost, i.taxable, po.tax_rate
           from purchase_order_items i join purchase_orders po on po.id = i.po_id
           where i.id = any(p_items) and i.qty_delivered > i.qty_paid order by i.id loop
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
  update purchase_order_items set qty_paid = qty_delivered, paid_at = v_date
  where id in (select (x->>'item')::uuid from jsonb_array_elements(v_lines) x);
  return v_amt;
end $$;

create or replace function public.undo_supplier_payment(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p supplier_payments%rowtype; x jsonb;
begin
  if not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  select * into p from supplier_payments where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  -- payments recorded before 124 have no line detail: their lines go back to unpaid
  if jsonb_array_length(p.lines) = 0 then
    update purchase_order_items set qty_paid = 0, paid_at = null where id = any(p.po_item_ids);
  end if;
  for x in select * from jsonb_array_elements(p.lines) loop
    update purchase_order_items set
      qty_paid = greatest(qty_paid - (x->>'qty')::numeric, 0),
      paid_at = case when qty_paid - (x->>'qty')::numeric > 0 then paid_at end
    where id = (x->>'item')::uuid;
  end loop;
  delete from supplier_payments where id = p_payment;
end $$;

revoke execute on function public.pay_po_items(uuid[], date, text, text, numeric), public.undo_supplier_payment(uuid) from public, anon;
grant execute on function public.pay_po_items(uuid[], date, text, text, numeric), public.undo_supplier_payment(uuid) to authenticated;

-- ===== 3. returns to the supplier
alter table public.returns alter column marked_at set default public.local_date();
update public.returns set
  shipped_at = case when status in ('shipped','delivered','refunded') then coalesce(shipped_at, delivered_at, refunded_at, marked_at) end,
  delivered_at = case when status in ('delivered','refunded') then coalesce(delivered_at, refunded_at, shipped_at, marked_at) end,
  refunded_at = case when status = 'refunded' then coalesce(refunded_at, delivered_at, shipped_at, marked_at) end;
alter table public.returns add constraint returns_values check (return_cost >= 0 and return_tax >= 0 and refund_amount >= 0 and qty <= 100000);
alter table public.returns add constraint returns_texts check (length(item_name) between 1 and 200 and (note is null or length(note) <= 1000)
  and (credit_number is null or length(credit_number) <= 100) and (supplier_invoice_no is null or length(supplier_invoice_no) <= 100));
revoke insert, update on public.returns from authenticated;
grant insert (id, kind, po_item_id, ro_id, supplier_id, catalog_item_id, item_name, qty, return_cost, return_tax, supplier_invoice_no, note)
  on public.returns to authenticated;
grant update (status, shipped_at, delivered_at, refunded_at, supplier_invoice_no, credit_number, refund_amount, note, qty, return_cost, return_tax)
  on public.returns to authenticated;

create or replace function public.return_step(s text) returns int language sql immutable set search_path = public as $$
  select array_position(array['marked','shipped','delivered','refunded'], s)
$$;

create or replace function public.check_return() returns trigger
language plpgsql security definer set search_path = public as $$
declare li record; v_left numeric;
begin
  new.item_name := btrim(new.item_name);
  if new.item_name = '' then raise exception 'Enter the part name'; end if;
  new.note := nullif(btrim(new.note), '');
  new.credit_number := nullif(btrim(new.credit_number), '');
  new.supplier_invoice_no := nullif(btrim(new.supplier_invoice_no), '');
  if tg_op = 'INSERT' then
    new.status := 'marked'; new.marked_at := local_date();   -- every return starts as marked, today
    if new.po_item_id is not null then
      select i.catalog_item_id, po.supplier_id, po.ro_id into li
      from purchase_order_items i join purchase_orders po on po.id = i.po_id where i.id = new.po_item_id for update of i;
      if not found then raise exception 'PO line not found'; end if;
      new.supplier_id := li.supplier_id;
      new.catalog_item_id := li.catalog_item_id;
      new.ro_id := li.ro_id;
      new.kind := case when li.ro_id is null then 'inventory' else 'ro' end;
    elsif new.kind = 'ro' and new.ro_id is null then
      raise exception 'Choose the job this part came from';
    elsif new.kind = 'inventory' then
      new.ro_id := null;
    end if;
    if new.catalog_item_id is not null and not exists (select 1 from catalog_items where id = new.catalog_item_id and item_type = 'part') then
      raise exception 'Only parts can be returned';
    end if;
  else
    if old.status <> 'marked' and (new.qty <> old.qty or new.return_cost <> old.return_cost or new.return_tax <> old.return_tax) then
      raise exception 'This return has shipped; its quantity and value can''t change';
    end if;
    if return_step(new.status) < return_step(old.status) then
      raise exception 'A return can''t go back a step';
    end if;
  end if;
  if new.po_item_id is not null then
    select qty_delivered - coalesce((select sum(r.qty) from returns r where r.po_item_id = new.po_item_id and r.id <> new.id), 0)
      into v_left from purchase_order_items where id = new.po_item_id;
    if new.qty > v_left then
      raise exception 'Only % delivered on this line can still be returned', trim(to_char(greatest(v_left, 0), 'FM999G999G990D99'), '.,');
    end if;
  end if;
  -- each step gets its date; steps not reached have none
  -- a skipped step takes the date of the step after it
  new.refunded_at := case when return_step(new.status) >= 4 then coalesce(new.refunded_at, local_date()) end;
  new.delivered_at := case when return_step(new.status) >= 3 then coalesce(new.delivered_at, new.refunded_at, local_date()) end;
  new.shipped_at := case when return_step(new.status) >= 2 then coalesce(new.shipped_at, new.delivered_at, local_date()) end;
  if greatest(new.shipped_at, new.delivered_at, new.refunded_at) > local_date() then
    raise exception 'Dates can''t be in the future';
  end if;
  if new.shipped_at < new.marked_at or new.delivered_at < new.shipped_at or new.refunded_at < new.delivered_at then
    raise exception 'A step can''t be dated before the step before it';
  end if;
  return new;
end $$;
drop trigger if exists returns_check on public.returns;
create trigger returns_check before insert or update on public.returns
  for each row execute function public.check_return();

create or replace function public.guard_return() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' and old.status <> 'marked' then
    raise exception 'Only a return that hasn''t shipped can be deleted';
  end if;
  if exists (select 1 from stock_movements where return_id = old.id) then
    if tg_op = 'DELETE' then raise exception 'This return has already left stock and can''t be deleted'; end if;
    if new.qty <> old.qty or new.catalog_item_id is distinct from old.catalog_item_id then
      raise exception 'This return has already left stock; its part and quantity can''t be changed';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- every delivery lands on the shelf, so a return takes it back off when it is sent (leaves "marked").
-- A job part that the invoice already took off the shelf (stock_deducted) went into the vehicle; sending it back
-- (e.g. warranty) doesn't touch the shelf again.
create or replace function public.return_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_have numeric;
begin
  if new.catalog_item_id is null or new.status not in ('shipped','delivered','refunded') then return null; end if;
  if tg_op = 'UPDATE' and old.status <> 'marked' then return null; end if;      -- only the step out of "marked" moves stock
  if exists (select 1 from stock_movements where return_id = new.id) then return null; end if;
  if new.kind = 'ro' and (
       exists (select 1 from purchase_order_items pi join ro_service_items i on i.id = pi.ro_service_item_id
               where pi.id = new.po_item_id and i.stock_deducted)
       or (new.po_item_id is null and exists (select 1 from ro_service_items i join ro_services sv on sv.id = i.service_id
               where sv.ro_id = new.ro_id and i.catalog_item_id = new.catalog_item_id and i.stock_deducted))) then
    return null;
  end if;
  select qty_on_hand into v_have from catalog_items where id = new.catalog_item_id and track_inventory for update;
  if not found then return null; end if;
  if v_have < new.qty then
    raise exception 'Only % in stock; you can''t send back more than you have', trim(to_char(greatest(v_have, 0), 'FM999G999G990D99'), '.,');
  end if;
  insert into stock_movements (catalog_item_id, qty_change, reason, return_id, note)
  values (new.catalog_item_id, -new.qty, 'return', new.id, 'Returned to supplier');
  return null;
end $$;

-- ===== 4. cores
alter table public.cores add column if not exists shipped_at date;
update public.cores set
  shipped_at = case when return_status in ('shipped','delivered','refunded') then coalesce(delivered_at, refunded_at, marked_at) end,
  delivered_at = case when return_status in ('delivered','refunded') then coalesce(delivered_at, refunded_at, marked_at) else delivered_at end,
  refunded_at = case when return_status = 'refunded' then coalesce(refunded_at, delivered_at, marked_at) else refunded_at end
where return_status in ('shipped','delivered','refunded');
alter table public.cores add constraint cores_values check (refund_amount >= 0 and (credit_number is null or length(credit_number) <= 100));
revoke insert, update, delete on public.cores from authenticated;
grant update (retrieval_status, return_status, shipped_at, delivered_at, refunded_at, credit_number, refund_amount, supplier_id)
  on public.cores to authenticated;

create or replace function public.core_step(s text) returns int language sql immutable set search_path = public as $$
  select array_position(array['to_be_returned','marked','shipped','delivered','refunded'], s)
$$;

create or replace function public.check_core() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.credit_number := nullif(btrim(new.credit_number), '');
  if new.return_status is distinct from old.return_status then
    if old.return_status = 'refunded' then raise exception 'This core has been refunded'; end if;
    if old.return_status = 'damaged' and new.return_status <> 'to_be_returned' then
      raise exception 'This core was marked damaged; put it back to To be returned first';
    end if;
    if new.return_status <> 'damaged' and old.return_status <> 'damaged' and core_step(new.return_status) < core_step(old.return_status) then
      raise exception 'A core return can''t go back a step';
    end if;
    if new.return_status not in ('to_be_returned','damaged') then
      if new.retrieval_status <> 'retrieved' then raise exception 'Take the old part off the vehicle (Retrieved) first'; end if;
      if new.supplier_id is null then raise exception 'Choose the supplier the core goes back to'; end if;
    end if;
  end if;
  if new.retrieval_status is distinct from old.retrieval_status and old.return_status not in ('to_be_returned','damaged')
     and new.return_status not in ('to_be_returned','damaged') then
    raise exception 'This core is already on its way back';
  end if;
  if new.return_status <> 'damaged' then   -- a core the supplier rejects as damaged keeps the dates it had
    new.refunded_at := case when core_step(new.return_status) >= 5 then coalesce(new.refunded_at, local_date()) end;
    new.delivered_at := case when core_step(new.return_status) >= 4 then coalesce(new.delivered_at, new.refunded_at, local_date()) end;
    new.shipped_at := case when core_step(new.return_status) >= 3 then coalesce(new.shipped_at, new.delivered_at, local_date()) end;
  end if;
  if greatest(new.shipped_at, new.delivered_at, new.refunded_at) > local_date() then
    raise exception 'Dates can''t be in the future';
  end if;
  if new.delivered_at < new.shipped_at or new.refunded_at < new.delivered_at then
    raise exception 'A step can''t be dated before the step before it';
  end if;
  return new;
end $$;
drop trigger if exists cores_check on public.cores;
create trigger cores_check before update on public.cores for each row execute function public.check_core();
