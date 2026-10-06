-- 119: Everything on a job shows in its Activity (decided Oct 6, 2026)
--
-- Concerns, inspections, inspection results and credits applied to / taken off a job were not
-- recorded. They are now logged against the job itself (entity_type 'repair_orders', the job id),
-- as line_add / line_update / line_remove entries naming the table and the row.

-- Concerns and inspections carry the job id directly: the generic line logger from 118 does the work.
create trigger log_ro_concerns after insert or update or delete on public.ro_concerns
  for each row execute function log_line_activity('repair_orders', 'ro_id');
create trigger log_ro_inspections after insert or update or delete on public.ro_inspections
  for each row execute function log_line_activity('repair_orders', 'ro_id');

-- Inspection results belong to an inspection; look up its job.
create or replace function public.log_inspection_result_activity() returns trigger language plpgsql security definer set search_path = public as $$
declare diff jsonb; v_ro uuid; r jsonb;
begin
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  select ro_id into v_ro from ro_inspections where id = (r->>'inspection_id')::uuid;
  if v_ro is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value;
    if diff is null then return new; end if;
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', v_ro, 'line_update', jsonb_build_object('table', 'ro_inspection_results', 'row', r, 'diff', diff));
    return new;
  end if;
  insert into activity_log (entity_type, entity_id, action, changes)
  values ('repair_orders', v_ro, case when tg_op = 'INSERT' then 'line_add' else 'line_remove' end, jsonb_build_object('table', 'ro_inspection_results', 'row', r));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function public.log_inspection_result_activity() from public, anon, authenticated;
create trigger log_ro_inspection_results after insert or update or delete on public.ro_inspection_results
  for each row execute function log_inspection_result_activity();

-- Credits: applying one to a job (or taking it off) is logged on that job.
create or replace function public.log_credit_job_activity() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.applied_ro_id is not null
     and (tg_op = 'DELETE' or new.applied_ro_id is distinct from old.applied_ro_id) then
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', old.applied_ro_id, 'line_remove', jsonb_build_object('table', 'credit_memos', 'row', to_jsonb(old)));
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.applied_ro_id is not null
     and (tg_op = 'INSERT' or new.applied_ro_id is distinct from old.applied_ro_id) then
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', new.applied_ro_id, 'line_add', jsonb_build_object('table', 'credit_memos', 'row', to_jsonb(new)));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function public.log_credit_job_activity() from public, anon, authenticated;
create trigger log_credit_job after insert or update of applied_ro_id or delete on public.credit_memos
  for each row execute function log_credit_job_activity();
