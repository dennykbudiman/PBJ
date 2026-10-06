-- Axle v2 · 104 security: row-level security on every table + storage buckets
-- v1 rule: active staff can read everything; edits are permission-gated by area. Detailed access is designed later in Settings.
do $$
declare t text; perm text;
  rules text[][] := array[
    array['customers','edit_customers'], array['customer_contacts','edit_customers'], array['vehicles','edit_customers'],
    array['vehicle_transfers','edit_customers'], array['service_schedules','edit_customers'],
    array['categories','edit_catalog'], array['suppliers','edit_catalog'], array['catalog_items','edit_catalog'],
    array['catalog_item_fees','edit_catalog'], array['discounts','edit_catalog'], array['inspection_items','edit_catalog'],
    array['inspection_item_notes','edit_catalog'], array['inspection_checklists','edit_catalog'], array['inspection_checklist_items','edit_catalog'],
    array['service_templates','edit_catalog'], array['service_template_items','edit_catalog'], array['labor_rates','edit_settings'],
    array['repair_orders','edit_jobs'], array['ro_concerns','edit_jobs'], array['ro_services','edit_jobs'], array['ro_service_items','edit_jobs'],
    array['ro_job_fees','edit_jobs'], array['ro_job_discounts','edit_jobs'], array['approvals','edit_jobs'],
    array['ro_inspections','edit_jobs'], array['ro_inspection_results','edit_jobs'], array['appointments','edit_jobs'],
    array['attachments','edit_jobs'],
    array['payments','record_payments'], array['credit_memos','record_payments'],
    array['purchase_orders','manage_inventory'], array['purchase_order_items','manage_inventory'], array['supplier_payments','manage_inventory'],
    array['stock_movements','manage_inventory'], array['returns','manage_inventory'], array['cores','manage_inventory'],
    array['shop_settings','edit_settings'], array['number_sequences','edit_settings'],
    array['roles','manage_users'], array['role_permissions','manage_users']];
  i int;
begin
  for i in 1 .. array_length(rules, 1) loop
    t := rules[i][1]; perm := rules[i][2];
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "staff read %1$s" on public.%1$I for select using (is_staff())', t);
    execute format('create policy "edit %1$s" on public.%1$I for all using (has_permission(%2$L)) with check (has_permission(%2$L))', t, perm);
  end loop;
end $$;

-- Technicians may update their own services and inspections without edit_jobs
create policy "technician updates own services" on public.ro_services for update using (technician_id = auth.uid()) with check (technician_id = auth.uid());
create policy "technician updates own inspections" on public.ro_inspections for update using (technician_id = auth.uid()) with check (technician_id = auth.uid());
-- Deleting jobs needs delete_jobs (overrides the general edit policy for delete)
create policy "delete jobs" on public.repair_orders as restrictive for delete using (has_permission('delete_jobs'));
-- Invoiced jobs can't be deleted at all
create policy "no delete invoiced" on public.repair_orders as restrictive for delete using (order_status = 'estimate');

alter table public.profiles enable row level security;
create policy "staff read profiles" on public.profiles for select using (is_staff());
create policy "own profile update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
-- only user managers may change someone's role or status (also blocks self-promotion)
create or replace function public.protect_profile_role() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and (new.role_id is distinct from old.role_id or new.status is distinct from old.status)
     and not has_permission('manage_users') then
    raise exception 'Only user managers can change roles or status';
  end if;
  return new;
end $$;
create trigger profiles_protect_role before update on public.profiles for each row execute function protect_profile_role();
create policy "manage users" on public.profiles for all using (has_permission('manage_users')) with check (has_permission('manage_users'));

alter table public.activity_log enable row level security;
create policy "staff read activity" on public.activity_log for select using (is_staff());

alter table public.notifications enable row level security;
create policy "read own or broadcast notifications" on public.notifications for select using (is_staff() and (user_id is null or user_id = auth.uid()));
create policy "mark own notifications read" on public.notifications for update using (is_staff() and (user_id is null or user_id = auth.uid()));

-- Storage: public bucket for the shop logo, private bucket for job photos/attachments
insert into storage.buckets (id, name, public) values ('shop-assets', 'shop-assets', true), ('attachments', 'attachments', false)
on conflict (id) do nothing;
create policy "logo upload" on storage.objects for insert with check (bucket_id = 'shop-assets' and public.has_permission('edit_settings'));
create policy "logo update" on storage.objects for update using (bucket_id = 'shop-assets' and public.has_permission('edit_settings'));
create policy "attachments read" on storage.objects for select using (bucket_id = 'attachments' and public.is_staff());
create policy "attachments write" on storage.objects for insert with check (bucket_id = 'attachments' and public.is_staff());
create policy "attachments delete" on storage.objects for delete using (bucket_id = 'attachments' and public.has_permission('edit_jobs'));

-- next_number / functions are security definer; only staff may call them from the app
revoke execute on function public.next_number(text) from anon, public;
grant execute on function public.next_number(text) to authenticated;
revoke execute on function public.convert_to_invoice(uuid), public.transfer_vehicle(uuid,uuid,date,int,text),
  public.mark_po_items_delivered(uuid[],date,text,date,date), public.mark_po_items_cancelled(uuid[]), public.recalc_repair_order(uuid) from anon, public;
grant execute on function public.convert_to_invoice(uuid), public.transfer_vehicle(uuid,uuid,date,int,text),
  public.mark_po_items_delivered(uuid[],date,text,date,date), public.mark_po_items_cancelled(uuid[]), public.recalc_repair_order(uuid) to authenticated;
