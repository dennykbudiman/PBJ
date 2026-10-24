-- Axle v2 · 129 Money kept in the database, Cashier additions, sign-in through the server, and go-live fixes
--
-- Decided by Denny on Oct 24, 2026 (see claude/v2-decisions.md):
--
-- 1. Money is hidden by the database, not only on screen. Anyone with the public key and a login used to be able to read
--    every figure through the API. Now:
--      cost prices (catalog, job lines)                     only with view_costs (Owner, Admin, Service advisor)
--      supplier money (PO line costs, supplier payments,    with view_costs or the new pay_supplier_bills
--      returns and cores money)                             (adds the Cashier)
--      job money (line prices, discounts, fees, totals,     with view_reports (Owner, Admin, Service advisor, Cashier),
--      balances, payments, credits)                         and for a Technician on the jobs they work on
--    How: the money columns are no longer readable from the tables themselves. The app reads through "<table>_read"
--    views that show each figure only to people allowed to see it (blank otherwise), with the same row rule as the
--    tables (staff only). Writing is unchanged. Payments, credits and voided invoices are filtered by row instead.
--    The change history (activity_log) is read through activity_log_read, which removes figures the same way.
--    NOTE for later migrations: a new column on one of these tables must also be added to its _read view.
-- 2. Cashier: pays supplier bills (new permission pay_supplier_bills: Owner, Admin, Service advisor, Cashier), may enter
--    the faktur pajak number of an issued invoice (set_faktur_pajak), and may attach transfer slips to a job
--    (attachments of kind 'payment', seen only by people who see job money).
-- 3. Sign-in through the server: the username-to-email lookup is no longer open to the public. The new edge function
--    `login` resolves the username and signs in, with the same answer for any wrong username or password, and limits
--    repeated failures (login_attempts).
-- 4. Fixes: each person marks shop-wide notifications read for themselves (notification_reads); overdue-invoice notices
--    only reach people who see job money; one default labor rate, kept by the database; the Users screen can show who
--    hasn't finished their invite yet (user_logins).

-- ============================================================================================================
-- 1. New permission: pay supplier bills
-- ============================================================================================================
insert into public.role_permissions (role_id, permission_key)
select r.id, 'pay_supplier_bills' from public.roles r where r.name in ('Owner', 'Admin', 'Service advisor', 'Cashier')
on conflict do nothing;

do $$
declare f regprocedure; src text; changed text;
begin
  foreach f in array array['public.pay_po_items(uuid[], date, text, text, numeric)'::regprocedure,
                           'public.undo_supplier_payment(uuid)'::regprocedure]
  loop
    src := pg_get_functiondef(f);
    changed := replace(src, 'has_permission(''manage_inventory'')', 'has_permission(''pay_supplier_bills'')');
    if changed = src then
      if position('has_permission(''pay_supplier_bills'')' in src) = 0 then raise exception 'permission check not found in %', f; end if;
    else
      execute changed;
    end if;
  end loop;
end $$;

-- Supplier payments are only made and undone through pay_po_items / undo_supplier_payment.
drop policy if exists "edit supplier_payments" on public.supplier_payments;
revoke insert, update, delete on public.supplier_payments from anon, authenticated;

-- The dashboard's "bills to pay" tile follows the same rule.
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.dashboard_summary()'::regprocedure);
  changed := replace(src, 'v_costs boolean := has_permission(''view_costs'');',
                          'v_costs boolean := has_permission(''view_costs'') or has_permission(''pay_supplier_bills'');');
  if changed = src then
    if position('has_permission(''pay_supplier_bills'')' in src) = 0 then raise exception 'dashboard_summary: v_costs not found'; end if;
  else
    execute changed;
  end if;
end $$;

-- ============================================================================================================
-- 2. Who works on a job (a Technician sees the money of the jobs they are assigned to)
-- ============================================================================================================
create or replace function public.works_on_job(p_ro uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_ro is not null and exists (select 1 from ro_services s where s.ro_id = p_ro and s.technician_id = auth.uid());
$$;
revoke execute on function public.works_on_job(uuid) from public, anon;
grant execute on function public.works_on_job(uuid) to authenticated;

-- ============================================================================================================
-- 3. Read views: the tables keep every row for staff, but money columns are only readable through these views
-- ============================================================================================================
-- catalog_items: cost (C), core_cost (C), markup_pct (C)
create or replace view public.catalog_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.item_type, t.name, t.code, t.description, t.category_id, t.supplier_id, t.brand,
       case when p.costs then t.cost end as cost,
       t.price,
       case when p.costs then t.markup_pct end as markup_pct,
       t.default_qty, t.labor_hours, t.labor_rate_id, t.fee_kind, t.fee_value, t.taxable, t.show_on_invoice,
       t.show_qty_price, t.track_inventory, t.qty_on_hand, t.reorder_point, t.has_core,
       case when p.costs then t.core_cost end as core_cost,
       t.tire_size, t.notes, t.active, t.created_at, t.updated_at
from public.catalog_items t
cross join p
where (select public.is_staff());
revoke all on public.catalog_items_read from public, anon, authenticated;
grant select on public.catalog_items_read to authenticated;
revoke select on public.catalog_items from anon, authenticated;
grant select (id, item_type, name, code, description, category_id, supplier_id, brand, price, default_qty, labor_hours, labor_rate_id, fee_kind, fee_value, taxable, show_on_invoice, show_qty_price, track_inventory, qty_on_hand, reorder_point, has_core, tire_size, notes, active, created_at, updated_at) on public.catalog_items to authenticated;

-- ro_service_items: cost (C), price (M), discount_pct (M), discount_amount (M), core_charge (M), amount (M), discount (M), net (M)
create or replace view public.ro_service_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.service_id, t.position, t.item_type, t.catalog_item_id, t.name, t.description,
       case when p.costs then t.cost end as cost,
       case when p.money or m.works then t.price end as price,
       t.qty, t.hours_worked,
       case when p.money or m.works then t.discount_pct end as discount_pct,
       case when p.money or m.works then t.discount_amount end as discount_amount,
       t.taxable,
       case when p.money or m.works then t.core_charge end as core_charge,
       t.show_qty_price, t.stock_deducted, t.po_item_id,
       case when p.money or m.works then t.amount end as amount,
       case when p.money or m.works then t.discount end as discount,
       case when p.money or m.works then t.net end as net,
       t.created_at
from public.ro_service_items t
cross join p
left join public.ro_services j on j.id = t.service_id
cross join lateral (select case when p.money then false else public.works_on_job(j.ro_id) end as works) m
where (select public.is_staff());
revoke all on public.ro_service_items_read from public, anon, authenticated;
grant select on public.ro_service_items_read to authenticated;
revoke select on public.ro_service_items from anon, authenticated;
grant select (id, service_id, position, item_type, catalog_item_id, name, description, qty, hours_worked, taxable, show_qty_price, stock_deducted, po_item_id, created_at) on public.ro_service_items to authenticated;

-- purchase_order_items: cost (S), core_cost (S)
create or replace view public.purchase_order_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.po_id, t.catalog_item_id, t.ro_service_item_id, t.name, t.part_number,
       case when p.supplier then t.cost end as cost,
       case when p.supplier then t.core_cost end as core_cost,
       t.taxable, t.qty_ordered, t.qty_delivered, t.qty_cancelled, t.delivered_at, t.supplier_invoice_no,
       t.invoice_date, t.payment_due, t.paid_at, t.created_at, t.qty_paid
from public.purchase_order_items t
cross join p
where (select public.is_staff());
revoke all on public.purchase_order_items_read from public, anon, authenticated;
grant select on public.purchase_order_items_read to authenticated;
revoke select on public.purchase_order_items from anon, authenticated;
grant select (id, po_id, catalog_item_id, ro_service_item_id, name, part_number, taxable, qty_ordered, qty_delivered, qty_cancelled, delivered_at, supplier_invoice_no, invoice_date, payment_due, paid_at, created_at, qty_paid) on public.purchase_order_items to authenticated;

-- supplier_payments: amount (S), lines (S)
create or replace view public.supplier_payments_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.supplier_id,
       case when p.supplier then t.amount end as amount,
       t.paid_at, t.method, t.reference, t.po_item_ids, t.recorded_by, t.created_at,
       case when p.supplier then t.lines end as lines
from public.supplier_payments t
cross join p
where (select public.is_staff());
revoke all on public.supplier_payments_read from public, anon, authenticated;
grant select on public.supplier_payments_read to authenticated;
revoke select on public.supplier_payments from anon, authenticated;
grant select (id, supplier_id, paid_at, method, reference, po_item_ids, recorded_by, created_at) on public.supplier_payments to authenticated;

-- returns: return_cost (S), return_tax (S), refund_amount (S)
create or replace view public.returns_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.kind, t.po_item_id, t.ro_id, t.supplier_id, t.catalog_item_id, t.item_name, t.qty,
       case when p.supplier then t.return_cost end as return_cost,
       case when p.supplier then t.return_tax end as return_tax,
       t.status, t.marked_at, t.shipped_at, t.delivered_at, t.refunded_at, t.supplier_invoice_no,
       t.credit_number,
       case when p.supplier then t.refund_amount end as refund_amount,
       t.note, t.created_at, t.batch_id
from public.returns t
cross join p
where (select public.is_staff());
revoke all on public.returns_read from public, anon, authenticated;
grant select on public.returns_read to authenticated;
revoke select on public.returns from anon, authenticated;
grant select (id, kind, po_item_id, ro_id, supplier_id, catalog_item_id, item_name, qty, status, marked_at, shipped_at, delivered_at, refunded_at, supplier_invoice_no, credit_number, note, created_at, batch_id) on public.returns to authenticated;

-- cores: core_cost (S), refund_amount (S)
create or replace view public.cores_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.ro_service_item_id, t.po_item_id, t.ro_id, t.supplier_id, t.item_name,
       case when p.supplier then t.core_cost end as core_cost,
       t.qty, t.retrieval_status, t.return_status, t.marked_at, t.delivered_at, t.refunded_at,
       t.credit_number,
       case when p.supplier then t.refund_amount end as refund_amount,
       t.created_at, t.shipped_at
from public.cores t
cross join p
where (select public.is_staff());
revoke all on public.cores_read from public, anon, authenticated;
grant select on public.cores_read to authenticated;
revoke select on public.cores from anon, authenticated;
grant select (id, ro_service_item_id, po_item_id, ro_id, supplier_id, item_name, qty, retrieval_status, return_status, marked_at, delivered_at, refunded_at, credit_number, created_at, shipped_at) on public.cores to authenticated;

-- repair_orders: parts_total (M), labor_total (M), other_total (M), service_fees_total (M), item_discount_total (M), service_discount_total (M), job_fees_total (M), job_discount_total (M), subtotal (M), taxable_base (M), tax_total (M), total (M), paid_total (M), balance (M)
create or replace view public.repair_orders_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.job_number, t.invoice_number, t.customer_id, t.vehicle_id, t.odometer_in, t.odometer_out,
       t.order_status, t.workflow_status, t.priority, t.tags, t.service_advisor_id, t.shop_notes,
       t.recommendations, t.print_language, t.invoiced_at, t.due_date, t.archived_at, t.faktur_pajak_number,
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
       t.payment_status, t.created_by, t.created_at, t.updated_at, t.job_no, t.invoice_no, t.closed_at,
       t.close_reason, t.closed_by
from public.repair_orders t
cross join p
cross join lateral (select case when p.money then false else public.works_on_job(t.id) end as works) m
where (select public.is_staff());
revoke all on public.repair_orders_read from public, anon, authenticated;
grant select on public.repair_orders_read to authenticated;
revoke select on public.repair_orders from anon, authenticated;
grant select (id, job_number, invoice_number, customer_id, vehicle_id, odometer_in, odometer_out, order_status, workflow_status, priority, tags, service_advisor_id, shop_notes, recommendations, print_language, invoiced_at, due_date, archived_at, faktur_pajak_number, bill_to_snapshot, shop_snapshot, payment_status, created_by, created_at, updated_at, job_no, invoice_no, closed_at, close_reason, closed_by) on public.repair_orders to authenticated;

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
       t.created_at, t.carried_from
from public.ro_services t
cross join p
cross join lateral (select case when p.money then false else public.works_on_job(t.ro_id) end as works) m
where (select public.is_staff());
revoke all on public.ro_services_read from public, anon, authenticated;
grant select on public.ro_services_read to authenticated;
revoke select on public.ro_services from anon, authenticated;
grant select (id, ro_id, position, name, notes_external, technician_id, concern_id, approval_status, work_status, completed_at, template_id, checklist_id, service_schedule_id, created_at, carried_from) on public.ro_services to authenticated;

-- ro_job_fees: value (M), amount (M)
create or replace view public.ro_job_fees_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.ro_id, t.name, t.kind,
       case when p.money or m.works then t.value end as value,
       case when p.money or m.works then t.amount end as amount,
       t.taxable, t.is_shop_supplies, t.manual_override
from public.ro_job_fees t
cross join p
cross join lateral (select case when p.money then false else public.works_on_job(t.ro_id) end as works) m
where (select public.is_staff());
revoke all on public.ro_job_fees_read from public, anon, authenticated;
grant select on public.ro_job_fees_read to authenticated;
revoke select on public.ro_job_fees from anon, authenticated;
grant select (id, ro_id, name, kind, taxable, is_shop_supplies, manual_override) on public.ro_job_fees to authenticated;

-- ro_job_discounts: value (M), max_amount (M), amount (M)
create or replace view public.ro_job_discounts_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.ro_id, t.discount_id, t.name, t.kind,
       case when p.money or m.works then t.value end as value,
       case when p.money or m.works then t.max_amount end as max_amount,
       case when p.money or m.works then t.amount end as amount
from public.ro_job_discounts t
cross join p
cross join lateral (select case when p.money then false else public.works_on_job(t.ro_id) end as works) m
where (select public.is_staff());
revoke all on public.ro_job_discounts_read from public, anon, authenticated;
grant select on public.ro_job_discounts_read to authenticated;
revoke select on public.ro_job_discounts from anon, authenticated;
grant select (id, ro_id, discount_id, name, kind) on public.ro_job_discounts to authenticated;

-- ============================================================================================================
-- 4. Payments, credits and voided invoices: whole rows, for people who see job money
-- ============================================================================================================
drop policy if exists "staff read payments" on public.payments;
create policy "staff read payments" on public.payments for select using (
  (select public.is_staff()) and ((select public.has_permission('view_reports')) or (select public.has_permission('record_payments'))
                                  or public.works_on_job(ro_id)));

drop policy if exists "staff read credit_memos" on public.credit_memos;
create policy "staff read credit_memos" on public.credit_memos for select using (
  (select public.is_staff()) and ((select public.has_permission('view_reports')) or (select public.has_permission('record_payments'))
                                  or (select public.has_permission('issue_credits')) or public.works_on_job(applied_ro_id)));

-- A voided invoice keeps a full copy of the job (with cost prices), so it is for the money people only.
drop policy if exists "staff read invoice_voids" on public.invoice_voids;
create policy "staff read invoice_voids" on public.invoice_voids for select using (
  (select public.is_staff()) and (select public.has_permission('view_reports')));

-- ============================================================================================================
-- 5. Balances and the invoice register read money columns, so they now run as their owner with their own check
-- ============================================================================================================
drop view if exists public.customer_balances;
create view public.customer_balances with (security_barrier = true) as
select c.id as customer_id, c.display_name,
       coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0), 0) as balance_due,
       coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0
                                         and coalesce(r.due_date, (r.invoiced_at at time zone coalesce((select s.timezone from public.shop_settings s limit 1), 'Asia/Jakarta'))::date)
                                             < public.local_date()), 0) as overdue,
       count(r.id) filter (where r.order_status = 'invoice' and r.balance > 0) as open_invoices,
       coalesce((select sum(m.amount) from public.credit_memos m
                 where m.customer_id = c.id and m.applied_ro_id is null and m.refunded_at is null), 0) as available_credit
from public.customers c
left join public.repair_orders r on r.customer_id = c.id
where (select public.is_staff()) and ((select public.has_permission('view_reports')) or (select public.has_permission('record_payments')))
group by c.id, c.display_name;
revoke all on public.customer_balances from public, anon, authenticated;
grant select on public.customer_balances to authenticated;

drop view if exists public.invoice_register;
create view public.invoice_register with (security_barrier = true) as
select r.invoice_number, r.invoice_no, r.job_no, r.id as ro_id, r.customer_id, r.invoiced_at, r.due_date, r.total, r.paid_total,
       r.balance, r.payment_status, 'issued'::text as status, null::text as void_reason, null::timestamptz as voided_at
from public.repair_orders r
where r.order_status = 'invoice' and (select public.is_staff()) and (select public.has_permission('view_reports'))
union all
select v.invoice_number, v.invoice_no, lpad(v.snapshot->'job'->>'job_number', 6, '0'), v.ro_id, (v.snapshot->'job'->>'customer_id')::uuid,
       v.invoiced_at, null::date, 0, 0, 0, 'void'::text, 'void'::text, v.reason, v.voided_at
from public.invoice_voids v
where (select public.is_staff()) and (select public.has_permission('view_reports'));
revoke all on public.invoice_register from public, anon, authenticated;
grant select on public.invoice_register to authenticated;

-- ============================================================================================================
-- 6. Change history without the figures a person may not see
-- ============================================================================================================
create or replace function public.mask_activity(p_type text, p_changes jsonb, p_costs boolean, p_supplier boolean, p_money boolean)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  t text := coalesce(p_changes->>'table', p_type);
  hide text[] := '{}';
  r jsonb;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then return p_changes; end if;
  if not p_costs then hide := hide || array['cost', 'core_cost', 'markup_pct']; end if;
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
  if cardinality(hide) = 0 then return p_changes; end if;
  r := p_changes - hide;
  if jsonb_typeof(r->'row') = 'object' then r := jsonb_set(r, '{row}', (r->'row') - hide); end if;
  if jsonb_typeof(r->'diff') = 'object' then r := jsonb_set(r, '{diff}', (r->'diff') - hide); end if;
  return r;
end $$;
revoke execute on function public.mask_activity(text, jsonb, boolean, boolean, boolean) from public, anon;
grant execute on function public.mask_activity(text, jsonb, boolean, boolean, boolean) to authenticated;

create or replace view public.activity_log_read with (security_barrier = true) as
with p as (select public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier,
                  public.has_permission('view_reports') as money)
select a.id, a.entity_type, a.entity_id, a.action, public.mask_activity(a.entity_type, a.changes, p.costs, p.supplier, p.money) as changes,
       a.user_id, a.created_at
from public.activity_log a
cross join p
where (select public.is_staff());
revoke all on public.activity_log_read from public, anon, authenticated;
grant select on public.activity_log_read to authenticated;
revoke select on public.activity_log from anon, authenticated;

-- ============================================================================================================
-- 7. Faktur pajak number on an issued invoice: Service advisor, Cashier, Owner, Admin
-- ============================================================================================================
create or replace function public.set_faktur_pajak(p_ro uuid, p_number text) returns void
language plpgsql security definer set search_path = public as $$
declare v_status text; v_closed timestamptz; v_no text := nullif(btrim(p_number), '');
begin
  if not (has_permission('record_payments') or has_permission('edit_jobs')) then raise exception 'Not allowed'; end if;
  select order_status, closed_at into v_status, v_closed from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if v_status <> 'invoice' then raise exception 'The faktur pajak number is entered once the invoice is issued'; end if;
  if v_closed is not null then raise exception 'This job is closed. Reopen it first.'; end if;
  if length(v_no) > 40 then raise exception 'The faktur pajak number is too long'; end if;
  update repair_orders set faktur_pajak_number = v_no where id = p_ro;
end $$;
revoke execute on function public.set_faktur_pajak(uuid, text) from public, anon;
grant execute on function public.set_faktur_pajak(uuid, text) to authenticated;

-- ============================================================================================================
-- 8. Attachments: general files (job editors) and transfer slips (people who record payments)
-- ============================================================================================================
-- Paths: jobs/<job id>/<file> for general files, payments/<job id>/<file> for transfer slips.
alter table public.attachments add column if not exists kind text not null default 'general';
alter table public.attachments drop constraint if exists attachments_kind_check;
alter table public.attachments add constraint attachments_kind_check check (
  (kind = 'general' and file_path like 'jobs/%') or (kind = 'payment' and file_path like 'payments/%'));
alter table public.attachments drop constraint if exists attachments_file_name_check;
alter table public.attachments add constraint attachments_file_name_check check (file_name is null or length(file_name) <= 200);

drop policy if exists "edit attachments" on public.attachments;
drop policy if exists "staff read attachments" on public.attachments;
drop policy if exists "read attachments" on public.attachments;
drop policy if exists "add attachments" on public.attachments;
drop policy if exists "remove attachments" on public.attachments;
create policy "read attachments" on public.attachments for select using (
  (select public.is_staff()) and (kind = 'general' or (select public.has_permission('view_reports')) or (select public.has_permission('record_payments'))));
create policy "add attachments" on public.attachments for insert with check (
  uploaded_by = (select auth.uid()) and entity_type = 'repair_order'
  and ((kind = 'general' and (select public.has_permission('edit_jobs'))) or (kind = 'payment' and (select public.has_permission('record_payments')))));
create policy "remove attachments" on public.attachments for delete using (
  (kind = 'general' and (select public.has_permission('edit_jobs'))) or (kind = 'payment' and (select public.has_permission('record_payments'))));
revoke update on public.attachments from anon, authenticated;

drop policy if exists "attachments read" on storage.objects;
drop policy if exists "attachments write" on storage.objects;
drop policy if exists "attachments delete" on storage.objects;
create policy "attachments read" on storage.objects for select using (
  bucket_id = 'attachments' and public.is_staff()
  and ((storage.foldername(name))[1] = 'jobs' or ((storage.foldername(name))[1] = 'payments'
       and (public.has_permission('view_reports') or public.has_permission('record_payments')))));
create policy "attachments write" on storage.objects for insert with check (
  bucket_id = 'attachments'
  and (((storage.foldername(name))[1] = 'jobs' and public.has_permission('edit_jobs'))
       or ((storage.foldername(name))[1] = 'payments' and public.has_permission('record_payments'))));
create policy "attachments delete" on storage.objects for delete using (
  bucket_id = 'attachments'
  and (((storage.foldername(name))[1] = 'jobs' and public.has_permission('edit_jobs'))
       or ((storage.foldername(name))[1] = 'payments' and public.has_permission('record_payments'))));

-- ============================================================================================================
-- 9. Notifications: shop-wide ones are marked read per person; overdue invoices only for people who see job money
-- ============================================================================================================
create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);
alter table public.notification_reads enable row level security;
drop policy if exists "read own notification reads" on public.notification_reads;
create policy "read own notification reads" on public.notification_reads for select using (user_id = (select auth.uid()));
revoke all on public.notification_reads from anon, authenticated;
grant select on public.notification_reads to authenticated;

drop policy if exists "read own or broadcast notifications" on public.notifications;
create policy "read own or broadcast notifications" on public.notifications for select using (
  (select public.is_staff()) and (user_id is null or user_id = (select auth.uid()))
  and (type is distinct from 'invoice_overdue' or (select public.has_permission('view_reports'))));

-- What the bell shows: the person's own notifications and shop-wide ones, with read_at for this person.
create or replace view public.my_notifications with (security_invoker = true) as
select n.id, n.type, n.severity, n.title, n.body, n.entity_type, n.entity_id, n.user_id,
       case when n.user_id is null then r.read_at else n.read_at end as read_at, n.created_at, n.data
from public.notifications n
left join public.notification_reads r on r.notification_id = n.id and r.user_id = (select auth.uid());
revoke all on public.my_notifications from public, anon, authenticated;
grant select on public.my_notifications to authenticated;

create or replace function public.mark_notifications_read(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  update notifications set read_at = now() where id = any(p_ids) and user_id = auth.uid() and read_at is null;
  insert into notification_reads (notification_id, user_id)
  select n.id, auth.uid() from notifications n
  where n.id = any(p_ids) and n.user_id is null and (n.type is distinct from 'invoice_overdue' or has_permission('view_reports'))
  on conflict do nothing;
end $$;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ============================================================================================================
-- 10. One default labor rate, and it is active
-- ============================================================================================================
update public.labor_rates set is_default = false
where is_default and id <> (select id from public.labor_rates where is_default order by active desc, created_at, id limit 1);
update public.labor_rates set active = true where is_default and not active;
alter table public.labor_rates drop constraint if exists labor_rates_default_active;
alter table public.labor_rates add constraint labor_rates_default_active check (not is_default or active);
create unique index if not exists labor_rates_one_default on public.labor_rates ((true)) where is_default;

-- Making a rate the default takes the flag off the old one in the same step.
create or replace function public.one_default_labor_rate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_default and (tg_op = 'INSERT' or not old.is_default) then
    update labor_rates set is_default = false where is_default and id <> new.id;
  end if;
  return new;
end $$;
revoke execute on function public.one_default_labor_rate() from public, anon, authenticated;
drop trigger if exists labor_rates_one_default on public.labor_rates;
create trigger labor_rates_one_default before insert or update of is_default on public.labor_rates
for each row execute function public.one_default_labor_rate();

-- ============================================================================================================
-- 11. Users screen: who hasn't finished their invite, and when each person last signed in
-- ============================================================================================================
create or replace function public.user_logins()
returns table (id uuid, invited boolean, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('manage_users') then raise exception 'Not allowed'; end if;
  return query
  select u.id, (u.invited_at is not null and coalesce(u.raw_user_meta_data->>'password_set', '') <> 'true'), u.last_sign_in_at
  from auth.users u join profiles p on p.id = u.id;
end $$;
revoke execute on function public.user_logins() from public, anon;
grant execute on function public.user_logins() to authenticated;

-- ============================================================================================================
-- 12. Sign-in through the server (edge function `login`)
-- ============================================================================================================
-- The username-to-email lookup is for the server only now.
revoke execute on function public.get_email_for_username(text) from public, anon, authenticated;
grant execute on function public.get_email_for_username(text) to service_role;

-- Failed sign-ins, to slow down guessing: per username or email, and per network address.
create table if not exists public.login_attempts (
  id bigint generated always as identity primary key,
  login_key text not null,
  ip text,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists login_attempts_key_at on public.login_attempts (login_key, at);
create index if not exists login_attempts_ip_at on public.login_attempts (ip, at);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from public, anon, authenticated;

-- true when a sign-in may be tried now: fewer than 8 failures for this login, and fewer than 30 from this address,
-- in the last 15 minutes.
create or replace function public.login_allowed(p_key text, p_ip text) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from login_attempts where login_key = lower(btrim(p_key)) and not ok and at > now() - interval '15 minutes') < 8
     and (p_ip is null or (select count(*) from login_attempts where ip = p_ip and not ok and at > now() - interval '15 minutes') < 30);
$$;

create or replace function public.login_note(p_key text, p_ip text, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from login_attempts where at < now() - interval '1 day';
  if p_ok then
    delete from login_attempts where login_key = lower(btrim(p_key)) and not ok;
  else
    insert into login_attempts (login_key, ip, ok) values (lower(btrim(p_key)), left(p_ip, 100), false);
  end if;
end $$;
revoke execute on function public.login_allowed(text, text) from public, anon, authenticated;
revoke execute on function public.login_note(text, text, boolean) from public, anon, authenticated;
grant execute on function public.login_allowed(text, text) to service_role;
grant execute on function public.login_note(text, text, boolean) to service_role;
grant select, insert, delete on public.login_attempts to service_role;
