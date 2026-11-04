-- Axle v2 · 138 Future updates of Nov 4, 2026 (Denny)
--
-- 1. Item 8: work is approved automatically (shop setting, on for now). A service added to a job starts as approved
--    instead of waiting for approval; declining or deferring stays possible by hand (Catat persetujuan).
-- 2. Item 12: a default markup for parts (shop setting, 0% for now). New parts are priced cost × (1 + markup); the
--    Owner can apply it to every catalog part at once.
--
-- Run once in the SQL Editor, after 137. Safe to re-run.

-- 1. Automatic approval ----------------------------------------------------------------------------------------------
alter table public.shop_settings add column if not exists auto_approve boolean not null default true;
grant update (auto_approve) on public.shop_settings to authenticated;

create or replace function public.auto_approve_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.approval_status = 'pending' and coalesce((select auto_approve from shop_settings limit 1), false) then
    new.approval_status := 'approved';
  end if;
  return new;
end;
$$;
revoke execute on function public.auto_approve_service() from public, anon, authenticated;
drop trigger if exists auto_approve_ro_services on public.ro_services;
create trigger auto_approve_ro_services before insert on public.ro_services
  for each row execute function public.auto_approve_service();

-- 2. Default parts markup --------------------------------------------------------------------------------------------
alter table public.shop_settings add column if not exists default_markup_pct numeric(6,2) not null default 0;
alter table public.shop_settings drop constraint if exists shop_settings_default_markup;
alter table public.shop_settings add constraint shop_settings_default_markup check (default_markup_pct between 0 and 1000);
grant update (default_markup_pct) on public.shop_settings to authenticated;

-- Prices every active catalog part with a cost at cost × (1 + markup), rounded to whole rupiah. Owner only.
-- Lines already on jobs keep their prices. Returns how many parts changed.
create or replace function public.apply_parts_markup(p_markup numeric)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is not null and not exists (select 1 from profiles p join roles r on r.id = p.role_id
       where p.id = auth.uid() and r.name = 'Owner' and p.status = 'active') then
    raise exception 'Only the Owner can reprice all parts.';
  end if;
  if p_markup is null or p_markup < 0 or p_markup > 1000 then
    raise exception 'Markup must be between 0 and 1000%%';
  end if;
  update catalog_items
     set markup_pct = p_markup, price = round(cost * (1 + p_markup / 100))
   where item_type = 'part' and active and cost > 0
     and (price is distinct from round(cost * (1 + p_markup / 100)) or markup_pct is distinct from p_markup);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.apply_parts_markup(numeric) from public, anon;
grant execute on function public.apply_parts_markup(numeric) to authenticated;

-- 3. Typed-in parts into the catalog (item 9) ------------------------------------------------------------------------
-- A part typed by hand on a job or a PO (no catalog part) can be added to the catalog or linked to an existing part.
-- Lines on open jobs and PO lines with nothing received yet are switched to the catalog part, so they count in stock
-- from now on. For what already happened (received on POs, used on invoiced jobs) the stock is set once:
-- received − used is added (Denny, Nov 4), or nothing ("start at 0"). Invoiced lines keep their typed name.
-- typed_part_links remembers lines already handled, so nothing is counted twice.
create table if not exists public.typed_part_links (
  line_id uuid primary key,
  source text not null check (source in ('job', 'po')),
  catalog_item_id uuid not null references public.catalog_items(id) on delete cascade,
  linked_by uuid default auth.uid(),
  linked_at timestamptz not null default now()
);
alter table public.typed_part_links enable row level security;
drop policy if exists "staff read typed_part_links" on public.typed_part_links;
create policy "staff read typed_part_links" on public.typed_part_links for select using ((select is_staff()));
revoke insert, update, delete on public.typed_part_links from anon, authenticated;
grant select on public.typed_part_links to authenticated;

create or replace function public.link_typed_part(p_item uuid, p_job_lines uuid[], p_po_lines uuid[], p_count boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_received numeric := 0; v_used numeric := 0; v_change numeric := 0; v_jobs int := 0; v_pos int := 0;
  r record;
begin
  if not has_permission('edit_catalog') then raise exception 'Only people who edit the catalog can add parts to it'; end if;
  if not exists (select 1 from catalog_items where id = p_item and item_type = 'part') then raise exception 'Part not found'; end if;
  p_job_lines := coalesce(p_job_lines, '{}'); p_po_lines := coalesce(p_po_lines, '{}');
  if cardinality(p_job_lines) + cardinality(p_po_lines) = 0 then raise exception 'Choose the lines to add'; end if;
  if exists (select 1 from typed_part_links where line_id = any(p_job_lines || p_po_lines)) then
    raise exception 'Some of these lines were already added to the catalog';
  end if;

  -- job lines: typed-in parts only
  for r in select i.id, i.qty, i.po_item_id, i.catalog_item_id, i.item_type, ro.order_status
             from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders ro on ro.id = s.ro_id
            where i.id = any(p_job_lines) for update of i loop
    if r.item_type <> 'part' or r.catalog_item_id is not null then raise exception 'Only typed-in parts can be added to the catalog'; end if;
    -- already used: on an invoiced job. Lines on open jobs switch to the catalog part and come off the shelf when their
    -- job is invoiced (every approved catalog line does, also one covered by a PO delivery).
    if r.order_status = 'invoice' then v_used := v_used + r.qty; end if;
    if r.order_status <> 'invoice' then
      update ro_service_items set catalog_item_id = p_item where id = r.id;
    end if;
    v_jobs := v_jobs + 1;
  end loop;
  if v_jobs <> cardinality(p_job_lines) then raise exception 'A job line was not found'; end if;

  -- PO lines: typed-in parts only; a line still waiting for part of its delivery must be received or cancelled first
  for r in select pi.id, pi.qty_delivered, pi.qty_ordered, pi.qty_cancelled, pi.catalog_item_id, pi.ro_service_item_id
             from purchase_order_items pi where pi.id = any(p_po_lines) for update loop
    if r.catalog_item_id is not null then raise exception 'Only typed-in parts can be added to the catalog'; end if;
    if r.qty_delivered > 0 and r.qty_ordered - r.qty_delivered - r.qty_cancelled > 0 then
      raise exception 'Receive or cancel the rest of a PO line before adding it to the catalog';
    end if;
    if r.qty_delivered > 0 then
      v_received := v_received + r.qty_delivered - po_qty_returned(r.id);
    elsif r.ro_service_item_id is null
       or (select catalog_item_id from ro_service_items where id = r.ro_service_item_id) = p_item then
      update purchase_order_items set catalog_item_id = p_item where id = r.id;
    else
      -- it is for a job line that stays typed-in: its delivery would never reach stock
      raise exception 'A PO line still to come is for a job line that isn''t added with it; add them together';
    end if;
    v_pos := v_pos + 1;
  end loop;
  if v_pos <> cardinality(p_po_lines) then raise exception 'A PO line was not found'; end if;

  v_change := round(v_received - v_used, 2);
  if p_count and v_change <> 0 then
    if not has_permission('adjust_stock') then
      raise exception 'Only an Owner or Admin can put these parts into stock; choose "start at 0" or ask them';
    end if;
    if not (select track_inventory from catalog_items where id = p_item) then
      raise exception 'Stock is not tracked for this part';
    end if;
    insert into stock_movements (catalog_item_id, qty_change, reason, note)
    values (p_item, v_change, 'adjustment', format('Part di luar katalog ditambahkan: %s diterima lewat PO, %s terpakai', v_received, v_used));
  end if;

  insert into typed_part_links (line_id, source, catalog_item_id)
  select x, 'job', p_item from unnest(p_job_lines) x
  union all select x, 'po', p_item from unnest(p_po_lines) x;

  return jsonb_build_object('job_lines', v_jobs, 'po_lines', v_pos, 'received', v_received, 'used', v_used,
                            'stock_change', case when p_count then v_change else 0 end);
end;
$$;
revoke execute on function public.link_typed_part(uuid, uuid[], uuid[], boolean) from public, anon;
grant execute on function public.link_typed_part(uuid, uuid[], uuid[], boolean) to authenticated;

-- A received typed-in PO line that was added to the catalog had its stock counted once; returning it or lowering what
-- was received wouldn't move that stock any more, so it's refused (correct the part's stock with Adjust stock).
create or replace function public.guard_linked_typed_po_line() returns trigger language plpgsql security definer set search_path = public as $$
declare v_line uuid;
begin
  if tg_table_name = 'returns' then v_line := new.po_item_id; else v_line := new.id; end if;
  if v_line is null or not exists (select 1 from typed_part_links where line_id = v_line and source = 'po') then return new; end if;
  if tg_table_name = 'returns' then
    if (select catalog_item_id from purchase_order_items where id = v_line) is null then
      raise exception 'This part was added to the catalog after it arrived; correct its stock with Adjust stock instead';
    end if;
  elsif new.qty_delivered < old.qty_delivered and new.catalog_item_id is null then
    raise exception 'This part was added to the catalog after it arrived; correct its stock with Adjust stock instead';
  end if;
  return new;
end $$;
revoke execute on function public.guard_linked_typed_po_line() from public, anon, authenticated;
drop trigger if exists returns_linked_typed_guard on public.returns;
create trigger returns_linked_typed_guard before insert on public.returns
  for each row execute function public.guard_linked_typed_po_line();
drop trigger if exists po_items_linked_typed_guard on public.purchase_order_items;
create trigger po_items_linked_typed_guard before update of qty_delivered on public.purchase_order_items
  for each row execute function public.guard_linked_typed_po_line();

-- 4. Staff app hours (item 11) ---------------------------------------------------------------------------------------
-- Service advisors, cashiers, technicians and viewers can use the app from 1 hour before the shop opens until 1 hour
-- after it closes (Settings → opening hours, shop time zone), or later with overtime an Owner or Admin allows. Owner
-- and Admin are never limited; customer fleet-manager logins neither. Enforced in is_staff() / has_permission(), so
-- every request outside the hours is refused, also from a session left open. Uses outside the hours are recorded.
alter table public.shop_settings add column if not exists staff_hours_limit boolean not null default true;
grant update (staff_hours_limit) on public.shop_settings to authenticated;

create table if not exists public.overtime_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  until timestamptz not null,
  note text check (char_length(note) <= 200),
  granted_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists overtime_grants_user_idx on public.overtime_grants (user_id, until desc);
alter table public.overtime_grants enable row level security;
drop policy if exists "read overtime_grants" on public.overtime_grants;
create policy "read overtime_grants" on public.overtime_grants for select
  using (user_id = auth.uid() or (select has_permission('manage_users')));
revoke insert, update, delete on public.overtime_grants from anon, authenticated;
grant select on public.overtime_grants to authenticated;

create table if not exists public.staff_access_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now(),
  ip text,
  user_agent text
);
create index if not exists staff_access_log_at_idx on public.staff_access_log (at desc);
alter table public.staff_access_log enable row level security;
drop policy if exists "read staff_access_log" on public.staff_access_log;
create policy "read staff_access_log" on public.staff_access_log for select using ((select has_permission('manage_users')));
revoke insert, update, delete on public.staff_access_log from anon, authenticated;
grant select on public.staff_access_log to authenticated;

-- Shop time now (a test can set axle.now; the app can't set it).
create or replace function public.shop_now() returns timestamptz language sql stable set search_path = public as $$
  select coalesce(nullif(current_setting('axle.now', true), '')::timestamptz, now())
$$;
revoke execute on function public.shop_now() from public, anon;

-- Is this moment inside the staff window (opening hours ± 1 hour)? Minutes since local midnight; a window that runs
-- past midnight (open until 23:30 → 00:30) carries into the next day.
create or replace function public.in_staff_window(p_at timestamptz) returns boolean language plpgsql stable set search_path = public as $$
declare
  h jsonb; tz text; loc timestamp; m int; d int; day jsonb; s int; e int;
  keys text[] := array['mon','tue','wed','thu','fri','sat','sun'];
begin
  select opening_hours, coalesce(timezone, 'Asia/Makassar') into h, tz from shop_settings limit 1;
  if h is null then return true; end if;
  loc := p_at at time zone tz;
  m := extract(hour from loc)::int * 60 + extract(minute from loc)::int;
  for d in -1..1 loop
    day := h -> keys[((extract(isodow from loc)::int - 1 + d + 7) % 7) + 1];
    continue when day is null or not coalesce((day->>'open')::boolean, false);
    s := split_part(day->>'start', ':', 1)::int * 60 + split_part(day->>'start', ':', 2)::int - 60 + d * 1440;
    e := split_part(day->>'end', ':', 1)::int * 60 + split_part(day->>'end', ':', 2)::int + 60 + d * 1440;
    if m >= s and m < e then return true; end if;
  end loop;
  return false;
end $$;
revoke execute on function public.in_staff_window(timestamptz) from public, anon;

-- May this person use the app right now? (used inside is_staff / has_permission: no writes here)
create or replace function public.staff_hours_ok(p_user uuid, p_role text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_role, '') in ('Owner', 'Admin', 'Fleet manager')
      or not coalesce((select staff_hours_limit from shop_settings limit 1), false)
      or in_staff_window(shop_now())
      or exists (select 1 from overtime_grants where user_id = p_user and until > shop_now())
$$;
revoke execute on function public.staff_hours_ok(uuid, text) from public, anon, authenticated;

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p left join public.roles r on r.id = p.role_id
                 where p.id = auth.uid() and p.status = 'active' and coalesce(r.name, '') <> 'Fleet manager'
                   and public.staff_hours_ok(p.id, r.name));
$$;

create or replace function public.has_permission(perm text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p join public.role_permissions rp on rp.role_id = p.role_id
                 left join public.roles r on r.id = p.role_id
                 where p.id = auth.uid() and p.status = 'active' and rp.permission_key = perm and coalesce(r.name, '') <> 'Fleet manager'
                   and public.staff_hours_ok(p.id, r.name));
$$;

-- The app asks this after signing in and from time to time. Outside the hours it records the use (at most once per
-- 10 minutes per person) and says when the app opens again.
create or replace function public.staff_hours_check() returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_role text; v_status text; v_ok boolean; v_until timestamptz; v_next timestamptz; t timestamptz; hdr json;
begin
  select r.name, p.status into v_role, v_status from profiles p left join roles r on r.id = p.role_id where p.id = auth.uid();
  if not found or v_status <> 'active' then return jsonb_build_object('limited', false, 'ok', true); end if;
  if coalesce(v_role, '') in ('Owner', 'Admin', 'Fleet manager') or not coalesce((select staff_hours_limit from shop_settings limit 1), false) then
    return jsonb_build_object('limited', false, 'ok', true);
  end if;
  select max(until) into v_until from overtime_grants where user_id = auth.uid() and until > shop_now();
  v_ok := v_until is not null or in_staff_window(shop_now());
  if not v_ok then
    if not exists (select 1 from staff_access_log where user_id = auth.uid() and at > now() - interval '10 minutes') then
      begin hdr := current_setting('request.headers', true)::json; exception when others then hdr := null; end;
      insert into staff_access_log (user_id, ip, user_agent)
      values (auth.uid(), left(coalesce(hdr->>'cf-connecting-ip', split_part(hdr->>'x-forwarded-for', ',', 1)), 64), left(hdr->>'user-agent', 300));
    end if;
    -- the next moment the window opens, looking ahead in 15-minute steps (up to 8 days)
    t := date_trunc('hour', shop_now()) + ceil(extract(minute from shop_now()) / 15 + 0.0001) * interval '15 minutes';
    while t < shop_now() + interval '8 days' loop
      if in_staff_window(t) then v_next := t; exit; end if;
      t := t + interval '15 minutes';
    end loop;
  else
    -- when it closes (so the app can switch to the closed page right then): the first quarter hour outside the
    -- window, or the end of overtime if that is later
    t := date_trunc('hour', shop_now()) + ceil(extract(minute from shop_now()) / 15 + 0.0001) * interval '15 minutes';
    while t < shop_now() + interval '3 days' loop
      if not in_staff_window(t) then v_next := greatest(t, coalesce(v_until, t)); exit; end if;
      t := t + interval '15 minutes';
    end loop;
    if v_until is not null and not in_staff_window(shop_now()) then v_next := v_until; end if;
  end if;
  return jsonb_build_object('limited', true, 'ok', v_ok, 'overtime_until', v_until,
                            'next_open', case when v_ok then null else v_next end, 'closes_at', case when v_ok then v_next end,
                            'timezone', (select timezone from shop_settings limit 1));
end $$;
revoke execute on function public.staff_hours_check() from public, anon;
grant execute on function public.staff_hours_check() to authenticated;

-- Owner / Admin: let one person work outside the hours until a later time (at most 2 days ahead).
create or replace function public.grant_overtime(p_user uuid, p_until timestamptz, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_permission('manage_users') then raise exception 'Only an Owner or Admin can allow overtime'; end if;
  if p_until is null or p_until <= shop_now() then raise exception 'Choose a time later than now'; end if;
  if p_until > shop_now() + interval '2 days' then raise exception 'Overtime can be allowed for at most 2 days ahead'; end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'Person not found'; end if;
  insert into overtime_grants (user_id, until, note) values (p_user, p_until, nullif(btrim(p_note), ''));
end $$;
revoke execute on function public.grant_overtime(uuid, timestamptz, text) from public, anon;
grant execute on function public.grant_overtime(uuid, timestamptz, text) to authenticated;

-- Owner / Admin: end someone's overtime now.
create or replace function public.end_overtime(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_permission('manage_users') then raise exception 'Only an Owner or Admin can allow overtime'; end if;
  update overtime_grants set until = shop_now() where user_id = p_user and until > shop_now();
end $$;
revoke execute on function public.end_overtime(uuid) from public, anon;
grant execute on function public.end_overtime(uuid) to authenticated;
