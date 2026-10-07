-- Axle v2 · 128 Cashier role, and fixes from the full review (Oct 7)
--
-- Cashier (decided by Denny, Oct 7): payments are received and refunded by a separate Cashier. The Service advisor
-- works a job from booking until it becomes an invoice; after that the money is the Cashier's.
--   Cashier          record_payments (payments, deposits, applying company credit), refund_payments (refunds on issued
--                    invoices, paying company credit back as money), view_reports (dashboard money, Sales, Aging, Payments)
--   Service advisor  loses record_payments; keeps jobs, customers, catalog, inventory, costs and reports
--   Owner, Admin     everything, as before, plus the two new permissions
-- New permissions:
--   refund_payments   record a refund on an issued invoice; pay unused company credit back as money (was Owner/Admin only)
--   view_ops_reports  the Technicians, Fleet spend and Service compliance reports (Owner, Admin, Service advisor);
--                     Sales, Aging and Payments stay on view_reports, Profit and Inventory also need view_costs
-- Unchanged on purpose: changing or deleting a payment on an issued invoice, taking credit off an issued invoice, voiding
-- (void_invoices) and issuing a manual company credit (issue_credits) stay with Owner and Admin.

-- ===== roles and permissions
insert into public.roles (name) values ('Cashier') on conflict (name) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p from public.roles r, unnest(array['record_payments', 'refund_payments', 'view_reports']) p where r.name = 'Cashier'
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
select r.id, p from public.roles r, unnest(array['refund_payments', 'view_ops_reports']) p where r.name in ('Owner', 'Admin')
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
select r.id, 'view_ops_reports' from public.roles r where r.name = 'Service advisor'
on conflict do nothing;
delete from public.role_permissions
where permission_key = 'record_payments' and role_id = (select id from public.roles where name = 'Service advisor');

-- ===== refunds on issued invoices: Cashier, Owner, Admin
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
    if new.kind = 'refund' and v_status = 'invoice' and not has_permission('refund_payments') then
      raise exception 'Only a cashier, owner or admin can record a refund on an issued invoice';
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

-- ===== company credit paid back as money: Cashier, Owner, Admin
create or replace function public.refund_credit(p_credit uuid, p_amount numeric default null, p_method text default 'transfer', p_reference text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare cm credit_memos%rowtype; v_amt numeric; v_id uuid;
begin
  if auth.uid() is not null and not has_permission('refund_payments') then raise exception 'Not allowed'; end if;
  if p_method is null or p_method not in ('transfer', 'cash', 'card', 'giro', 'other') then raise exception 'Choose how the money was paid back'; end if;
  select * into cm from credit_memos where id = p_credit for update;
  if not found then raise exception 'Credit not found'; end if;
  if cm.applied_ro_id is not null then raise exception 'Unapply this credit from its job first'; end if;
  if cm.refunded_at is not null then raise exception 'This credit was already refunded'; end if;
  v_amt := round(coalesce(p_amount, cm.amount));
  if v_amt <= 0 or v_amt > cm.amount then raise exception 'Enter an amount between 1 and the credit available'; end if;
  if v_amt < cm.amount then
    update credit_memos set amount = amount - v_amt where id = p_credit;
    insert into credit_memos (customer_id, amount, reason, created_by, refunded_at, refund_method, refund_reference, source)
    values (cm.customer_id, v_amt, coalesce(cm.reason, 'Credit') || ' (refunded part)', auth.uid(), now(), p_method, nullif(btrim(p_reference), ''), cm.source)
    returning id into v_id;
    return v_id;
  end if;
  update credit_memos set refunded_at = now(), refund_method = p_method, refund_reference = nullif(btrim(p_reference), '') where id = p_credit;
  return p_credit;
end $$;

-- ===== operational reports: view_ops_reports (the 127 functions, with only the permission check changed)
do $$
declare f regprocedure; src text; changed text;
begin
  foreach f in array array['public.report_technicians(date, date)'::regprocedure, 'public.report_fleet(date, date)'::regprocedure,
                           'public.report_service_status()'::regprocedure, 'public.report_service_done(date, date)'::regprocedure]
  loop
    src := pg_get_functiondef(f);
    changed := replace(src, 'has_permission(''view_reports'')', 'has_permission(''view_ops_reports'')');
    if changed = src then raise exception 'permission check not found in %', f; end if;
    execute changed;
  end loop;
end $$;

-- ============================================================================================================
-- Fixes from the full review (Oct 7)
-- ============================================================================================================

-- ===== 1. A profile can't be moved onto another login (an Admin could take over the Owner's account), and profiles
--          are only created and removed by the server (sign-up trigger, invite-user and delete-user functions).
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.protect_profile_role()'::regprocedure);
  changed := replace(src, '  -- UPDATE
', '  -- UPDATE
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception ''A profile can''''t be moved to another login'';
  end if;
');
  if changed = src then raise exception 'protect_profile_role: UPDATE marker not found'; end if;
  execute changed;
end $$;
revoke insert, delete on public.profiles from anon, authenticated;
revoke update (id, created_at) on public.profiles from anon, authenticated;

-- ===== 2. Roles and their permissions are set by migrations only (an Admin could strip the Owner's permissions).
revoke insert, update, delete on public.role_permissions from anon, authenticated;
revoke insert, update, delete on public.roles from anon, authenticated;

-- ===== 3. customer_balances lost security_invoker when 126 re-created it, so it skipped row security (anyone with the
--          public key could read every company's balance).
alter view public.customer_balances set (security_invoker = true);
revoke all on public.customer_balances from anon;
revoke insert, update, delete on public.customer_balances from authenticated;

-- ===== 4. Payments: a closed job's payments can't be changed, deleted or moved onto it; no payment dated in the
--          future; the job row is locked while a payment is checked, so a payment and close_job can't cross.
-- The trigger runs as the user, and a Cashier can't lock (or, through row security, even see for locking) a job row,
-- so the lock and the shop-day check go through this small helper.
create or replace function public.payment_job(p_ro uuid, p_paid_at timestamptz default null,
  out order_status text, out closed_at timestamptz, out customer_id uuid, out future boolean)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_staff() then raise exception 'Not allowed'; end if;
  select r.order_status, r.closed_at, r.customer_id into order_status, closed_at, customer_id from repair_orders r where r.id = p_ro for share;
  future := p_paid_at is not null and shop_day(p_paid_at) > local_date();
end $$;
revoke execute on function public.payment_job(uuid, timestamptz) from public, anon;
grant execute on function public.payment_job(uuid, timestamptz) to authenticated;

create or replace function public.guard_payment() returns trigger language plpgsql security invoker set search_path = public as $$
declare j record;
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    j := payment_job(new.ro_id, new.paid_at);
    if j.future then raise exception 'A payment can''t be dated in the future'; end if;
    if j.closed_at is not null then raise exception 'This job is closed. Reopen it first.'; end if;
    if new.kind = 'refund' and j.order_status = 'invoice' and not has_permission('refund_payments') then
      raise exception 'Only a cashier, owner or admin can record a refund on an issued invoice';
    end if;
    return new;
  end if;
  if old.source <> 'manual' then raise exception 'This entry was made by the system and can''t be changed'; end if;
  if exists (select 1 from invoice_voids v where v.ro_id = old.ro_id and v.voided_at >= old.created_at) then
    raise exception 'This payment belongs to a voided invoice and is kept as history';
  end if;
  j := payment_job(old.ro_id);
  if j.closed_at is not null then raise exception 'This job is closed. Reopen it first.'; end if;
  if j.order_status = 'invoice' and not has_permission('void_invoices') then
    raise exception 'Only an owner or admin can change a payment on an issued invoice';
  end if;
  if tg_op = 'UPDATE' then
    if new.paid_at is distinct from old.paid_at and (payment_job(old.ro_id, new.paid_at)).future then
      raise exception 'A payment can''t be dated in the future';
    end if;
    if new.ro_id is distinct from old.ro_id then
      j := payment_job(new.ro_id);
      if j.customer_id is distinct from old.customer_id then raise exception 'A payment can only be moved to a job of the same company'; end if;
      if j.closed_at is not null then raise exception 'This job is closed. Reopen it first.'; end if;
      if j.order_status = 'invoice' and not has_permission('void_invoices') then
        raise exception 'Only an owner or admin can change a payment on an issued invoice';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- ===== 5. An issued invoice's due date is part of the invoice: only an Owner or Admin changes it, and it can't be
--          cleared (Aging, the dashboard and the reminders all read it).
create or replace function public.lock_invoice_header() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status = 'invoice' then
    if (new.odometer_in, new.odometer_out, new.recommendations) is distinct from (old.odometer_in, old.odometer_out, old.recommendations) then
      raise exception 'This job is invoiced. Void the invoice to make changes.';
    end if;
    if new.due_date is distinct from old.due_date then
      if new.due_date is null then raise exception 'An issued invoice needs a due date'; end if;
      if auth.uid() is not null and not has_permission('void_invoices') then
        raise exception 'Only an owner or admin can change the due date of an issued invoice';
      end if;
    end if;
    if new.workflow_status not in ('invoiced','paid') then
      raise exception 'An invoiced job stays Invoiced (or Paid) on the board';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.lock_invoice_header() from public, anon, authenticated;

-- ===== 6. Voided invoices are listed under the company they were billed to, not the job's company today.
create or replace function public.report_voids(p_from date, p_to date)
returns table (id uuid, ro_id uuid, invoice_number bigint, invoiced_on date, voided_on date, total numeric, reason text, customer_id uuid, company text)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz;
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select x.id, x.ro_id, x.invoice_number, shop_day(x.invoiced_at), shop_day(x.voided_at), x.total, x.reason,
         coalesce((x.snapshot->'job'->>'customer_id')::uuid, r.customer_id), c.display_name
  from invoice_voids x left join repair_orders r on r.id = x.ro_id
  left join customers c on c.id = coalesce((x.snapshot->'job'->>'customer_id')::uuid, r.customer_id)
  where x.voided_at >= a and x.voided_at < b
  order by x.voided_at;
end $$;
revoke execute on function public.report_voids(date, date) from public, anon;
grant execute on function public.report_voids(date, date) to authenticated;
