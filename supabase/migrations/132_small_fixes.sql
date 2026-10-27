-- Axle v2 · 132 Smaller fixes from the Oct 25 audit, and completed work can't be declined (Oct 27, 2026)
--
-- 1. A completed service can't be declined or deferred, and a declined or deferred service can't be marked completed
--    (set the work status back first). A job with completed work can't be closed without an invoice. (Denny, Oct 27)
-- 2. An Owner's profile (name, username, phone…) can only be changed by an Owner, so an Admin can't take over the
--    Owner's username.
-- 3. Money details kept back from people who don't handle money: a job's payment status, due date and "Paid" on the
--    work board (shown as Invoiced; Technicians see them on their own jobs, like totals), and supplier bank account
--    numbers (only with view_costs or pay_supplier_bills), in the change history too. The Fleet spend report needs view_reports; the Technicians report shows labor money only
--    with view_reports.
-- 4. Files and transfer slips on an invoiced job can only be removed by someone who can void invoices.
-- 5. The shop logo can no longer be an SVG file (SVG can carry script); PNG, JPEG and WEBP as before.
-- 6. Database rights: anon and signed-in users (and PUBLIC, for functions) get no rights on tables, functions or
--    sequences created later unless a migration grants them; TRUNCATE, TRIGGER and REFERENCES are taken away from them on every table, and anon from
--    sequences.
-- 7. Item discounts inside a flat-price service are no longer counted in "item discounts included" (the company pays
--    the flat price).
-- 8. Faktur pajak numbers: digits with dots, dashes or spaces only, 13 to 20 digits, never the same number on two
--    invoices, and only when the shop is PKP.
-- 9. Appointments: the technician must be an active staff member (not a Viewer or Fleet manager).
-- 10. Cores: when a voided invoice is issued again, cores not yet sent back follow the job line's new quantity.
-- 11. An index on notification_reads(user_id).
--
-- Run once, after 131, in the SQL Editor.

-- ===== 1. Completed work can't be declined or deferred
create or replace function public.guard_completed_service() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.work_status = 'completed' and new.approval_status in ('declined', 'deferred') then
    if old.work_status = 'completed' then
      raise exception 'Completed work can''t be declined or deferred. Set its work status back first';
    else
      raise exception 'Declined or deferred work can''t be marked completed';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_completed_service() from public, anon, authenticated;
drop trigger if exists ro_services_completed_guard on public.ro_services;
create trigger ro_services_completed_guard before update of work_status, approval_status on public.ro_services
  for each row execute function guard_completed_service();

-- close_job (as it stands), one check added
CREATE OR REPLACE FUNCTION public.close_job(p_ro uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare ro repair_orders%rowtype;
begin
  if auth.uid() is not null and not has_permission('edit_jobs') then raise exception 'Not allowed'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required to close a job without an invoice'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status <> 'estimate' then raise exception 'Only an estimate can be closed without an invoice'; end if;
  if ro.closed_at is not null then return; end if;
  if exists (select 1 from ro_services where ro_id = p_ro and work_status = 'completed') then
    raise exception 'This job has completed work. Invoice it, or set the work back to To do first.';
  end if;
  if exists (select 1 from ro_services where ro_id = p_ro and approval_status = 'approved') then
    raise exception 'This job has approved work. Invoice it, or decline/defer the work first.';
  end if;
  if coalesce((select sum(case when kind = 'payment' then amount else -amount end) from payments where ro_id = p_ro), 0) <> 0
     or exists (select 1 from credit_memos where applied_ro_id = p_ro) then
    raise exception 'This job has money on it. Refund the payments or unapply the credits first.';
  end if;
  update repair_orders set closed_at = now(), close_reason = trim(p_reason), closed_by = auth.uid(), archived_at = now() where id = p_ro;
end $function$;


-- ===== 2. An Owner's profile only changes by an Owner (protect_profile_role as it stands, one check added)
CREATE OR REPLACE FUNCTION public.protect_profile_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid := (select id from public.roles where name = 'Owner');
  v_me_owner boolean;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  v_me_owner := exists (select 1 from public.profiles
                        where id = auth.uid() and role_id = v_owner and status = 'active');

  if tg_op = 'INSERT' then
    if new.role_id = v_owner and not v_me_owner then
      raise exception 'Only an Owner can make someone an Owner.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.id = auth.uid() then
      raise exception 'You can''t remove your own account.';
    end if;
    if old.role_id = v_owner then
      if not v_me_owner then
        raise exception 'Only an Owner can remove an Owner.';
      end if;
      if old.status = 'active' and not exists (select 1 from public.profiles
           where role_id = v_owner and status = 'active' and id <> old.id) then
        raise exception 'There must always be at least one active Owner.';
      end if;
    end if;
    return old;
  end if;

  -- UPDATE
  -- an Owner's details are the Owner's own business (Admins can't rename an Owner or take over their username)
  if old.role_id = v_owner and not v_me_owner and new is distinct from old then
    raise exception 'Only an Owner can change an Owner''s details.';
  end if;
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'A profile can''t be moved to another login';
  end if;
  if new.username is distinct from old.username and not has_permission('manage_users') then
    raise exception 'Only user managers can change usernames.';
  end if;

  if new.role_id is distinct from old.role_id or new.status is distinct from old.status then
    if not has_permission('manage_users') then
      raise exception 'Only user managers can change roles or status';
    end if;
    if new.id = auth.uid() then
      raise exception 'You can''t change your own role or status.';
    end if;
    if (old.role_id = v_owner or new.role_id = v_owner) and not v_me_owner then
      raise exception 'Only an Owner can change an Owner, or make someone an Owner.';
    end if;
    if old.role_id = v_owner and old.status = 'active'
       and (new.role_id is distinct from v_owner or new.status <> 'active')
       and not exists (select 1 from public.profiles
                       where role_id = v_owner and status = 'active' and id <> old.id) then
      raise exception 'There must always be at least one active Owner.';
    end if;
  end if;

  return new;
end $function$;


-- ===== 3. Money details kept back
-- Job payment status and due date: like the job's totals (view_reports, or a Technician on that job).
create or replace view public.repair_orders_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.job_number, t.invoice_number, t.customer_id, t.vehicle_id, t.odometer_in, t.odometer_out,
       t.order_status, case when t.workflow_status = 'paid' and not (p.money or m.works) then 'invoiced' else t.workflow_status end as workflow_status, t.priority, t.tags, t.service_advisor_id, t.shop_notes,
       t.recommendations, t.print_language, t.invoiced_at,
       case when p.money or m.works then t.due_date end as due_date, t.archived_at, t.faktur_pajak_number,
       t.bill_to_snapshot, t.shop_snapshot,
       case when p.money or m.works then t.parts_total end as parts_total,
       case when p.money or m.works then t.labor_total end as labor_total,
       case when p.money or m.works then t.other_total end as other_total,
       case when p.money or m.works then t.service_fees_total end as service_fees_total,
       case when p.money or m.works then t.item_discount_total end as item_discount_total,
       case when p.money or m.works then t.service_discount_total end as service_discount_total,
       case when p.money or m.works then t.job_fees_total end as job_fees_total,
       case when p.money or m.works then t.job_discount_total end as job_discount_total,
       case when p.money or m.works then t.subtotal end as subtotal,
       case when p.money or m.works then t.taxable_base end as taxable_base,
       case when p.money or m.works then t.tax_total end as tax_total,
       case when p.money or m.works then t.total end as total,
       case when p.money or m.works then t.paid_total end as paid_total,
       case when p.money or m.works then t.balance end as balance,
       case when p.money or m.works then t.payment_status end as payment_status, t.created_by, t.created_at, t.updated_at, t.job_no, t.invoice_no, t.closed_at,
       t.close_reason, t.closed_by
from public.repair_orders t
cross join p
cross join lateral (select case when p.money then false else public.works_on_job(t.id) end as works) m
where (select public.is_staff());
revoke select (payment_status, due_date, workflow_status) on public.repair_orders from anon, authenticated;

-- Supplier bank account: only for people who see costs or pay supplier bills.
create or replace view public.suppliers_read with (security_barrier = true) as
select t.id, t.name, t.type, t.payment_terms_days,
       case when public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') then t.account_number end as account_number,
       t.contact_name, t.phone, t.email, t.address, t.pinned_notes, t.active, t.created_at, t.updated_at
from public.suppliers t
where (select public.is_staff());
revoke all on public.suppliers_read from public, anon, authenticated;
grant select on public.suppliers_read to authenticated;
revoke select on public.suppliers from anon, authenticated;
grant select (id, name, type, payment_terms_days, contact_name, phone, email, address, pinned_notes, active, created_at, updated_at)
  on public.suppliers to authenticated;

-- Fleet spend is money from start to end: it needs view_reports too.
CREATE OR REPLACE FUNCTION public.report_fleet(p_from date, p_to date)
 RETURNS TABLE(ro_id uuid, invoice_number bigint, invoiced_on date, job_number bigint, customer_id uuid, company text, vehicle_id uuid, plate text, make text, model text, year integer, vehicle_type text, km integer, parts numeric, labor numeric, sublet numeric, fees numeric, discounts numeric, subtotal numeric, tax numeric, total numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a timestamptz; b timestamptz; tz text := shop_tz();
begin
  if not (has_permission('view_ops_reports') and has_permission('view_reports')) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select r.id, r.invoice_number, (r.invoiced_at at time zone tz)::date, r.job_number, r.customer_id, c.display_name,
         r.vehicle_id, v.plate, v.make, v.model, v.year, v.type, coalesce(r.odometer_out, r.odometer_in),
         r.parts_total, r.labor_total, r.other_total, r.service_fees_total + r.job_fees_total,
         r.service_discount_total + r.job_discount_total, r.subtotal, r.tax_total, r.total
  from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
  where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
  order by c.display_name, v.plate, r.invoiced_at, r.id;
end $function$;

-- Technicians: hours for everyone with the report, labor money only with view_reports.
CREATE OR REPLACE FUNCTION public.report_technicians(p_from date, p_to date)
 RETURNS TABLE(ro_id uuid, invoice_number bigint, invoiced_on date, job_number bigint, customer_id uuid, company text, plate text, service_id uuid, service_name text, technician_id uuid, technician text, hours_sold numeric, hours_worked numeric, hours_sold_timed numeric, labor numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a timestamptz; b timestamptz; tz text := shop_tz(); v_money boolean := has_permission('view_reports');
begin
  if not has_permission('view_ops_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  with inv as (
    select * from repair_orders r where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
  ), x as (
    select i.service_id,
           sum(i.qty) filter (where i.item_type = 'labor') as hours_sold,
           sum(i.hours_worked) filter (where i.item_type = 'labor' and i.hours_worked is not null) as hours_worked,
           sum(i.qty) filter (where i.item_type = 'labor' and i.hours_worked is not null) as hours_sold_timed,
           coalesce(sum(i.net + round(coalesce(i.core_charge, 0) * i.qty)) filter (where i.item_type = 'part'), 0) as p,
           coalesce(sum(i.net) filter (where i.item_type = 'labor'), 0) as l,
           coalesce(sum(i.net) filter (where i.item_type = 'sublet'), 0) as o,
           coalesce(sum(i.net) filter (where i.item_type = 'fee'), 0) as f,
           coalesce(sum(i.net + round(coalesce(i.core_charge, 0) * i.qty)), 0) as line_sum
    from inv join ro_services s on s.ro_id = inv.id join ro_service_items i on i.service_id = s.id
    group by i.service_id
  )
  select r.id, r.invoice_number, (r.invoiced_at at time zone tz)::date, r.job_number, r.customer_id, c.display_name, v.plate,
         s.id, s.name, s.technician_id, p.name,
         coalesce(x.hours_sold, 0), x.hours_worked, coalesce(x.hours_sold_timed, 0),
         case when not v_money then null
              when s.flat_price is null then coalesce(x.l, 0)
              when coalesce(x.line_sum, 0) <= 0 then s.flat_price
              when not (q.rp >= greatest(q.rl, q.ro, q.rf)) and q.rl >= greatest(q.ro, q.rf)
                then q.rl + (s.flat_price - (q.rp + q.rl + q.ro + q.rf))
              else q.rl end
  from inv r
  join ro_services s on s.ro_id = r.id and s.approval_status in ('pending', 'approved')
  left join x on x.service_id = s.id
  left join lateral (
    select round(x.p * k.k) as rp, round(x.l * k.k) as rl, round(x.o * k.k) as ro, round(x.f * k.k) as rf
    from (select s.flat_price / nullif(x.line_sum, 0) as k) k
  ) q on true
  left join profiles p on p.id = s.technician_id
  left join customers c on c.id = r.customer_id
  left join vehicles v on v.id = r.vehicle_id
  order by r.invoiced_at, r.invoice_number, s.position, s.id;
end $function$;


-- Change history: the same details kept back (mask_activity from 130, extended)
CREATE OR REPLACE FUNCTION public.mask_activity(p_type text, p_changes jsonb, p_costs boolean, p_supplier boolean, p_money boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  t text := coalesce(p_changes->>'table', p_type);
  hide text[] := '{}';
  r jsonb := p_changes;
begin
  if r is null or jsonb_typeof(r) <> 'object' then return r; end if;
  if not p_costs then r := public.strip_keys(r, array['cost', 'core_cost', 'markup_pct']); end if;
  if not p_supplier and (p_type in ('purchase_order_items', 'supplier_payments', 'returns', 'cores')
                         or t in ('purchase_order_items', 'supplier_payments', 'returns', 'cores')) then
    hide := hide || array['cost', 'core_cost', 'amount', 'lines', 'return_cost', 'return_tax', 'refund_amount'];
  end if;
  if not p_money and (p_type in ('repair_orders', 'ro_services', 'ro_service_items', 'ro_job_fees', 'ro_job_discounts', 'payments', 'credit_memos', 'invoice_voids')
                      or t in ('ro_services', 'ro_service_items', 'ro_job_fees', 'ro_job_discounts', 'payments', 'credit_memos', 'invoice_voids')) then
    hide := hide || array['price', 'discount_pct', 'discount_amount', 'core_charge', 'amount', 'discount', 'net', 'flat_price',
                          'service_total', 'service_discount', 'service_net', 'value', 'max_amount', 'parts_total', 'labor_total',
                          'other_total', 'service_fees_total', 'item_discount_total', 'service_discount_total', 'job_fees_total',
                          'job_discount_total', 'subtotal', 'taxable_base', 'tax_total', 'total', 'paid_total', 'balance', 'snapshot',
                          'due_date', 'payment_status'];
    -- "Paid" on the board is money too: a change to or from it isn't shown (132)
    if r->'diff'->>'workflow_status' like '%paid%' then r := jsonb_set(r, '{diff}', (r->'diff') - 'workflow_status'); end if;
    if r->>'workflow_status' like '%paid%' then r := r - 'workflow_status'; end if;
    if r->'row'->>'workflow_status' = 'paid' then r := jsonb_set(r, '{row,workflow_status}', '"invoiced"'); end if;
  end if;
  if not p_money and (p_type in ('catalog_items', 'labor_rates', 'service_templates', 'discounts', 'customers')
                      or t in ('catalog_item_fees', 'service_template_items')) then
    hide := hide || array['price', 'fee_value', 'rate_per_hour', 'flat_price', 'price_override', 'value', 'max_amount', 'credit_limit'];
  end if;
  if not p_supplier and (p_type = 'suppliers' or t = 'suppliers') then
    hide := hide || array['account_number'];
  end if;
  if cardinality(hide) = 0 then return r; end if;
  r := r - hide;
  if jsonb_typeof(r->'row') = 'object' then r := jsonb_set(r, '{row}', (r->'row') - hide); end if;
  if jsonb_typeof(r->'diff') = 'object' then r := jsonb_set(r, '{diff}', (r->'diff') - hide); end if;
  return r;
end $function$;

-- ===== 4. Files on an invoiced job stay unless the person can void invoices
alter policy "remove attachments" on public.attachments using (
  (((kind = 'general') and (select has_permission('edit_jobs'))) or ((kind = 'payment') and (select has_permission('record_payments'))))
  and ((select has_permission('void_invoices'))
       or not exists (select 1 from public.repair_orders r where r.id = entity_id and r.order_status = 'invoice')));
alter policy "attachments delete" on storage.objects using (
  bucket_id = 'attachments'
  and ((((storage.foldername(name))[1] = 'jobs') and public.has_permission('edit_jobs'))
       or (((storage.foldername(name))[1] = 'payments') and public.has_permission('record_payments')))
  and (public.has_permission('void_invoices')
       or not exists (select 1 from public.repair_orders r where r.id::text = (storage.foldername(name))[2] and r.order_status = 'invoice')));

-- ===== 5. No SVG logos
update storage.buckets set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'] where id = 'shop-assets';

-- ===== 6. Database rights
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('revoke truncate, trigger, references on public.%I from anon, authenticated', t.relname);
  end loop;
end $$;
revoke all on all sequences in schema public from anon;


-- ===== 7. Item discounts inside a flat-price service don't count (recalc_repair_order from 131, one line added)
create or replace function public.recalc_repair_order(p_ro uuid) returns void language plpgsql security definer set search_path = public as $$
declare
  s record; st shop_settings%rowtype; ro repair_orders%rowtype;
  v_parts numeric := 0; v_labor numeric := 0; v_other numeric := 0; v_fees numeric := 0;
  v_item_disc numeric := 0; v_svc_disc numeric := 0; v_taxable numeric := 0;
  v_job_fees numeric := 0; v_job_disc numeric := 0; v_pre numeric; v_base numeric; v_amt numeric;
  v_subtotal numeric; v_tax numeric; v_paid numeric; v_total numeric; v_taxable_fees numeric := 0; v_rate numeric;
  line_sum numeric; line_taxable numeric; svc_total numeric; svc_disc numeric; svc_taxable numeric;
  c_p numeric; c_l numeric; c_o numeric; c_f numeric; c_disc numeric; k numeric; rem numeric; any_taxable boolean;
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
           coalesce(sum(discount),0), bool_or(taxable)
      into line_sum, line_taxable, c_p, c_l, c_o, c_f, c_disc, any_taxable
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
        -- no priced lines: taxed like its lines (any taxable one), or with no lines, like new items (Settings)
        c_p := 0; c_l := s.flat_price; c_o := 0; c_f := 0;
        line_taxable := case when coalesce(any_taxable, st.new_items_taxable, false) then s.flat_price else 0 end;
      end if;
      c_disc := 0;   -- the company pays the flat price: line discounts inside it aren't discounts given (132)
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

-- ===== 8. Faktur pajak numbers checked (set_faktur_pajak as it stands, checks added). The lock keeps two people
-- from entering the same number at the same moment.
CREATE OR REPLACE FUNCTION public.set_faktur_pajak(p_ro uuid, p_number text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text; v_closed timestamptz; v_no text := nullif(btrim(p_number), '');
begin
  if not (has_permission('record_payments') or has_permission('edit_jobs')) then raise exception 'Not allowed'; end if;
  perform pg_advisory_xact_lock(hashtext('axle-faktur'));
  select order_status, closed_at into v_status, v_closed from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if v_status <> 'invoice' then raise exception 'The faktur pajak number is entered once the invoice is issued'; end if;
  if v_closed is not null then raise exception 'This job is closed. Reopen it first.'; end if;
  if length(v_no) > 40 then raise exception 'The faktur pajak number is too long'; end if;
  if v_no is not null then
    if (select pkp_status from shop_settings limit 1) = 'non_pkp' then
      raise exception 'The shop is not PKP, so invoices have no faktur pajak number';
    end if;
    if v_no !~ '^[0-9][0-9 .-]*[0-9]$' or length(regexp_replace(v_no, '[^0-9]', '', 'g')) not between 13 and 20 then
      raise exception 'A faktur pajak number has 13 to 20 digits, with dots or dashes between them';
    end if;
    if exists (select 1 from repair_orders where id <> p_ro
               and regexp_replace(faktur_pajak_number, '[^0-9]', '', 'g') = regexp_replace(v_no, '[^0-9]', '', 'g')) then
      raise exception 'That faktur pajak number is already on another invoice';
    end if;
  end if;
  update repair_orders set faktur_pajak_number = v_no where id = p_ro;
end $function$;


-- ===== 9. Appointment technician (check_appointment as it stands, one check added)
CREATE OR REPLACE FUNCTION public.check_appointment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r repair_orders%rowtype; v_changed boolean;
begin
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
  if new.technician_id is not null and (tg_op = 'INSERT' or new.technician_id is distinct from old.technician_id)
     and not exists (select 1 from profiles pf join roles rl on rl.id = pf.role_id
                     where pf.id = new.technician_id and pf.status = 'active' and rl.name not in ('Viewer', 'Fleet manager')) then
    raise exception 'The technician must be an active staff member';
  end if;
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
end $function$;


-- ===== 10. Cores follow the job line when a voided invoice is issued again (cores not yet sent back)
create or replace function public.sync_cores_on_invoice() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update cores c set qty = i.qty
  from ro_service_items i
  where c.ro_id = new.id and c.ro_service_item_id = i.id and c.qty is distinct from i.qty and i.qty > 0
    and c.return_status = 'to_be_returned';
  return null;
end $$;
revoke execute on function public.sync_cores_on_invoice() from public, anon, authenticated;
drop trigger if exists repair_orders_sync_cores on public.repair_orders;
create trigger repair_orders_sync_cores after update of order_status on public.repair_orders for each row
  when (new.order_status = 'invoice' and old.order_status is distinct from 'invoice') execute function sync_cores_on_invoice();

-- ===== 11. Index
create index if not exists notification_reads_user_idx on public.notification_reads (user_id);
