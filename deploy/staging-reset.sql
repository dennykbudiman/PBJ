-- Axle v2 · empty the STAGING database for a fresh rehearsal (migration 129 release tools; guard from 131)
--
-- Removes every company, vehicle, job, invoice, payment, credit, appointment, schedule, catalog item, supplier, purchase
-- order, return, core, stock entry, notification and history entry, and starts the job, invoice and PO numbers again
-- from 100001, INV-000001 and 1. Keeps: people and their logins, roles and permissions, shop settings (name, logo,
-- tax, opening hours...) and labor rates.
--
-- How to run (Supabase → the STAGING project "Axle v2 staging" → SQL Editor):
--   1. Paste this whole file.
--   2. Change REPLACE-ME on the first line below to the staging project's reference: wuwabhwvnzhlcctxwpda
--      (it is in the address bar: supabase.com/dashboard/project/<reference>).
--   3. Run. It says "Staging emptied" when done.
-- It also only runs on a database marked as staging (migration 131), so pasting it into the live project's SQL Editor
-- by mistake does nothing. Staging is marked once, after migration 131:
--   insert into public.app_environment (name) values ('staging');
-- The live project is marked 'production' at go-live, and a marker can't be changed afterwards.
-- Files attached to jobs (bucket "attachments") are not removed by SQL: delete the "jobs" and "payments" folders in
-- Storage → attachments if you want those gone too.

select set_config('axle.reset_project', 'REPLACE-ME', false);

do $$
begin
  if current_setting('axle.reset_project', true) is distinct from 'wuwabhwvnzhlcctxwpda' then
    raise exception 'Not run: type the staging project reference (wuwabhwvnzhlcctxwpda) in place of REPLACE-ME on the first line.';
  end if;
  if to_regclass('public.app_environment') is null then
    raise exception 'Not run: this database does not have migration 131 yet.';
  end if;
  if not exists (select 1 from public.app_environment where name = 'staging') then
    raise exception 'Not run: this database is not marked as staging (it is marked %). Only the staging project can be emptied.',
      coalesce((select name from public.app_environment), 'as nothing');
  end if;

  -- TRUNCATE skips the row rules (invoiced jobs can't be deleted one by one), and CASCADE follows every link.
  truncate table
    public.activity_log, public.notification_reads, public.notifications, public.attachments, public.login_attempts,
    public.payments, public.credit_memos, public.invoice_voids, public.approvals, public.deferred_dismissals,
    public.ro_inspection_results, public.ro_inspections, public.ro_concerns, public.ro_job_discounts, public.ro_job_fees,
    public.ro_service_items, public.ro_services, public.appointments, public.service_schedule_log, public.repair_orders,
    public.cores, public.returns, public.supplier_payments, public.purchase_order_items, public.purchase_orders,
    public.stock_movements, public.service_schedules, public.vehicle_transfers, public.vehicles, public.customer_contacts,
    public.customers, public.service_template_items, public.service_templates, public.catalog_item_fees, public.catalog_items,
    public.categories, public.discounts, public.inspection_checklist_items, public.inspection_checklists,
    public.inspection_item_notes, public.inspection_items, public.suppliers, public.app_runs
  cascade;

  -- Numbers start again (the counter guard only lets numbers move forward, so it is paused for this one change).
  alter table public.number_sequences disable trigger user;
  update public.number_sequences set next_value = case name when 'job' then 100001 when 'invoice' then 1 when 'stock_po' then 1 else next_value end;
  alter table public.number_sequences enable trigger user;

  raise notice 'Staging emptied';
end $$;

select case when exists (select 1 from public.app_environment where name = 'staging') then 'Staging emptied' else 'Not run' end as result,
       (select count(*) from public.repair_orders) as jobs_left,
       (select count(*) from public.customers) as companies_left,
       (select count(*) from public.profiles) as people_kept,
       (select json_object_agg(name, next_value) from public.number_sequences) as next_numbers;
