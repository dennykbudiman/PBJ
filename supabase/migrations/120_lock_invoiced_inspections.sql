-- 120: Inspections are locked once the job is invoiced (decided Oct 6, 2026)
--
-- Like services, lines, fees and concerns, an invoiced job's inspections and their results
-- can't be added, changed or deleted. Void the invoice to correct them.

create or replace function public.lock_invoiced_inspection() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ro uuid; v_status text;
begin
  if tg_table_name = 'ro_inspection_results' then
    select ro_id into v_ro from ro_inspections
    where id = (case when tg_op = 'DELETE' then old.inspection_id else new.inspection_id end);
    -- a result moved to another inspection: check the one it leaves too
    if tg_op = 'UPDATE' and new.inspection_id is distinct from old.inspection_id then
      select order_status into v_status from repair_orders r join ro_inspections i on i.ro_id = r.id where i.id = old.inspection_id;
      if v_status = 'invoice' then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
    end if;
  else
    v_ro := case when tg_op = 'DELETE' then old.ro_id else new.ro_id end;
    if tg_op = 'UPDATE' and new.ro_id is distinct from old.ro_id then
      select order_status into v_status from repair_orders where id = old.ro_id;
      if v_status = 'invoice' then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
    end if;
  end if;
  select order_status into v_status from repair_orders where id = v_ro;
  if v_status = 'invoice' then raise exception 'This job is invoiced. Void the invoice to make changes.'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function public.lock_invoiced_inspection() from public, anon, authenticated;

create trigger lock_ro_inspections before insert or update or delete on public.ro_inspections
  for each row execute function lock_invoiced_inspection();
create trigger lock_ro_inspection_results before insert or update or delete on public.ro_inspection_results
  for each row execute function lock_invoiced_inspection();
