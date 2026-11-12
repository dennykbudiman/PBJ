-- 148 · Nov 12, 2026 (Denny, item 47): "Berkas diterima".
-- The service advisor hands the Owner a copy of each invoice stapled with the PO, the supplier's receipt and the
-- drum-oil sheet. The Owner (or an Admin) marks the invoiced job's paperwork as received: one mark for the whole
-- bundle, with the date, who marked it and an optional note. Only the Owner and Admins see or change it (other staff
-- and fleet managers never see it). Voiding the invoice clears the mark: the new invoice number needs new papers.
-- Adds one table and four functions; changes no existing data.

-- ===== 1. the marks ================================================================================================
create table if not exists public.invoice_paperwork (
  ro_id uuid primary key references public.repair_orders(id) on delete cascade,
  invoice_no text,                                   -- the invoice the papers were for (kept for the record)
  received_on date not null,
  note text check (char_length(note) <= 200),
  received_by uuid references public.profiles(id) on delete set null,
  marked_at timestamptz not null default now()
);
alter table public.invoice_paperwork enable row level security;
revoke all on public.invoice_paperwork from public, anon, authenticated;
grant select on public.invoice_paperwork to authenticated;
drop policy if exists "owner admin read invoice_paperwork" on public.invoice_paperwork;
create policy "owner admin read invoice_paperwork" on public.invoice_paperwork for select to authenticated
  using ((select public.is_owner_or_admin()));

-- ===== 2. marking (Owner or Admin) ==================================================================================
-- Marks the given invoiced jobs as received (again: the date and note are replaced). Jobs that aren't invoiced are
-- skipped. Returns how many were marked.
create or replace function public.paperwork_mark(p_ros uuid[], p_on date default null, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_on date := coalesce(p_on, shop_day(shop_now())); v_note text := nullif(btrim(coalesce(p_note, '')), ''); n int;
begin
  if not is_owner_or_admin() then raise exception 'Only the Owner or an Admin can mark paperwork received'; end if;
  if v_on > shop_day(shop_now()) then raise exception 'The date received can''t be in the future'; end if;
  if char_length(v_note) > 200 then raise exception 'The note is too long (200 characters at most)'; end if;
  insert into invoice_paperwork (ro_id, invoice_no, received_on, note, received_by, marked_at)
  select r.id, r.invoice_no, v_on, v_note, auth.uid(), now()
  from repair_orders r where r.id = any(coalesce(p_ros, '{}')) and r.order_status = 'invoice'
  on conflict (ro_id) do update set invoice_no = excluded.invoice_no, received_on = excluded.received_on, note = excluded.note,
                                    received_by = excluded.received_by, marked_at = excluded.marked_at;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.paperwork_mark(uuid[], date, text) from public, anon;
grant execute on function public.paperwork_mark(uuid[], date, text) to authenticated;

create or replace function public.paperwork_unmark(p_ro uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner_or_admin() then raise exception 'Only the Owner or an Admin can mark paperwork received'; end if;
  delete from invoice_paperwork where ro_id = p_ro;
end $$;
revoke execute on function public.paperwork_unmark(uuid) from public, anon;
grant execute on function public.paperwork_unmark(uuid) to authenticated;

-- Dasbor: how many issued invoices still have no paperwork (null for anyone but the Owner and Admins).
create or replace function public.paperwork_pending() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when is_owner_or_admin() then (
    select jsonb_build_object('count', count(*), 'oldest', min(r.invoiced_at))
    from repair_orders r where r.order_status = 'invoice'
      and not exists (select 1 from invoice_paperwork p where p.ro_id = r.id)) end
$$;
revoke execute on function public.paperwork_pending() from public, anon;
grant execute on function public.paperwork_pending() to authenticated;

-- ===== 3. a voided invoice drops its mark ===========================================================================
create or replace function public.invoice_paperwork_void() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status is distinct from 'invoice' then
    delete from invoice_paperwork where ro_id = new.id;
  end if;
  return new;
end $$;
revoke execute on function public.invoice_paperwork_void() from public, anon, authenticated;
drop trigger if exists repair_orders_paperwork_void on public.repair_orders;
create trigger repair_orders_paperwork_void after update of order_status on public.repair_orders
  for each row execute function public.invoice_paperwork_void();
