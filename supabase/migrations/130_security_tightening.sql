-- Axle v2 · 130 Security tightening from the pre-go-live reviews (Oct 24, 2026)
--
-- 1. File storage limits, checked by Supabase Storage itself (the screens already check the same):
--      shop-assets (shop logo, public)        2 MB, PNG / JPEG / WEBP / SVG
--      attachments (job files, private)      10 MB, JPEG / PNG / WEBP / PDF
-- 2. Five trigger functions could still be called with the public key (they only work as triggers); no longer.
-- 3. Independent review findings:
--    a. A voided invoice keeps a copy of the job with cost prices, and the Cashier (view_reports, no view_costs)
--       could read it. The copy is now read through invoice_voids_read, which removes cost figures for people who
--       may not see costs; the change history does the same at any depth.
--    b. Price list hidden from people who don't handle money (Denny, Oct 24: option A). Technicians and Viewers no
--       longer see catalog prices and fee amounts, labor rates, bundle prices, discount values or company credit
--       limits (they could work out job prices from them). Read through *_read views like the other money.
--    c. The faktur pajak number can only be set through set_faktur_pajak (issued invoice, open job, 40 characters).
--    d. Sign-in limits can't be beaten by sending many tries at once: login_begin records each try before the
--       password is checked, under a lock per username and address; login_finish clears them after a success.
--       Addresses are cut to 100 characters everywhere. login_allowed / login_note stay until the new `login`
--       function is deployed (the old one calls them).
-- The app update in the same delivery reads the new views; run this before pushing it.

update storage.buckets
set file_size_limit = 2 * 1024 * 1024,
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
where id = 'shop-assets';

update storage.buckets
set file_size_limit = 10 * 1024 * 1024,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
where id = 'attachments';

revoke execute on function public.stamp_purchase_order() from public, anon, authenticated;
revoke execute on function public.guard_po_row() from public, anon, authenticated;
revoke execute on function public.check_core() from public, anon, authenticated;
revoke execute on function public.check_return() from public, anon, authenticated;
revoke execute on function public.keep_invoiced_technician() from public, anon, authenticated;

-- ============================================================================================================
-- 3b. Price list: read through views for people who handle money (view_reports); blank for everyone else
-- ============================================================================================================
drop view if exists public.catalog_items_read;
-- catalog_items: cost (C), core_cost (C), markup_pct (C), price (P), fee_value (P)
create or replace view public.catalog_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.item_type, t.name, t.code, t.description, t.category_id, t.supplier_id, t.brand,
       case when p.costs then t.cost end as cost,
       case when p.money then t.price end as price,
       case when p.costs then t.markup_pct end as markup_pct,
       t.default_qty, t.labor_hours, t.labor_rate_id, t.fee_kind,
       case when p.money then t.fee_value end as fee_value,
       t.taxable, t.show_on_invoice, t.show_qty_price, t.track_inventory, t.qty_on_hand, t.reorder_point,
       t.has_core,
       case when p.costs then t.core_cost end as core_cost,
       t.tire_size, t.notes, t.active, t.created_at, t.updated_at
from public.catalog_items t
cross join p
where (select public.is_staff());
revoke all on public.catalog_items_read from public, anon, authenticated;
grant select on public.catalog_items_read to authenticated;
revoke select on public.catalog_items from anon, authenticated;
grant select (id, item_type, name, code, description, category_id, supplier_id, brand, default_qty, labor_hours, labor_rate_id, fee_kind, taxable, show_on_invoice, show_qty_price, track_inventory, qty_on_hand, reorder_point, has_core, tire_size, notes, active, created_at, updated_at) on public.catalog_items to authenticated;

-- labor_rates: rate_per_hour (P)
create or replace view public.labor_rates_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.name,
       case when p.money then t.rate_per_hour end as rate_per_hour,
       t.is_default, t.active, t.created_at
from public.labor_rates t
cross join p
where (select public.is_staff());
revoke all on public.labor_rates_read from public, anon, authenticated;
grant select on public.labor_rates_read to authenticated;
revoke select on public.labor_rates from anon, authenticated;
grant select (id, name, is_default, active, created_at) on public.labor_rates to authenticated;

-- service_templates: flat_price (P)
create or replace view public.service_templates_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.name, t.tags,
       case when p.money then t.flat_price end as flat_price,
       t.checklist_id, t.default_interval_km, t.default_interval_months, t.active, t.created_at,
       (t.flat_price is not null) as is_flat
from public.service_templates t
cross join p
where (select public.is_staff());
revoke all on public.service_templates_read from public, anon, authenticated;
grant select on public.service_templates_read to authenticated;
revoke select on public.service_templates from anon, authenticated;
grant select (id, name, tags, checklist_id, default_interval_km, default_interval_months, active, created_at) on public.service_templates to authenticated;

-- service_template_items: price_override (P)
create or replace view public.service_template_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.template_id, t.catalog_item_id, t.qty,
       case when p.money then t.price_override end as price_override,
       t.position
from public.service_template_items t
cross join p
where (select public.is_staff());
revoke all on public.service_template_items_read from public, anon, authenticated;
grant select on public.service_template_items_read to authenticated;
revoke select on public.service_template_items from anon, authenticated;
grant select (id, template_id, catalog_item_id, qty, position) on public.service_template_items to authenticated;

-- discounts: value (P), max_amount (P)
create or replace view public.discounts_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.name, t.level, t.kind,
       case when p.money then t.value end as value,
       case when p.money then t.max_amount end as max_amount,
       t.valid_from, t.valid_to, t.active, t.created_at
from public.discounts t
cross join p
where (select public.is_staff());
revoke all on public.discounts_read from public, anon, authenticated;
grant select on public.discounts_read to authenticated;
revoke select on public.discounts from anon, authenticated;
grant select (id, name, level, kind, valid_from, valid_to, active, created_at) on public.discounts to authenticated;

-- customers: credit_limit (P)
create or replace view public.customers_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.type, t.display_name, t.legal_name, t.npwp, t.billing_address, t.phone, t.email,
       t.payment_terms_days,
       case when p.money then t.credit_limit end as credit_limit,
       t.charge_account, t.tax_exempt, t.pinned_notes, t.tags, t.active, t.created_at, t.updated_at
from public.customers t
cross join p
where (select public.is_staff());
revoke all on public.customers_read from public, anon, authenticated;
grant select on public.customers_read to authenticated;
revoke select on public.customers from anon, authenticated;
grant select (id, type, display_name, legal_name, npwp, billing_address, phone, email, payment_terms_days, charge_account, tax_exempt, pinned_notes, tags, active, created_at, updated_at) on public.customers to authenticated;

-- ro_services: flat_price (M), discount_pct (M), discount_amount (M), service_total (M), service_discount (M), service_net (M)
create or replace view public.ro_services_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.ro_id, t.position, t.name, t.notes_external, t.technician_id, t.concern_id, t.approval_status,
       t.work_status, t.completed_at, t.template_id, t.checklist_id, t.service_schedule_id,
       case when p.money or m.works then t.flat_price end as flat_price,
       case when p.money or m.works then t.discount_pct end as discount_pct,
       case when p.money or m.works then t.discount_amount end as discount_amount,
       case when p.money or m.works then t.service_total end as service_total,
       case when p.money or m.works then t.service_discount end as service_discount,
       case when p.money or m.works then t.service_net end as service_net,
       t.created_at, t.carried_from,
       (t.flat_price is not null) as is_flat
from public.ro_services t
cross join p
cross join lateral (select case when p.money then false else public.works_on_job(t.ro_id) end as works) m
where (select public.is_staff());
revoke all on public.ro_services_read from public, anon, authenticated;
grant select on public.ro_services_read to authenticated;
revoke select on public.ro_services from anon, authenticated;
grant select (id, ro_id, position, name, notes_external, technician_id, concern_id, approval_status, work_status, completed_at, template_id, checklist_id, service_schedule_id, created_at, carried_from) on public.ro_services to authenticated;

-- ============================================================================================================
-- 3a. Cost figures removed from copies (voided invoices, change history) for people who may not see costs
-- ============================================================================================================
-- Removes the given keys from a JSON value at any depth.
create or replace function public.strip_keys(j jsonb, keys text[]) returns jsonb
language plpgsql immutable set search_path = public as $$
declare r jsonb;
begin
  if j is null then return null; end if;
  if jsonb_typeof(j) = 'object' then
    select coalesce(jsonb_object_agg(e.key, public.strip_keys(e.value, keys)), '{}'::jsonb) into r
    from jsonb_each(j) e where e.key <> all(keys);
    return r;
  elsif jsonb_typeof(j) = 'array' then
    select coalesce(jsonb_agg(public.strip_keys(a.value, keys) order by a.n), '[]'::jsonb) into r
    from jsonb_array_elements(j) with ordinality a(value, n);
    return r;
  end if;
  return j;
end $$;
revoke execute on function public.strip_keys(jsonb, text[]) from public, anon;
grant execute on function public.strip_keys(jsonb, text[]) to authenticated;

create or replace view public.invoice_voids_read with (security_barrier = true) as
with p as (select public.has_permission('view_costs') as costs)
select v.id, v.ro_id, v.invoice_number, v.invoice_no, v.invoiced_at, v.total, v.reason, v.voided_by, v.voided_at,
       case when p.costs then v.snapshot else public.strip_keys(v.snapshot, array['cost', 'core_cost', 'markup_pct']) end as snapshot
from public.invoice_voids v
cross join p
where (select public.is_staff()) and (select public.has_permission('view_reports'));
revoke all on public.invoice_voids_read from public, anon, authenticated;
grant select on public.invoice_voids_read to authenticated;
revoke select on public.invoice_voids from anon, authenticated;
grant select (id, ro_id, invoice_number, invoice_no, invoiced_at, total, reason, voided_by, voided_at) on public.invoice_voids to authenticated;

-- Change history: costs removed at any depth; the price list hidden like 3b.
create or replace function public.mask_activity(p_type text, p_changes jsonb, p_costs boolean, p_supplier boolean, p_money boolean)
returns jsonb language plpgsql immutable set search_path = public as $$
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
                          'job_discount_total', 'subtotal', 'taxable_base', 'tax_total', 'total', 'paid_total', 'balance', 'snapshot'];
  end if;
  if not p_money and (p_type in ('catalog_items', 'labor_rates', 'service_templates', 'discounts', 'customers')
                      or t in ('catalog_item_fees', 'service_template_items')) then
    hide := hide || array['price', 'fee_value', 'rate_per_hour', 'flat_price', 'price_override', 'value', 'max_amount', 'credit_limit'];
  end if;
  if cardinality(hide) = 0 then return r; end if;
  r := r - hide;
  if jsonb_typeof(r->'row') = 'object' then r := jsonb_set(r, '{row}', (r->'row') - hide); end if;
  if jsonb_typeof(r->'diff') = 'object' then r := jsonb_set(r, '{diff}', (r->'diff') - hide); end if;
  return r;
end $$;

-- ============================================================================================================
-- 3c. Faktur pajak number only through set_faktur_pajak
-- ============================================================================================================
revoke update (faktur_pajak_number) on public.repair_orders from anon, authenticated;

-- ============================================================================================================
-- 3d. Sign-in limits that hold when many tries arrive at once
-- ============================================================================================================
-- Starts a sign-in try: null when the username or the address is paused (8 / 30 failed tries in 15 minutes);
-- otherwise the try is recorded as failed until login_finish says it succeeded.
create or replace function public.login_begin(p_key text, p_ip text) returns bigint
language plpgsql security definer set search_path = public as $$
declare k text := lower(btrim(coalesce(p_key, ''))); a text := nullif(left(btrim(coalesce(p_ip, '')), 100), ''); v bigint;
begin
  -- one try at a time per username, then per address (always in this order, so two tries can't wait on each other)
  perform pg_advisory_xact_lock(hashtext('axle-login:' || k));
  if a is not null then perform pg_advisory_xact_lock(hashtext('axle-login-ip:' || a)); end if;
  if (select count(*) from login_attempts where login_key = k and not ok and at > now() - interval '15 minutes') >= 8 then return null; end if;
  if a is not null and (select count(*) from login_attempts where ip = a and not ok and at > now() - interval '15 minutes') >= 30 then return null; end if;
  insert into login_attempts (login_key, ip, ok) values (k, a, false) returning id into v;
  return v;
end $$;

create or replace function public.login_finish(p_id bigint, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  delete from login_attempts where at < now() - interval '1 day';
  if p_ok then
    select login_key into k from login_attempts where id = p_id;
    if k is not null then delete from login_attempts where login_key = k and not ok; end if;
  end if;
end $$;
revoke execute on function public.login_begin(text, text) from public, anon, authenticated;
revoke execute on function public.login_finish(bigint, boolean) from public, anon, authenticated;
grant execute on function public.login_begin(text, text) to service_role;
grant execute on function public.login_finish(bigint, boolean) to service_role;

-- The older pair (used by the first `login` function) cut addresses the same way.
create or replace function public.login_allowed(p_key text, p_ip text) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from login_attempts where login_key = lower(btrim(p_key)) and not ok and at > now() - interval '15 minutes') < 8
     and (nullif(left(btrim(coalesce(p_ip, '')), 100), '') is null
          or (select count(*) from login_attempts where ip = left(btrim(p_ip), 100) and not ok and at > now() - interval '15 minutes') < 30);
$$;
create or replace function public.login_note(p_key text, p_ip text, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from login_attempts where at < now() - interval '1 day';
  if p_ok then
    delete from login_attempts where login_key = lower(btrim(p_key)) and not ok;
  else
    insert into login_attempts (login_key, ip, ok) values (lower(btrim(p_key)), nullif(left(btrim(coalesce(p_ip, '')), 100), ''), false);
  end if;
end $$;
revoke execute on function public.login_allowed(text, text) from public, anon, authenticated;
revoke execute on function public.login_note(text, text, boolean) from public, anon, authenticated;
grant execute on function public.login_allowed(text, text) to service_role;
grant execute on function public.login_note(text, text, boolean) to service_role;
