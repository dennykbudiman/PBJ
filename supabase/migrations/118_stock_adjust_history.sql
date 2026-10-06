-- 118: Stock adjustments by Owners and Admins, and edit history for every catalog record (decided Oct 6, 2026)
--
-- 1. New permission adjust_stock (Owner and Admin). Stock counts are corrected only through adjust_stock(),
--    which locks the part, works out the difference from the live count and writes it to the stock ledger
--    with the reason typed in. The app can no longer insert "adjustment" rows directly, and "opening" stock
--    is only accepted as a part's very first stock entry.
-- 2. Edit history: categories, inspection points and checklists are now logged like the other catalog
--    records, and changes to their lines (bundle lines, canned notes, checklist points, auto-added fees)
--    are logged against the record they belong to.

insert into public.role_permissions (role_id, permission_key)
select id, 'adjust_stock' from public.roles where name in ('Owner','Admin') on conflict do nothing;

create or replace function public.guard_stock_movement() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  -- current_user is 'authenticated' only for writes coming straight from the app (not from database functions)
  if current_user = 'authenticated' then
    if new.reason <> 'opening' then
      raise exception 'Stock for jobs, deliveries and returns is moved automatically; counts are corrected with Adjust stock';
    end if;
    if exists (select 1 from stock_movements where catalog_item_id = new.catalog_item_id) then
      raise exception 'This part already has stock entries; use Adjust stock to correct the count';
    end if;
  end if;
  return new;
end $$;

create or replace function public.adjust_stock(p_item uuid, p_new_qty numeric, p_note text) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_old numeric; v_track boolean; v_type text; v_new numeric := round(p_new_qty, 2);
begin
  if not has_permission('adjust_stock') then raise exception 'Only an Owner or Admin can adjust stock'; end if;
  if v_new is null or v_new < 0 or v_new > 1000000 then raise exception 'Enter a stock count from 0 to 1.000.000'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'Enter a reason for the adjustment'; end if;
  select qty_on_hand, track_inventory, item_type into v_old, v_track, v_type from catalog_items where id = p_item for update;
  if not found then raise exception 'Part not found'; end if;
  if v_type <> 'part' or not v_track then raise exception 'Stock is not tracked for this item'; end if;
  if v_new = v_old then return v_old; end if;
  insert into stock_movements (catalog_item_id, qty_change, reason, note)
  values (p_item, v_new - v_old, 'adjustment', left(btrim(p_note), 500));
  return v_new;
end $$;
revoke execute on function public.adjust_stock(uuid, numeric, text) from public, anon;
grant execute on function public.adjust_stock(uuid, numeric, text) to authenticated;

-- Parent records not logged before
create trigger log_categories after insert or update or delete on public.categories for each row execute function log_activity();
create trigger log_inspection_items after insert or update or delete on public.inspection_items for each row execute function log_activity();
create trigger log_inspection_checklists after insert or update or delete on public.inspection_checklists for each row execute function log_activity();

-- Line changes, logged against the parent record: TG_ARGV[0] = parent table, TG_ARGV[1] = column holding the parent id
create or replace function public.log_line_activity() returns trigger language plpgsql security definer set search_path = public as $$
declare diff jsonb; v_parent uuid;
begin
  if tg_op = 'DELETE' then v_parent := (to_jsonb(old)->>tg_argv[1])::uuid; else v_parent := (to_jsonb(new)->>tg_argv[1])::uuid; end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value;
    if diff is null then return new; end if;
    insert into activity_log (entity_type, entity_id, action, changes)
    values (tg_argv[0], v_parent, 'line_update', jsonb_build_object('table', tg_table_name, 'row', to_jsonb(new), 'diff', diff));
    return new;
  elsif tg_op = 'INSERT' then
    insert into activity_log (entity_type, entity_id, action, changes)
    values (tg_argv[0], v_parent, 'line_add', jsonb_build_object('table', tg_table_name, 'row', to_jsonb(new)));
    return new;
  else
    insert into activity_log (entity_type, entity_id, action, changes)
    values (tg_argv[0], v_parent, 'line_remove', jsonb_build_object('table', tg_table_name, 'row', to_jsonb(old)));
    return old;
  end if;
end $$;
revoke execute on function public.log_line_activity() from public, anon, authenticated;

create trigger log_service_template_items after insert or update or delete on public.service_template_items
  for each row execute function log_line_activity('service_templates', 'template_id');
create trigger log_inspection_item_notes after insert or update or delete on public.inspection_item_notes
  for each row execute function log_line_activity('inspection_items', 'item_id');
create trigger log_inspection_checklist_items after insert or update or delete on public.inspection_checklist_items
  for each row execute function log_line_activity('inspection_checklists', 'checklist_id');
create trigger log_catalog_item_fees after insert or update or delete on public.catalog_item_fees
  for each row execute function log_line_activity('catalog_items', 'item_id');
