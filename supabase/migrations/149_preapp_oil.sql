-- 149 · Nov 13, 2026 (Denny, item 48): oil changes done before the app ("sebelum aplikasi").
-- Before the app (2 Nov 2026) trucks had their oil changed from the shop's bulk-oil drums with no invoice. Those oil
-- changes are recorded once (one-off import, no entry screen): truck, the company it belonged to, the oil, date, km,
-- litres, note. They are never sales and create no invoice. They:
--   * count in the drums: a drum's pre-app use is its FIRST use (before the invoices), so the PT that used the oil owes
--     the drum's owner (Drum page, "Tagihan oli drum" print, Tandai lunas, and what Tagihan PT shows as still open);
--   * show in the vehicle's history, Rekap servis and Biaya armada as a separate "sebelum aplikasi" part, never in totals;
--   * (data step, not here) give each truck's engine-oil schedule its last change.
-- A drum can be marked empty (emptied_on): what the app still thinks is in it is then "tidak tercatat" (used, not
-- recorded anywhere; nobody owes it).

-- ===== 1. the pre-app oil changes =================================================================================
create table if not exists public.oil_preapp (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  customer_id uuid not null references public.customers(id),          -- the truck's company then (who used the oil)
  catalog_item_id uuid not null references public.catalog_items(id),   -- the bulk oil
  oil_name text,                                -- its name (for the vehicle history, also for fleet managers)
  done_on date not null,
  km int check (km >= 0),
  litres numeric(12,2) not null check (litres > 0),
  note text check (char_length(note) <= 200),
  payer text,                                   -- the paying PT then (only for companies that pay their own parts)
  book text,                                    -- its book then
  batch text,                                   -- the import it came from (to undo it)
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.oil_preapp add column if not exists oil_name text;
create index if not exists oil_preapp_vehicle_idx on public.oil_preapp (vehicle_id, done_on);
create index if not exists oil_preapp_item_idx on public.oil_preapp (catalog_item_id, done_on);
alter table public.oil_preapp enable row level security;
revoke all on public.oil_preapp from public, anon, authenticated;
grant select (id, vehicle_id, customer_id, catalog_item_id, oil_name, done_on, km, litres, note, payer, book, created_at) on public.oil_preapp to authenticated;
drop policy if exists "staff and own fleet read oil_preapp" on public.oil_preapp;
create policy "staff and own fleet read oil_preapp" on public.oil_preapp for select to authenticated
  using ((select public.is_staff()) or customer_id in (select public.fleet_customer_ids()));

-- the paying PT and book are kept as they were (like an invoice's bill-to), and the company follows the truck
create or replace function public.oil_preapp_fill() returns trigger
language plpgsql security definer set search_path = public as $$
declare c customers%rowtype;
begin
  if new.customer_id is null then select customer_id into new.customer_id from vehicles where id = new.vehicle_id; end if;
  select * into c from customers where id = new.customer_id;
  if tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id then
    new.payer := case when c.paid_direct then canon_payer(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)) end;
    new.book := regexp_replace(btrim(coalesce(nullif(btrim(c.book_name), ''), c.display_name)), '\s+', ' ', 'g');
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  new.oil_name := (select name from catalog_items where id = new.catalog_item_id);
  if not exists (select 1 from oil_drums where catalog_item_id = new.catalog_item_id) then
    raise exception 'Only oil from a drum can be recorded as a pre-app oil change';
  end if;
  return new;
end $$;
revoke execute on function public.oil_preapp_fill() from public, anon, authenticated;
drop trigger if exists oil_preapp_fill on public.oil_preapp;
create trigger oil_preapp_fill before insert or update on public.oil_preapp for each row execute function public.oil_preapp_fill();

-- ===== 2. a drum can be marked empty ==============================================================================
alter table public.oil_drums add column if not exists emptied_on date;
grant select (emptied_on), insert (emptied_on), update (emptied_on) on public.oil_drums to authenticated;

-- ===== 3. drum use: an invoice line or a pre-app oil change =======================================================
alter table public.drum_use add column if not exists preapp_id uuid references public.oil_preapp(id) on delete cascade;
alter table public.drum_use alter column line_id drop not null;
alter table public.drum_use alter column ro_id drop not null;
do $$ begin
  alter table public.drum_use add constraint drum_use_one_source
    check ((preapp_id is null and line_id is not null and ro_id is not null) or (preapp_id is not null and line_id is null and ro_id is null));
exception when duplicate_object then null; end $$;
create unique index if not exists drum_use_preapp_drum_idx on public.drum_use (preapp_id, drum_id) where preapp_id is not null;

-- a pre-app oil change takes from the drums like an invoice line, oldest drum first, whatever the opening date
create or replace function public.drum_take_preapp(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o record; d record; v_need numeric; v_take numeric; v_left numeric; v_last uuid;
begin
  delete from drum_use where preapp_id = p_id;
  select * into o from oil_preapp where id = p_id;
  if not found then return; end if;
  v_need := o.litres;
  for d in select od.id, od.litres - coalesce((select sum(u.litres) from drum_use u where u.drum_id = od.id), 0) as left_l
             from oil_drums od where od.catalog_item_id = o.catalog_item_id
            order by od.opened_on, od.created_at, od.id loop
    v_last := d.id;
    exit when v_need <= 0;
    v_left := greatest(d.left_l, 0);
    if v_left > 0 then
      v_take := least(v_need, v_left);
      insert into drum_use (drum_id, preapp_id, catalog_item_id, litres) values (d.id, o.id, o.catalog_item_id, v_take);
      v_need := v_need - v_take;
    end if;
  end loop;
  if v_need > 0 and v_last is not null then
    insert into drum_use (drum_id, preapp_id, catalog_item_id, litres) values (v_last, o.id, o.catalog_item_id, v_need)
    on conflict (preapp_id, drum_id) where preapp_id is not null do update set litres = drum_use.litres + excluded.litres;
  end if;
end $$;
revoke execute on function public.drum_take_preapp(uuid) from public, anon, authenticated;

-- rebuilt from scratch: the pre-app oil changes first (by date), then the invoices (as before)
create or replace function public.drum_rebuild(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if p_item is null then return; end if;
  delete from drum_use where catalog_item_id = p_item;
  for r in select o.id from oil_preapp o where o.catalog_item_id = p_item order by o.done_on, o.created_at, o.id loop
    perform drum_take_preapp(r.id);
  end loop;
  for r in select i.id from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders ro on ro.id = s.ro_id
            where i.catalog_item_id = p_item and i.item_type = 'part' and i.stock_deducted and i.qty > 0 and ro.order_status = 'invoice'
            order by ro.invoiced_at, ro.invoice_number, i.id loop
    perform drum_take(r.id);
  end loop;
end $$;

create or replace function public.oil_preapp_to_drums() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform drum_rebuild(old.catalog_item_id); end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.catalog_item_id is distinct from old.catalog_item_id) then
    perform drum_rebuild(new.catalog_item_id);
  end if;
  return null;
end $$;
revoke execute on function public.oil_preapp_to_drums() from public, anon, authenticated;
drop trigger if exists oil_preapp_to_drums on public.oil_preapp;
create trigger oil_preapp_to_drums after insert or update or delete on public.oil_preapp
  for each row execute function public.oil_preapp_to_drums();

-- litres a PT · book took from a drum (invoices and pre-app): what it owes, before payments
create or replace function public.drum_book_litres(p_drum uuid, p_payer text, p_book text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(x.litres), 0) from (
    select u.litres, pb.payer, pb.book from drum_use u join repair_orders r on r.id = u.ro_id cross join lateral ro_payer_book(r.id) pb
     where u.drum_id = p_drum and r.order_status = 'invoice'
    union all
    select u.litres, o.payer, o.book from drum_use u join oil_preapp o on o.id = u.preapp_id
     where u.drum_id = p_drum) x
  where payer_key(x.payer) is not distinct from payer_key(p_payer) and payer_key(x.book) is not distinct from payer_key(p_book)
$$;
revoke execute on function public.drum_book_litres(uuid, text, text) from public, anon, authenticated;

-- ===== 4. the Drum page (drum_report, from 143) with the pre-app use and "tidak tercatat" =========================
create or replace function public.drum_report(p_item uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb; v_money boolean;
begin
  if auth.uid() is not null and not is_staff() then raise exception 'Not allowed'; end if;
  v_money := auth.uid() is null or has_permission('view_costs') or has_permission('pay_supplier_bills');
  with dr as (
    select d.*, row_number() over (partition by d.catalog_item_id order by d.opened_on desc, d.created_at desc, d.id desc) = 1 as last
      from oil_drums d where p_item is null or d.catalog_item_id = p_item),
  uses as (
    select u.drum_id, r.customer_id,
           case when (select c0.paid_direct from customers c0 where c0.id = r.customer_id) then payer_of(r.customer_id) end as payer,
           book_of(r.customer_id) as book, u.litres, r.invoiced_at as at, false as preapp,
           jsonb_build_object('ro_id', r.id, 'job_number', r.job_number, 'invoice_number', r.invoice_number,
                              'litres', u.litres, 'invoiced_at', r.invoiced_at) as job
      from drum_use u join repair_orders r on r.id = u.ro_id
     where u.drum_id in (select id from dr)
    union all
    select u.drum_id, o.customer_id, o.payer, o.book, u.litres, (o.done_on::timestamp at time zone shop_tz()), true,
           jsonb_build_object('preapp', true, 'preapp_id', o.id, 'litres', u.litres, 'done_on', o.done_on, 'km', o.km,
                              'vehicle_id', o.vehicle_id, 'plate', (select v.plate from vehicles v where v.id = o.vehicle_id))
      from drum_use u join oil_preapp o on o.id = u.preapp_id
     where u.drum_id in (select id from dr)),
  per_co as (
    select x.drum_id, x.customer_id, x.payer, x.book, sum(x.litres) as litres,
           coalesce(sum(x.litres) filter (where x.preapp), 0) as preapp_litres,
           jsonb_agg(x.job order by x.at) as jobs
      from uses x group by x.drum_id, x.customer_id, x.payer, x.book),
  drums as (
    select dr.catalog_item_id, jsonb_build_object(
             'id', dr.id, 'litres', dr.litres, 'cost_per_l', case when v_money then dr.cost_per_l end,
             'cost_estimated', dr.cost_estimated,
             'paid_by', canon_payer(dr.paid_by_name), 'paid_by_book', dr.paid_by_book, 'opened_on', dr.opened_on,
             'po_item_id', dr.po_item_id, 'note', dr.note, 'last', dr.last, 'emptied_on', dr.emptied_on,
             'used', coalesce((select sum(litres) from per_co where drum_id = dr.id), 0),
             'preapp', coalesce((select sum(preapp_litres) from per_co where drum_id = dr.id), 0),
             'left', dr.litres - coalesce((select sum(litres) from per_co where drum_id = dr.id), 0),
             'untracked', case when dr.emptied_on is not null
                               then greatest(dr.litres - coalesce((select sum(litres) from per_co where drum_id = dr.id), 0), 0) end,
             'companies', coalesce((select jsonb_agg(jsonb_build_object('customer_id', pc.customer_id, 'company', c.display_name,
                                                                       'payer', pc.payer, 'book', pc.book, 'litres', pc.litres,
                                                                       'preapp', pc.preapp_litres,
                                                                       'value', case when v_money then round(pc.litres * dr.cost_per_l) end, 'jobs', pc.jobs)
                                                    order by pc.payer nulls last, pc.book, c.display_name)
                                    from per_co pc join customers c on c.id = pc.customer_id where pc.drum_id = dr.id), '[]'),
             'owed', coalesce((select jsonb_agg(jsonb_build_object('payer', x.payer, 'book', x.book, 'litres', x.litres,
                                                                  'amount', case when v_money then round(x.litres * dr.cost_per_l) end)
                                                order by x.payer nulls last, x.book)
                                 from (select pc.payer, case when pc.payer is not null then pc.book end as book, sum(pc.litres) as litres
                                         from per_co pc
                                        where pc.drum_id = dr.id and drum_owes(dr.paid_by_name, dr.paid_by_book, pc.payer, pc.book)
                                        group by 1, 2) x), '[]')
           ) as j, dr.opened_on, dr.created_at, dr.id
      from dr)
  select coalesce(jsonb_agg(jsonb_build_object(
           'catalog_item_id', ci.id, 'name', ci.name, 'unit', ci.unit, 'on_hand', ci.qty_on_hand,
           'on_open_jobs', coalesce((select sum(i.qty) from ro_service_items i join ro_services s on s.id = i.service_id
                                       join repair_orders r on r.id = s.ro_id
                                      where i.catalog_item_id = ci.id and i.item_type = 'part' and not i.stock_deducted
                                        and r.order_status = 'estimate' and r.closed_at is null
                                        and s.approval_status in ('approved', 'pending')), 0),
           'drums', (select jsonb_agg(d.j order by d.opened_on, d.created_at, d.id) from drums d where d.catalog_item_id = ci.id))
         order by ci.name), '[]')
    into out
    from catalog_items ci where ci.id in (select catalog_item_id from oil_drums where p_item is null or catalog_item_id = p_item);
  return out;
end $$;

-- ===== 5. "Tagihan oli drum" (drum_statement, from 145) with the pre-app oil changes ==============================
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
    select u.drum_id, u.payer, case when u.payer is null then null else u.book end as book,
           sum(u.litres) as litres_all,
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
                where p.drum_id = d.id and payer_key(p.payer) is not distinct from payer_key(x.payer)
                  and payer_key(p.book) is not distinct from payer_key(x.book)) pp on true
            where x.drum_id = d.id), '[]'))
         order by ci.name, d.opened_on, d.created_at), '[]')
    into out
    from oil_drums d join catalog_items ci on ci.id = d.catalog_item_id;
  return jsonb_build_object('from', p_from, 'to', p_to, 'drums', out);
end $$;

-- ===== 6. Tagihan PT (pt_supplier_bills, from 145): "still open" on a drum counts the pre-app litres too ============
create or replace function public.pt_supplier_bills(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', coalesce(p_month, local_date()))::date; m1 date; v_ids uuid[];
begin
  if auth.uid() is not null and not (has_permission('view_costs') or has_permission('pay_supplier_bills')) then raise exception 'Not allowed'; end if;
  m1 := (m0 + interval '1 month')::date;
  select array_agg(pi.id) into v_ids
    from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
   where (po.paid_by_pt or po.paid_by_name is not null) and pi.qty_delivered - po_qty_returned(pi.id) > 0
     and pi.delivered_at >= m0 and pi.delivered_at < m1;
  return jsonb_build_object('month', m0,
    'lines', coalesce((select jsonb_agg(x order by x.payer, x.book, x.supplier, x.delivered_at, x.po_number) from (
      select coalesce(case when po.ro_id is not null then payer_of(r.customer_id) end, canon_payer(po.paid_by_name)) as payer,
             case when po.ro_id is not null then book_of(r.customer_id) else po.paid_by_book end as book,
             s.name as supplier, po.id as po_id, po.po_number, r.id as ro_id, r.job_number, c.display_name as company, v.plate,
             pi.id as line_id, pi.name, pi.line_type, pi.delivered_at, pi.supplier_invoice_no,
             a.qty, pi.cost, a.base, a.tax, a.amount,
             case when po.talangan_name is not null then jsonb_build_object('name', po.talangan_name, 'phone', po.talangan_phone,
                    'nota', po.talangan_nota, 'reimbursed_on', po.reimbursed_on, 'method', po.reimbursed_method,
                    'reference', po.reimbursed_reference) end as talangan
        from po_amounts('delivered', coalesce(v_ids, '{}')) a
        join purchase_order_items pi on pi.id = a.line_id join purchase_orders po on po.id = pi.po_id
        left join suppliers s on s.id = po.supplier_id
        left join repair_orders r on r.id = po.ro_id left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id) x), '[]'),
    'drum_oil', coalesce((select jsonb_agg(y order by y.payer, y.book, y.drum_payer, y.drum_book, y.day, y.invoice_no) from (
      select pb.payer, pb.book, d.id as drum_id, ci.name as oil, ci.unit, canon_payer(d.paid_by_name) as drum_payer, d.paid_by_book as drum_book,
             r.id as ro_id, r.invoice_no, r.job_number, (r.invoiced_at at time zone shop_tz())::date as day, v.plate, c.display_name as company,
             u.litres, d.cost_per_l, d.cost_estimated as estimated, round(u.litres * d.cost_per_l) as amount,
             greatest(round(drum_book_litres(d.id, pb.payer, pb.book) * d.cost_per_l)
                      - coalesce((select sum(p.amount) from drum_debt_payments p where p.drum_id = d.id
                                    and payer_key(p.payer) is not distinct from payer_key(pb.payer)
                                    and payer_key(p.book) is not distinct from payer_key(pb.book)), 0), 0) as drum_open
        from drum_use u join repair_orders r on r.id = u.ro_id join oil_drums d on d.id = u.drum_id
        join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
        left join catalog_items ci on ci.id = d.catalog_item_id
        cross join lateral ro_payer_book(r.id) pb
       where r.order_status = 'invoice' and pb.payer is not null
         and (r.invoiced_at at time zone shop_tz())::date >= m0 and (r.invoiced_at at time zone shop_tz())::date < m1
         and drum_owes(d.paid_by_name, d.paid_by_book, pb.payer, pb.book)) y), '[]'));
end $$;

revoke execute on function public.pt_supplier_bills(date) from public, anon;
grant execute on function public.pt_supplier_bills(date) to authenticated;

-- ===== 7. reports: the pre-app oil changes in a period (Rekap servis, Biaya armada) ==================================
-- Staff who see reports, and fleet managers (their companies). The value (litres × the drum's price) only for those
-- who see money in reports, and fleet managers (as on the Rekap servis).
create or replace function public.report_preapp(p_from date, p_to date)
returns table(preapp_id uuid, done_on date, km int, customer_id uuid, company text, payer text, book text, vehicle_id uuid,
              plate text, make text, model text, year int, catalog_item_id uuid, oil text, unit text, litres numeric, value numeric, note text)
language plpgsql stable security definer set search_path = public as $$
declare v_staff boolean := has_permission('view_reports') or has_permission('view_ops_reports');
        v_fleet boolean := is_fleet();
        v_money boolean := has_permission('view_reports') or is_fleet();
begin
  if not (v_staff or v_fleet) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  return query
  select o.id, o.done_on, o.km, o.customer_id, c.display_name,
         coalesce(o.payer, nullif(btrim(c.payer_name), ''), c.display_name),
         coalesce(o.book, nullif(btrim(c.book_name), ''), c.display_name),
         o.vehicle_id, v.plate, v.make, v.model, v.year, o.catalog_item_id, ci.name, ci.unit, o.litres,
         case when v_money then (select round(sum(u.litres * d.cost_per_l)) from drum_use u join oil_drums d on d.id = u.drum_id where u.preapp_id = o.id) end,
         o.note
  from oil_preapp o
  join customers c on c.id = o.customer_id
  join vehicles v on v.id = o.vehicle_id
  join catalog_items ci on ci.id = o.catalog_item_id
  where o.done_on between p_from and p_to
    and (v_staff or o.customer_id in (select fleet_customer_ids()))
  order by c.display_name, v.plate, o.done_on, ci.name, o.id;
end $$;
revoke execute on function public.report_preapp(date, date) from public, anon;
grant execute on function public.report_preapp(date, date) to authenticated;

create or replace function public.report_rows(p_report text, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare out jsonb;
begin
  case p_report
    when 'report_sales' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_sales(p_from, p_to) with ordinality t;
    when 'report_voids' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_voids(p_from, p_to) with ordinality t;
    when 'report_aging' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_aging() with ordinality t;
    when 'report_open_credits' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_open_credits() with ordinality t;
    when 'report_payments' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_payments(p_from, p_to) with ordinality t;
    when 'report_profit' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_profit(p_from, p_to) with ordinality t;
    when 'report_technicians' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_technicians(p_from, p_to) with ordinality t;
    when 'report_fleet' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_fleet(p_from, p_to) with ordinality t;
    when 'report_inventory' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_inventory(p_from, p_to) with ordinality t;
    when 'report_service_status' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_service_status() with ordinality t;
    when 'report_service_done' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_service_done(p_from, p_to) with ordinality t;
    when 'report_rekap' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_rekap(p_from, p_to) with ordinality t;
    when 'report_preapp' then select jsonb_agg(to_jsonb(t) - 'ordinality' order by t.ordinality) into out from report_preapp(p_from, p_to) with ordinality t;
    else raise exception 'Unknown report';
  end case;
  return coalesce(out, '[]'::jsonb);
end $$;
