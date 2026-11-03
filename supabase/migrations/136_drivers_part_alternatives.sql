-- Axle v2 · 136 Drivers on vehicles and jobs; alternative part numbers and fitment in the catalog (Nov 3, 2026)
--
-- 1. Drivers (future-updates item 2). A vehicle has its current driver (name and phone). Each job records who brought
--    the vehicle in ("dibawa oleh"), prefilled from the vehicle and kept on the job, so past jobs and printed estimates
--    and invoices still show the right person after the driver changes. Fleet-manager logins see both for their own
--    companies (Denny, Nov 3), unlike the vehicle's internal notes. Like the odometer, the driver on an issued invoice
--    is locked (void the invoice to change it).
--    Driver names typed into vehicle notes as a line "Supir: <name>" (the Ekspedisi Lintas trucks, Nov 3) move into
--    the new field, and that line is removed from the notes.
-- 2. Catalog (items 4 and 5). Each part keeps one catalog item per part number and brand. New fields:
--    alt_numbers: other part numbers for the same part (other brands, superseded numbers), free text;
--    fits: the vehicles it fits, in the vehicle list's words, e.g. "Colt FE71 Euro 4 (2022+)".
--    Search covers both, and the job page lists the alternatives of a part (items sharing a part number).
--
-- Run once in the SQL Editor, after 135. Safe to re-run.

-- 1. Drivers ---------------------------------------------------------------------------------------------------------
alter table public.vehicles add column if not exists driver_name text;
alter table public.vehicles add column if not exists driver_phone text;
alter table public.repair_orders add column if not exists driver_name text;
alter table public.repair_orders add column if not exists driver_phone text;

do $$ begin
  alter table public.vehicles add constraint vehicles_driver_len check (char_length(driver_name) <= 120 and char_length(driver_phone) <= 40);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.repair_orders add constraint repair_orders_driver_len check (char_length(driver_name) <= 120 and char_length(driver_phone) <= 40);
exception when duplicate_object then null; end $$;

grant select (driver_name, driver_phone), insert (driver_name, driver_phone), update (driver_name, driver_phone)
  on public.vehicles to authenticated;
grant select (driver_name, driver_phone), insert (driver_name, driver_phone), update (driver_name, driver_phone)
  on public.repair_orders to authenticated;

-- "Supir: <name>" lines in the notes become the driver (only where no driver is set yet). The first such line with a
-- name moves; a phone number at its end ("Supir: Budi 0812-1234-5678") goes to the phone. The other lines stay as
-- they were (Windows line endings tolerated, blank lines at the start and end trimmed). Check what will move first:
--   select plate, notes from vehicles where driver_name is null and notes ~* '(^|\n)\s*supir\s*:\s*\S';
do $$
declare
  r record; lines text[]; keep text[]; ln text; who text; ph text; picked boolean;
begin
  for r in select id, notes from public.vehicles
           where driver_name is null and notes ~* '(^|\n)[ \t]*supir[ \t]*:[ \t]*\S' for update loop
    lines := regexp_split_to_array(replace(r.notes, E'\r', ''), E'\n');
    keep := '{}'; who := null; ph := null; picked := false;
    foreach ln in array lines loop
      if not picked and ln ~* '^\s*supir\s*:\s*\S' then
        who := btrim(substring(ln from '(?i)^\s*supir\s*:\s*(.*)$'));
        ph := substring(who from '(\+?\d[\d \-]{6,}\d)\s*$');
        if ph is not null then who := btrim(left(who, length(who) - length(substring(who from '(\+?\d[\d \-]{6,}\d\s*)$'))), E' \t-,'); end if;
        picked := true;
      else
        keep := keep || ln;
      end if;
    end loop;
    update public.vehicles
    set driver_name = nullif(left(who, 120), ''),
        driver_phone = coalesce(driver_phone, left(btrim(ph), 40)),
        notes = nullif(btrim(array_to_string(keep, E'\n'), E' \t\n'), '')
    where id = r.id;
  end loop;
end $$;

-- A vehicle sold or moved to another company leaves its driver behind: the new company's fleet manager must not see
-- the old company's driver, and new jobs must not be prefilled with them. (Same as 131 otherwise.)
create or replace function public.transfer_vehicle(p_vehicle uuid, p_to uuid, p_date date default null, p_odometer int default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from uuid;
begin
  if auth.uid() is not null and not has_permission('edit_customers') then raise exception 'Not allowed'; end if;
  select customer_id into v_from from vehicles where id = p_vehicle for update;
  if not found then raise exception 'Vehicle not found'; end if;
  if not exists (select 1 from customers where id = p_to) then raise exception 'Company not found'; end if;
  if v_from = p_to then return; end if;
  -- a deposit belongs to the company that paid it: it can't move to the new owner with the vehicle (131)
  if exists (select 1 from repair_orders r where r.vehicle_id = p_vehicle and r.order_status = 'estimate' and job_deposit(r.id, v_from) > 0) then
    raise exception 'A job on this vehicle has a deposit from the current company. Refund it before transferring the vehicle';
  end if;
  insert into vehicle_transfers (vehicle_id, from_customer_id, to_customer_id, transferred_at, odometer_km, note)
  values (p_vehicle, v_from, p_to, coalesce(p_date, local_date()), p_odometer, p_note);
  update vehicles set customer_id = p_to, mileage_km = coalesce(greatest(mileage_km, p_odometer), mileage_km),
                      driver_name = null, driver_phone = null
  where id = p_vehicle;
  -- open jobs follow the vehicle (their payments, credits and linked appointments follow via triggers)
  update repair_orders set customer_id = p_to where vehicle_id = p_vehicle and order_status = 'estimate';
  -- future appointments not tied to a job move too; ones tied to an invoiced job stay with that job
  update appointments set customer_id = p_to
  where vehicle_id = p_vehicle and ro_id is null and start_time > now() and status not in ('cancelled','no_show') and customer_id is distinct from p_to;
end $$;

-- The driver on an issued invoice is locked like the odometer and recommendations.
create or replace function public.lock_invoice_header() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status = 'invoice' then
    if (new.odometer_in, new.odometer_out, new.recommendations, new.driver_name, new.driver_phone)
       is distinct from (old.odometer_in, old.odometer_out, old.recommendations, old.driver_name, old.driver_phone) then
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

-- Views: the same as before (migrations 129-133) with the driver columns added at the end.
create or replace view public.vehicles_read with (security_barrier = true) as
select t.id, t.customer_id, t.plate, t.make, t.model, t.year, t.vin, t.type, t.fuel_type, t.status, t.mileage_km,
       case when (select public.is_staff()) then t.notes else null::text end as notes,
       t.created_at, t.updated_at, t.driver_name, t.driver_phone
from public.vehicles t
where (select public.is_staff()) or t.customer_id in (select public.fleet_customer_ids());
revoke all on public.vehicles_read from public, anon;
grant select on public.vehicles_read to authenticated;

create or replace view public.repair_orders_read with (security_barrier = true) as
with p as (
  select public.has_permission('view_reports') as money,
         public.has_permission('view_costs') as costs,
         (public.has_permission('view_costs') or public.has_permission('pay_supplier_bills')) as supplier
)
select t.id, t.job_number, t.invoice_number, t.customer_id, t.vehicle_id, t.odometer_in, t.odometer_out, t.order_status,
  case when t.workflow_status = 'paid' and not (p.money or m.works) then 'invoiced' else t.workflow_status end as workflow_status,
  t.priority, t.tags, t.service_advisor_id,
  case when (select public.is_staff()) then t.shop_notes else null::text end as shop_notes,
  t.recommendations, t.print_language, t.invoiced_at,
  case when p.money or m.works then t.due_date else null::date end as due_date,
  t.archived_at, t.faktur_pajak_number, t.bill_to_snapshot, t.shop_snapshot,
  case when p.money or m.works then t.parts_total else null::numeric end as parts_total,
  case when p.money or m.works then t.labor_total else null::numeric end as labor_total,
  case when p.money or m.works then t.other_total else null::numeric end as other_total,
  case when p.money or m.works then t.service_fees_total else null::numeric end as service_fees_total,
  case when p.money or m.works then t.item_discount_total else null::numeric end as item_discount_total,
  case when p.money or m.works then t.service_discount_total else null::numeric end as service_discount_total,
  case when p.money or m.works then t.job_fees_total else null::numeric end as job_fees_total,
  case when p.money or m.works then t.job_discount_total else null::numeric end as job_discount_total,
  case when p.money or m.works then t.subtotal else null::numeric end as subtotal,
  case when p.money or m.works then t.taxable_base else null::numeric end as taxable_base,
  case when p.money or m.works then t.tax_total else null::numeric end as tax_total,
  case when p.money or m.works then t.total else null::numeric end as total,
  case when p.money or m.works then t.paid_total else null::numeric end as paid_total,
  case when p.money or m.works then t.balance else null::numeric end as balance,
  case when p.money or m.works then t.payment_status else null::text end as payment_status,
  t.created_by, t.created_at, t.updated_at, t.job_no, t.invoice_no, t.closed_at, t.close_reason, t.closed_by,
  t.driver_name, t.driver_phone
from public.repair_orders t
  cross join p
  cross join lateral (select case when p.money then false else public.works_on_job(t.id) or public.fleet_job(t.id) end as works) m
where (select public.is_staff()) or t.id in (select public.fleet_job_ids());
revoke all on public.repair_orders_read from public, anon;
grant select on public.repair_orders_read to authenticated;

-- 2. Catalog: alternative part numbers and fitment -----------------------------------------------------------------
alter table public.catalog_items add column if not exists alt_numbers text;
alter table public.catalog_items add column if not exists fits text;
do $$ begin
  alter table public.catalog_items add constraint catalog_items_alt_fits_len check (char_length(alt_numbers) <= 500 and char_length(fits) <= 500);
exception when duplicate_object then null; end $$;
grant select (alt_numbers, fits), insert (alt_numbers, fits), update (alt_numbers, fits) on public.catalog_items to authenticated;

create or replace view public.catalog_items_read with (security_barrier = true) as
with p as (select public.has_permission('view_reports') as money, public.has_permission('view_costs') as costs,
                  public.has_permission('view_costs') or public.has_permission('pay_supplier_bills') as supplier)
select t.id, t.item_type, t.name, t.code, t.description, t.category_id, t.supplier_id, t.brand,
  case when p.costs then t.cost else null::numeric end as cost,
  case when p.money then t.price else null::numeric end as price,
  case when p.costs then t.markup_pct else null::numeric end as markup_pct,
  t.default_qty, t.labor_hours, t.labor_rate_id, t.fee_kind,
  case when p.money then t.fee_value else null::numeric end as fee_value,
  t.taxable, t.show_on_invoice, t.show_qty_price, t.track_inventory, t.qty_on_hand, t.reorder_point, t.has_core,
  case when p.costs then t.core_cost else null::numeric end as core_cost,
  t.tire_size, t.notes, t.active, t.created_at, t.updated_at,
  t.alt_numbers, t.fits
from public.catalog_items t cross join p
where (select public.is_staff());
revoke all on public.catalog_items_read from public, anon;
grant select on public.catalog_items_read to authenticated;
