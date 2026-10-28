-- Axle v2 · 133 Fleet manager access (Oct 27, 2026)
--
-- A Fleet manager is a login for a customer's own fleet person. It sees only the companies an Owner or Admin links it
-- to (one or more) and, for those companies: the company details and contacts, vehicles, service schedules and what is
-- due, work orders (estimates and invoices) with their services, lines, prices, totals, payments and what is still owed,
-- concerns, inspections, approvals, bookings, and the shop's name, address and bank details for printing.
-- Never: other companies, cost prices or margins, the shop's internal notes (job "Catatan bengkel" and the company's
-- pinned notes), attachments, activity logs, staff, the catalog, stock, suppliers, reports or settings.
-- Everything is read-only, except one thing: on an open estimate it may approve, defer or decline services that are
-- still waiting (fleet_decide). Once decided it can't change that decision itself; the shop can (Catat persetujuan),
-- including putting it back to waiting.
--
-- Run once in the SQL Editor, after 132. Safe to re-run. The app update in the same delivery uses it.

-- 1. Which companies each Fleet manager login may see ---------------------------------------------------------------
create table if not exists public.fleet_manager_companies (
  user_id uuid not null references public.profiles(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  primary key (user_id, customer_id)
);
create index if not exists fleet_manager_companies_customer on public.fleet_manager_companies (customer_id);
alter table public.fleet_manager_companies enable row level security;
revoke all on public.fleet_manager_companies from anon, authenticated;
grant select, insert, delete on public.fleet_manager_companies to authenticated;
drop policy if exists "read fleet links" on public.fleet_manager_companies;
create policy "read fleet links" on public.fleet_manager_companies for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_permission('manage_users')));
drop policy if exists "manage fleet links" on public.fleet_manager_companies;
create policy "manage fleet links" on public.fleet_manager_companies for insert to authenticated
  with check ((select public.has_permission('manage_users')));
drop policy if exists "unlink fleet" on public.fleet_manager_companies;
create policy "unlink fleet" on public.fleet_manager_companies for delete to authenticated
  using ((select public.has_permission('manage_users')));

-- Only Fleet manager logins can be linked to companies.
create or replace function public.guard_fleet_link() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles p join roles r on r.id = p.role_id where p.id = new.user_id and r.name = 'Fleet manager') then
    raise exception 'Only Fleet manager logins can be linked to a company';
  end if;
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end $$;
drop trigger if exists fleet_manager_companies_guard on public.fleet_manager_companies;
create trigger fleet_manager_companies_guard before insert on public.fleet_manager_companies
  for each row execute function public.guard_fleet_link();

-- A login that stops being a Fleet manager loses its links.
create or replace function public.drop_fleet_links() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role_id is distinct from old.role_id
     and not exists (select 1 from roles where id = new.role_id and name = 'Fleet manager') then
    delete from fleet_manager_companies where user_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists profiles_drop_fleet_links on public.profiles;
create trigger profiles_drop_fleet_links after update of role_id on public.profiles
  for each row execute function public.drop_fleet_links();

-- The Fleet manager role is recognised by its name, so that name can't be changed, taken or deleted.
create or replace function public.guard_fleet_role() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.name = 'Fleet manager' then raise exception 'The Fleet manager role can''t be deleted'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.name = 'Fleet manager' and new.name is distinct from old.name then
    raise exception 'The Fleet manager role can''t be renamed';
  end if;
  if new.name = 'Fleet manager' and (tg_op = 'INSERT' or old.name is distinct from new.name) then
    raise exception 'Another role can''t be called Fleet manager';
  end if;
  return new;
end $$;
drop trigger if exists roles_guard_fleet on public.roles;
create trigger roles_guard_fleet before insert or update of name or delete on public.roles
  for each row execute function public.guard_fleet_role();
revoke all on function public.guard_fleet_role() from public, anon, authenticated;

-- 2. Helpers (one answer per statement, used by the row rules below) -----------------------------------------------
create or replace function public.is_fleet() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p join roles r on r.id = p.role_id
                 where p.id = auth.uid() and p.status = 'active' and r.name = 'Fleet manager');
$$;
create or replace function public.fleet_customer_ids() returns setof uuid language sql stable security definer set search_path = public as $$
  select f.customer_id from fleet_manager_companies f
  where f.user_id = auth.uid() and public.is_fleet();
$$;
create or replace function public.fleet_vehicle_ids() returns setof uuid language sql stable security definer set search_path = public as $$
  select v.id from vehicles v where v.customer_id in (select public.fleet_customer_ids());
$$;
-- Work orders billed to the fleet's companies (a vehicle bought from another company doesn't bring that company's
-- old invoices with it).
create or replace function public.fleet_job_ids() returns setof uuid language sql stable security definer set search_path = public as $$
  select r.id from repair_orders r where r.customer_id in (select public.fleet_customer_ids());
$$;
create or replace function public.fleet_job(p_ro uuid) returns boolean language sql stable security definer set search_path = public as $$
  select p_ro is not null and exists (select 1 from repair_orders r where r.id = p_ro and r.customer_id in (select public.fleet_customer_ids()));
$$;
revoke all on function public.is_fleet(), public.fleet_customer_ids(), public.fleet_vehicle_ids(), public.fleet_job_ids(),
  public.fleet_job(uuid) from public, anon;
grant execute on function public.is_fleet(), public.fleet_customer_ids(), public.fleet_vehicle_ids(), public.fleet_job_ids(),
  public.fleet_job(uuid) to authenticated;
revoke all on function public.guard_fleet_link(), public.drop_fleet_links() from public, anon, authenticated;

-- 3. Read rules for the fleet's own rows ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
    ('customers',            'id in (select public.fleet_customer_ids())'),
    ('customer_contacts',    'customer_id in (select public.fleet_customer_ids())'),
    ('vehicles',             'customer_id in (select public.fleet_customer_ids())'),
    ('service_schedules',    'vehicle_id in (select public.fleet_vehicle_ids())'),
    ('repair_orders',        'customer_id in (select public.fleet_customer_ids())'),
    ('ro_concerns',          'ro_id in (select public.fleet_job_ids())'),
    ('ro_services',          'ro_id in (select public.fleet_job_ids())'),
    ('ro_service_items',     'service_id in (select s.id from public.ro_services s where s.ro_id in (select public.fleet_job_ids()))'),
    ('ro_job_fees',          'ro_id in (select public.fleet_job_ids())'),
    ('ro_job_discounts',     'ro_id in (select public.fleet_job_ids())'),
    ('approvals',            'ro_id in (select public.fleet_job_ids())'),
    ('ro_inspections',       'ro_id in (select public.fleet_job_ids())'),
    ('ro_inspection_results','inspection_id in (select i.id from public.ro_inspections i where i.ro_id in (select public.fleet_job_ids()))'),
    ('payments',             'ro_id in (select public.fleet_job_ids())'),
    ('appointments',         'customer_id in (select public.fleet_customer_ids())'),
    ('shop_settings',        '(select public.is_fleet())')
  ) v(tbl, cond) loop
    execute format('drop policy if exists %I on public.%I', 'fleet read ' || r.tbl, r.tbl);
    execute format('create policy %I on public.%I for select to authenticated using (%s)', 'fleet read ' || r.tbl, r.tbl, r.cond);
  end loop;
end $$;
-- The fleet's own role name (the app reads it with the profile).
drop policy if exists "read own role" on public.roles;
create policy "read own role" on public.roles for select to authenticated
  using (id = (select p.role_id from public.profiles p where p.id = (select auth.uid())));

-- 4. Approve, defer or decline waiting work -------------------------------------------------------------------------
alter table public.approvals drop constraint if exists approvals_method_check;
alter table public.approvals add constraint approvals_method_check
  check (method in ('in_person', 'phone', 'whatsapp', 'email', 'internal', 'online'));

create or replace function public.fleet_decide(p_services uuid[], p_decision text, p_note text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_ro uuid; v_name text; v_n int := 0; s record;
begin
  if not public.is_fleet() then raise exception 'Only a fleet manager can decide here'; end if;
  if p_decision is null or p_decision not in ('approved', 'deferred', 'declined') then raise exception 'Choose approve, defer or decline'; end if;
  if p_services is null or cardinality(p_services) = 0 then raise exception 'Choose at least one service'; end if;
  if length(coalesce(p_note, '')) > 500 then raise exception 'The note is too long (500 characters at most)'; end if;
  select distinct ro_id into v_ro from ro_services where id = any(p_services);
  if (select count(distinct ro_id) from ro_services where id = any(p_services)) <> 1
     or (select count(*) from ro_services where id = any(p_services)) <> cardinality(p_services) then
    raise exception 'Those services aren''t on one work order';
  end if;
  if not public.fleet_job(v_ro) then raise exception 'That work order isn''t one of your fleet''s'; end if;
  perform 1 from repair_orders where id = v_ro and order_status = 'estimate' and closed_at is null for update;
  if not found then raise exception 'This work order is no longer open for decisions'; end if;
  select coalesce(nullif(name, ''), username) into v_name from profiles where id = auth.uid();
  for s in select id, approval_status, work_status from ro_services where id = any(p_services) for update loop
    if s.approval_status <> 'pending' then
      raise exception 'A decision was already made on this work. Ask the shop if it needs to change';
    end if;
    if p_decision <> 'approved' and s.work_status = 'completed' then
      raise exception 'Completed work can''t be declined or deferred';
    end if;
    insert into approvals (ro_id, service_id, decision, method, approved_by_name, note)
    values (v_ro, s.id, p_decision, 'online', v_name, nullif(btrim(coalesce(p_note, '')), ''));
    v_n := v_n + 1;
  end loop;
  insert into notifications (type, severity, title, body, entity_type, entity_id, data)
  select 'fleet_decision', case p_decision when 'approved' then 'info' else 'warning' end,
         format('%s: %s %s', r.job_number, v_name, case p_decision when 'approved' then 'approved' when 'deferred' then 'deferred' else 'declined' end),
         nullif(btrim(coalesce(p_note, '')), ''), 'repair_order', r.id,
         jsonb_build_object('decision', p_decision, 'count', v_n, 'by', v_name, 'job_number', r.job_number, 'company', c.display_name)
  from repair_orders r join customers c on c.id = r.customer_id where r.id = v_ro;
  return v_n;
end $$;
revoke all on function public.fleet_decide(uuid[], text, text) from public, anon;
grant execute on function public.fleet_decide(uuid[], text, text) to authenticated;

-- 5. Read views: the fleet's rows, with prices and totals; never cost prices, the shop's internal notes, or other
--    companies' rows (generated from the 132 definitions; only the row filter, the price rule and two notes change).
create or replace view public.repair_orders_read with (security_barrier = true) as
WITH p AS (
         SELECT has_permission('view_reports'::text) AS money,
            has_permission('view_costs'::text) AS costs,
            (has_permission('view_costs'::text) OR has_permission('pay_supplier_bills'::text)) AS supplier
        )
 SELECT t.id,
    t.job_number,
    t.invoice_number,
    t.customer_id,
    t.vehicle_id,
    t.odometer_in,
    t.odometer_out,
    t.order_status,
        CASE
            WHEN ((t.workflow_status = 'paid'::text) AND (NOT (p.money OR m.works))) THEN 'invoiced'::text
            ELSE t.workflow_status
        END AS workflow_status,
    t.priority,
    t.tags,
    t.service_advisor_id,
        CASE
            WHEN ( SELECT is_staff() AS is_staff) THEN t.shop_notes
            ELSE NULL::text
        END AS shop_notes,
    t.recommendations,
    t.print_language,
    t.invoiced_at,
        CASE
            WHEN (p.money OR m.works) THEN t.due_date
            ELSE NULL::date
        END AS due_date,
    t.archived_at,
    t.faktur_pajak_number,
    t.bill_to_snapshot,
    t.shop_snapshot,
        CASE
            WHEN (p.money OR m.works) THEN t.parts_total
            ELSE NULL::numeric
        END AS parts_total,
        CASE
            WHEN (p.money OR m.works) THEN t.labor_total
            ELSE NULL::numeric
        END AS labor_total,
        CASE
            WHEN (p.money OR m.works) THEN t.other_total
            ELSE NULL::numeric
        END AS other_total,
        CASE
            WHEN (p.money OR m.works) THEN t.service_fees_total
            ELSE NULL::numeric
        END AS service_fees_total,
        CASE
            WHEN (p.money OR m.works) THEN t.item_discount_total
            ELSE NULL::numeric
        END AS item_discount_total,
        CASE
            WHEN (p.money OR m.works) THEN t.service_discount_total
            ELSE NULL::numeric
        END AS service_discount_total,
        CASE
            WHEN (p.money OR m.works) THEN t.job_fees_total
            ELSE NULL::numeric
        END AS job_fees_total,
        CASE
            WHEN (p.money OR m.works) THEN t.job_discount_total
            ELSE NULL::numeric
        END AS job_discount_total,
        CASE
            WHEN (p.money OR m.works) THEN t.subtotal
            ELSE NULL::numeric
        END AS subtotal,
        CASE
            WHEN (p.money OR m.works) THEN t.taxable_base
            ELSE NULL::numeric
        END AS taxable_base,
        CASE
            WHEN (p.money OR m.works) THEN t.tax_total
            ELSE NULL::numeric
        END AS tax_total,
        CASE
            WHEN (p.money OR m.works) THEN t.total
            ELSE NULL::numeric
        END AS total,
        CASE
            WHEN (p.money OR m.works) THEN t.paid_total
            ELSE NULL::numeric
        END AS paid_total,
        CASE
            WHEN (p.money OR m.works) THEN t.balance
            ELSE NULL::numeric
        END AS balance,
        CASE
            WHEN (p.money OR m.works) THEN t.payment_status
            ELSE NULL::text
        END AS payment_status,
    t.created_by,
    t.created_at,
    t.updated_at,
    t.job_no,
    t.invoice_no,
    t.closed_at,
    t.close_reason,
    t.closed_by
   FROM ((repair_orders t
     CROSS JOIN p)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.money THEN false
                    ELSE (works_on_job(t.id) OR fleet_job(t.id))
                END AS works) m)
  WHERE (( SELECT is_staff() AS is_staff) OR (t.id IN ( SELECT fleet_job_ids() AS fleet_job_ids)));

create or replace view public.ro_services_read with (security_barrier = true) as
WITH p AS (
         SELECT has_permission('view_reports'::text) AS money,
            has_permission('view_costs'::text) AS costs,
            (has_permission('view_costs'::text) OR has_permission('pay_supplier_bills'::text)) AS supplier
        )
 SELECT t.id,
    t.ro_id,
    t."position",
    t.name,
    t.notes_external,
    t.technician_id,
    t.concern_id,
    t.approval_status,
    t.work_status,
    t.completed_at,
    t.template_id,
    t.checklist_id,
    t.service_schedule_id,
        CASE
            WHEN (p.money OR m.works) THEN t.flat_price
            ELSE NULL::numeric
        END AS flat_price,
        CASE
            WHEN (p.money OR m.works) THEN t.discount_pct
            ELSE NULL::numeric
        END AS discount_pct,
        CASE
            WHEN (p.money OR m.works) THEN t.discount_amount
            ELSE NULL::numeric
        END AS discount_amount,
        CASE
            WHEN (p.money OR m.works) THEN t.service_total
            ELSE NULL::numeric
        END AS service_total,
        CASE
            WHEN (p.money OR m.works) THEN t.service_discount
            ELSE NULL::numeric
        END AS service_discount,
        CASE
            WHEN (p.money OR m.works) THEN t.service_net
            ELSE NULL::numeric
        END AS service_net,
    t.created_at,
    t.carried_from,
    (t.flat_price IS NOT NULL) AS is_flat
   FROM ((ro_services t
     CROSS JOIN p)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.money THEN false
                    ELSE (works_on_job(t.ro_id) OR fleet_job(t.ro_id))
                END AS works) m)
  WHERE (( SELECT is_staff() AS is_staff) OR (t.ro_id IN ( SELECT fleet_job_ids() AS fleet_job_ids)));

create or replace view public.ro_service_items_read with (security_barrier = true) as
WITH p AS (
         SELECT has_permission('view_reports'::text) AS money,
            has_permission('view_costs'::text) AS costs,
            (has_permission('view_costs'::text) OR has_permission('pay_supplier_bills'::text)) AS supplier
        )
 SELECT t.id,
    t.service_id,
    t."position",
    t.item_type,
    t.catalog_item_id,
    t.name,
    t.description,
        CASE
            WHEN p.costs THEN t.cost
            ELSE NULL::numeric
        END AS cost,
        CASE
            WHEN (p.money OR m.works) THEN t.price
            ELSE NULL::numeric
        END AS price,
    t.qty,
    t.hours_worked,
        CASE
            WHEN (p.money OR m.works) THEN t.discount_pct
            ELSE NULL::numeric
        END AS discount_pct,
        CASE
            WHEN (p.money OR m.works) THEN t.discount_amount
            ELSE NULL::numeric
        END AS discount_amount,
    t.taxable,
        CASE
            WHEN (p.money OR m.works) THEN t.core_charge
            ELSE NULL::numeric
        END AS core_charge,
    t.show_qty_price,
    t.stock_deducted,
    t.po_item_id,
        CASE
            WHEN (p.money OR m.works) THEN t.amount
            ELSE NULL::numeric
        END AS amount,
        CASE
            WHEN (p.money OR m.works) THEN t.discount
            ELSE NULL::numeric
        END AS discount,
        CASE
            WHEN (p.money OR m.works) THEN t.net
            ELSE NULL::numeric
        END AS net,
    t.created_at
   FROM (((ro_service_items t
     CROSS JOIN p)
     LEFT JOIN ro_services j ON ((j.id = t.service_id)))
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.money THEN false
                    ELSE (works_on_job(j.ro_id) OR fleet_job(j.ro_id))
                END AS works) m)
  WHERE (( SELECT is_staff() AS is_staff) OR (j.ro_id IN ( SELECT fleet_job_ids() AS fleet_job_ids)));

create or replace view public.ro_job_fees_read with (security_barrier = true) as
WITH p AS (
         SELECT has_permission('view_reports'::text) AS money,
            has_permission('view_costs'::text) AS costs,
            (has_permission('view_costs'::text) OR has_permission('pay_supplier_bills'::text)) AS supplier
        )
 SELECT t.id,
    t.ro_id,
    t.name,
    t.kind,
        CASE
            WHEN (p.money OR m.works) THEN t.value
            ELSE NULL::numeric
        END AS value,
        CASE
            WHEN (p.money OR m.works) THEN t.amount
            ELSE NULL::numeric
        END AS amount,
    t.taxable,
    t.is_shop_supplies,
    t.manual_override
   FROM ((ro_job_fees t
     CROSS JOIN p)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.money THEN false
                    ELSE (works_on_job(t.ro_id) OR fleet_job(t.ro_id))
                END AS works) m)
  WHERE (( SELECT is_staff() AS is_staff) OR (t.ro_id IN ( SELECT fleet_job_ids() AS fleet_job_ids)));

create or replace view public.ro_job_discounts_read with (security_barrier = true) as
WITH p AS (
         SELECT has_permission('view_reports'::text) AS money,
            has_permission('view_costs'::text) AS costs,
            (has_permission('view_costs'::text) OR has_permission('pay_supplier_bills'::text)) AS supplier
        )
 SELECT t.id,
    t.ro_id,
    t.discount_id,
    t.name,
    t.kind,
        CASE
            WHEN (p.money OR m.works) THEN t.value
            ELSE NULL::numeric
        END AS value,
        CASE
            WHEN (p.money OR m.works) THEN t.max_amount
            ELSE NULL::numeric
        END AS max_amount,
        CASE
            WHEN (p.money OR m.works) THEN t.amount
            ELSE NULL::numeric
        END AS amount
   FROM ((ro_job_discounts t
     CROSS JOIN p)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.money THEN false
                    ELSE (works_on_job(t.ro_id) OR fleet_job(t.ro_id))
                END AS works) m)
  WHERE (( SELECT is_staff() AS is_staff) OR (t.ro_id IN ( SELECT fleet_job_ids() AS fleet_job_ids)));

create or replace view public.customers_read with (security_barrier = true) as
WITH p AS (
         SELECT has_permission('view_reports'::text) AS money,
            has_permission('view_costs'::text) AS costs,
            (has_permission('view_costs'::text) OR has_permission('pay_supplier_bills'::text)) AS supplier
        )
 SELECT t.id,
    t.type,
    t.display_name,
    t.legal_name,
    t.npwp,
    t.billing_address,
    t.phone,
    t.email,
    t.payment_terms_days,
        CASE
            WHEN p.money THEN t.credit_limit
            ELSE NULL::numeric
        END AS credit_limit,
    t.charge_account,
    t.tax_exempt,
        CASE
            WHEN ( SELECT is_staff() AS is_staff) THEN t.pinned_notes
            ELSE NULL::text
        END AS pinned_notes,
    t.tags,
    t.active,
    t.created_at,
    t.updated_at
   FROM (customers t
     CROSS JOIN p)
  WHERE (( SELECT is_staff() AS is_staff) OR (t.id IN ( SELECT fleet_customer_ids() AS fleet_customer_ids)));

create or replace view public.customer_balances with (security_barrier = true) as
SELECT c.id AS customer_id,
    c.display_name,
    COALESCE(sum(r.balance) FILTER (WHERE ((r.order_status = 'invoice'::text) AND (r.balance > (0)::numeric))), (0)::numeric) AS balance_due,
    COALESCE(sum(r.balance) FILTER (WHERE ((r.order_status = 'invoice'::text) AND (r.balance > (0)::numeric) AND (COALESCE(r.due_date, ((r.invoiced_at AT TIME ZONE COALESCE(( SELECT s.timezone
           FROM shop_settings s
         LIMIT 1), 'Asia/Jakarta'::text)))::date) < local_date()))), (0)::numeric) AS overdue,
    count(r.id) FILTER (WHERE ((r.order_status = 'invoice'::text) AND (r.balance > (0)::numeric))) AS open_invoices,
    COALESCE(( SELECT sum(m.amount) AS sum
           FROM credit_memos m
          WHERE ((m.customer_id = c.id) AND (m.applied_ro_id IS NULL) AND (m.refunded_at IS NULL))), (0)::numeric) AS available_credit
   FROM (customers c
     LEFT JOIN repair_orders r ON ((r.customer_id = c.id)))
  WHERE ((( SELECT is_staff() AS is_staff) AND (( SELECT has_permission('view_reports'::text) AS has_permission) OR ( SELECT has_permission('record_payments'::text) AS has_permission))) OR (c.id IN ( SELECT fleet_customer_ids() AS fleet_customer_ids)))
  GROUP BY c.id, c.display_name;


-- 6. Vehicles: read through a view so the shop's own vehicle notes stay internal (fleet sees every other field).
create or replace view public.vehicles_read with (security_barrier = true) as
select t.id, t.customer_id, t.plate, t.make, t.model, t.year, t.vin, t.type, t.fuel_type, t.status, t.mileage_km,
       case when (select public.is_staff()) then t.notes else null::text end as notes,
       t.created_at, t.updated_at
from public.vehicles t
where (select public.is_staff()) or t.customer_id in (select public.fleet_customer_ids());
revoke all on public.vehicles_read from public, anon;
grant select on public.vehicles_read to authenticated;

-- The base tables no longer hand out the internal notes; the app reads them through the views above.
revoke select on public.vehicles from authenticated;
grant select (id, customer_id, plate, make, model, year, vin, type, fuel_type, status, mileage_km, created_at, updated_at)
  on public.vehicles to authenticated;
revoke select (shop_notes) on public.repair_orders from authenticated;
revoke select (pinned_notes) on public.customers from authenticated;
