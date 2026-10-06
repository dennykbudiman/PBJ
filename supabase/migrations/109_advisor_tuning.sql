-- Axle v2 · 109 advisor follow-ups after 108
alter function public.guard_number_sequence() set search_path = public;

-- evaluate auth.uid() once per query instead of once per row
alter policy "mark own notifications read" on public.notifications using (is_staff() and user_id = (select auth.uid()));
alter policy "read own or broadcast notifications" on public.notifications using (is_staff() and (user_id is null or user_id = (select auth.uid())));
alter policy "own profile update" on public.profiles using (id = (select auth.uid())) with check (id = (select auth.uid()));
alter policy "read own profile" on public.profiles using (id = (select auth.uid()));
alter policy "technician updates own inspections" on public.ro_inspections using (technician_id = (select auth.uid())) with check (technician_id = (select auth.uid()));
alter policy "technician updates own services" on public.ro_services using (technician_id = (select auth.uid())) with check (technician_id = (select auth.uid()));

-- index every foreign key that has no covering index (joins, cascades, per-company / per-vehicle lists)
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname, string_agg(quote_ident(a.attname), ', ' order by k.ord) as cols
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid
                      and (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey and array_length(c.conkey,1) <= i.indnkeyatts)
    group by c.conrelid, c.conname
  loop
    execute format('create index if not exists %I on %s (%s)', left(r.conname, 55) || '_idx', r.tbl, r.cols);
  end loop;
end $$;
