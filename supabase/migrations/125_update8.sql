-- Axle v2 · 125 update 8 (Denny's stage 7 feedback, Oct 7)
-- 1. Invoicing needs the km out and a technician on every approved service.
-- 2. Returns: several parts of one PO are returned together (batch_id, one supplier per batch), and the tax on a
--    return follows what the order was charged; the app can no longer set it.
--    advance_returns() moves a whole batch to its next step in one go and shares one refund across its parts.
-- 3. unreceive_po_item(): correct a received quantity that was entered too high (before it is paid or returned).
-- 4. An invoiced job can't lose the technician on an approved service.

-- ===== 1. invoicing
create or replace function public.convert_to_invoice(p_ro uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Denny, Oct 7: an invoice needs the km out and a technician on every approved service
  if ro.odometer_out is null then raise exception 'Enter the km out before invoicing'; end if;
  if ro.odometer_in is not null and ro.odometer_out < ro.odometer_in then raise exception 'The km out can''t be lower than the km in'; end if;
  if exists (select 1 from ro_services sv left join profiles p on p.id = sv.technician_id left join roles rl on rl.id = p.role_id
             where sv.ro_id = p_ro and sv.approval_status = 'approved'
               and (sv.technician_id is null or p.status is distinct from 'active' or coalesce(rl.name, '') = 'Fleet manager')) then
    raise exception 'Choose a technician for every approved service before invoicing';
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
end $function$;

-- ===== 2. returns
alter table public.returns add column if not exists batch_id uuid;
create index if not exists returns_batch_id_idx on public.returns (batch_id);
-- returns not sent yet take their tax from the order, like new ones (124 still had a tax switch)
update public.returns r set return_tax = case when pi.taxable then round(r.return_cost * r.qty * po.tax_rate / 100) else 0 end
from public.purchase_order_items pi join public.purchase_orders po on po.id = pi.po_id
where pi.id = r.po_item_id and r.status = 'marked';
revoke insert, update on public.returns from authenticated;
grant insert (id, kind, po_item_id, ro_id, supplier_id, catalog_item_id, item_name, qty, return_cost, supplier_invoice_no, note, batch_id)
  on public.returns to authenticated;
-- steps, dates, refund and credit note change only through advance_returns(), so rows of one batch stay together
grant update (supplier_invoice_no, note, qty, return_cost)
  on public.returns to authenticated;

create or replace function public.check_return() returns trigger
language plpgsql security definer set search_path = public as $$
declare li record; v_left numeric; v_tax boolean; v_rate numeric; v_other uuid;
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
  -- Returns made together (one PO, one go) share batch_id and must go to one supplier.
  if new.batch_id is not null then
    select supplier_id into v_other from returns where batch_id = new.batch_id and id <> new.id limit 1;
    if found and v_other is distinct from new.supplier_id then raise exception 'A return batch goes to one supplier'; end if;
    if tg_op = 'INSERT' and found then
      if exists (select 1 from returns where batch_id = new.batch_id and id <> new.id and status <> 'marked') then
        raise exception 'Parts can only be added to a return that hasn''t been sent';
      end if;
      if exists (select 1 from returns r left join purchase_order_items pi on pi.id = r.po_item_id
                 where r.batch_id = new.batch_id and r.id <> new.id
                   and pi.po_id is distinct from (select po_id from purchase_order_items where id = new.po_item_id)) then
        raise exception 'A return batch is for one PO';
      end if;
    end if;
  end if;
  -- Tax follows the order: what the PO line was charged (or, from stock, the last delivery of that part
  -- from this supplier). It is worked out here, not typed in.
  if tg_op = 'INSERT' or new.qty <> old.qty or new.return_cost <> old.return_cost then
    if new.po_item_id is not null then
      select pi.taxable, po.tax_rate into v_tax, v_rate from purchase_order_items pi join purchase_orders po on po.id = pi.po_id where pi.id = new.po_item_id;
    elsif new.catalog_item_id is not null then
      select pi.taxable, po.tax_rate into v_tax, v_rate from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
      where pi.catalog_item_id = new.catalog_item_id and po.supplier_id = new.supplier_id and pi.qty_delivered > 0
      order by pi.delivered_at desc nulls last, pi.created_at desc limit 1;
    end if;
    new.return_tax := case when coalesce(v_tax, false) then round(new.return_cost * new.qty * coalesce(v_rate, 0) / 100) else 0 end;
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

-- Move returns made together to a step in one go. A refund for the batch is shared out by each part's value
-- (the last part takes the rounding), so the rows add up to what came back.
create or replace function public.advance_returns(p_ids uuid[], p_status text, p_date date, p_refund numeric, p_credit text) returns void
language plpgsql security definer set search_path = public as $$
declare r record; n int; k int := 0; v_total numeric; v_run numeric := 0; v_prev numeric := 0; v_share numeric; v_sup int; v_steps int; v_ids uuid[];
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  v_ids := array(select distinct x from unnest(p_ids) x where x is not null);
  if p_status not in ('shipped','delivered','refunded') then raise exception 'Unknown return step'; end if;
  if cardinality(v_ids) = 0 then raise exception 'Pick a return'; end if;
  if p_refund is not null and p_refund < 0 then raise exception 'Amounts can''t be negative'; end if;
  if p_refund is not null and p_refund <> round(p_refund) then raise exception 'Enter the refund in whole Rupiah'; end if;
  perform 1 from returns where id = any(v_ids) order by id for update;
  -- a batch moves as a whole: every part returned together must be in the list
  if exists (select 1 from returns x where coalesce(x.batch_id, x.id) in (select coalesce(y.batch_id, y.id) from returns y where y.id = any(v_ids))
             and x.id <> all(v_ids)) then
    raise exception 'Move all parts of a return together';
  end if;
  select count(*), count(distinct supplier_id), count(distinct status), coalesce(sum(round(return_cost * qty) + return_tax), 0)
    into n, v_sup, v_steps, v_total from returns where id = any(v_ids);
  if n <> cardinality(v_ids) then raise exception 'Return not found'; end if;
  if v_sup > 1 or v_steps > 1 then raise exception 'Returns moved together must be for one supplier and at the same step'; end if;
  for r in select id, round(return_cost * qty) + return_tax as v from returns where id = any(v_ids) order by id loop
    k := k + 1;
    if p_status = 'refunded' and p_refund is not null then
      -- running shares: never negative, and they always add up to the refund exactly
      v_run := v_run + case when v_total > 0 then r.v else 1 end;
      v_share := round(p_refund * v_run / case when v_total > 0 then v_total else n end) - v_prev;
      v_prev := v_prev + v_share;
    end if;
    update returns set status = p_status,
      shipped_at = case when p_status = 'shipped' then coalesce(p_date, shipped_at) else shipped_at end,
      delivered_at = case when p_status = 'delivered' then coalesce(p_date, delivered_at) else delivered_at end,
      refunded_at = case when p_status = 'refunded' then coalesce(p_date, refunded_at) else refunded_at end,
      refund_amount = case when p_status = 'refunded' and p_refund is not null then v_share else refund_amount end,
      credit_number = case when p_status = 'refunded' then coalesce(nullif(btrim(p_credit), ''), credit_number) else credit_number end
    where id = r.id;
  end loop;
end $$;
revoke execute on function public.advance_returns(uuid[], text, date, numeric, text) from public, anon;
grant execute on function public.advance_returns(uuid[], text, date, numeric, text) to authenticated;

-- ===== 3. correcting a received quantity
-- Stock moves back by the same amount (po_item_stock), noted as a correction.
create or replace function public.po_item_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.qty_delivered = old.qty_delivered or new.catalog_item_id is null then return null; end if;
  if exists (select 1 from catalog_items where id = new.catalog_item_id and track_inventory) then
    insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id, note)
    values (new.catalog_item_id, new.qty_delivered - old.qty_delivered, 'po_delivery', new.id,
            case when new.qty_delivered < old.qty_delivered then 'Received quantity corrected' end);
  end if;
  return null;
end $$;

create or replace function public.unreceive_po_item(p_item uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = public as $$
declare l purchase_order_items%rowtype; v_returned numeric; v_have numeric; v_track boolean; v_shelf numeric; v_closed boolean;
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  p_qty := round(p_qty, 2);
  if p_qty is null or p_qty <= 0 then raise exception 'Enter how many fewer arrived'; end if;
  select * into l from purchase_order_items where id = p_item for update;
  if not found then raise exception 'PO line not found'; end if;
  -- a PO whose rest was cancelled stays closed: the parts taken off count as cancelled instead of reopening it
  select status = 'cancelled' or l.qty_cancelled > 0 into v_closed from purchase_orders where id = l.po_id;
  select coalesce(sum(qty), 0) into v_returned from returns where po_item_id = p_item;
  if p_qty > l.qty_delivered - l.qty_paid - v_returned then
    raise exception 'Only % can be taken off: paid or returned parts stay received', trim(to_char(greatest(l.qty_delivered - l.qty_paid - v_returned, 0), 'FM999G999G990D99'), '.,');
  end if;
  select qty_on_hand, track_inventory into v_have, v_track from catalog_items where id = l.catalog_item_id for update;
  if coalesce(v_track, false) then
    if v_have < p_qty then
      raise exception 'Only % on the shelf, so the received quantity can''t go down by more', trim(to_char(greatest(v_have, 0), 'FM999G999G990D99'), '.,');
    end if;
    -- only what this line actually put on the shelf can come off (older job deliveries skipped the shelf)
    select coalesce(sum(qty_change), 0) into v_shelf from stock_movements where po_item_id = p_item and reason = 'po_delivery';
    if p_qty > v_shelf then
      raise exception 'Only % of this line went onto the shelf, so only that much can be taken off', trim(to_char(greatest(v_shelf, 0), 'FM999G999G990D99'), '.,');
    end if;
  end if;
  -- On a cancelled PO (or a line whose rest was cancelled) the parts taken off stay cancelled instead of reopening the line.
  update purchase_order_items set
    qty_delivered = qty_delivered - p_qty,
    qty_cancelled = qty_cancelled + case when v_closed then p_qty else 0 end,
    delivered_at = case when qty_delivered - p_qty = 0 then null else delivered_at end
  where id = p_item;
end $$;
revoke execute on function public.unreceive_po_item(uuid, numeric) from public, anon;
grant execute on function public.unreceive_po_item(uuid, numeric) to authenticated;

-- ===== 4. an invoiced job keeps a technician on its approved services
create or replace function public.keep_invoiced_technician() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.technician_id is null and old.technician_id is not null and new.approval_status = 'approved'
     and exists (select 1 from repair_orders where id = new.ro_id and order_status = 'invoice') then
    raise exception 'An invoiced job keeps a technician on every approved service';
  end if;
  return new;
end $$;
drop trigger if exists ro_services_keep_technician on public.ro_services;
create trigger ro_services_keep_technician before update of technician_id on public.ro_services
  for each row execute function public.keep_invoiced_technician();
