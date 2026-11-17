-- 151: fixes from the 17 Nov report review (claude/report-review-2026-11-17.md), Denny 18 Nov "lets just do everything".
-- Decisions (18 Nov): no core charge on customers' invoices; the shop's discounts come off the shop's share only;
-- a package price is always charged; a PT's own leftover part counts as paid by that PT.
-- Runs twice cleanly (patches check what they already did). No drum rebuild here: existing drum use stays as it is.

-- ============================================================================================================
-- 151 A. Km, service schedules, drums
-- ============================================================================================================

-- ---------- A1 (review 103, 45, 46). A job's km reaches the truck as soon as it is typed (not only when a service
-- is ticked done). A lowered reading (a typo fixed) takes the truck back to its highest other reading, when the truck's
-- km came from this job; completed services of the job and their schedules follow the job's km.
create or replace function public.job_km_follows() returns trigger language plpgsql security definer set search_path = public as $$
declare v_new int; v_old int; v_veh int; v_best int; l record; s service_schedules%rowtype; first_l service_schedule_log%rowtype;
        last_l service_schedule_log%rowtype; v_km int;
begin
  v_new := coalesce(new.odometer_out, new.odometer_in);
  v_old := case when tg_op = 'UPDATE' then coalesce(old.odometer_out, old.odometer_in) end;
  if tg_op = 'UPDATE' and v_new is not distinct from v_old then return null; end if;
  if new.vehicle_id is null then return null; end if;
  if v_new is not null then
    update vehicles set mileage_km = v_new where id = new.vehicle_id and coalesce(mileage_km, 0) < v_new;
  end if;
  if v_old is not null and (v_new is null or v_new < v_old) then
    select mileage_km into v_veh from vehicles where id = new.vehicle_id;
    if v_veh = v_old then
      select max(x) into v_best from (
        select greatest(coalesce(r.odometer_in, 0), coalesce(r.odometer_out, 0)) as x from repair_orders r
         where r.vehicle_id = new.vehicle_id and r.id <> new.id
        union all select v_new
        union all select o.km from oil_preapp o where o.vehicle_id = new.vehicle_id
        union all select t.odometer_km from vehicle_transfers t where t.vehicle_id = new.vehicle_id) q;
      update vehicles set mileage_km = nullif(v_best, 0) where id = new.vehicle_id;
    end if;
  end if;
  -- the job's completed services count at the job's km (the schedule log keeps what each one set)
  for l in select * from service_schedule_log where ro_id = new.id and done_km is distinct from v_new loop
    update service_schedule_log set done_km = v_new where id = l.id;
    continue when l.schedule_id is null;
    select * into s from service_schedules where id = l.schedule_id for update;
    continue when not found;
    select * into first_l from service_schedule_log where schedule_id = s.id order by seq limit 1;
    select * into last_l from service_schedule_log where schedule_id = s.id order by seq desc limit 1;
    -- changed by hand since (or tracked before 131): left alone
    continue when last_l.set_date is null or s.last_done_km is distinct from last_l.set_km;
    select max(x) into v_km from (select first_l.prev_km as x union all select done_km from service_schedule_log where schedule_id = s.id) q;
    update service_schedules set last_done_km = v_km where id = s.id;
    update service_schedule_log set set_km = v_km where id = last_l.id;
  end loop;
  return null;
end $$;
revoke execute on function public.job_km_follows() from public, anon, authenticated;
drop trigger if exists repair_orders_km_follows on public.repair_orders;
create trigger repair_orders_km_follows after insert or update of odometer_in, odometer_out on public.repair_orders
  for each row execute function public.job_km_follows();

-- on_service_completed (131): a service done without a km reading no longer counts at the truck's old km (it keeps the
-- schedule's last km; the job's km moves it once typed, above). A new schedule may still start from the truck's km.
-- A schedule with no package that has the service's (or its package's) name is used instead of starting a second one
-- (review 118), and gets the package.
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.on_service_completed()'::regprocedure);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 km%' then
    v_def := replace(v_def,
      $a$km := coalesce(ro.odometer_out, ro.odometer_in, (select mileage_km from vehicles where id = ro.vehicle_id));$a$,
      $b$km := coalesce(ro.odometer_out, ro.odometer_in);   -- 151 km: the job's own reading only$b$);
    v_def := replace(v_def,
      $a$      v_months := case when tp.default_interval_months between 1 and 120 then tp.default_interval_months end;
      if km is null then v_km := null; end if;$a$,
      $b$      v_months := case when tp.default_interval_months between 1 and 120 then tp.default_interval_months end;
      -- a schedule with no package and the same name (e.g. the "Ganti oli mesin" schedules made by the imports) is
      -- this one: it gets the package instead of a second schedule starting (151)
      v_tp := found;
      if v_tp then
        select ss.id into new.service_schedule_id from service_schedules ss
         where ss.vehicle_id = ro.vehicle_id and ss.active and ss.template_id is null
           and lower(regexp_replace(btrim(ss.name), '\s+', ' ', 'g')) in (lower(regexp_replace(btrim(tp.name), '\s+', ' ', 'g')),
                                                                          lower(regexp_replace(btrim(new.name), '\s+', ' ', 'g')))
         order by ss.created_at limit 1;
        if new.service_schedule_id is not null then
          update service_schedules set template_id = tp.id where id = new.service_schedule_id
            and not exists (select 1 from service_schedules x where x.vehicle_id = ro.vehicle_id and x.template_id = tp.id and x.active);
        end if;
      end if;
      -- a new schedule may start from the truck's km when the job has none
      if km is null then km := (select mileage_km from vehicles where id = ro.vehicle_id); end if;
      if km is null then v_km := null; end if;$b$);
    v_def := replace(v_def,
      $a$      if found and (v_km is not null or v_months is not null)$a$,
      $b$      if v_tp and new.service_schedule_id is null and (v_km is not null or v_months is not null)$b$);
    v_def := replace(v_def, 'v_set_km int; v_set_date date;', 'v_set_km int; v_set_date date; v_tp boolean;');
    -- the km a new schedule started from is only for starting it; progress on an existing one uses the job's km
    v_def := replace(v_def,
      $a$  if new.service_schedule_id is not null then
    if not v_started then$a$,
      $b$  if not v_started then km := coalesce(ro.odometer_out, ro.odometer_in); end if;
  if new.service_schedule_id is not null then
    if not v_started then$b$);
    if v_def not like '%151 km%' or v_def not like '%gets the package instead%' or v_def not like '%if not v_started then km :=%' or v_def not like '%v_tp boolean;%' then
      raise exception '151: on_service_completed did not patch';
    end if;
    execute v_def;
  end if;
end $do$;

-- link_service_schedule: a service with a package also links to a no-package schedule of the same name (151, review 118)
create or replace function public.link_service_schedule() returns trigger language plpgsql security definer set search_path = public as $$
declare v_veh uuid; v_tname text;
begin
  if new.service_schedule_id is null and new.template_id is not null then
    select r.vehicle_id into v_veh from repair_orders r where r.id = new.ro_id;
    select ss.id into new.service_schedule_id from service_schedules ss
     where ss.vehicle_id = v_veh and ss.template_id = new.template_id and ss.active limit 1;
    if new.service_schedule_id is null then
      select name into v_tname from service_templates where id = new.template_id;
      select ss.id into new.service_schedule_id from service_schedules ss
       where ss.vehicle_id = v_veh and ss.active and ss.template_id is null
         and lower(regexp_replace(btrim(ss.name), '\s+', ' ', 'g')) in (lower(regexp_replace(btrim(coalesce(v_tname, '')), '\s+', ' ', 'g')),
                                                                        lower(regexp_replace(btrim(coalesce(new.name, '')), '\s+', ' ', 'g')))
       order by ss.created_at limit 1;
      if new.service_schedule_id is not null then
        update service_schedules set template_id = new.template_id where id = new.service_schedule_id;
      end if;
    end if;
  end if;
  return new;
end $$;

-- ---------- A2. Drums
-- 53: setting or moving a drum's habis date re-sorts its oil too (drum_pick uses it since 150)
drop trigger if exists oil_drums_drum_use_change on public.oil_drums;
create trigger oil_drums_drum_use_change after update of catalog_item_id, litres, opened_on, emptied_on on public.oil_drums
  for each row when (new.catalog_item_id is distinct from old.catalog_item_id or new.litres is distinct from old.litres
                     or new.opened_on is distinct from old.opened_on or new.emptied_on is distinct from old.emptied_on)
  execute function public.drum_use_follows_drums();

-- 124: oil on a shop-billed invoice (the shop sold it from its own stock) goes on a drum only if that drum was in the
-- app when the invoice was made; recording or back-dating a drum later doesn't pull it in. PT-paid invoices (the oil
-- counted as the PT's) still follow the drums by date.
-- (a function of its own, so drum_pick(uuid, date, numeric) stays as it is)
create or replace function public.drum_pick_known(p_item uuid, p_day date, p_need numeric, p_known_by timestamptz,
                                            out drum_id uuid, out litres numeric)
returns setof record language plpgsql stable security definer set search_path = public as $$
declare d record; v_need numeric := p_need; v_take numeric; v_left numeric; v_last uuid; v_dated boolean;
begin
  v_dated := exists (select 1 from oil_drums od where od.catalog_item_id = p_item and od.opened_on <= p_day
                       and (od.emptied_on is null or od.emptied_on >= p_day)
                       and (p_known_by is null or od.created_at <= p_known_by));
  for d in select od.id, od.litres - coalesce((select sum(u.litres) from drum_use u where u.drum_id = od.id), 0) as left_l
             from oil_drums od
            where od.catalog_item_id = p_item
              and (p_known_by is null or od.created_at <= p_known_by)
              and (not v_dated or (od.opened_on <= p_day and (od.emptied_on is null or od.emptied_on >= p_day)))
            order by od.opened_on, od.created_at, od.id loop
    v_last := d.id;
    exit when v_need <= 0;
    v_left := greatest(d.left_l, 0);
    if v_left > 0 then
      v_take := least(v_need, v_left);
      drum_id := d.id; litres := v_take; return next;
      v_need := v_need - v_take;
    end if;
  end loop;
  if v_need > 0 and v_last is not null then
    drum_id := v_last; litres := v_need; return next;
  end if;
end $$;
revoke execute on function public.drum_pick_known(uuid, date, numeric, timestamptz) from public, anon, authenticated;

-- drum_take: 124 as above; 117: litres the job line got through its own PO (delivered, not returned) didn't come
-- out of a drum, so only the rest is taken from the drums.
create or replace function public.drum_take(p_line uuid) returns void language plpgsql security definer set search_path = public as $$
declare l record; x record; v_day date; v_po numeric; v_need numeric; v_by timestamptz;
begin
  delete from drum_use where line_id = p_line;
  select i.id, i.catalog_item_id, i.qty, i.po_item_id, r.id as ro_id, r.invoiced_at into l
    from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders r on r.id = s.ro_id
   where i.id = p_line and i.item_type = 'part' and i.stock_deducted and i.qty > 0 and r.order_status = 'invoice';
  if not found or l.catalog_item_id is null then return; end if;
  v_day := (l.invoiced_at at time zone shop_tz())::date;
  select coalesce(sum(greatest(pi.qty_delivered - po_qty_returned(pi.id), 0)), 0) into v_po
    from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
   where (pi.ro_service_item_id = l.id or pi.id = l.po_item_id) and po.status <> 'cancelled' and pi.qty_delivered > 0;
  v_need := l.qty - v_po;
  if v_need <= 0 then return; end if;
  if (select payer from ro_payer_book(l.ro_id)) is null then v_by := l.invoiced_at; end if;
  if not exists (select 1 from oil_drums where catalog_item_id = l.catalog_item_id and opened_on <= v_day
                   and (v_by is null or created_at <= v_by)) then
    return;
  end if;
  for x in select * from drum_pick_known(l.catalog_item_id, v_day, v_need, v_by) loop
    insert into drum_use (drum_id, line_id, ro_id, catalog_item_id, litres) values (x.drum_id, l.id, l.ro_id, l.catalog_item_id, x.litres)
    on conflict (line_id, drum_id) do update set litres = drum_use.litres + excluded.litres;
  end loop;
end $$;
revoke execute on function public.drum_take(uuid) from public, anon, authenticated;

-- ============================================================================================================
-- 151 B. Drum money and the monthly bills
-- ============================================================================================================

-- ---------- B1. Drum guards
-- 125/126/81/69: a drum with recorded payments can't be deleted or moved to another oil; one that has oil on it can
-- only be deleted by the Owner/Admin; once paid, only the Owner/Admin changes its litres, price, dates or owner.
-- The paying PT must be a PT the app knows (a typo like "PT. Baru" for "PT Baru" made a PT owe its own drum).
create or replace function public.check_oil_drum() returns trigger language plpgsql security definer set search_path = public as $$
declare v_paid boolean;
begin
  new.paid_by_name := btrim(new.paid_by_name);
  new.paid_by_book := nullif(regexp_replace(btrim(coalesce(new.paid_by_book, '')), '\s+', ' ', 'g'), '');
  new.note := nullif(btrim(new.note), '');
  if not exists (select 1 from catalog_items where id = new.catalog_item_id and item_type = 'part' and track_inventory) then
    raise exception 'A drum is a stocked part (e.g. a bulk oil)';
  end if;
  if new.po_item_id is not null and not exists (select 1 from purchase_order_items where id = new.po_item_id and catalog_item_id = new.catalog_item_id) then
    raise exception 'The PO line is a different part';
  end if;
  if (tg_op = 'INSERT' or new.paid_by_name is distinct from old.paid_by_name) and nullif(new.paid_by_name, '') is not null then
    if not exists (select 1 from customers c where payer_key(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)) = payer_key(new.paid_by_name)) then
      raise exception 'Unknown PT "%": pick the PT from the list (PT pembayar of a company)', new.paid_by_name;
    end if;
    new.paid_by_name := canon_payer(new.paid_by_name);
  end if;
  if new.paid_by_book is not null and (tg_op = 'INSERT' or new.paid_by_book is distinct from old.paid_by_book or new.paid_by_name is distinct from old.paid_by_name)
     and not book_in_payer(new.paid_by_name, new.paid_by_book) then
    raise exception 'That book isn''t one of this PT''s books (Pembukuan of its companies)';
  end if;
  if tg_op = 'UPDATE' then
    v_paid := exists (select 1 from drum_debt_payments where drum_id = old.id);
    if v_paid and new.catalog_item_id is distinct from old.catalog_item_id then
      raise exception 'This drum has payments recorded (Tandai lunas); it can''t be moved to another oil';
    end if;
    if v_paid and auth.uid() is not null and not is_owner_or_admin()
       and (new.litres, new.cost_per_l, new.opened_on, new.emptied_on, new.paid_by_name, new.paid_by_book)
           is distinct from (old.litres, old.cost_per_l, old.opened_on, old.emptied_on, old.paid_by_name, old.paid_by_book) then
      raise exception 'This drum has payments recorded; only the Owner or an Admin can change its litres, price, dates or owner';
    end if;
  end if;
  return new;
end $$;
create or replace function public.guard_drum_delete() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from drum_debt_payments where drum_id = old.id) then
    raise exception 'This drum has payments recorded (Tandai lunas); remove those first';
  end if;
  if auth.uid() is not null and not is_owner_or_admin() and exists (select 1 from drum_use where drum_id = old.id) then
    raise exception 'Only the Owner or an Admin can delete a drum that has oil on it';
  end if;
  return old;
end $$;
revoke execute on function public.guard_drum_delete() from public, anon, authenticated;
drop trigger if exists oil_drums_no_delete_paid on public.oil_drums;
create trigger oil_drums_no_delete_paid before delete on public.oil_drums for each row execute function public.guard_drum_delete();

-- 126: a bulk oil that has drums keeps "stock tracked" on
create or replace function public.guard_drum_oil_tracking() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not new.track_inventory and old.track_inventory and exists (select 1 from oil_drums where catalog_item_id = new.id) then
    raise exception 'This oil has drums; it stays a stocked part';
  end if;
  return new;
end $$;
revoke execute on function public.guard_drum_oil_tracking() from public, anon, authenticated;
drop trigger if exists catalog_drum_oil_tracking on public.catalog_items;
create trigger catalog_drum_oil_tracking before update of track_inventory on public.catalog_items
  for each row execute function public.guard_drum_oil_tracking();

-- 82: drum payments are logged (who recorded or removed what)
drop trigger if exists log_drum_debt_payments on public.drum_debt_payments;
create trigger log_drum_debt_payments after insert or delete or update on public.drum_debt_payments
  for each row execute function public.log_activity();

-- ---------- B2 (129). Tandai lunas: one at a time per drum, never more than is still open for that book
create or replace function public.drum_book_open(p_drum uuid, p_payer text, p_book text) returns numeric
language sql stable security definer set search_path = public as $$
  -- the shop (payer null) owes for oil its own customers took: every shop-billed invoice, whatever its book
  select greatest(round(case when p_payer is null then
                          coalesce((select sum(u.litres) from drum_use u join repair_orders r on r.id = u.ro_id cross join lateral ro_payer_book(r.id) pb
                                     where u.drum_id = d.id and r.order_status = 'invoice' and pb.payer is null), 0)
                          + coalesce((select sum(u.litres) from drum_use u join oil_preapp o on o.id = u.preapp_id
                                       where u.drum_id = d.id and o.payer is null), 0)
                        else drum_book_litres(d.id, p_payer, p_book) end * d.cost_per_l)
                  - coalesce((select sum(p.amount) from drum_debt_payments p where p.drum_id = d.id
                                and payer_key(p.payer) is not distinct from payer_key(p_payer)
                                and payer_key(p.book) is not distinct from payer_key(p_book)), 0), 0)
    from oil_drums d where d.id = p_drum
$$;
revoke execute on function public.drum_book_open(uuid, text, text) from public, anon, authenticated;

do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.drum_mark_paid'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 lock%' then
    v_def := replace(v_def, $a$  select * into d from oil_drums where id = p_drum;$a$,
                            $b$  select * into d from oil_drums where id = p_drum for update;   -- 151 lock: one payment at a time$b$);
    v_def := replace(v_def, $a$  insert into drum_debt_payments$a$,
      $b$  if round(p_amount) > drum_book_open(p_drum, nullif(btrim(p_payer), ''), case when nullif(btrim(p_payer), '') is not null then nullif(btrim(p_book), '') end) then
    raise exception 'That is more than this book still owes for this drum (Rp %)',
      drum_book_open(p_drum, nullif(btrim(p_payer), ''), case when nullif(btrim(p_payer), '') is not null then nullif(btrim(p_book), '') end);
  end if;
  insert into drum_debt_payments$b$);
    if v_def not like '%151 lock%' or v_def not like '%still owes for this drum%' then raise exception '151: drum_mark_paid did not patch'; end if;
    execute v_def;
  end if;
end $do$;

-- ---------- B3 (135, 134). Drum statement: one group per PT · book however it is spelled; old (pre-app) oil and what
-- of it is paid (payments go to the oldest oil first), so the old-oil bill can show what's still open.
create or replace function public.drum_statement(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if auth.uid() is not null and not (is_staff() and (has_permission('view_costs') or has_permission('pay_supplier_bills'))) then
    raise exception 'Not allowed';
  end if;
  with u as (
    select u.drum_id, u.ro_id, u.litres, r.invoice_no, r.job_number, (r.invoiced_at at time zone shop_tz())::date as day,
           v.plate, c.display_name as company, pb.payer, pb.book, false as preapp, null::int as km
      from drum_use u join repair_orders r on r.id = u.ro_id join customers c on c.id = r.customer_id
      left join vehicles v on v.id = r.vehicle_id
      cross join lateral ro_payer_book(r.id) pb
     where r.order_status = 'invoice'
    union all
    select u.drum_id, null::uuid, u.litres, null::text, null::bigint, o.done_on,
           v.plate, c.display_name, o.payer, o.book, true, o.km
      from drum_use u join oil_preapp o on o.id = u.preapp_id join customers c on c.id = o.customer_id
      left join vehicles v on v.id = o.vehicle_id),
  deb as (
    select u.drum_id, payer_key(u.payer) as pk, case when u.payer is null then null else payer_key(u.book) end as bk,
           min(u.payer) as payer, case when min(u.payer) is null then null else min(u.book) end as book,
           sum(u.litres) as litres_all,
           coalesce(sum(u.litres) filter (where u.preapp), 0) as old_litres,
           jsonb_agg(jsonb_build_object('ro_id', u.ro_id, 'invoice_no', u.invoice_no, 'job_number', u.job_number, 'day', u.day,
                                        'plate', u.plate, 'company', u.company, 'litres', u.litres, 'preapp', u.preapp, 'km', u.km)
                     order by u.day, u.preapp desc, u.invoice_no, u.plate) filter (where (p_from is null or u.day >= p_from) and (p_to is null or u.day <= p_to)) as lines,
           coalesce(sum(u.litres) filter (where (p_from is null or u.day >= p_from) and (p_to is null or u.day <= p_to)), 0) as litres
      from u group by 1, 2, 3)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'catalog_item_id', d.catalog_item_id, 'oil', ci.name, 'unit', ci.unit,
           'payer', canon_payer(d.paid_by_name), 'book', d.paid_by_book, 'litres', d.litres, 'cost_per_l', d.cost_per_l,
           'estimated', d.cost_estimated, 'opened_on', d.opened_on, 'note', d.note, 'emptied_on', d.emptied_on,
           'used', coalesce((select sum(x.litres_all) from deb x where x.drum_id = d.id), 0),
           'left', d.litres - coalesce((select sum(x.litres_all) from deb x where x.drum_id = d.id), 0),
           'debtors', coalesce((select jsonb_agg(jsonb_build_object(
                 'payer', x.payer, 'book', x.book, 'owes', drum_owes(d.paid_by_name, d.paid_by_book, x.payer, x.book),
                 'litres', x.litres, 'amount', round(x.litres * d.cost_per_l),
                 'litres_all', x.litres_all, 'owed_all', round(x.litres_all * d.cost_per_l),
                 'paid', coalesce(pp.paid, 0),
                 'open', case when drum_owes(d.paid_by_name, d.paid_by_book, x.payer, x.book)
                              then greatest(round(x.litres_all * d.cost_per_l) - coalesce(pp.paid, 0), 0) else 0 end,
                 -- old oil (before the app): its own one-time bill; payments cover the oldest oil first
                 'old_litres', x.old_litres, 'old_amount', round(x.old_litres * d.cost_per_l),
                 'old_paid', least(coalesce(pp.paid, 0), round(x.old_litres * d.cost_per_l)),
                 'old_open', case when drum_owes(d.paid_by_name, d.paid_by_book, x.payer, x.book)
                                  then greatest(round(x.old_litres * d.cost_per_l) - coalesce(pp.paid, 0), 0) else 0 end,
                 'lines', coalesce((select jsonb_agg(l || jsonb_build_object('amount', round((l->>'litres')::numeric * d.cost_per_l)))
                                      from jsonb_array_elements(coalesce(x.lines, '[]')) l), '[]'),
                 'payments', coalesce(pp.list, '[]'))
               order by drum_owes(d.paid_by_name, d.paid_by_book, x.payer, x.book) desc, x.payer nulls last, x.book)
             from deb x
             left join lateral (
               select sum(p.amount) as paid,
                      jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method,
                                                   'reference', p.reference, 'by', (select name from profiles where id = p.recorded_by))
                                order by p.paid_on, p.created_at) as list
                 from drum_debt_payments p
                where p.drum_id = d.id and payer_key(p.payer) is not distinct from x.pk
                  and payer_key(p.book) is not distinct from x.bk) pp on true
            where x.drum_id = d.id), '[]'))
         order by ci.name, d.opened_on, d.created_at), '[]')
    into out
    from oil_drums d join catalog_items ci on ci.id = d.catalog_item_id;
  return jsonb_build_object('from', p_from, 'to', p_to, 'drums', out);
end $$;

-- ---------- B4 (58). Drum tab: who used the oil comes from the invoice (as on the bills), not the company today
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.drum_report'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 invoice book%' then
    v_def := replace(v_def,
      $a$           case when (select c0.paid_direct from customers c0 where c0.id = r.customer_id) then payer_of(r.customer_id) end as payer,
           book_of(r.customer_id) as book, u.litres,$a$,
      $b$           (select pb.payer from ro_payer_book(r.id) pb) as payer,   -- 151 invoice book
           (select pb.book from ro_payer_book(r.id) pb) as book, u.litres,$b$);
    if v_def not like '%151 invoice book%' then raise exception '151: drum_report did not patch'; end if;
    execute v_def;
  end if;
end $do$;

-- ---------- B5. Tagihan bulanan (book_statement) and Tagihan PT (pt_supplier_bills)
-- 10/58: a job's PO parts go to the book on the job's invoice (as the invoice and its drum oil do), not the company's
--   book today; an open job still follows its company.
-- 1: "per drum habis": a use is billed in the period of the later of the drum's habis day and its invoice day, so oil
--   invoiced after a drum was marked habis is still billed (once).
-- 7: oil a shop-billed customer took from a PT's drum is owed to the drum's PT by the shop ("dari bengkel").
-- 60: drum oil at an estimated price is marked.
create or replace function public.po_line_book(p_po uuid, out payer text, out book text)
language sql stable security definer set search_path = public as $$
  -- (an invoice billed to the shop with a PO the PT still pays: the company's PT, else that PO is on no bill; 151)
  select case when po.ro_id is not null and r.order_status = 'invoice' and (select x.payer from ro_payer_book(r.id) x) is not null
                then (select x.payer from ro_payer_book(r.id) x)
              when po.ro_id is not null then canon_payer(coalesce(nullif(btrim(rc.payer_name), ''), rc.display_name))
              else canon_payer(po.paid_by_name) end,
         case when po.ro_id is not null and r.order_status = 'invoice' and (select x.payer from ro_payer_book(r.id) x) is not null
                then (select x.book from ro_payer_book(r.id) x)
              when po.ro_id is not null then regexp_replace(btrim(coalesce(nullif(btrim(rc.book_name), ''), rc.display_name)), '\s+', ' ', 'g')
              else po.paid_by_book end
    from purchase_orders po left join repair_orders r on r.id = po.ro_id left join customers rc on rc.id = r.customer_id
   where po.id = p_po
$$;
revoke execute on function public.po_line_book(uuid) from public, anon, authenticated;

do $do$
declare v_def text; v_n int := 0;
begin
  v_def := pg_get_functiondef('public.book_statement'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 bills%' then return; end if;
  -- PO lines: the invoice's book
  v_def := replace(v_def,
    $a$     and same_book(coalesce(case when po.ro_id is not null then canon_payer(coalesce(nullif(btrim(rc.payer_name), ''), rc.display_name)) end,
                            canon_payer(po.paid_by_name)),
                   case when po.ro_id is not null then regexp_replace(btrim(coalesce(nullif(btrim(rc.book_name), ''), rc.display_name)), '\s+', ' ', 'g')
                        else po.paid_by_book end, p_payer, p_book);$a$,
    $b$     and (select same_book(x.payer, x.book, p_payer, p_book) from po_line_book(po.id) x);   -- 151 bills$b$);
  -- drum oil: shop-billed users too (owed to the drum's PT by the shop), estimated price, habis-mode period
  v_def := replace(v_def,
    $a$               (r.invoiced_at at time zone shop_tz())::date as day, v.plate, u.litres, d.cost_per_l,
               round(u.litres * d.cost_per_l) as amount$a$,
    $b$               (r.invoiced_at at time zone shop_tz())::date as day, v.plate, u.litres, d.cost_per_l,
               round(u.litres * d.cost_per_l) as amount, d.cost_estimated as estimated, pb.payer is null as shop$b$);
  v_def := replace(v_def,
    $a$         where r.order_status = 'invoice' and pb.payer is not null
           and drum_owes(d.paid_by_name, d.paid_by_book, pb.payer, pb.book)$a$,
    $b$         where r.order_status = 'invoice'
           and drum_owes(d.paid_by_name, d.paid_by_book, pb.payer, pb.book)$b$);
  v_def := replace(v_def,
    $a$                    else d.emptied_on between p_from and p_to end) y), '[]'),$a$,
    $b$                    else d.emptied_on is not null and greatest(d.emptied_on, (r.invoiced_at at time zone shop_tz())::date) between p_from and p_to end) y), '[]'),$b$);
  if v_def not like '%151 bills%' or v_def not like '%pb.payer is null as shop%' or v_def not like '%d.emptied_on is not null and greatest(d.emptied_on,%' then
    raise exception '151: book_statement did not patch';
  end if;
  if v_def like '%pb.payer is not null%' then raise exception '151: book_statement still filters shop-billed oil'; end if;
  execute v_def;
end $do$;

do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.pt_supplier_bills'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 bills%' then return; end if;
  v_def := replace(v_def,
    $a$      select coalesce(case when po.ro_id is not null then payer_of(r.customer_id) end, canon_payer(po.paid_by_name)) as payer,
             case when po.ro_id is not null then book_of(r.customer_id) else po.paid_by_book end as book,$a$,
    $b$      select (select x.payer from po_line_book(po.id) x) as payer,   -- 151 bills: the invoice's book
             (select x.book from po_line_book(po.id) x) as book,$b$);
  if v_def not like '%151 bills%' then raise exception '151: pt_supplier_bills did not patch'; end if;
  execute v_def;
end $do$;

-- ---------- B6 (68, 70, 2). The books to pick on Tagihan bulanan: every PT · book with something in the period
-- (invoices, PT-paid parts, drum oil either way) plus today's paid-direct companies; one entry however it is spelled;
-- a PT's stock POs and drums with no book appear as the PT's own entry ("Seluruh PT", book empty).
create or replace function public.statement_books(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not (is_owner_or_admin() or fleet_can('bills')) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(b order by b.payer, b.book nulls first) from (
    select min(k.payer) as payer, case when min(k.book) is null then null else min(k.book) end as book,
           (select count(*) from repair_orders r cross join lateral ro_payer_book(r.id) pb
             where r.order_status = 'invoice' and same_book(pb.payer, pb.book, min(k.payer), min(k.book))
               and (r.invoiced_at at time zone shop_tz())::date between p_from and p_to) as invoices
      from (
        select canon_payer(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)) as payer,
               regexp_replace(btrim(coalesce(nullif(btrim(c.book_name), ''), c.display_name)), '\s+', ' ', 'g') as book
          from customers c where c.paid_direct
        union all
        select pb.payer, pb.book from repair_orders r cross join lateral ro_payer_book(r.id) pb
         where r.order_status = 'invoice' and pb.payer is not null
           and (r.invoiced_at at time zone shop_tz())::date between p_from and p_to
        union all
        select x.payer, x.book from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
          cross join lateral po_line_book(po.id) x
         where (po.paid_by_pt or po.paid_by_name is not null) and pi.qty_delivered > 0
           and pi.delivered_at between p_from and p_to and x.payer is not null
        union all
        select canon_payer(d.paid_by_name), d.paid_by_book from oil_drums d
         where nullif(btrim(d.paid_by_name), '') is not null
           and exists (select 1 from drum_use u join repair_orders r on r.id = u.ro_id where u.drum_id = d.id and r.order_status = 'invoice'
                         and (r.invoiced_at at time zone shop_tz())::date <= p_to)
      ) k
     where k.payer is not null
     group by payer_key(k.payer), payer_key(k.book)
    having can_see_book(min(k.payer), min(k.book))) b), '[]');
end $$;

-- ---------- B7 (15). Tagihan bulanan: the book's invoices from before the period still not fully paid ("Tunggakan
-- sebelumnya"), with their balance today.
create or replace function public.book_older_unpaid(p_payer text, p_book text, p_before date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_before is null then raise exception 'Choose the period'; end if;
  if not can_see_book(p_payer, p_book) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(x order by x.day, x.invoice_number) from (
    select r.id as ro_id, r.invoice_no, r.invoice_number, (r.invoiced_at at time zone shop_tz())::date as day, r.due_date,
           v.plate, r.total, r.settled_direct, r.balance
      from repair_orders r left join vehicles v on v.id = r.vehicle_id
      cross join lateral ro_payer_book(r.id) pb
     where r.order_status = 'invoice' and r.balance > 0 and same_book(pb.payer, pb.book, p_payer, p_book)
       and (r.invoiced_at at time zone shop_tz())::date < p_before) x), '[]');
end $$;
revoke execute on function public.book_older_unpaid(text, text, date) from public, anon;
grant execute on function public.book_older_unpaid(text, text, date) to authenticated;

-- ============================================================================================================
-- 151 D. Purchase orders, parts and who pays
-- ============================================================================================================

-- ---------- D1 (111, 127). Who pays a job's PO follows the company only while nothing on it has arrived, and never
-- on a void (the reissue keeps the payer the invoice was made with).
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.job_po_payer_follows'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 payer%' then
    v_def := replace(v_def,
      $a$  v := coalesce((select paid_direct from customers where id = new.customer_id), false);$a$,
      $b$  -- a void (invoice → estimate, same company) keeps the payers the invoice was made with (151 payer)
  if old.order_status = 'invoice' and new.customer_id is not distinct from old.customer_id then return null; end if;
  v := coalesce((select paid_direct from customers where id = new.customer_id), false);$b$);
    v_def := replace(v_def,
      $a$     and not exists (select 1 from purchase_order_items pi where pi.po_id = po.id and pi.qty_paid > 0);$a$,
      $b$     and not exists (select 1 from purchase_order_items pi where pi.po_id = po.id and (pi.qty_paid > 0 or pi.qty_delivered > 0));$b$);
    if v_def not like '%151 payer%' or v_def not like '%pi.qty_delivered > 0));%' then raise exception '151: job_po_payer_follows did not patch'; end if;
    execute v_def;
  end if;
  v_def := pg_get_functiondef('public.customer_pay_follows'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%qty_delivered > 0%' then
    v_def := replace(v_def,
      $a$         and not exists (select 1 from purchase_order_items pi where pi.po_id = po.id and pi.qty_paid > 0);$a$,
      $b$         and not exists (select 1 from purchase_order_items pi where pi.po_id = po.id and (pi.qty_paid > 0 or pi.qty_delivered > 0));$b$);
    if v_def not like '%qty_delivered > 0%' then raise exception '151: customer_pay_follows did not patch'; end if;
    execute v_def;
  end if;
end $do$;

-- ---------- D2 (113, 121). A PT-paid part on an invoiced job can't be un-received or cancelled below what the
-- invoice used: the invoice says the PT paid the supplier for it. Void the invoice first.
-- What the PT covers on a job's lines (qty × line_paid_share of its part and outside-work lines), the same measure the
-- invoice's "paid by the PT" came from; a PO line change on an invoiced job may not lower it.
create or replace function public.job_pt_cover(p_ro uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(i.qty * line_paid_share(i.id, i.catalog_item_id, i.qty)), 0)
    from ro_services s join ro_service_items i on i.service_id = s.id
   where s.ro_id = p_ro and s.approval_status in ('pending', 'approved') and i.item_type in ('part', 'sublet')
$$;
revoke execute on function public.job_pt_cover(uuid) from public, anon, authenticated;
-- …and what of it has come in: a job line on PT-paid PO lines is covered up to what was delivered (less returns) on them
create or replace function public.job_pt_received(p_ro uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(least(i.qty, x.got)), 0)
    from ro_services s join ro_service_items i on i.service_id = s.id
    cross join lateral (select sum(o.qty_delivered - po_qty_returned(o.id)) as got
                          from purchase_order_items o join purchase_orders po on po.id = o.po_id
                         where o.ro_service_item_id = i.id and (po.paid_by_pt or po.paid_by_name is not null)) x
   where s.ro_id = p_ro and s.approval_status in ('pending', 'approved') and i.item_type in ('part', 'sublet') and x.got is not null
$$;
revoke execute on function public.job_pt_received(uuid) from public, anon, authenticated;

create or replace function public.guard_invoiced_po_line() returns trigger language plpgsql security definer set search_path = public as $$
declare l purchase_order_items%rowtype := case when tg_op = 'DELETE' then old else new end;
        v_ro uuid; v_key text; v_before numeric; v_got numeric;
begin
  -- the rest of a line split off by a delivery in another month (po_line_split_rest): the copy carries it on
  if coalesce(current_setting('axle.po_split', true), '') = 'on' then return l; end if;
  if tg_op = 'UPDATE' and new.qty_delivered >= old.qty_delivered and new.qty_cancelled <= old.qty_cancelled
     and new.qty_ordered >= old.qty_ordered and new.ro_service_item_id is not distinct from old.ro_service_item_id
     and new.po_id = old.po_id then return l; end if;
  -- the line's job (as it was): its job line's, else its PO's
  select coalesce((select s.ro_id from ro_service_items i join ro_services s on s.id = i.service_id where i.id = old.ro_service_item_id), po.ro_id)
    into v_ro from purchase_orders po where po.id = old.po_id and (po.paid_by_pt or po.paid_by_name is not null);
  if v_ro is null or not exists (select 1 from repair_orders r where r.id = v_ro and r.order_status = 'invoice') then return l; end if;
  v_key := 'axle.ptcover_' || replace(l.id::text, '-', '');
  if tg_when = 'BEFORE' then
    perform set_config(v_key, job_pt_cover(v_ro)::text || ':' || job_pt_received(v_ro)::text, true);
  else
    v_before := nullif(split_part(current_setting(v_key, true), ':', 1), '')::numeric;
    v_got := nullif(split_part(current_setting(v_key, true), ':', 2), '')::numeric;
    perform set_config(v_key, '', true);
    if v_before is not null and (job_pt_cover(v_ro) < v_before - 0.0001 or job_pt_received(v_ro) < v_got - 0.0001) then
      raise exception 'This part is on an invoice as paid by the PT; void the invoice first';
    end if;
  end if;
  return l;
end $$;
revoke execute on function public.guard_invoiced_po_line() from public, anon, authenticated;
-- deleting a whole PO (a draft) takes its lines with it: checked on the PO, before its lines go
create or replace function public.guard_invoiced_po_delete() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (old.paid_by_pt or old.paid_by_name is not null) and old.ro_id is not null
     and exists (select 1 from repair_orders r where r.id = old.ro_id and r.order_status = 'invoice')
     and exists (select 1 from purchase_order_items o where o.po_id = old.id and o.qty_ordered > o.qty_cancelled
                  and (o.ro_service_item_id is not null or o.qty_delivered > 0)) then
    raise exception 'This part is on an invoice as paid by the PT; void the invoice first';
  end if;
  return old;
end $$;
revoke execute on function public.guard_invoiced_po_delete() from public, anon, authenticated;
drop trigger if exists purchase_orders_guard_invoiced_delete on public.purchase_orders;
create trigger purchase_orders_guard_invoiced_delete before delete on public.purchase_orders
  for each row execute function public.guard_invoiced_po_delete();
-- a part sent back from a PT-paid PO line of an invoiced job: only what the invoice didn't use (the spare)
create or replace function public.guard_invoiced_return() returns trigger language plpgsql security definer set search_path = public as $$
declare r returns%rowtype := case when tg_op = 'DELETE' then old else new end; v_ro uuid; v_key text; v_c numeric; v_g numeric;
begin
  if r.po_item_id is null then return r; end if;
  select coalesce((select s.ro_id from ro_service_items i join ro_services s on s.id = i.service_id where i.id = pi.ro_service_item_id), po.ro_id)
    into v_ro from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
   where pi.id = r.po_item_id and (po.paid_by_pt or po.paid_by_name is not null);
  if v_ro is null or not exists (select 1 from repair_orders x where x.id = v_ro and x.order_status = 'invoice') then return r; end if;
  v_key := 'axle.ptret_' || replace(r.id::text, '-', '');
  if tg_when = 'BEFORE' then
    perform set_config(v_key, job_pt_cover(v_ro)::text || ':' || job_pt_received(v_ro)::text, true);
  else
    v_c := nullif(split_part(current_setting(v_key, true), ':', 1), '')::numeric;
    v_g := nullif(split_part(current_setting(v_key, true), ':', 2), '')::numeric;
    perform set_config(v_key, '', true);
    if v_c is not null and (job_pt_cover(v_ro) < v_c - 0.0001 or job_pt_received(v_ro) < v_g - 0.0001) then
      raise exception 'This part is on an invoice as paid by the PT; only a spare part can be sent back. Void the invoice first';
    end if;
  end if;
  return r;
end $$;
revoke execute on function public.guard_invoiced_return() from public, anon, authenticated;
drop trigger if exists returns_guard_invoiced on public.returns;
create trigger returns_guard_invoiced before insert or update of qty, po_item_id on public.returns
  for each row execute function public.guard_invoiced_return();
drop trigger if exists returns_guard_invoiced_after on public.returns;
create trigger returns_guard_invoiced_after after insert or update of qty, po_item_id on public.returns
  for each row execute function public.guard_invoiced_return();
create index if not exists purchase_order_items_ro_item_idx on public.purchase_order_items (ro_service_item_id);
create index if not exists leftover_uses_ro_item_idx on public.leftover_uses (ro_item_id);
drop trigger if exists po_items_guard_invoiced on public.purchase_order_items;
create trigger po_items_guard_invoiced before update of qty_delivered, qty_cancelled, qty_ordered, ro_service_item_id, po_id or delete on public.purchase_order_items
  for each row execute function public.guard_invoiced_po_line();
drop trigger if exists po_items_guard_invoiced_after on public.purchase_order_items;
create trigger po_items_guard_invoiced_after after update of qty_delivered, qty_cancelled, qty_ordered, ro_service_item_id, po_id or delete on public.purchase_order_items
  for each row execute function public.guard_invoiced_po_line();

-- ---------- D3 (120). A job PO's spare part sent back after the invoice comes off the shelf (only the part that came
-- off the truck never went onto the shelf)
create or replace function public.return_stock() returns trigger language plpgsql security definer set search_path = public as $$
declare v_have numeric; v_take numeric := new.qty; v_spare numeric; v_used numeric; v_deliv numeric; v_prev numeric;
begin
  if new.catalog_item_id is null or new.status not in ('shipped','delivered','refunded') then return null; end if;
  if tg_op = 'UPDATE' and old.status <> 'marked' then return null; end if;      -- only the step out of "marked" moves stock
  if exists (select 1 from stock_movements where return_id = new.id) then return null; end if;
  if new.kind = 'ro' then
    if new.po_item_id is not null then
      -- every PO line of the job line together (a line split by a delivery in two months is two lines)
      select i.qty, (select sum(o.qty_delivered) from purchase_order_items o where o.ro_service_item_id = i.id)
        into v_used, v_deliv from purchase_order_items pi
        join ro_service_items i on i.id = pi.ro_service_item_id
       where pi.id = new.po_item_id and i.stock_deducted;
      if found then
        -- what's on the shelf from these lines: delivered beyond what the invoice used, less what earlier returns took
        select coalesce(sum(-m.qty_change), 0) into v_prev from stock_movements m join returns r on r.id = m.return_id
         where r.po_item_id in (select o.id from purchase_order_items o join purchase_order_items p2 on p2.ro_service_item_id = o.ro_service_item_id
                                 where p2.id = new.po_item_id)
           and r.id <> new.id and m.reason = 'return';
        v_spare := greatest(v_deliv - v_used - v_prev, 0);
        v_take := least(new.qty, v_spare);
        if v_take <= 0 then return null; end if;
      end if;
    elsif exists (select 1 from ro_service_items i join ro_services sv on sv.id = i.service_id
                   where sv.ro_id = new.ro_id and i.catalog_item_id = new.catalog_item_id and i.stock_deducted) then
      return null;
    end if;
  end if;
  select qty_on_hand into v_have from catalog_items where id = new.catalog_item_id and track_inventory for update;
  if not found then return null; end if;
  if v_have < v_take then
    raise exception 'Only % in stock; you can''t send back more than you have', trim(to_char(greatest(v_have, 0), 'FM999G999G990D99'), '.,');
  end if;
  insert into stock_movements (catalog_item_id, qty_change, reason, return_id, note)
  values (new.catalog_item_id, -v_take, 'return', new.id, 'Returned to supplier');
  return null;
end $$;

-- ---------- D4 (55, 122, 117). What of a job line the PT paid its supplier for directly:
--   55: a part from this PT · book's own leftover (bought on its earlier job's PT-paid PO) is the PT's;
--   122: an untracked / typed / outside-work line the shop bought on a "shop pays" PO of the same job is the shop's.
create or replace function public.line_paid_share(p_item uuid, p_cat uuid, p_qty numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(p_qty, 0) <= 0 then 0
    when exists (select 1 from purchase_order_items o where o.ro_service_item_id = p_item and o.qty_cancelled < o.qty_ordered)
      then least(coalesce((select sum(greatest(o.qty_ordered - o.qty_cancelled - po_qty_returned(o.id), 0))
                             from purchase_order_items o join purchase_orders po on po.id = o.po_id
                            where o.ro_service_item_id = p_item and (po.paid_by_pt or po.paid_by_name is not null)), 0) / p_qty, 1)
    when p_cat is not null and exists (select 1 from catalog_items ci where ci.id = p_cat and ci.track_inventory)
      then case
        when exists (select 1 from oil_drums d where d.catalog_item_id = p_cat) then 1
        else least((coalesce((
          select sum(greatest(o.qty_delivered - po_qty_returned(o.id), 0))
            from purchase_order_items o join purchase_orders po on po.id = o.po_id
           where po.ro_id = (select s.ro_id from ro_service_items i join ro_services s on s.id = i.service_id where i.id = p_item)
             and (po.paid_by_pt or po.paid_by_name is not null) and po.status <> 'cancelled'
             and o.ro_service_item_id is null
             and (o.catalog_item_id = p_cat
                  or exists (select 1 from typed_part_links t where t.line_id = o.id and t.catalog_item_id = p_cat))), 0)
          + coalesce((select sum(lu.qty) from leftover_uses lu where lu.ro_item_id = p_item and not lu.other_book), 0)) / p_qty, 1)
      end
    else greatest(1 - least(coalesce((
          select sum(greatest(o.qty_ordered - o.qty_cancelled - po_qty_returned(o.id), 0))
            from purchase_order_items o join purchase_orders po on po.id = o.po_id
            join ro_service_items i on i.id = p_item
           where po.ro_id = (select s.ro_id from ro_services s where s.id = i.service_id)
             and not po.paid_by_pt and po.paid_by_name is null and po.status <> 'cancelled'
             and o.ro_service_item_id is null
             and ((p_cat is not null and o.catalog_item_id = p_cat)
                  or lower(btrim(o.name)) = lower(btrim(i.name)))), 0) / p_qty, 1), 0)
  end
$$;

-- ---------- D5 (112). A stock PO a PT pays for is only for bulk oil (a drum); other parts a PT buys go on its job's PO
create or replace function public.guard_stock_po_payer() returns trigger language plpgsql security definer set search_path = public as $$
declare v_po purchase_orders%rowtype;
begin
  if tg_table_name = 'purchase_orders' then v_po := new;
  else select * into v_po from purchase_orders where id = new.po_id; end if;
  if v_po.ro_id is null and nullif(btrim(v_po.paid_by_name), '') is not null
     and exists (select 1 from purchase_order_items pi left join catalog_items ci on ci.id = pi.catalog_item_id
                  where pi.po_id = v_po.id and pi.qty_cancelled < pi.qty_ordered
                    and not (coalesce(lower(ci.unit), '') in ('l', 'liter', 'litre')
                             or exists (select 1 from oil_drums d where d.catalog_item_id = pi.catalog_item_id))) then
    raise exception 'A stock PO paid by a PT is for bulk oil (a drum) only; put other parts on the job''s PO';
  end if;
  return null;
end $$;
revoke execute on function public.guard_stock_po_payer() from public, anon, authenticated;
drop trigger if exists purchase_orders_stock_payer on public.purchase_orders;
create trigger purchase_orders_stock_payer after insert or update of paid_by_name, ro_id on public.purchase_orders
  for each row execute function public.guard_stock_po_payer();
drop trigger if exists po_items_stock_payer on public.purchase_order_items;
create trigger po_items_stock_payer after insert or update of catalog_item_id on public.purchase_order_items
  for each row execute function public.guard_stock_po_payer();

-- ---------- D6 (80). A PO cost typed after the job is invoiced reaches the invoice line's cost (never its price), so
-- Laba, Rekap and Inventaris use what the part really cost.
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.sync_po_line_to_job'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 cost%' then
    v_def := replace(v_def,
      $a$  if not exists (select 1 from ro_services s join repair_orders ro on ro.id = s.ro_id
                  where s.id = l.service_id and ro.order_status = 'estimate' and ro.closed_at is null) then
    return;
  end if;$a$,
      $b$  if not exists (select 1 from ro_services s join repair_orders ro on ro.id = s.ro_id
                  where s.id = l.service_id and ro.order_status = 'estimate' and ro.closed_at is null) then
    -- an invoiced job: only the line's cost follows the PO (its price is on the invoice) (151 cost)
    if exists (select 1 from ro_services s join repair_orders ro on ro.id = s.ro_id where s.id = l.service_id and ro.order_status = 'invoice') then
      v_jc := po_to_job_cost(p.cost, p.taxable, v_rate);
      if coalesce(l.cost, 0) > 0 and job_to_po_cost(l.cost, p.taxable, v_rate) = p.cost then v_jc := l.cost; end if;
      if v_jc is distinct from l.cost then
        v_flag := current_setting('axle.po_to_job', true);
        perform set_config('axle.po_to_job', 'on', true);
        update ro_service_items set cost = v_jc where id = l.id;
        perform set_config('axle.po_to_job', coalesce(nullif(v_flag, ''), 'off'), true);
      end if;
    end if;
    return;
  end if;$b$);
    if v_def not like '%151 cost%' then raise exception '151: sync_po_line_to_job did not patch'; end if;
    execute v_def;
  end if;
  v_def := pg_get_functiondef('public.lock_invoiced_job'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 cost%' then
    v_def := replace(v_def,
      $a$  o := to_jsonb(old) - allowed; n := to_jsonb(new) - allowed;$a$,
      $b$  -- the cost of a PO-linked part follows its PO line after invoicing (sync_po_line_to_job) (151 cost)
  if tg_table_name = 'ro_service_items' and current_setting('axle.po_to_job', true) = 'on' then allowed := allowed || array['cost']; end if;
  o := to_jsonb(old) - allowed; n := to_jsonb(new) - allowed;$b$);
    if v_def not like '%151 cost%' then raise exception '151: lock_invoiced_job did not patch'; end if;
    execute v_def;
  end if;
end $do$;

-- ---------- D7 (34). A delivery counts on the day it arrived (the day given when receiving), not the day typed in
create or replace function public.po_item_stock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.qty_delivered = old.qty_delivered or new.catalog_item_id is null then return null; end if;
  if exists (select 1 from catalog_items where id = new.catalog_item_id and track_inventory) then
    insert into stock_movements (catalog_item_id, qty_change, reason, po_item_id, note, created_at)
    values (new.catalog_item_id, new.qty_delivered - old.qty_delivered, 'po_delivery', new.id,
            case when new.qty_delivered < old.qty_delivered then 'Received quantity corrected' end,
            case when new.qty_delivered > old.qty_delivered and new.delivered_at is not null and new.delivered_at < local_date()
                 then (new.delivered_at + time '12:00') at time zone shop_tz() else now() end);
  end if;
  return null;
end $$;

-- ---------- D8 (130). Receiving and correcting say how many the page showed as received; a second tap or an old page
-- is refused instead of counting twice (po_receive / po_unreceive check, then call deliver_po_item / unreceive_po_item).
create or replace function public.po_receive(p_item uuid, p_qty numeric, p_expect numeric, p_delivered date default null,
                                             p_invoice_no text default null, p_invoice_date date default null, p_due date default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_now numeric;
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  select qty_delivered into v_now from purchase_order_items where id = p_item for update;
  if not found then raise exception 'PO line not found'; end if;
  if p_expect is not null and v_now is distinct from p_expect then
    raise exception 'This PO line was changed by someone else (now % received); reload and try again', trim(to_char(v_now, 'FM999G999G990D99'), '.,');
  end if;
  perform deliver_po_item(p_item, p_qty, p_delivered, p_invoice_no, p_invoice_date, p_due);
end $$;
revoke execute on function public.po_receive(uuid, numeric, numeric, date, text, date, date) from public, anon;
grant execute on function public.po_receive(uuid, numeric, numeric, date, text, date, date) to authenticated, service_role;
create or replace function public.po_unreceive(p_item uuid, p_qty numeric, p_expect numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_now numeric;
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  select qty_delivered into v_now from purchase_order_items where id = p_item for update;
  if not found then raise exception 'PO line not found'; end if;
  if p_expect is not null and v_now is distinct from p_expect then
    raise exception 'This PO line was changed by someone else (now % received); reload and try again', trim(to_char(v_now, 'FM999G999G990D99'), '.,');
  end if;
  perform unreceive_po_item(p_item, p_qty);
end $$;
revoke execute on function public.po_unreceive(uuid, numeric, numeric) from public, anon;
grant execute on function public.po_unreceive(uuid, numeric, numeric) to authenticated, service_role;

-- ============================================================================================================
-- 151 E. Void and reissue, payments, credits
-- ============================================================================================================
do $do$
declare v_def text;
begin
  -- 128: voiding no longer ticks the job's unfinished services as done (and moves their schedules)
  v_def := pg_get_functiondef('public.void_invoice'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 void%' then
    v_def := replace(v_def,
      $a$  update repair_orders set order_status = 'estimate', invoice_number = null, invoiced_at = null, due_date = null,$a$,
      $b$  perform set_config('axle.auto_workflow', 'on', true);   -- 151 void: services stay as they were
  update repair_orders set order_status = 'estimate', invoice_number = null, invoiced_at = null, due_date = null,$b$);
    v_def := replace(v_def,
      $a$  select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) into v_cash from payments where ro_id = p_ro;$a$,
      $b$  perform set_config('axle.auto_workflow', '', true);
  select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) into v_cash from payments where ro_id = p_ro;$b$);
    if v_def not like '%151 void%' or v_def not like '%axle.auto_workflow'', '''', true%' then raise exception '151: void_invoice did not patch'; end if;
    execute v_def;
  end if;
  -- 61: a reissued invoice keeps the due date of the first invoice it replaces; 78: the invoice keeps the company's
  -- tax-exempt flag and terms as they were
  v_def := pg_get_functiondef('public.convert_to_invoice'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 due%' then
    v_def := replace(v_def,
      $a$    due_date = local_date() + coalesce(c.payment_terms_days, st.default_payment_terms_days),$a$,
      $b$    due_date = coalesce((select min((v.snapshot->'job'->>'due_date')::date) from invoice_voids v where v.ro_id = p_ro),   -- 151 due
                        local_date() + coalesce(c.payment_terms_days, st.default_payment_terms_days)),$b$);
    v_def := replace(v_def,
      $a$    bill_to_snapshot = jsonb_build_object('display_name', c.display_name,$a$,
      $b$    bill_to_snapshot = jsonb_build_object('tax_exempt', c.tax_exempt, 'terms_days', coalesce(c.payment_terms_days, st.default_payment_terms_days),
                                          'display_name', c.display_name,$b$);
    if v_def not like '%151 due%' or v_def not like '%''terms_days''%' then raise exception '151: convert_to_invoice did not patch'; end if;
    execute v_def;
  end if;
end $do$;

-- 64: a credit on a job that is partly given back after a void/reissue shows on the job's Activity tab
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
  if tg_op = 'UPDATE' and new.applied_ro_id is not null and new.applied_ro_id is not distinct from old.applied_ro_id
     and new.amount is distinct from old.amount then
    insert into activity_log (entity_type, entity_id, action, changes)
    values ('repair_orders', new.applied_ro_id, 'line_update',
            jsonb_build_object('table', 'credit_memos', 'row', to_jsonb(new), 'amount', jsonb_build_array(old.amount, new.amount)));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists log_credit_job on public.credit_memos;
create trigger log_credit_job after insert or delete or update of applied_ro_id, amount on public.credit_memos
  for each row execute function public.log_credit_job_activity();

-- 65: paying back company credit can be dated (like payments; not in the future): refund_credit_on
create or replace function public.refund_credit_on(p_credit uuid, p_amount numeric, p_method text, p_reference text, p_paid_on date)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_at timestamptz;
begin
  if p_paid_on is not null and p_paid_on > local_date() then raise exception 'The date can''t be in the future'; end if;
  v_id := refund_credit(p_credit, p_amount, coalesce(p_method, 'transfer'), p_reference);
  if p_paid_on is not null and p_paid_on < local_date() then
    v_at := (p_paid_on + time '12:00') at time zone shop_tz();
    update credit_memos set refunded_at = v_at where id = v_id;
  end if;
  return v_id;
end $$;
revoke execute on function public.refund_credit_on(uuid, numeric, text, text, date) from public, anon;
grant execute on function public.refund_credit_on(uuid, numeric, text, text, date) to authenticated, service_role;

-- 62: a payment made on an invoice that was later voided shows the invoice number it was paid against
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.report_payments'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 paid against%' then return; end if;
  v_def := replace(v_def, $a$p.ro_id, r.invoice_number, r.job_number,$a$,
    $b$p.ro_id, coalesce((select v.invoice_number from invoice_voids v where v.ro_id = p.ro_id and v.voided_at > p.created_at   -- 151 paid against
                         order by v.voided_at limit 1), r.invoice_number), r.job_number,$b$);
  if v_def not like '%151 paid against%' then raise exception '151: report_payments did not patch'; end if;
  execute v_def;
end $do$;

-- ============================================================================================================
-- 151 F. Money rules (Denny 18 Nov) and report numbers
-- ============================================================================================================
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.recalc_repair_order'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 discounts%' then
    -- 73: the shop's discounts come off the shop's own share; what the PT pays its supplier stays at full price
    v_def := replace(v_def, $a$        v_set_pre := v_set_pre + c_set * (svc_total - svc_disc) / svc_total;
        v_set_tax := v_set_tax + c_pst * (svc_total - svc_disc) / svc_total;$a$,
      $b$        v_set_pre := v_set_pre + c_set;   -- 151 discounts: the PT's parts stay at full price
        v_set_tax := v_set_tax + c_pst;$b$);
    v_def := replace(v_def, $a$    v_set_pre := v_set_pre * (v_pre - v_job_disc) / v_pre;
    v_set_tax := v_set_tax * (v_pre - v_job_disc) / v_pre;
$a$, '');
    -- 79: a package price with no priced lines is charged in full (also for "Jasa tidak ditagih" companies)
    v_def := replace(v_def, $a$        c_p := 0; c_l := s.flat_price; c_o := 0; c_f := 0;$a$,
      $b$        c_p := 0; c_l := case when cu.labour_not_charged then 0 else s.flat_price end;   -- 151 package
        c_o := case when cu.labour_not_charged then s.flat_price else 0 end; c_f := 0;$b$);
    v_def := replace(v_def, $a$        c_lt := line_taxable; c_pst := 0; c_set := 0;$a$,
      $b$        c_lt := case when cu.labour_not_charged then 0 else line_taxable end; c_pst := 0; c_set := 0;$b$);
    if v_def not like '%151 discounts%' or v_def not like '%151 package%' or v_def like '%v_set_pre * (v_pre - v_job_disc)%'
       or v_def not like '%c_lt := case when cu.labour_not_charged%' then
      raise exception '151: recalc_repair_order did not patch';
    end if;
    execute v_def;
  end if;
end $do$;

-- 133: no core charge on the customer's invoice: the shop takes the old part off the truck and returns it to the
-- supplier itself (the Cores tab still tracks it). Open jobs' lines lose theirs.
create or replace function public.no_core_charge() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.core_charge, 0) <> 0 then new.core_charge := 0; end if;
  return new;
end $$;
revoke execute on function public.no_core_charge() from public, anon, authenticated;
drop trigger if exists ro_items_no_core_charge on public.ro_service_items;
create trigger ro_items_no_core_charge before insert or update of core_charge on public.ro_service_items
  for each row when (coalesce(new.core_charge, 0) <> 0) execute function public.no_core_charge();
do $do$
declare r record;
begin
  for r in select distinct s.ro_id from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders ro on ro.id = s.ro_id
            where coalesce(i.core_charge, 0) <> 0 and ro.order_status = 'estimate' loop
    update ro_service_items i set core_charge = 0 from ro_services s where s.id = i.service_id and s.ro_id = r.ro_id and coalesce(i.core_charge, 0) <> 0;
    perform recalc_repair_order(r.ro_id);
  end loop;
end $do$;
-- a voided invoice that had core charges (from before 151) is reissued without them
create or replace function public.void_drops_core() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from ro_service_items i join ro_services s on s.id = i.service_id where s.ro_id = new.id and coalesce(i.core_charge, 0) <> 0) then
    update ro_service_items i set core_charge = 0 from ro_services s where s.id = i.service_id and s.ro_id = new.id and coalesce(i.core_charge, 0) <> 0;
    perform recalc_repair_order(new.id);
  end if;
  return null;
end $$;
revoke execute on function public.void_drops_core() from public, anon, authenticated;
drop trigger if exists repair_orders_void_drops_core on public.repair_orders;
create trigger repair_orders_void_drops_core after update of order_status on public.repair_orders
  for each row when (old.order_status = 'invoice' and new.order_status = 'estimate') execute function public.void_drops_core();

-- 74: Settings → shop supplies "taxable" reaches open estimates too
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.reprice_open_estimates'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 taxable%' then return; end if;
  v_def := replace(v_def, $a$    if (new.tax_rate, new.pkp_status, new.shop_supplies_type,$a$,
    $b$    if new.shop_supplies_taxable is distinct from old.shop_supplies_taxable then   -- 151 taxable
      update ro_job_fees f set taxable = new.shop_supplies_taxable
      from repair_orders r
      where r.id = f.ro_id and r.order_status = 'estimate' and r.closed_at is null and f.is_shop_supplies and not f.manual_override
        and f.taxable is distinct from new.shop_supplies_taxable;
    end if;
    if (new.tax_rate, new.pkp_status, new.shop_supplies_taxable, new.shop_supplies_type,$b$);
  v_def := replace(v_def, $a$       is distinct from (old.tax_rate, old.pkp_status, old.shop_supplies_type,$a$,
                          $a$       is distinct from (old.tax_rate, old.pkp_status, old.shop_supplies_taxable, old.shop_supplies_type,$a$);
  if v_def not like '%151 taxable%' or v_def not like '%old.shop_supplies_taxable, old.shop_supplies_type%' then raise exception '151: reprice_open_estimates did not patch'; end if;
  execute v_def;
end $do$;

-- 3: Laba — what the PT paid its suppliers directly isn't the shop's sale or cost: per invoice, to take off
drop function if exists public.report_profit_pt(date, date);
create function public.report_profit_pt(p_from date, p_to date)
returns table(ro_id uuid, pt_sales numeric, pt_cost numeric, pt_parts numeric, pt_parts_cost numeric, pt_sublet numeric, pt_sublet_cost numeric)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz;
begin
  if auth.uid() is not null and not (has_permission('view_reports') and has_permission('view_costs')) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  with l as (
    -- a package price: each line at its share of the package, as the PT settled it
    select r.id as rid, i.item_type, coalesce(i.cost, 0) * i.qty * line_paid_share(i.id, i.catalog_item_id, i.qty) as c,
           (i.net + round(coalesce(i.core_charge, 0) * i.qty)) * line_paid_share(i.id, i.catalog_item_id, i.qty)
             * case when s.flat_price is not null and sum(i.net + round(coalesce(i.core_charge, 0) * i.qty)) over (partition by s.id) <> 0
                    then s.flat_price / sum(i.net + round(coalesce(i.core_charge, 0) * i.qty)) over (partition by s.id) else 1 end as v   -- as recalc_repair_order
      from repair_orders r join ro_services s on s.ro_id = r.id and s.approval_status in ('pending', 'approved')
      join ro_service_items i on i.service_id = s.id
     where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
       and (select pb.payer from ro_payer_book(r.id) pb) is not null
  )
  -- never more than the invoice's own parts, outside work and subtotal (rounding, or a discount bigger than the shop's share)
  , k as (
    select l.rid, round(coalesce(sum(l.v) filter (where l.item_type = 'part'), 0)) as vp, round(coalesce(sum(l.c) filter (where l.item_type = 'part'), 0)) as cp,
           round(coalesce(sum(l.v) filter (where l.item_type = 'sublet'), 0)) as vs, round(coalesce(sum(l.c) filter (where l.item_type = 'sublet'), 0)) as cs
      from l group by l.rid
  )
  select k.rid, least(least(k.vp, greatest(r.parts_total, 0)) + least(k.vs, greatest(r.other_total, 0)), greatest(r.subtotal, 0)), k.cp + k.cs,
         least(k.vp, greatest(r.parts_total, 0)), k.cp, least(k.vs, greatest(r.other_total, 0)), k.cs
    from k join repair_orders r on r.id = k.rid;
end $$;
revoke execute on function public.report_profit_pt(date, date) from public, anon;
grant execute on function public.report_profit_pt(date, date) to authenticated, service_role;

-- 6: Teknisi — labour of a company that isn't charged labour isn't counted as labour sold
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.report_technicians'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 waived%' then return; end if;
  v_def := replace(v_def, $a$         case when not v_money then null
              when s.flat_price is null then coalesce(x.l, 0)$a$,
    $b$         case when not v_money then null
              when r.labor_waived > 0 then 0   -- 151 waived: the company isn't charged labour
              when s.flat_price is null then coalesce(x.l, 0)$b$);
  if v_def not like '%151 waived%' then raise exception '151: report_technicians did not patch'; end if;
  execute v_def;
end $do$;

-- 63: Umur piutang — the total is what the shop bills (less what the PT paid its suppliers directly), so
-- total − paid = what's left
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.report_aging'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 shop total%' then return; end if;
  v_def := replace(v_def, $a$r.job_number, r.customer_id, c.display_name, v.plate, r.total, r.paid_total, r.balance$a$,
    $a$r.job_number, r.customer_id, c.display_name, v.plate, r.total - coalesce(r.settled_direct, 0) /* 151 shop total */, r.paid_total, r.balance$a$);
  if v_def not like '%151 shop total%' then raise exception '151: report_aging did not patch'; end if;
  execute v_def;
end $do$;

-- ============================================================================================================
-- 151 G. Service due, Rekap, report fixes
-- ============================================================================================================
do $do$
declare v_def text;
begin
  -- 37 + 44: Kepatuhan servis — trucks of companies no longer active are left out; a schedule with no due point yet
  -- (never done) is "never", not "Aman"
  v_def := pg_get_functiondef('public.report_service_status'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 never%' then
    v_def := replace(v_def, $a$           case
             when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km) or (ss.next_due_date is not null and d >= ss.next_due_date) then 'overdue'$a$,
      $b$           case
             when ss.next_due_km is null and ss.next_due_date is null then 'never'   -- 151 never
             when (ss.next_due_km is not null and v.mileage_km >= ss.next_due_km) or (ss.next_due_date is not null and d >= ss.next_due_date) then 'overdue'$b$);
    v_def := replace(v_def, $a$    where ss.active and v.status not in ('sold', 'inactive')
    union all$a$, $a$    where ss.active and v.status not in ('sold', 'inactive') and coalesce(c.active, true)
    union all$a$);
    if v_def not like '%151 never%' or v_def not like '%(''sold'', ''inactive'') and coalesce(c.active, true)
    union all%' then raise exception '151: report_service_status did not patch'; end if;
    execute v_def;
  end if;
  -- 106 + 37: reminders leave out trucks already in the shop (an open job that has arrived) and companies no longer active
  v_def := pg_get_functiondef('public.service_reminder_rows'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 in shop%' then
    v_def := replace(v_def, $a$    where ss.active and v.status not in ('sold', 'inactive')
  )$a$, $a$    where ss.active and v.status not in ('sold', 'inactive') and coalesce(c.active, true)
      and not exists (select 1 from repair_orders r where r.vehicle_id = v.id and r.order_status = 'estimate' and r.closed_at is null
                        and r.workflow_status in ('arrived', 'in_progress', 'waiting_parts', 'completed'))   -- 151 in shop
  )$a$);
    if v_def not like '%151 in shop%' then raise exception '151: service_reminder_rows did not patch'; end if;
    execute v_def;
  end if;
  -- 41 + 51: Rekap — a package-price service with no lines is one row (it no longer drops the invoice); km is the km
  -- out (else in), like Riwayat and Biaya armada
  v_def := pg_get_functiondef('public.report_rekap'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 rekap%' then
    v_def := replace(v_def, $a$r.job_number, r.odometer_in, r.km_unreadable,$a$, $a$r.job_number, coalesce(r.odometer_out, r.odometer_in), r.km_unreadable,$a$);
    v_def := replace(v_def, $a$         r.total, s.id, s.name, s.position, i.id, i.position,
         case when i.item_type = 'part' and exists (select 1 from oil_drums d where d.catalog_item_id = i.catalog_item_id) then 'oil'
              when i.item_type in ('part', 'labor', 'sublet') then i.item_type::text
              else 'other' end,
         i.name, i.qty, ci.unit, i.price,
         i.net + case when i.item_type = 'part' then round(coalesce(i.core_charge, 0) * i.qty) else 0 end,
         case when i.item_type = 'labor' and coalesce(r.labor_waived, 0) > 0 then 0
              else i.net + case when i.item_type = 'part' then round(coalesce(i.core_charge, 0) * i.qty) else 0 end end,
         case when v_cost and i.item_type in ('part', 'sublet') then round(coalesce(i.cost, 0) * i.qty) end$a$,
      $b$         r.total, s.id, s.name, s.position, i.id, coalesce(i.position, 0),
         case when i.id is null then 'other'   -- 151 rekap: a package price with no lines
              when i.item_type = 'part' and exists (select 1 from oil_drums d where d.catalog_item_id = i.catalog_item_id) then 'oil'
              when i.item_type in ('part', 'labor', 'sublet') then i.item_type::text
              else 'other' end,
         coalesce(i.name, s.name), coalesce(i.qty, 1), ci.unit, coalesce(i.price, s.service_total),
         case when i.id is null then s.service_total
              else i.net + case when i.item_type = 'part' then round(coalesce(i.core_charge, 0) * i.qty) else 0 end end,
         case when i.id is null then s.service_total
              when i.item_type = 'labor' and coalesce(r.labor_waived, 0) > 0 then 0
              else i.net + case when i.item_type = 'part' then round(coalesce(i.core_charge, 0) * i.qty) else 0 end end,
         case when v_cost and i.item_type in ('part', 'sublet') then round(coalesce(i.cost, 0) * i.qty) end$b$);
    v_def := replace(v_def, $a$  join ro_service_items i on i.service_id = s.id
  left join catalog_items ci$a$, $a$  left join ro_service_items i on i.service_id = s.id
  left join catalog_items ci$a$);
    if v_def not like '%151 rekap%' or v_def not like '%left join ro_service_items i%' or v_def not like '%coalesce(r.odometer_out, r.odometer_in), r.km_unreadable%' then
      raise exception '151: report_rekap did not patch';
    end if;
    execute v_def;
  end if;
end $do$;

-- 47 + 106: the fleet's service-due tile and lists leave out sold or inactive trucks; the truck's open job in the shop
-- (if any) comes with each row
create or replace view public.service_due with (security_invoker = true) as
 select ss.id, ss.vehicle_id, ss.name, ss.template_id, ss.interval_km, ss.interval_months, ss.last_done_km, ss.last_done_date,
        ss.next_due_km, ss.next_due_date, ss.active, ss.created_at, ss.updated_at, v.plate, v.customer_id, v.mileage_km,
        ss.next_due_km - v.mileage_km as km_left, ss.next_due_date - local_date() as days_left,
        case
          when ss.next_due_km is not null and v.mileage_km >= ss.next_due_km or ss.next_due_date is not null and local_date() >= ss.next_due_date then 'overdue'::text
          when ss.next_due_km is not null and v.mileage_km >= (ss.next_due_km - (select shop_settings.due_soon_km from shop_settings limit 1))
            or ss.next_due_date is not null and local_date() >= (ss.next_due_date - (select shop_settings.due_soon_days from shop_settings limit 1)) then 'due_soon'::text
          else 'ok'::text
        end as due_status,
        (select r.job_number from repair_orders r where r.vehicle_id = v.id and r.order_status = 'estimate' and r.closed_at is null
            and r.workflow_status in ('arrived', 'in_progress', 'waiting_parts', 'completed') order by r.created_at desc limit 1) as in_shop_job
   from service_schedules ss join vehicles v on v.id = ss.vehicle_id
  where ss.active and v.status not in ('sold', 'inactive');

-- 4 + 67: Rekap per invoice: PPN on its own, and the difference between a package price and its lines (not "Lain-lain")
create or replace function public.report_rekap_inv(p_from date, p_to date)
returns table (ro_id uuid, subtotal numeric, tax numeric, package_diff numeric)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz;
        v_staff boolean := has_permission('view_reports');
        v_fleet boolean := is_fleet();
begin
  if not (v_staff or v_fleet) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select r.id, r.subtotal, r.tax_total,
         -- package-price services only, against what Rekap bills for their lines (labour Rp 0 when not charged)
         coalesce((select sum(s.service_total - x.lines)
                     from ro_services s
                     cross join lateral (select sum(case when i.item_type = 'labor' and coalesce(r.labor_waived, 0) > 0 then 0
                                                         else i.net + case when i.item_type = 'part' then round(coalesce(i.core_charge, 0) * i.qty) else 0 end end) as lines
                                           from ro_service_items i where i.service_id = s.id) x
                    where s.ro_id = r.id and s.approval_status = 'approved' and s.flat_price is not null and x.lines is not null), 0)
    from repair_orders r
   where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
     and (v_staff or r.customer_id in (select fleet_customer_ids()));
end $$;
revoke execute on function public.report_rekap_inv(date, date) from public, anon;
grant execute on function public.report_rekap_inv(date, date) to authenticated;

-- ============================================================================================================
-- 151 H. Who sees what; Tanya Claude's lookups
-- ============================================================================================================

-- ---------- H1 (39). The shop's default parts markup is cost information: only logins that see costs read it
-- (fleet, viewer, technician, cashier no longer can, also not from an invoice's shop snapshot).
-- (the column lock itself is 151b_shop_markup_lock.sql, run once the 151 app is live: the 150c app reads shop_settings with *)
create or replace function public.shop_markup() returns numeric language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null or (is_staff() and has_permission('view_costs')) then (select default_markup_pct from shop_settings limit 1) end
$$;
revoke execute on function public.shop_markup() from public, anon;
grant execute on function public.shop_markup() to authenticated;

do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.convert_to_invoice'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 no markup%' then
    v_def := replace(v_def, $a$shop_snapshot = to_jsonb(st) - 'id'$a$, $a$shop_snapshot = to_jsonb(st) - 'id' - 'default_markup_pct' /* 151 no markup */$a$);
    if v_def not like '%151 no markup%' then raise exception '151: convert_to_invoice (snapshot) did not patch'; end if;
    execute v_def;
  end if;
end $do$;
alter table public.repair_orders disable trigger user;
update public.repair_orders set shop_snapshot = shop_snapshot - 'default_markup_pct' where shop_snapshot ? 'default_markup_pct';
alter table public.repair_orders enable trigger user;

-- ---------- H2 (40). Old-oil values on a fleet login's Rekap only with "Lihat tagihan & biaya" on
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.report_preapp'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 fleet bills%' then return; end if;
  v_def := replace(v_def, $a$v_money boolean := has_permission('view_reports') or is_fleet();$a$,
                          $a$v_money boolean := has_permission('view_reports') or (is_fleet() and fleet_can('bills'));   -- 151 fleet bills$a$);
  if v_def not like '%151 fleet bills%' then raise exception '151: report_preapp did not patch'; end if;
  execute v_def;
end $do$;

-- ---------- H3 (96-101). Tanya Claude
do $do$
declare v_def text;
begin
  -- 96: a PO the PT pays its supplier for, or a driver paid first, is not "unpaid" by the shop
  v_def := pg_get_functiondef('public.tc_po'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 payer%' then
    v_def := replace(v_def, $a$'id', p.id, 'po_number', p.po_number, 'status', p.status, 'payment', p.payment_status,$a$,
      $b$'id', p.id, 'po_number', p.po_number, 'status', p.status,
    'payment', case when p.paid_by_pt or p.paid_by_name is not null then 'paid by the PT to its supplier directly (not a shop bill)'   -- 151 payer
                    when p.talangan_name is not null then 'paid by the driver first (talangan); the shop pays the driver back'
                    else p.payment_status end,
    'paid_by_pt', case when p.paid_by_pt or p.paid_by_name is not null then
                    coalesce(p.paid_by_name, (select coalesce(nullif(btrim(c.payer_name), ''), c.display_name)
                                                from repair_orders_read r join customers_read c on c.id = r.customer_id where r.id = p.ro_id)) end,
    'paid_by_book', p.paid_by_book, 'talangan_driver', p.talangan_name,$b$);
    if v_def not like '%151 payer%' then raise exception '151: tc_po did not patch'; end if;
    execute v_def;
  end if;
  -- 97: a job's money says what the PT paid its suppliers directly and what labour isn't charged
  v_def := pg_get_functiondef('public.tc_job'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 money%' then
    v_def := replace(v_def, $a$'fees', r.job_fees_total, 'tax', r.tax_total, 'total', r.total, 'paid', r.paid_total, 'balance', r.balance,$a$,
      $b$'fees', r.job_fees_total, 'tax', r.tax_total, 'total', r.total, 'paid', r.paid_total, 'balance', r.balance,
                  'paid_by_pt_directly', nullif(r.settled_direct, 0), 'shop_bills', r.total - coalesce(r.settled_direct, 0),   -- 151 money
                  'labour_not_charged_value', nullif(r.labor_waived, 0),$b$);
    v_def := replace(v_def, $a$                                                            'payment', p.payment_status, 'ordered_at', tc_t(p.ordered_at)) order by p.created_at)$a$,
      $b$                                                            'payment', case when p.paid_by_pt or p.paid_by_name is not null then 'paid by the PT directly'
                                                                            when p.talangan_name is not null then 'talangan (driver paid first)'
                                                                            else p.payment_status end,
                                                            'ordered_at', tc_t(p.ordered_at)) order by p.created_at)$b$);
    if v_def not like '%151 money%' or v_def not like '%talangan (driver paid first)%' then raise exception '151: tc_job did not patch'; end if;
    execute v_def;
  end if;
  -- 98: logins that can't see money get "not available", not Rp 0
  v_def := pg_get_functiondef('public.tc_balances'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 money%' then
    v_def := replace(v_def, $a$  with b as (select * from customer_balances where balance_due <> 0 or available_credit <> 0)
  select jsonb_build_object($a$,
      $b$  with b as (select * from customer_balances where balance_due <> 0 or available_credit <> 0)
  select case when not (is_fleet() or has_permission('view_reports') or has_permission('record_payments'))   -- 151 money
              then jsonb_build_object('error', 'Not available for this login (it can''t see money)') else jsonb_build_object($b$);
    v_def := regexp_replace(v_def, $a$'\[\]'\)\)\s*\$function\$$a$, $b$'[]')) end
$function$$b$);
    if v_def not like '%151 money%' or v_def not like '%end
$function$%' then raise exception '151: tc_balances did not patch'; end if;
    execute v_def;
  end if;
  v_def := pg_get_functiondef('public.tc_invoices'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 money%' then
    v_def := replace(v_def, $a$  if k not in ('unpaid', 'overdue', 'recent') then$a$,
      $b$  if not (is_fleet() or has_permission('view_reports') or has_permission('record_payments')) then   -- 151 money
    return jsonb_build_object('error', 'Not available for this login (it can''t see money)');
  end if;
  if k not in ('unpaid', 'overdue', 'recent') then$b$);
    v_def := replace(v_def, $a$'total', r.total, 'paid', r.paid_total, 'balance', r.balance,$a$,
      $a$'total', r.total, 'paid_by_pt_directly', nullif(r.settled_direct, 0), 'paid', r.paid_total, 'balance', r.balance,$a$);
    if v_def not like '%151 money%' or v_def not like '%paid_by_pt_directly%' then raise exception '151: tc_invoices did not patch'; end if;
    execute v_def;
  end if;
  -- 100: a voided invoice number finds its job
  v_def := pg_get_functiondef('public.tc_job_id'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 voided%' then
    v_def := replace(v_def, $a$    select id into r from repair_orders_read where invoice_number = m[1]::bigint * 1000 + m[2]::bigint limit 1;
    if r is not null then return r; end if;$a$,
      $b$    select id into r from repair_orders_read where invoice_number = m[1]::bigint * 1000 + m[2]::bigint limit 1;
    if r is not null then return r; end if;
    -- a voided invoice: its job (151 voided)
    select x.id into r from invoice_voids v join repair_orders_read x on x.id = v.ro_id where v.invoice_number = m[1]::bigint * 1000 + m[2]::bigint limit 1;
    if r is not null then return r; end if;
    select id into r from repair_orders_read where job_number = m[1]::bigint limit 1;
    if r is not null then return r; end if;$b$);
    v_def := replace(v_def, $a$    select id into r from repair_orders_read where invoice_number = d::bigint limit 1; return r;$a$,
      $b$    select id into r from repair_orders_read where invoice_number = d::bigint limit 1;
    if r is null then
      select x.id into r from invoice_voids v join repair_orders_read x on x.id = v.ro_id where v.invoice_number = d::bigint limit 1;
    end if;
    return r;$b$);
    if v_def not like '%151 voided%' then raise exception '151: tc_job_id did not patch'; end if;
    execute v_def;
  end if;
  -- 101: "to order" uses the app's rule (free stock plus what's on order at or under the reorder point, or short);
  -- bulk oil (negative on purpose) is left out
  v_def := pg_get_functiondef('public.tc_stock_low'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def not like '%151 to order%' then
    v_def := replace(v_def, $a$                                  where i.active and s.reorder_point is not null and s.qty_on_hand - coalesce(s.qty_on_estimates, 0) <= s.reorder_point))$a$,
      $b$                                  where i.active and not exists (select 1 from oil_drums d where d.catalog_item_id = s.id)   -- 151 to order
                                    and ((s.reorder_point is not null
                                          and s.qty_on_hand - coalesce(s.qty_on_estimates, 0) + coalesce(s.qty_on_order, 0) <= s.reorder_point)
                                         or s.qty_on_hand - coalesce(s.qty_on_estimates, 0) + coalesce(s.qty_on_order, 0) < 0)))$b$);
    if v_def not like '%151 to order%' then raise exception '151: tc_stock_low did not patch'; end if;
    execute v_def;
  end if;
end $do$;

-- ============================================================================================================
-- 151 I. Deliveries in more than one go (54); what an approval approved (75)
-- ============================================================================================================

-- A PO line keeps one delivery: date, supplier invoice and due date. When the rest of a line that already had parts
-- delivered arrives in another month or on another supplier invoice, it becomes its own line (same part, same job
-- line), so each delivery is billed in its own month with its own invoice number. Returns the line that was delivered.
create or replace function public.po_line_split_rest(p_item uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare l purchase_order_items%rowtype; v_rest numeric; v_new uuid := gen_random_uuid();
begin
  select * into l from purchase_order_items where id = p_item for update;
  v_rest := l.qty_ordered - l.qty_delivered - l.qty_cancelled;
  if v_rest <= 0 then return p_item; end if;
  -- the delivered part first, so the job line isn't on two open PO lines at once
  -- the copy keeps the job line even when that job is already invoiced (it was on the PO before)
  perform set_config('axle.po_split', 'on', true);
  update purchase_order_items set qty_ordered = l.qty_delivered + l.qty_cancelled where id = p_item;
  insert into purchase_order_items
  select (jsonb_populate_record(null::purchase_order_items, to_jsonb(l) || jsonb_build_object(
            'id', v_new, 'qty_ordered', v_rest, 'qty_delivered', 0, 'qty_cancelled', 0, 'qty_paid', 0,
            'delivered_at', null, 'supplier_invoice_no', null, 'invoice_date', null, 'payment_due', null, 'paid_at', null,
            'created_at', l.created_at + interval '1 millisecond'))).*;
  perform set_config('axle.po_split', 'off', true);
  -- a typed-in line added to the catalog: the copy is the same catalog part (138)
  insert into typed_part_links (line_id, source, catalog_item_id, linked_by, linked_at)
  select v_new, t.source, t.catalog_item_id, t.linked_by, t.linked_at from typed_part_links t where t.line_id = p_item
  on conflict (line_id) do nothing;
  return v_new;
end $$;
revoke execute on function public.po_line_split_rest(uuid) from public, anon, authenticated;
-- (guard_po_item lets the split's copy link to an invoiced job's line)
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.guard_po_item'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%axle.po_split%' then return; end if;
  v_def := replace(v_def, $a$    if not v_job_open or v_taken then$a$,
    $b$    if (not v_job_open or v_taken) and tg_op = 'INSERT' and coalesce(current_setting('axle.po_split', true), '') = 'on' then
      null;   -- 151: the rest of a line already on this PO, split off by deliver_po_item
    elsif not v_job_open or v_taken then$b$);
  if v_def not like '%axle.po_split%' then raise exception '151: guard_po_item did not patch'; end if;
  execute v_def;
end $do$;

create or replace function public.deliver_po_item(p_item uuid, p_qty numeric, p_delivered date default null, p_invoice_no text default null,
                                                  p_invoice_date date default null, p_due date default null)
returns void language plpgsql security definer set search_path = public as $$
declare l purchase_order_items%rowtype; v_day date := coalesce(p_delivered, local_date()); v_line uuid := p_item;
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity delivered'; end if;
  select * into l from purchase_order_items where id = p_item for update;
  if not found then raise exception 'PO line not found'; end if;
  -- the rest arriving in another month or on another supplier invoice: its own line (151, review 54)
  if l.qty_delivered > 0 and l.delivered_at is not null
     and (date_trunc('month', l.delivered_at) <> date_trunc('month', v_day)
          or (nullif(btrim(p_invoice_no), '') is not null and l.supplier_invoice_no is not null
              and lower(btrim(p_invoice_no)) <> lower(btrim(l.supplier_invoice_no)))) then
    v_line := po_line_split_rest(p_item);
  end if;
  update purchase_order_items set qty_delivered = qty_delivered + p_qty, delivered_at = v_day,
    supplier_invoice_no = coalesce(nullif(btrim(p_invoice_no), ''), supplier_invoice_no), invoice_date = coalesce(p_invoice_date, invoice_date),
    payment_due = coalesce(p_due, payment_due)
  where id = v_line;
end $$;
revoke execute on function public.deliver_po_item(uuid, numeric, date, text, date, date) from public, anon;
grant execute on function public.deliver_po_item(uuid, numeric, date, text, date, date) to authenticated, service_role;

create or replace function public.mark_po_items_delivered(p_items uuid[], p_delivered date, p_invoice_no text, p_invoice_date date, p_due date)
returns void language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if auth.uid() is not null and not has_permission('manage_inventory') then raise exception 'Not allowed'; end if;
  -- row locks make a double-click harmless: the second call finds nothing left to deliver
  for l in select id, qty_ordered - qty_cancelled - qty_delivered as rest from purchase_order_items
            where id = any(p_items) and qty_delivered < qty_ordered - qty_cancelled order by created_at, id for update loop
    perform deliver_po_item(l.id, l.rest, p_delivered, p_invoice_no, p_invoice_date, p_due);
  end loop;
end $$;

-- 75: an approval keeps the amount approved; the job shows when a service now costs more than that.
-- Kept in its own table (no direct access) so logins that can't see prices don't get it from approvals.
create table if not exists public.approval_amounts (
  approval_id uuid primary key references public.approvals(id) on delete cascade,
  amount numeric not null
);
alter table public.approval_amounts enable row level security;
revoke all on public.approval_amounts from public, anon, authenticated;
create or replace function public.approval_amount() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.service_id is not null then
    insert into approval_amounts (approval_id, amount)
    select new.id, s.service_net from ro_services s where s.id = new.service_id and s.service_net is not null
    on conflict (approval_id) do nothing;
  end if;
  return null;
end $$;
revoke execute on function public.approval_amount() from public, anon, authenticated;
drop trigger if exists approvals_amount on public.approvals;
create trigger approvals_amount after insert on public.approvals for each row execute function public.approval_amount();
-- what each approval on a job approved, for logins that see the job's money (else nothing)
create or replace function public.job_approval_amounts(p_ro uuid) returns table (approval_id uuid, amount numeric)
language sql stable security definer set search_path = public as $$
  select x.approval_id, x.amount from approval_amounts x join approvals a on a.id = x.approval_id
   where a.ro_id = p_ro and exists (select 1 from repair_orders_read r where r.id = p_ro and r.total is not null)
$$;
revoke execute on function public.job_approval_amounts(uuid) from public, anon;
grant execute on function public.job_approval_amounts(uuid) to authenticated;

-- ============================================================================================================
-- 151 J. Names, deletes, history, dashboard counts
-- ============================================================================================================

-- 71: names compare the same however their spaces were typed or pasted (WhatsApp non-breaking spaces, tabs)
create or replace function public.payer_key(p text) returns text language sql immutable as $$
  select nullif(btrim(lower(regexp_replace(coalesce(p, ''), '[\s   -​    　﻿]+', ' ', 'g'))), '')
$$;

-- 69: a stock PO paid by a PT names a PT the app knows (checked with the "bulk oil only" rule, D5)
create or replace function public.guard_stock_po_payer() returns trigger language plpgsql security definer set search_path = public as $$
declare v_po purchase_orders%rowtype; v_po_row boolean := tg_table_name = 'purchase_orders';
begin
  if v_po_row then select * into v_po from purchase_orders where id = new.id;
  else select * into v_po from purchase_orders where id = new.po_id; end if;
  if not found or v_po.ro_id is not null or nullif(btrim(v_po.paid_by_name), '') is null then return null; end if;
  -- the PT named is one the app knows: checked when the name is typed (an old PO with a misspelt name can still be
  -- worked on: cancel a line, receive, pay)
  if v_po_row and (tg_op = 'INSERT' or new.paid_by_name is distinct from old.paid_by_name)
     and not exists (select 1 from customers c where payer_key(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)) = payer_key(v_po.paid_by_name)) then
    raise exception 'Unknown PT "%": pick the PT from the list (PT pembayar of a company)', v_po.paid_by_name;
  end if;
  -- bulk oil only: the PO's lines when the PT is named on it, a line when it is added or its part changes
  if exists (select 1 from purchase_order_items pi left join catalog_items ci on ci.id = pi.catalog_item_id
              where pi.po_id = v_po.id and pi.qty_cancelled < pi.qty_ordered and (v_po_row or pi.id = new.id)
                and not (coalesce(lower(ci.unit), '') in ('l', 'liter', 'litre')
                         or exists (select 1 from oil_drums d where d.catalog_item_id = pi.catalog_item_id))) then
    raise exception 'A stock PO paid by a PT is for bulk oil (a drum) only; put other parts on the job''s PO';
  end if;
  return null;
end $$;
drop trigger if exists po_items_stock_payer on public.purchase_order_items;
create trigger po_items_stock_payer after insert or update of catalog_item_id on public.purchase_order_items
  for each row execute function public.guard_stock_po_payer();

-- 83: a truck with old (pre-app) oil changes can't be deleted (that would take its oil off the drums and bills)
alter table public.oil_preapp drop constraint if exists oil_preapp_vehicle_id_fkey;
alter table public.oil_preapp add constraint oil_preapp_vehicle_id_fkey foreign key (vehicle_id) references public.vehicles(id) on delete restrict;

-- 84: changes to labour rates, role permissions, old oil and truck transfers are logged like other money changes
do $do$
declare t text;
begin
  -- (role_permissions has no id column, which log_activity needs: not logged here)
  execute 'drop trigger if exists log_role_permissions on public.role_permissions';
  foreach t in array array['labor_rates', 'oil_preapp', 'vehicle_transfers'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on public.%I', 'log_' || t, t);
      execute format('create trigger %I after insert or delete or update on public.%I for each row execute function public.log_activity()', 'log_' || t, t);
    end if;
  end loop;
end $do$;

-- 108: Dasbor "Di bengkel" also gives the number of trucks (one truck can have two open jobs)
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.dashboard_summary'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 trucks%' then return; end if;
  v_def := replace(v_def, $a$    'open_estimates', (select count(*) from repair_orders where order_status = 'estimate' and closed_at is null and workflow_status = 'estimate'),$a$,
    $b$    'in_shop_trucks', (select count(distinct vehicle_id) from repair_orders   -- 151 trucks
                        where order_status = 'estimate' and closed_at is null and workflow_status in ('arrived','in_progress','waiting_parts','completed')),
    'open_estimates', (select count(*) from repair_orders where order_status = 'estimate' and closed_at is null and workflow_status = 'estimate'),$b$);
  if v_def not like '%151 trucks%' then raise exception '151: dashboard_summary did not patch'; end if;
  execute v_def;
end $do$;

-- 59: the job's own PO deliveries of a part count for its lines even when a line isn't linked to that PO line, so an
-- invoice isn't wrongly refused as "another book's leftover"
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.leftover_plan'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 own deliveries%' then return; end if;
  v_def := replace(v_def, $a$v_own numeric; v_pending numeric;$a$, $a$v_own numeric; v_own_rest numeric; v_pending numeric;$a$);
  v_def := replace(v_def, $a$    v_free := greatest(0, coalesce(c.shelf, 0) - v_own - v_pending - v_all);$a$,
    $b$    v_free := greatest(0, coalesce(c.shelf, 0) - v_own - v_pending - v_all);
    -- own deliveries not tied to a job line of the part: they cover unlinked lines first (151 own deliveries)
    v_own_rest := greatest(0, v_own - coalesce((select sum(greatest(l.qty_delivered - po_qty_returned(l.id), 0))
                    from ro_service_items i join ro_services s on s.id = i.service_id
                    join purchase_order_items l on l.id = i.po_item_id join purchase_orders po on po.id = l.po_id
                   where s.ro_id = p_ro and i.catalog_item_id = c.cid and po.ro_id = p_ro and po.status <> 'cancelled'), 0));$b$);
  v_def := replace(v_def, $a$      v_left := it.need;$a$,
    $b$      v_left := it.need;
      if v_own_rest > 0 and v_left > 0 then
        v_take := least(v_left, v_own_rest); v_left := v_left - v_take; v_own_rest := v_own_rest - v_take;
      end if;$b$);
  if v_def not like '%151 own deliveries%' or v_def not like '%v_own_rest := v_own_rest - v_take%' then raise exception '151: leftover_plan did not patch'; end if;
  execute v_def;
end $do$;

-- 38: Inventaris — a sub-category shows (and filters) as "Parent › Child", so two "Filter" sub-categories stay apart
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.report_inventory'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%151 category%' then return; end if;
  v_def := replace(v_def, $a$  select ci.id, ci.name, ci.code, ci.brand, cat.name, s.name, ci.active,$a$,
    $a$  select ci.id, ci.name, ci.code, ci.brand,
         case when cat.parent_id is not null then (select p.name from categories p where p.id = cat.parent_id) || ' › ' || cat.name else cat.name end /* 151 category */,
         s.name, ci.active,$a$);
  if v_def not like '%151 category%' then raise exception '151: report_inventory did not patch'; end if;
  execute v_def;
end $do$;

-- ============================================================================================================
-- 151 K. New reports (review 21–25): Tutup bulan, Rp/km per month, Pembelian per supplier, Riwayat ganti part,
-- Stok per pemilik / nilai akhir bulan / koreksi / sisa PO lama. New functions only (no signature changes).
-- ============================================================================================================

-- ---------- K1 (21). Tutup bulan: what to check before the month's bills go out. Owner/Admin.
create or replace function public.report_month_close(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
begin
  if auth.uid() is not null and not is_owner_or_admin() then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    -- invoices whose papers haven't come back (Berkas)
    'paperwork', coalesce((select jsonb_agg(jsonb_build_object('ro_id', r.id, 'invoice_no', r.invoice_no, 'day', (r.invoiced_at at time zone tz)::date,
                                                                'company', c.display_name, 'plate', v.plate) order by r.invoiced_at)
        from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
       where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
         and not exists (select 1 from invoice_paperwork p where p.ro_id = r.id)), '[]'),
    -- invoices made by the owner past a block (open PO, another book's leftover)
    'overrides', coalesce((select jsonb_agg(jsonb_build_object('ro_id', r.id, 'invoice_no', r.invoice_no, 'day', (r.invoiced_at at time zone tz)::date,
                                                                'company', c.display_name, 'plate', v.plate,
                                                                'note', concat_ws(' · ', r.invoice_open_po_note, r.invoice_leftover_note)) order by r.invoiced_at)
        from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
       where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
         and (r.invoice_open_po_note is not null or r.invoice_leftover_note is not null)), '[]'),
    -- parts received in the period on a job that isn't invoiced yet
    'po_not_invoiced', coalesce((select jsonb_agg(jsonb_build_object('ro_id', r.id, 'job_number', r.job_number, 'po_id', po.id, 'po_number', po.po_number,
                                                                      'name', pi.name, 'qty', pi.qty_delivered, 'delivered_at', pi.delivered_at,
                                                                      'company', c.display_name, 'plate', v.plate) order by pi.delivered_at, po.po_number)
        from purchase_order_items pi join purchase_orders po on po.id = pi.po_id join repair_orders r on r.id = po.ro_id
        left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
       where pi.qty_delivered > 0 and pi.delivered_at between p_from and p_to
         and r.order_status = 'estimate' and r.closed_at is null), '[]'),
    -- work finished (Selesai) but no invoice yet
    'done_not_invoiced', coalesce((select jsonb_agg(jsonb_build_object('ro_id', r.id, 'job_number', r.job_number, 'company', c.display_name, 'plate', v.plate,
                                                                        'since', (r.updated_at at time zone tz)::date) order by r.job_number)
        from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
       where r.order_status = 'estimate' and r.closed_at is null and r.workflow_status = 'completed'), '[]'),
    -- parts invoiced at Rp 0 (not inside a package price)
    'zero_parts', coalesce((select jsonb_agg(jsonb_build_object('ro_id', r.id, 'invoice_no', r.invoice_no, 'day', (r.invoiced_at at time zone tz)::date,
                                                                 'name', i.name, 'qty', i.qty, 'plate', v.plate) order by r.invoiced_at, i.name)
        from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders r on r.id = s.ro_id left join vehicles v on v.id = r.vehicle_id
       where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b and s.approval_status = 'approved'
         and s.flat_price is null and i.item_type = 'part' and coalesce(i.price, 0) = 0), '[]'),
    -- drum oil still at 1 L (the litres probably not filled in)
    'oil_one', coalesce((select jsonb_agg(jsonb_build_object('ro_id', r.id, 'invoice_no', r.invoice_no, 'day', (r.invoiced_at at time zone tz)::date,
                                                              'name', i.name, 'plate', v.plate) order by r.invoiced_at)
        from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders r on r.id = s.ro_id left join vehicles v on v.id = r.vehicle_id
       where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b and s.approval_status = 'approved'
         and i.item_type = 'part' and i.qty = 1 and exists (select 1 from oil_drums d where d.catalog_item_id = i.catalog_item_id)), '[]'),
    -- drums with more oil than they hold, or still at an estimated price
    'drums', coalesce((select jsonb_agg(x order by x.opened_on) from (
        select d.id as drum_id, ci.name as oil, d.opened_on, d.litres, d.paid_by_name as payer, d.paid_by_book as book, d.cost_estimated as estimated,
               coalesce((select sum(u.litres) from drum_use u where u.drum_id = d.id), 0) as used   -- invoices and old oil
          from oil_drums d left join catalog_items ci on ci.id = d.catalog_item_id
         where d.opened_on <= p_to and (d.emptied_on is null or d.emptied_on >= p_from)) x
       where x.estimated or x.used > x.litres + 0.005), '[]'),
    -- stock below zero (bulk oil is negative on purpose and left out)
    'negative_stock', coalesce((select jsonb_agg(jsonb_build_object('item_id', ci.id, 'name', ci.name, 'code', ci.code, 'qty', ci.qty_on_hand) order by ci.name)
        from catalog_items ci
       where ci.track_inventory and ci.qty_on_hand < 0 and not exists (select 1 from oil_drums d where d.catalog_item_id = ci.id)), '[]'),
    -- stock counted up or down by hand in the period
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('item_id', ci.id, 'name', ci.name, 'qty', m.qty_change, 'note', m.note,
                                                                  'day', (m.created_at at time zone tz)::date, 'by', p.name) order by m.created_at)
        from stock_movements m join catalog_items ci on ci.id = m.catalog_item_id left join profiles p on p.id = m.created_by
       where m.reason = 'adjustment' and m.created_at >= a and m.created_at < b), '[]'));
end $$;
revoke execute on function public.report_month_close(date, date) from public, anon;
grant execute on function public.report_month_close(date, date) to authenticated;

-- ---------- K2 (22). Rp per km month by month: km counted from the last reading before each month.
-- One row per vehicle, company and month with invoices; km_start = the last km before the month (else the month's
-- first), km_end = the month's last km (km out, else in; invoiced jobs).
create or replace function public.report_km_month(p_from date, p_to date)
returns table (vehicle_id uuid, customer_id uuid, company text, payer text, book text, plate text, month date,
               invoices integer, subtotal numeric, km_start integer, km_end integer)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
        v_staff boolean := has_permission('view_reports');
        v_fleet boolean := is_fleet();
begin
  if not (v_staff or v_fleet) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  with inv as (
    select r.id, r.vehicle_id, r.customer_id, (r.invoiced_at at time zone tz)::date as day, r.invoiced_at, r.subtotal,
           case when r.km_unreadable then null else coalesce(r.odometer_out, r.odometer_in) end as km
      from repair_orders r where r.order_status = 'invoice' and r.vehicle_id is not null
  ), m as (
    select i.vehicle_id, i.customer_id, date_trunc('month', i.day)::date as month, count(*)::int as n, sum(i.subtotal) as subtotal,
           (array_agg(i.km order by i.invoiced_at desc) filter (where i.km is not null))[1] as km_end,
           (array_agg(i.km order by i.invoiced_at) filter (where i.km is not null))[1] as km_first
      from inv i where i.invoiced_at >= a and i.invoiced_at < b
     group by 1, 2, 3
  )
  select m.vehicle_id, m.customer_id, c.display_name,
         coalesce(nullif(btrim(c.payer_name), ''), c.display_name),
         regexp_replace(btrim(coalesce(nullif(btrim(c.book_name), ''), c.display_name)), '\s+', ' ', 'g'),
         v.plate, m.month, m.n, m.subtotal,
         coalesce((select i.km from inv i where i.vehicle_id = m.vehicle_id and i.km is not null and i.day < m.month
                    order by i.invoiced_at desc limit 1), m.km_first),
         m.km_end
    from m left join customers c on c.id = m.customer_id left join vehicles v on v.id = m.vehicle_id
   where v_staff or m.customer_id in (select fleet_customer_ids())
   order by v.plate, m.month;
end $$;
revoke execute on function public.report_km_month(date, date) from public, anon;
grant execute on function public.report_km_month(date, date) to authenticated;

-- ---------- K3 (23). Pembelian per supplier: every PO line delivered in the period (cost prices).
create or replace function public.report_purchases(p_from date, p_to date)
returns table (supplier_id uuid, supplier text, po_id uuid, po_number text, line_id uuid, catalog_item_id uuid, name text, part_number text,
               qty numeric, returned numeric, cost numeric, amount numeric, payer_kind text, payer text, book text,
               ordered_on date, delivered_on date, ro_id uuid, job_number bigint)
language plpgsql stable security definer set search_path = public as $$
declare tz text := shop_tz();
begin
  if auth.uid() is not null and not (is_staff() and (has_permission('view_costs') or has_permission('pay_supplier_bills'))) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  return query
  select s.id, s.name, po.id, po.po_number, pi.id, pi.catalog_item_id, pi.name, coalesce(nullif(btrim(pi.part_number), ''), ci.code),
         pi.qty_delivered, po_qty_returned(pi.id), pi.cost, round(pi.cost * (pi.qty_delivered - po_qty_returned(pi.id))),
         case when po.talangan_name is not null then 'talangan' when po.paid_by_pt or po.paid_by_name is not null then 'pt' else 'shop' end,
         case when po.talangan_name is not null then po.talangan_name
              when po.paid_by_pt or po.paid_by_name is not null then (select x.payer from po_line_book(po.id) x) end,
         case when po.paid_by_pt or po.paid_by_name is not null then (select x.book from po_line_book(po.id) x) end,
         (coalesce(po.ordered_at, po.created_at) at time zone tz)::date, pi.delivered_at, r.id, r.job_number
    from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
    left join suppliers s on s.id = po.supplier_id left join catalog_items ci on ci.id = pi.catalog_item_id
    left join repair_orders r on r.id = po.ro_id
   where pi.qty_delivered > 0 and pi.delivered_at between p_from and p_to
   order by s.name, pi.delivered_at, po.po_number, pi.name;
end $$;
revoke execute on function public.report_purchases(date, date) from public, anon;
grant execute on function public.report_purchases(date, date) to authenticated;

-- ---------- K4 (24). Riwayat ganti part: each part (by catalog part, else name) and each service (by name) invoiced in
-- the period on a truck that had the same part or service before, with when and at what km.
create or replace function public.report_repeats(p_from date, p_to date)
returns table (kind text, ro_id uuid, invoice_no text, day date, km integer, vehicle_id uuid, plate text, customer_id uuid, company text,
               name text, category text, prev_ro_id uuid, prev_invoice_no text, prev_day date, prev_km integer)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
        v_staff boolean := has_permission('view_reports');
        v_fleet boolean := is_fleet();
begin
  if not (v_staff or v_fleet) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  with ev as (
    select 'part'::text as kind, r.id as ro_id, r.invoice_no, r.invoiced_at, r.vehicle_id, r.customer_id,
           case when r.km_unreadable then null else coalesce(r.odometer_out, r.odometer_in) end as km,
           coalesce(i.catalog_item_id::text, lower(btrim(i.name))) as k, i.name, cat.name as category
      from ro_service_items i join ro_services s on s.id = i.service_id and s.approval_status = 'approved'
      join repair_orders r on r.id = s.ro_id and r.order_status = 'invoice'
      left join catalog_items ci on ci.id = i.catalog_item_id left join categories cat on cat.id = ci.category_id
     where i.item_type = 'part' and coalesce(i.qty, 0) > 0
       and not exists (select 1 from oil_drums d where d.catalog_item_id = i.catalog_item_id)   -- oil changes are in Kepatuhan servis
    union all
    select 'service', r.id, r.invoice_no, r.invoiced_at, r.vehicle_id, r.customer_id,
           case when r.km_unreadable then null else coalesce(r.odometer_out, r.odometer_in) end,
           lower(btrim(s.name)), s.name, null
      from ro_services s join repair_orders r on r.id = s.ro_id and r.order_status = 'invoice'
     where s.approval_status = 'approved'
  ), d as (select distinct on (e.kind, e.ro_id, e.k) e.* from ev e order by e.kind, e.ro_id, e.k)
  select e.kind, e.ro_id, e.invoice_no, (e.invoiced_at at time zone tz)::date, e.km, e.vehicle_id, v.plate, e.customer_id, c.display_name,
         e.name, e.category, p.ro_id, p.invoice_no, (p.invoiced_at at time zone tz)::date, p.km
    from d e
    join lateral (select x.* from d x where x.kind = e.kind and x.vehicle_id = e.vehicle_id and x.k = e.k and x.invoiced_at < e.invoiced_at
                   order by x.invoiced_at desc limit 1) p on true
    left join vehicles v on v.id = e.vehicle_id left join customers c on c.id = e.customer_id
   where e.invoiced_at >= a and e.invoiced_at < b
     and (v_staff or e.customer_id in (select fleet_customer_ids()))
   order by v.plate, e.invoiced_at, e.name;
end $$;
revoke execute on function public.report_repeats(date, date) from public, anon;
grant execute on function public.report_repeats(date, date) to authenticated;

-- ---------- K5 (25). Stock at a day's end (quantity and value at today's cost), and whose it is now: the shop's, or
-- PTs' leftovers from their POs (with the oldest leftover's age). Bulk oil is left out (drums).
create or replace function public.report_stock_owner(p_at date)
returns table (item_id uuid, name text, code text, category text, cost numeric, qty_now numeric, qty_at numeric, value_at numeric,
               pt_qty numeric, pt_owners text, oldest_leftover date)
language plpgsql stable security definer set search_path = public as $$
declare tz text := shop_tz(); b timestamptz;
begin
  if auth.uid() is not null and not (has_permission('view_reports') and has_permission('view_costs')) then raise exception 'Not allowed'; end if;
  if p_at is null or p_at > local_date() or p_at < date '2000-01-01' then raise exception 'Choose a day up to today'; end if;
  b := shop_start(p_at + 1);
  return query
  with after as (
    select m.catalog_item_id as id, sum(m.qty_change) as q from stock_movements m where m.created_at >= b group by 1
  ), lo as (
    select x.catalog_item_id as id, sum(x.remaining) as q,
           string_agg(distinct case when x.book is null or lower(x.book) = lower(x.payer) then x.payer else x.payer || ' · ' || x.book end, ', ') as who,
           min((x.since at time zone tz)::date) as oldest
      from po_leftovers() x where x.remaining > 0 and x.catalog_item_id is not null group by 1
  )
  select ci.id, ci.name, ci.code,
         case when cat.parent_id is not null then (select p.name from categories p where p.id = cat.parent_id) || ' › ' || cat.name else cat.name end,
         ci.cost, ci.qty_on_hand, ci.qty_on_hand - coalesce(after.q, 0),
         round(greatest(ci.qty_on_hand - coalesce(after.q, 0), 0) * coalesce(ci.cost, 0)),
         coalesce(lo.q, 0), lo.who, lo.oldest
    from catalog_items ci left join categories cat on cat.id = ci.category_id
    left join after on after.id = ci.id left join lo on lo.id = ci.id
   where ci.track_inventory and not exists (select 1 from oil_drums d where d.catalog_item_id = ci.id)
     and (ci.qty_on_hand <> 0 or coalesce(after.q, 0) <> 0 or lo.id is not null)
   order by ci.name, ci.id;
end $$;
revoke execute on function public.report_stock_owner(date) from public, anon;
grant execute on function public.report_stock_owner(date) to authenticated;

-- ---------- K6. The new report functions through report_rows (one JSON list per report, past the 1.000-row limit)
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.report_rows'::regproc);
  v_def := replace(v_def, E'\r', '');   -- (staging keeps CRLF line endings)
  if v_def like '%report_km_month%' then return; end if;
  v_def := replace(v_def, $a$    else raise exception 'Unknown report';$a$,
$b$    when 'report_profit_pt' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_profit_pt(p_from, p_to) with ordinality t;
    when 'report_rekap_inv' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_rekap_inv(p_from, p_to) with ordinality t;
    when 'report_km_month' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_km_month(p_from, p_to) with ordinality t;
    when 'report_purchases' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_purchases(p_from, p_to) with ordinality t;
    when 'report_repeats' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_repeats(p_from, p_to) with ordinality t;
    when 'report_stock_owner' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_stock_owner(p_to) with ordinality t;
    else raise exception 'Unknown report';$b$);
  if v_def not like '%report_km_month%' then raise exception '151: report_rows did not patch'; end if;
  execute v_def;
end $do$;


-- ============================================================================================================
-- 151 Z. Open estimates work out again with the new rules (PT's share at full price, packages, leftovers, cores)
-- ============================================================================================================
do $do$
declare r record;
begin
  for r in select ro.id from repair_orders ro join customers c on c.id = ro.customer_id
            where ro.order_status = 'estimate' and ro.closed_at is null and (c.paid_direct or c.labour_not_charged) order by ro.id loop
    perform recalc_repair_order(r.id);
  end loop;
end $do$;
