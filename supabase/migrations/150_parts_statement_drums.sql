-- 150: items 49–54 (Denny, Nov 14–16, 2026)
--  49  every part has a part number (or is ticked "tidak punya nomor part") and is in the catalog; part-name dictionary;
--      invoicing refuses typed parts and parts without a number unless Pemilik/Admin give a reason
--  50  a part that came into stock from a PT-paid PO line of the same job counts as paid by the PT
--  51  fleet manager logins: switches "Setujui servis" and "Lihat tagihan & biaya"; books = the linked companies
--  53  monthly statement per book (Pemilik/Admin, and fleet logins with "Lihat tagihan & biaya" for their books)
--  54  drums take oil by date (the drum open on that day), an over-used drum no longer spills into the next one
-- Safe to run twice.

-- ===== 49. part numbers ==============================================================================================
alter table public.catalog_items add column if not exists no_part_number boolean not null default false;
alter table public.catalog_items add column if not exists no_part_number_by uuid;
alter table public.catalog_items add column if not exists no_part_number_at timestamptz;

create or replace function public.catalog_no_part_number() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nullif(btrim(coalesce(new.code, '')), '') is not null then
    new.no_part_number := false;
  end if;
  if new.no_part_number and (tg_op = 'INSERT' or not old.no_part_number) then
    new.no_part_number_by := auth.uid();
    new.no_part_number_at := now();
  elsif not new.no_part_number then
    new.no_part_number_by := null;
    new.no_part_number_at := null;
  end if;
  return new;
end $$;
drop trigger if exists catalog_items_no_part_number on public.catalog_items;
create trigger catalog_items_no_part_number before insert or update of code, no_part_number on public.catalog_items
  for each row execute function public.catalog_no_part_number();
-- catalog_items has column grants (129): the tick can be read and set like the other part fields
grant select (no_part_number, no_part_number_by, no_part_number_at) on public.catalog_items to authenticated;
grant insert (no_part_number), update (no_part_number) on public.catalog_items to authenticated;

-- catalog view (from 145) with the tick at the end
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
  t.alt_numbers, t.fits, t.unit, t.alt_parts,
  t.no_part_number, t.no_part_number_by, t.no_part_number_at
from public.catalog_items t cross join p
where (select public.is_staff());
revoke all on public.catalog_items_read from public, anon;
grant select on public.catalog_items_read to authenticated;

-- part-name dictionary: a word or phrase people write (wrong) and how the catalog writes it (right)
create table if not exists public.part_name_words (
  id uuid primary key default gen_random_uuid(),
  wrong text not null check (char_length(btrim(wrong)) between 1 and 60),
  right_text text not null check (char_length(btrim(right_text)) between 1 and 60),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists part_name_words_wrong on public.part_name_words (lower(btrim(wrong)));
alter table public.part_name_words enable row level security;
revoke all on public.part_name_words from anon, authenticated;
grant select, insert, update, delete on public.part_name_words to authenticated;
drop policy if exists "staff read part words" on public.part_name_words;
create policy "staff read part words" on public.part_name_words for select to authenticated using ((select public.is_staff()));
drop policy if exists "owner admin add part words" on public.part_name_words;
create policy "owner admin add part words" on public.part_name_words for insert to authenticated with check ((select public.is_owner_or_admin()));
drop policy if exists "owner admin change part words" on public.part_name_words;
create policy "owner admin change part words" on public.part_name_words for update to authenticated
  using ((select public.is_owner_or_admin())) with check ((select public.is_owner_or_admin()));
drop policy if exists "owner admin delete part words" on public.part_name_words;
create policy "owner admin delete part words" on public.part_name_words for delete to authenticated using ((select public.is_owner_or_admin()));

insert into public.part_name_words (wrong, right_text)
select w, r from (values
  ('isuzu nmr 71', 'Elf NMR71'), ('isuzu nmr71', 'Elf NMR71'), ('elf nmr 71', 'Elf NMR71'), ('nmr 71', 'NMR71'),
  ('mitsubishi engkel', 'Colt FE71'), ('engkel', 'FE71'),
  ('mitsubishi colt t 120 ss', 'Colt T120SS'), ('colt t 120 ss', 'Colt T120SS'), ('t 120 ss', 'T120SS'), ('t120 ss', 'T120SS'),
  ('24 volt', '24V'), ('12 volt', '12V'), ('24volt', '24V'), ('12volt', '12V'),
  ('perseneling', 'perseneling'), ('persneling', 'perseneling'), ('porseneling', 'perseneling'),
  ('vanbelt', 'Vanbelt'), ('fan belt', 'Vanbelt'), ('shockbreaker', 'Shock breaker'), ('shock absorber', 'Shock breaker'),
  ('saringan oli', 'Filter oli'), ('saringan solar', 'Filter solar'), ('saringan udara', 'Filter udara')
) v(w, r)
where not exists (select 1 from public.part_name_words x where lower(btrim(x.wrong)) = lower(btrim(v.w)));

-- the job's parts without a number: typed by hand (not in the catalog), catalog parts with no number that aren't
-- ticked, and ticked ones (asked to confirm). Approved services only.
create or replace function public.job_part_numbers(p_ro uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'typed', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name) order by i.position)
                         from ro_service_items i join ro_services s on s.id = i.service_id
                        where s.ro_id = p_ro and s.approval_status = 'approved' and i.item_type = 'part' and i.catalog_item_id is null
                          and i.qty > 0), '[]'),
    'missing', coalesce((select jsonb_agg(distinct jsonb_build_object('id', ci.id, 'name', ci.name))
                           from ro_service_items i join ro_services s on s.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
                          where s.ro_id = p_ro and s.approval_status = 'approved' and i.item_type = 'part' and i.qty > 0
                            and nullif(btrim(coalesce(ci.code, '')), '') is null and not ci.no_part_number), '[]'),
    'ticked', coalesce((select jsonb_agg(distinct jsonb_build_object('id', ci.id, 'name', ci.name))
                          from ro_service_items i join ro_services s on s.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
                         where s.ro_id = p_ro and s.approval_status = 'approved' and i.item_type = 'part' and i.qty > 0
                           and nullif(btrim(coalesce(ci.code, '')), '') is null and ci.no_part_number), '[]'))
  where auth.uid() is null or (select is_staff())
$$;
revoke execute on function public.job_part_numbers(uuid) from public, anon;
grant execute on function public.job_part_numbers(uuid) to authenticated;

-- convert_to_invoice: refuse typed parts and parts without a number unless a reason was given (Pemilik/Admin)
do $$
declare def text; anchor text; changed text;
begin
  select pg_get_functiondef('public.convert_to_invoice(uuid)'::regprocedure) into def;
  if position('axle.parts_reason' in def) > 0 then return; end if;   -- already patched
  anchor := '  if ro.odometer_in is null and not ro.km_unreadable then raise exception ''Enter the km in before invoicing''; end if;   -- (143)';
  if position(anchor in def) = 0 then raise exception 'convert_to_invoice: not as expected (150)'; end if;
  changed := replace(def, anchor, anchor || chr(10) ||
    '  -- every part has a part number (150, item 49)' || chr(10) ||
    '  if exists (select 1 from ro_service_items i join ro_services s on s.id = i.service_id left join catalog_items ci on ci.id = i.catalog_item_id' || chr(10) ||
    '              where s.ro_id = p_ro and s.approval_status = ''approved'' and i.item_type = ''part'' and i.qty > 0' || chr(10) ||
    '                and (i.catalog_item_id is null or (nullif(btrim(coalesce(ci.code, '''')), '''') is null and not ci.no_part_number)))' || chr(10) ||
    '     and nullif(btrim(coalesce(current_setting(''axle.parts_reason'', true), '''')), '''') is null then' || chr(10) ||
    '    raise exception ''Every part needs a part number: add typed parts to the catalog, and give each part its number or tick "tidak punya nomor part"'';' || chr(10) ||
    '  end if;');
  execute changed;
end $$;

create or replace function public.convert_to_invoice_reason(p_ro uuid, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_owner_or_admin() then
    raise exception 'Only the Owner or an Admin can invoice this job anyway';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Write why the invoice is made anyway'; end if;
  perform set_config('axle.open_po_reason', left(btrim(p_reason), 250), true);
  perform set_config('axle.leftover_reason', left(btrim(p_reason), 250), true);
  perform set_config('axle.parts_reason', left(btrim(p_reason), 250), true);
  return convert_to_invoice(p_ro);
end $$;
revoke execute on function public.convert_to_invoice_reason(uuid, text) from public, anon;
grant execute on function public.convert_to_invoice_reason(uuid, text) to authenticated;

-- ===== 50. a PT-paid PO part that went through stock is still paid by the PT ==========================================
-- A tracked part on a job with no PO line of its own: if the job's own PT-paid PO received that catalog part on a line
-- that isn't tied to a job line (a typed line added to the catalog after it arrived, or a catalog line ordered apart),
-- that quantity counts as paid by the PT.
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
        else least(coalesce((
          select sum(greatest(o.qty_delivered - po_qty_returned(o.id), 0))
            from purchase_order_items o join purchase_orders po on po.id = o.po_id
           where po.ro_id = (select s.ro_id from ro_service_items i join ro_services s on s.id = i.service_id where i.id = p_item)
             and (po.paid_by_pt or po.paid_by_name is not null) and po.status <> 'cancelled'
             and o.ro_service_item_id is null
             and (o.catalog_item_id = p_cat
                  or exists (select 1 from typed_part_links t where t.line_id = o.id and t.catalog_item_id = p_cat))), 0) / p_qty, 1)
      end
    else 1
  end
$$;
revoke execute on function public.line_paid_share(uuid, uuid, numeric) from public, anon;

-- "Ambil dari PO" (item 50): the job page's "lines on its POs not on this job" now also offers a typed PO line that was
-- added to the catalog after it arrived; putting it on the job adds the catalog part (from the shelf), not a typed line.
-- (142's add_po_lines_to_job with that one change.)
create or replace function public.add_po_lines_to_job(p_lines uuid[], p_service uuid default null, p_new_service text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_ro uuid; v_svc uuid; v_pos int; v_m numeric; l record; v_cat uuid; v_qty numeric; v_item uuid; n int := 0;
  v_desc text; v_price numeric; v_taxable boolean; v_showqty boolean; v_core numeric; v_jc numeric; v_stock uuid;
begin
  if not (has_permission('edit_jobs') and has_permission('manage_inventory')) then
    raise exception 'Only people who edit jobs and manage inventory can add PO parts to a job';
  end if;
  if p_lines is null or cardinality(p_lines) = 0 then raise exception 'Choose the PO lines to add'; end if;
  select distinct po.ro_id into v_ro from purchase_order_items pi join purchase_orders po on po.id = pi.po_id where pi.id = any (p_lines);
  if v_ro is null or (select count(distinct po.ro_id) from purchase_order_items pi join purchase_orders po on po.id = pi.po_id where pi.id = any (p_lines)) <> 1
     or (select count(*) from purchase_order_items where id = any (p_lines)) <> cardinality(array(select distinct unnest(p_lines))) then
    raise exception 'The lines must all be on POs for one job';
  end if;
  perform 1 from repair_orders where id = v_ro and order_status = 'estimate' and closed_at is null for update;
  if not found then raise exception 'This job is invoiced or closed; its parts can''t change'; end if;
  if p_service is not null then
    select id into v_svc from ro_services where id = p_service and ro_id = v_ro and approval_status in ('approved', 'pending');
    if v_svc is null then raise exception 'Choose a service on this job (approved or waiting)'; end if;
  else
    insert into ro_services (ro_id, name, position)
    values (v_ro, coalesce(nullif(left(btrim(coalesce(p_new_service, '')), 200), ''), 'Part tambahan'),
            (select coalesce(max(position), -1) + 1 from ro_services where ro_id = v_ro))
    returning id into v_svc;
  end if;
  v_m := coalesce((select default_markup_pct from shop_settings limit 1), 0);
  select coalesce(max(position), -1) + 1 into v_pos from ro_service_items where service_id = v_svc;
  for l in select pi.* from purchase_order_items pi where pi.id = any (p_lines) order by pi.created_at, pi.id for update loop
    if l.ro_service_item_id is not null then raise exception '"%" is already on the job', l.name; end if;
    -- 150 (item 50, "Ambil dari PO"): a typed line added to the catalog after it arrived is in stock now: the job gets
    -- that catalog part (it comes off the shelf at invoicing), for what was received; the PO line stays unlinked, and
    -- line_paid_share counts it as paid by the PT when the PO is
    v_stock := null;
    if l.catalog_item_id is null and l.qty_delivered > 0 then
      select catalog_item_id into v_stock from typed_part_links where line_id = l.id and source = 'po';
    end if;
    v_qty := case when v_stock is not null then l.qty_delivered - po_qty_returned(l.id)
                  else l.qty_ordered - l.qty_cancelled - po_qty_returned(l.id) end;
    if v_qty <= 0 then raise exception 'Nothing is left of "%" on its PO to add', l.name; end if;
    v_cat := coalesce(l.catalog_item_id, v_stock);
    if v_stock is not null and exists (select 1 from ro_service_items i join ro_services sv on sv.id = i.service_id
                                       where sv.ro_id = v_ro and i.catalog_item_id = v_stock and i.po_item_id is null) then
      raise exception '"%" is already on the job (from stock)', (select name from catalog_items where id = v_stock);
    end if;
    v_desc := null; v_price := null; v_taxable := null; v_showqty := null; v_core := 0;
    if v_cat is not null then
      select description, nullif(price, 0), taxable, show_qty_price, case when has_core then coalesce(core_cost, 0) else 0 end
        into v_desc, v_price, v_taxable, v_showqty, v_core from catalog_items where id = v_cat;
    end if;
    -- the job's cost: the PO cost, plus the supplier's PPN while the shop is non-PKP (142)
    v_jc := po_to_job_cost(l.cost, l.taxable, (select tax_rate from purchase_orders where id = l.po_id));
    insert into ro_service_items (service_id, position, item_type, catalog_item_id, name, description, cost, price, qty, taxable, show_qty_price, core_charge)
    values (v_svc, v_pos, l.line_type, v_cat, case when v_stock is not null then (select name from catalog_items where id = v_stock) else l.name end,
            v_desc, v_jc, coalesce(v_price, round(v_jc * (1 + v_m / 100))),
            v_qty, coalesce(v_taxable, new_line_taxable()), coalesce(v_showqty, true), case when l.line_type = 'part' then v_core else 0 end)
    returning id into v_item;
    if v_stock is null then update purchase_order_items set ro_service_item_id = v_item where id = l.id; end if;
    v_pos := v_pos + 1; n := n + 1;
  end loop;
  -- new work on the job: its status follows (e.g. back from Selesai)
  perform refresh_job_workflow(v_ro);
  return jsonb_build_object('added', n, 'service_id', v_svc);
end $$;
revoke execute on function public.add_po_lines_to_job(uuid[], uuid, text) from public, anon;
grant execute on function public.add_po_lines_to_job(uuid[], uuid, text) to authenticated;

-- ===== 51. fleet manager switches ======================================================================================
create table if not exists public.fleet_access (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  can_decide boolean not null default true,
  can_bills boolean not null default false,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
alter table public.fleet_access enable row level security;
revoke all on public.fleet_access from anon, authenticated;
grant select on public.fleet_access to authenticated;
drop policy if exists "read fleet access" on public.fleet_access;
create policy "read fleet access" on public.fleet_access for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_permission('manage_users')));

create or replace function public.set_fleet_access(p_user uuid, p_decide boolean, p_bills boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not has_permission('manage_users') then raise exception 'Not allowed'; end if;
  if not exists (select 1 from profiles p join roles r on r.id = p.role_id where p.id = p_user and r.name = 'Fleet manager') then
    raise exception 'Only Fleet manager logins have these switches';
  end if;
  insert into fleet_access (user_id, can_decide, can_bills, updated_by, updated_at)
  values (p_user, coalesce(p_decide, true), coalesce(p_bills, false), auth.uid(), now())
  on conflict (user_id) do update set can_decide = excluded.can_decide, can_bills = excluded.can_bills,
                                      updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;
revoke execute on function public.set_fleet_access(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_fleet_access(uuid, boolean, boolean) to authenticated;

create or replace function public.fleet_can(p_what text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_fleet() and case p_what
    when 'decide' then coalesce((select can_decide from fleet_access where user_id = auth.uid()), true)
    when 'bills' then coalesce((select can_bills from fleet_access where user_id = auth.uid()), false)
    else false end
$$;
revoke execute on function public.fleet_can(text) from public, anon;
grant execute on function public.fleet_can(text) to authenticated;

do $$
declare def text; anchor text;
begin
  select pg_get_functiondef('public.fleet_decide(uuid[], text, text)'::regprocedure) into def;
  if position('fleet_can(''decide'')' in def) > 0 then return; end if;
  anchor := '  if not public.is_fleet() then raise exception ''Only a fleet manager can decide here''; end if;';
  if position(anchor in def) = 0 then raise exception 'fleet_decide: not as expected (150)'; end if;
  execute replace(def, anchor, anchor || chr(10) ||
    '  if not public.fleet_can(''decide'') then raise exception ''This login can''''t approve work. Ask the shop''; end if;   -- (150)');
end $$;

-- ===== 53. monthly statement per book ===================================================================================
alter table public.shop_settings add column if not exists statement_drum_mode text not null default 'month';
do $$ begin
  alter table public.shop_settings add constraint shop_settings_statement_drum_mode check (statement_drum_mode in ('month', 'drum'));
exception when duplicate_object then null; end $$;
grant update (statement_drum_mode) on public.shop_settings to authenticated;   -- the shop_settings row policy still decides who

create or replace function public.same_book(p1 text, b1 text, p2 text, b2 text) returns boolean
language sql immutable set search_path = public as $$
  select payer_key(p1) is not distinct from payer_key(p2) and payer_key(b1) is not distinct from payer_key(b2)
$$;

-- may the caller see this book's money? Pemilik/Admin all; a fleet login with "Lihat tagihan & biaya" the books of
-- its linked companies
create or replace function public.can_see_book(p_payer text, p_book text) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is null or public.is_owner_or_admin()
      or (public.fleet_can('bills') and exists (
            select 1 from fleet_manager_companies f join customers c on c.id = f.customer_id
             where f.user_id = auth.uid() and c.paid_direct
               and same_book(canon_payer(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)),
                             regexp_replace(btrim(coalesce(nullif(btrim(c.book_name), ''), c.display_name)), '\s+', ' ', 'g'),
                             p_payer, p_book)))
$$;
revoke execute on function public.can_see_book(text, text) from public, anon;
grant execute on function public.can_see_book(text, text) to authenticated;

-- the books the caller may print, with what each has in the period
create or replace function public.statement_books(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not (is_owner_or_admin() or fleet_can('bills')) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(b order by b.payer, b.book) from (
    select x.payer, x.book,
           (select count(*) from repair_orders r cross join lateral ro_payer_book(r.id) pb
             where r.order_status = 'invoice' and same_book(pb.payer, pb.book, x.payer, x.book)
               and (r.invoiced_at at time zone shop_tz())::date between p_from and p_to) as invoices
      from (select distinct canon_payer(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)) as payer,
                            regexp_replace(btrim(coalesce(nullif(btrim(c.book_name), ''), c.display_name)), '\s+', ' ', 'g') as book
              from customers c where c.paid_direct) x
     where can_see_book(x.payer, x.book)) b), '[]');
end $$;
revoke execute on function public.statement_books(date, date) from public, anon;
grant execute on function public.statement_books(date, date) to authenticated;

-- one book's statement. p_drum_mode 'month': drum oil used in the period; 'drum': drums emptied in the period (all
-- their oil) and open drums for information. Oil from before the app (oil_preapp) is never on it: it has its own
-- one-time bill (the drum print up to 1 Nov 2026).
create or replace function public.book_statement(p_payer text, p_book text, p_from date, p_to date, p_drum_mode text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_mode text; v_ids uuid[];
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose the period'; end if;
  if not can_see_book(p_payer, p_book) then raise exception 'Not allowed'; end if;
  v_mode := coalesce(p_drum_mode, (select statement_drum_mode from shop_settings limit 1), 'month');
  if v_mode not in ('month', 'drum') then raise exception 'Unknown drum mode'; end if;

  select array_agg(pi.id) into v_ids
    from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
    left join repair_orders r on r.id = po.ro_id left join customers rc on rc.id = r.customer_id
   where (po.paid_by_pt or po.paid_by_name is not null) and pi.qty_delivered - po_qty_returned(pi.id) > 0
     and pi.delivered_at between p_from and p_to
     and same_book(coalesce(case when po.ro_id is not null then canon_payer(coalesce(nullif(btrim(rc.payer_name), ''), rc.display_name)) end,
                            canon_payer(po.paid_by_name)),
                   case when po.ro_id is not null then regexp_replace(btrim(coalesce(nullif(btrim(rc.book_name), ''), rc.display_name)), '\s+', ' ', 'g')
                        else po.paid_by_book end, p_payer, p_book);

  return jsonb_build_object(
    'payer', p_payer, 'book', p_book, 'from', p_from, 'to', p_to, 'drum_mode', v_mode,
    'invoices', coalesce((select jsonb_agg(x order by x.day, x.invoice_number) from (
        select r.id as ro_id, r.invoice_no, r.invoice_number, r.job_number, (r.invoiced_at at time zone shop_tz())::date as day,
               v.plate, concat_ws(' ', v.make, v.model) as model, c.display_name as company,
               r.total, r.settled_direct, r.labor_waived, r.balance
          from repair_orders r join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
          cross join lateral ro_payer_book(r.id) pb
         where r.order_status = 'invoice' and same_book(pb.payer, pb.book, p_payer, p_book)
           and (r.invoiced_at at time zone shop_tz())::date between p_from and p_to) x), '[]'),
    'lines', coalesce((select jsonb_agg(x order by x.supplier, x.delivered_at, x.po_number, x.name) from (
        select s.name as supplier, po.po_number, r.job_number, v.plate, pi.name, ci.code as part_number,
               pi.delivered_at, a.qty, a.amount,
               case when po.talangan_name is not null then jsonb_build_object('name', po.talangan_name, 'nota', po.talangan_nota,
                      'reimbursed_on', po.reimbursed_on) end as talangan
          from po_amounts('delivered', coalesce(v_ids, '{}')) a
          join purchase_order_items pi on pi.id = a.line_id join purchase_orders po on po.id = pi.po_id
          left join suppliers s on s.id = po.supplier_id left join catalog_items ci on ci.id = pi.catalog_item_id
          left join repair_orders r on r.id = po.ro_id left join vehicles v on v.id = r.vehicle_id) x), '[]'),
    'drum_oil', coalesce((select jsonb_agg(y order by y.direction, y.day, y.invoice_no) from (
        select case when same_book(canon_payer(d.paid_by_name), d.paid_by_book, p_payer, p_book) then 'owed' else 'owes' end as direction,
               d.id as drum_id, ci.name as oil, canon_payer(d.paid_by_name) as drum_payer, d.paid_by_book as drum_book,
               d.opened_on, d.emptied_on, pb.payer, pb.book, r.invoice_no, r.job_number,
               (r.invoiced_at at time zone shop_tz())::date as day, v.plate, u.litres, d.cost_per_l,
               round(u.litres * d.cost_per_l) as amount
          from drum_use u join repair_orders r on r.id = u.ro_id join oil_drums d on d.id = u.drum_id
          left join catalog_items ci on ci.id = d.catalog_item_id left join vehicles v on v.id = r.vehicle_id
          cross join lateral ro_payer_book(r.id) pb
         where r.order_status = 'invoice' and pb.payer is not null
           and drum_owes(d.paid_by_name, d.paid_by_book, pb.payer, pb.book)
           and (same_book(pb.payer, pb.book, p_payer, p_book) or same_book(canon_payer(d.paid_by_name), d.paid_by_book, p_payer, p_book))
           and case when v_mode = 'month' then (r.invoiced_at at time zone shop_tz())::date between p_from and p_to
                    else d.emptied_on between p_from and p_to end) y), '[]'),
    'open_drums', case when v_mode = 'drum' then coalesce((select jsonb_agg(jsonb_build_object(
          'drum_id', d.id, 'oil', ci.name, 'drum_payer', canon_payer(d.paid_by_name), 'drum_book', d.paid_by_book,
          'opened_on', d.opened_on, 'litres', d.litres) order by ci.name, d.opened_on)
        from oil_drums d left join catalog_items ci on ci.id = d.catalog_item_id
       where (d.emptied_on is null or d.emptied_on > p_to)
         -- only this book's drums, and drums this book took oil from
         and (same_book(canon_payer(d.paid_by_name), d.paid_by_book, p_payer, p_book)
              or exists (select 1 from drum_use u join repair_orders r on r.id = u.ro_id cross join lateral ro_payer_book(r.id) pb
                          where u.drum_id = d.id and r.order_status = 'invoice' and same_book(pb.payer, pb.book, p_payer, p_book)))), '[]')
      else '[]'::jsonb end,
    'old_oil', exists (select 1 from drum_use u join oil_preapp o on o.id = u.preapp_id join oil_drums d on d.id = u.drum_id
                        where drum_owes(d.paid_by_name, d.paid_by_book, o.payer, o.book)
                          and (same_book(o.payer, o.book, p_payer, p_book) or same_book(canon_payer(d.paid_by_name), d.paid_by_book, p_payer, p_book))));
end $$;
revoke execute on function public.book_statement(text, text, date, date, text) from public, anon;
grant execute on function public.book_statement(text, text, date, date, text) to authenticated;

-- ===== 54. drums take oil by date ======================================================================================
-- The drums of that oil open on the day (opened_on <= day and not emptied before it) take the oil, oldest first; what
-- doesn't fit stays on the last of them (shown as more than the drum holds) instead of spilling into another drum.
-- Only when no drum covers the day: all drums of that oil, oldest first, as before.
create or replace function public.drum_pick(p_item uuid, p_day date, p_need numeric, out drum_id uuid, out litres numeric)
returns setof record language plpgsql stable security definer set search_path = public as $$
declare d record; v_need numeric := p_need; v_take numeric; v_left numeric; v_last uuid; v_dated boolean;
begin
  v_dated := exists (select 1 from oil_drums od where od.catalog_item_id = p_item and od.opened_on <= p_day
                       and (od.emptied_on is null or od.emptied_on >= p_day));
  for d in select od.id, od.litres - coalesce((select sum(u.litres) from drum_use u where u.drum_id = od.id), 0) as left_l
             from oil_drums od
            where od.catalog_item_id = p_item
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
revoke execute on function public.drum_pick(uuid, date, numeric) from public, anon, authenticated;

create or replace function public.drum_take(p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l record; x record;
begin
  delete from drum_use where line_id = p_line;
  select i.id, i.catalog_item_id, i.qty, r.id as ro_id, r.invoiced_at into l
    from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders r on r.id = s.ro_id
   where i.id = p_line and i.item_type = 'part' and i.stock_deducted and i.qty > 0 and r.order_status = 'invoice';
  if not found or l.catalog_item_id is null then return; end if;
  if not exists (select 1 from oil_drums where catalog_item_id = l.catalog_item_id
                  and opened_on <= (l.invoiced_at at time zone shop_tz())::date) then
    return;
  end if;
  for x in select * from drum_pick(l.catalog_item_id, (l.invoiced_at at time zone shop_tz())::date, l.qty) loop
    insert into drum_use (drum_id, line_id, ro_id, catalog_item_id, litres) values (x.drum_id, l.id, l.ro_id, l.catalog_item_id, x.litres)
    on conflict (line_id, drum_id) do update set litres = drum_use.litres + excluded.litres;
  end loop;
end $$;

create or replace function public.drum_take_preapp(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o record; x record;
begin
  delete from drum_use where preapp_id = p_id;
  select * into o from oil_preapp where id = p_id;
  if not found then return; end if;
  for x in select * from drum_pick(o.catalog_item_id, o.done_on, o.litres) loop
    insert into drum_use (drum_id, preapp_id, catalog_item_id, litres) values (x.drum_id, o.id, o.catalog_item_id, x.litres)
    on conflict (preapp_id, drum_id) where preapp_id is not null do update set litres = drum_use.litres + excluded.litres;
  end loop;
end $$;
revoke execute on function public.drum_take(uuid) from public, anon;
revoke execute on function public.drum_take_preapp(uuid) from public, anon;
