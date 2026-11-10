-- Axle v2 · 143: books (pembukuan) under the paying PT, drum oil on the invoice, km in before invoicing, invoice
-- number = job number + version (Denny, Nov 10, 2026; items 23–26 in claude/future-updates.md)
--
--  * Books (item 23): a company can name the book its costs go into ("Pembukuan", book_name; empty = the company's own
--    name). One supplier bill per paying PT still, but the PO, the invoice, the monthly PT list and the drums show the
--    book. A drum and a stock PO can name the book that paid (paid_by_book). Debts for drum oil count between books,
--    also inside one PT; a drum with no book belongs to the whole PT (as before).
--  * Drum oil per invoice (item 26): which drum each invoiced oil line came from is kept in drum_use (oldest drum
--    first, as 142's drum report worked it out), written when the invoice is made and removed when it is voided, so
--    another job never changes it. Adding, removing or re-ordering a drum (oil, litres, opening day) works it out again
--    for that oil. invoice_drum_box() gives the invoice what to print: per oil line the drum, its owner and whom to pay.
--    A drum's price can be marked as an estimate (cost_estimated).
--  * Km in (item 24): an invoice needs the km in, unless the job is marked "km tidak terbaca" (km_unreadable).
--  * Invoice number (item 25): job number × 1000 + version (job 100001 → 100001001, after a void 100001002), shown as
--    INV-100001-1. Existing invoices keep theirs (INV-000001 …); the two can't meet (old ≤ 99 999 999).
--
-- Changes no business data (drum_use is worked out from the invoices). Safe to run more than once. Every
-- UPDATE/DELETE has a WHERE.

-- ===== 1. Books ===================================================================================================
alter table public.customers add column if not exists book_name text;
do $$ begin
  alter table public.customers add constraint customers_book_name_len check (char_length(book_name) <= 120);
exception when duplicate_object then null; end $$;
grant select (book_name), insert (book_name), update (book_name) on public.customers to authenticated;

-- customers view (from 142) with the book at the end
create or replace view public.customers_read with (security_barrier = true) as
WITH p AS (
         SELECT has_permission('view_reports'::text) AS money,
            has_permission('view_costs'::text) AS costs,
            (has_permission('view_costs'::text) OR has_permission('pay_supplier_bills'::text)) AS supplier
        )
 SELECT t.id,
    t.type,
    t.display_name,
    t.legal_name,
    t.npwp,
    t.billing_address,
    t.phone,
    t.email,
    t.payment_terms_days,
        CASE
            WHEN p.money THEN t.credit_limit
            ELSE NULL::numeric
        END AS credit_limit,
    t.charge_account,
    t.tax_exempt,
        CASE
            WHEN ( SELECT is_staff() AS is_staff) THEN t.pinned_notes
            ELSE NULL::text
        END AS pinned_notes,
    t.tags,
    t.active,
    t.created_at,
    t.updated_at,
    t.paid_direct,
    t.labour_not_charged,
    t.payer_name,
    t.book_name
   FROM (customers t
     CROSS JOIN p)
  WHERE (( SELECT is_staff() AS is_staff) OR (t.id IN ( SELECT fleet_customer_ids() AS fleet_customer_ids)));
revoke all on public.customers_read from public, anon;
grant select on public.customers_read to authenticated;

-- a company's book: its "Pembukuan", else its own name (spaces tidied)
create or replace function public.book_of(p_customer uuid) returns text
language sql stable security definer set search_path = public as $$
  select regexp_replace(btrim(coalesce(nullif(btrim(book_name), ''), display_name)), '\s+', ' ', 'g') from customers
   where id = p_customer and (auth.uid() is null or (select is_staff()) or id in (select fleet_customer_ids()))
$$;
revoke execute on function public.book_of(uuid) from public, anon;
grant execute on function public.book_of(uuid) to authenticated;

-- is this book one of the paying PT's books? (a drum's or a stock PO's book must be)
create or replace function public.book_in_payer(p_payer text, p_book text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from customers c
                  where payer_key(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)) = payer_key(canon_payer(p_payer))
                    and payer_key(coalesce(nullif(btrim(c.book_name), ''), c.display_name)) = payer_key(p_book))
$$;
revoke execute on function public.book_in_payer(text, text) from public, anon, authenticated;

-- does oil used by a company (its paying PT and book) have to be paid to a drum's owner? The shop (a company that pays
-- the shop: payer null) always does; another PT does; inside the drum's PT only when the drum names a book and the
-- company's book is another one.
create or replace function public.drum_owes(p_drum_payer text, p_drum_book text, p_payer text, p_book text) returns boolean
language sql immutable as $$
  select p_payer is null or payer_key(p_payer) is distinct from payer_key(p_drum_payer)
         or (payer_key(p_drum_book) is not null and payer_key(p_book) is distinct from payer_key(p_drum_book))
$$;

-- ===== 2. Drums and stock POs name their book =====================================================================
alter table public.oil_drums add column if not exists paid_by_book text;
alter table public.oil_drums add column if not exists cost_estimated boolean not null default false;
do $$ begin
  alter table public.oil_drums add constraint oil_drums_book_len check (char_length(paid_by_book) <= 120);
exception when duplicate_object then null; end $$;
grant select (paid_by_book, cost_estimated), insert (paid_by_book, cost_estimated), update (paid_by_book, cost_estimated)
  on public.oil_drums to authenticated;

alter table public.purchase_orders add column if not exists paid_by_book text;
do $$ begin
  alter table public.purchase_orders add constraint purchase_orders_book_len check (char_length(paid_by_book) <= 120);
exception when duplicate_object then null; end $$;
grant select (paid_by_book), insert (paid_by_book), update (paid_by_book) on public.purchase_orders to authenticated;

-- the drum check (from 142) also tidies the book and checks it is one of the PT's books
create or replace function public.check_oil_drum() returns trigger
language plpgsql security definer set search_path = public as $$
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
  if new.paid_by_book is not null and (tg_op = 'INSERT' or new.paid_by_book is distinct from old.paid_by_book or new.paid_by_name is distinct from old.paid_by_name)
     and not book_in_payer(new.paid_by_name, new.paid_by_book) then
    raise exception 'That book isn''t one of this PT''s books (Pembukuan of its companies)';
  end if;
  return new;
end $$;

-- a stock PO's book: tidied, one of its PT's books, and only with a PT; a job's PO takes the book of the job's company
create or replace function public.check_po_book() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.paid_by_book := nullif(regexp_replace(btrim(coalesce(new.paid_by_book, '')), '\s+', ' ', 'g'), '');
  if new.ro_id is not null or new.paid_by_name is null then
    new.paid_by_book := null;
  elsif new.paid_by_book is not null and (tg_op = 'INSERT' or new.paid_by_book is distinct from old.paid_by_book or new.paid_by_name is distinct from old.paid_by_name)
        and not book_in_payer(new.paid_by_name, new.paid_by_book) then
    raise exception 'That book isn''t one of this PT''s books (Pembukuan of its companies)';
  end if;
  return new;
end $$;
revoke execute on function public.check_po_book() from public, anon, authenticated;
-- runs after 142's purchase_orders_paid_by (alphabetical: "purchase_orders_paid_by" < "purchase_orders_paid_by_book")
drop trigger if exists purchase_orders_paid_by_book on public.purchase_orders;
create trigger purchase_orders_paid_by_book before insert or update of paid_by_book, paid_by_name, ro_id on public.purchase_orders
  for each row execute function public.check_po_book();

-- the monthly PT list (from 142) with each line's book: a job's PO → the job's company's book; a stock PO → its book
create or replace function public.pt_supplier_bills(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', coalesce(p_month, local_date()))::date; m1 date;
begin
  if auth.uid() is not null and not (has_permission('view_costs') or has_permission('pay_supplier_bills')) then raise exception 'Not allowed'; end if;
  m1 := (m0 + interval '1 month')::date;
  return jsonb_build_object('month', m0, 'lines', coalesce((select jsonb_agg(x order by x.payer, x.book, x.supplier, x.delivered_at, x.po_number) from (
    select coalesce(case when po.ro_id is not null then payer_of(r.customer_id) end, canon_payer(po.paid_by_name)) as payer,
           case when po.ro_id is not null then book_of(r.customer_id) else po.paid_by_book end as book,
           s.name as supplier, po.id as po_id, po.po_number, r.id as ro_id, r.job_number, c.display_name as company, v.plate,
           pi.id as line_id, pi.name, pi.line_type, pi.delivered_at, pi.supplier_invoice_no,
           pi.qty_delivered - po_qty_returned(pi.id) as qty, pi.cost,
           po_line_amount(pi.cost, pi.core_cost, pi.qty_delivered - po_qty_returned(pi.id), pi.taxable, po.tax_rate) as amount
      from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
      left join suppliers s on s.id = po.supplier_id
      left join repair_orders r on r.id = po.ro_id left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
     where (po.paid_by_pt or po.paid_by_name is not null) and pi.qty_delivered - po_qty_returned(pi.id) > 0
       and pi.delivered_at >= m0 and pi.delivered_at < m1) x), '[]'));
end $$;

-- ===== 3. Which drum each invoiced oil line came from =============================================================
create table if not exists public.drum_use (
  id uuid primary key default gen_random_uuid(),
  drum_id uuid not null references public.oil_drums(id) on delete cascade,
  line_id uuid not null references public.ro_service_items(id) on delete cascade,
  ro_id uuid not null references public.repair_orders(id) on delete cascade,
  catalog_item_id uuid not null references public.catalog_items(id),
  litres numeric(12,2) not null check (litres > 0),
  created_at timestamptz not null default now(),
  unique (line_id, drum_id)
);
create index if not exists drum_use_drum_idx on public.drum_use (drum_id);
create index if not exists drum_use_ro_idx on public.drum_use (ro_id);
create index if not exists drum_use_item_idx on public.drum_use (catalog_item_id);
alter table public.drum_use enable row level security;
revoke all on public.drum_use from public, anon, authenticated;

-- One invoiced oil line: its litres come from the oldest drums of that oil with oil left; anything beyond the last
-- drum counts on the last one (it shows below zero). Only lines invoiced on or after the first drum's opening day (oil
-- sold before that came from somewhere else), taken off the shelf on an issued invoice.
create or replace function public.drum_take(p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l record; d record; v_need numeric; v_take numeric; v_left numeric; v_last uuid;
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
  v_need := l.qty;
  for d in select od.id, od.litres - coalesce((select sum(u.litres) from drum_use u where u.drum_id = od.id), 0) as left_l
             from oil_drums od where od.catalog_item_id = l.catalog_item_id
            order by od.opened_on, od.created_at, od.id loop
    v_last := d.id;
    exit when v_need <= 0;
    v_left := greatest(d.left_l, 0);
    if v_left > 0 then
      v_take := least(v_need, v_left);
      insert into drum_use (drum_id, line_id, ro_id, catalog_item_id, litres) values (d.id, l.id, l.ro_id, l.catalog_item_id, v_take);
      v_need := v_need - v_take;
    end if;
  end loop;
  if v_need > 0 and v_last is not null then
    insert into drum_use (drum_id, line_id, ro_id, catalog_item_id, litres) values (v_last, l.id, l.ro_id, l.catalog_item_id, v_need)
    on conflict (line_id, drum_id) do update set litres = drum_use.litres + excluded.litres;
  end if;
end $$;
revoke execute on function public.drum_take(uuid) from public, anon, authenticated;

-- All the invoiced lines of one oil worked out again, oldest invoice first (a drum added, removed, or its oil, litres or
-- opening day changed).
create or replace function public.drum_rebuild(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if p_item is null then return; end if;
  delete from drum_use where catalog_item_id = p_item;
  for r in select i.id from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders ro on ro.id = s.ro_id
            where i.catalog_item_id = p_item and i.item_type = 'part' and i.stock_deducted and i.qty > 0 and ro.order_status = 'invoice'
            order by ro.invoiced_at, ro.invoice_number, i.id loop
    perform drum_take(r.id);
  end loop;
end $$;
revoke execute on function public.drum_rebuild(uuid) from public, anon, authenticated;

-- a line taken off the shelf on an invoice takes from the drums; put back (the invoice voided) gives its oil back. The
-- job's lines of that oil are taken again in line order, so two lines of one oil always split the same way (review).
create or replace function public.drum_use_follows_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ro uuid; r record;
begin
  if new.stock_deducted and not old.stock_deducted then
    if exists (select 1 from oil_drums where catalog_item_id = new.catalog_item_id) then
      select s.ro_id into v_ro from ro_services s where s.id = new.service_id;
      delete from drum_use where ro_id = v_ro and catalog_item_id = new.catalog_item_id;
      for r in select i.id from ro_service_items i join ro_services s on s.id = i.service_id
                where s.ro_id = v_ro and i.catalog_item_id = new.catalog_item_id and i.stock_deducted order by i.id loop
        perform drum_take(r.id);
      end loop;
    end if;
  elsif old.stock_deducted and not new.stock_deducted then
    delete from drum_use where line_id = new.id;
  end if;
  return null;
end $$;
revoke execute on function public.drum_use_follows_line() from public, anon, authenticated;
drop trigger if exists ro_items_drum_use on public.ro_service_items;
create trigger ro_items_drum_use after update of stock_deducted on public.ro_service_items
  for each row when (new.stock_deducted is distinct from old.stock_deducted) execute function public.drum_use_follows_line();

create or replace function public.drum_use_follows_drums() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform drum_rebuild(old.catalog_item_id); end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.catalog_item_id is distinct from old.catalog_item_id) then
    perform drum_rebuild(new.catalog_item_id);
  end if;
  return null;
end $$;
revoke execute on function public.drum_use_follows_drums() from public, anon, authenticated;
-- only a real change of oil, litres or opening day works the oil out again (the drum form sends them with every save;
-- a note, price or book change leaves the invoices' drums as they are)
drop trigger if exists oil_drums_drum_use on public.oil_drums;
drop trigger if exists oil_drums_drum_use_add on public.oil_drums;
create trigger oil_drums_drum_use_add after insert or delete on public.oil_drums
  for each row execute function public.drum_use_follows_drums();
drop trigger if exists oil_drums_drum_use_change on public.oil_drums;
create trigger oil_drums_drum_use_change after update of catalog_item_id, litres, opened_on on public.oil_drums
  for each row when (new.catalog_item_id is distinct from old.catalog_item_id or new.litres is distinct from old.litres
                     or new.opened_on is distinct from old.opened_on)
  execute function public.drum_use_follows_drums();

-- Where each drum's oil went (from 142), now from drum_use, with books: per drum its litres, used, left, use per
-- company (its paying PT and book, with jobs), and what each other PT or book owes the drum's owner at its price per
-- litre. Oil on open jobs (not invoiced yet) is shown per oil. Prices and amounts only for people who see costs or pay
-- supplier bills.
create or replace function public.drum_report(p_item uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb; v_money boolean;
begin
  if auth.uid() is not null and not is_staff() then raise exception 'Not allowed'; end if;
  v_money := auth.uid() is null or has_permission('view_costs') or has_permission('pay_supplier_bills');
  with dr as (
    select d.*, row_number() over (partition by d.catalog_item_id order by d.opened_on desc, d.created_at desc, d.id desc) = 1 as last
      from oil_drums d where p_item is null or d.catalog_item_id = p_item),
  per_co as (
    select u.drum_id, r.customer_id,
           case when (select c0.paid_direct from customers c0 where c0.id = r.customer_id) then payer_of(r.customer_id) end as payer,
           book_of(r.customer_id) as book,
           sum(u.litres) as litres,
           jsonb_agg(jsonb_build_object('ro_id', r.id, 'job_number', r.job_number, 'invoice_number', r.invoice_number,
                                        'litres', u.litres, 'invoiced_at', r.invoiced_at) order by r.invoiced_at) as jobs
      from drum_use u join repair_orders r on r.id = u.ro_id
     where u.drum_id in (select id from dr)
     group by u.drum_id, r.customer_id),
  drums as (
    select dr.catalog_item_id, jsonb_build_object(
             'id', dr.id, 'litres', dr.litres, 'cost_per_l', case when v_money then dr.cost_per_l end,
             'cost_estimated', dr.cost_estimated,
             'paid_by', canon_payer(dr.paid_by_name), 'paid_by_book', dr.paid_by_book, 'opened_on', dr.opened_on,
             'po_item_id', dr.po_item_id, 'note', dr.note, 'last', dr.last,
             'used', coalesce((select sum(litres) from per_co where drum_id = dr.id), 0),
             'left', dr.litres - coalesce((select sum(litres) from per_co where drum_id = dr.id), 0),
             'companies', coalesce((select jsonb_agg(jsonb_build_object('customer_id', pc.customer_id, 'company', c.display_name,
                                                                       'payer', pc.payer, 'book', pc.book, 'litres', pc.litres,
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
revoke execute on function public.drum_report(uuid) from public, anon;
grant execute on function public.drum_report(uuid) to authenticated;

-- What the invoice prints about drum oil (item 26): per oil line the drum, its owner, litres, price per litre (marked
-- when it is an estimate), the amount and whom to pay, and the totals per owner to pay. Only for issued invoices of a
-- company whose parts the PT pays directly (a company that pays the shop paid the shop for its oil). For people who
-- see reports or costs, and the company's fleet manager.
create or replace function public.invoice_drum_box(p_ro uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r repair_orders%rowtype; v_payer text; v_book text; v_lines jsonb;
begin
  select * into r from repair_orders where id = p_ro;
  if not found or r.order_status <> 'invoice' then return null; end if;
  -- drum prices are cost prices: people who see reports or costs, and the company's fleet manager (it pays them)
  if auth.uid() is not null and not ((is_staff() and (has_permission('view_reports') or has_permission('view_costs'))) or fleet_job(p_ro)) then
    return null;
  end if;
  -- as invoiced: the invoice's own "dibayar langsung" (older invoices: the company's)
  if not coalesce((r.bill_to_snapshot->>'paid_direct')::boolean, (select paid_direct from customers where id = r.customer_id), false) then return null; end if;
  v_payer := canon_payer(coalesce(nullif(r.bill_to_snapshot->>'payer', ''),
                                  (select coalesce(nullif(btrim(payer_name), ''), display_name) from customers where id = r.customer_id)));
  v_book := coalesce(nullif(r.bill_to_snapshot->>'book', ''),
                     (select regexp_replace(btrim(coalesce(nullif(btrim(book_name), ''), display_name)), '\s+', ' ', 'g') from customers where id = r.customer_id));
  select jsonb_agg(jsonb_build_object(
           'line_id', i.id, 'name', i.name, 'oil', ci.name, 'unit', ci.unit, 'litres', u.litres,
           'drum_id', d.id, 'opened_on', d.opened_on, 'drum_payer', canon_payer(d.paid_by_name), 'drum_book', d.paid_by_book,
           'cost_per_l', d.cost_per_l, 'estimated', d.cost_estimated, 'amount', round(u.litres * d.cost_per_l),
           'pay', drum_owes(d.paid_by_name, d.paid_by_book, v_payer, v_book))
         order by s.position, i.position, d.opened_on, d.created_at, d.id)
    into v_lines
    from drum_use u join oil_drums d on d.id = u.drum_id join ro_service_items i on i.id = u.line_id
    join ro_services s on s.id = i.service_id left join catalog_items ci on ci.id = u.catalog_item_id
   where u.ro_id = p_ro;
  if v_lines is null then return null; end if;
  return jsonb_build_object('payer', v_payer, 'book', v_book, 'lines', v_lines,
    'to_pay', coalesce((select jsonb_agg(jsonb_build_object('payer', x.payer, 'book', x.book, 'amount', x.amount, 'estimated', x.estimated)
                                          order by x.payer, x.book)
                          from (select l->>'drum_payer' as payer, l->>'drum_book' as book, sum((l->>'amount')::numeric) as amount,
                                       bool_or((l->>'estimated')::boolean) as estimated
                                  from jsonb_array_elements(v_lines) l where (l->>'pay')::boolean group by 1, 2) x), '[]'));
end $$;
revoke execute on function public.invoice_drum_box(uuid) from public, anon;
grant execute on function public.invoice_drum_box(uuid) to authenticated;

-- ===== 4. Km in before invoicing ===================================================================================
alter table public.repair_orders add column if not exists km_unreadable boolean not null default false;
alter table public.repair_orders add column if not exists km_unreadable_note text;
do $$ begin
  alter table public.repair_orders add constraint repair_orders_km_note_len check (char_length(km_unreadable_note) <= 200);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.repair_orders add constraint repair_orders_km_note_needed check (not km_unreadable or km_unreadable_note is not null);
exception when duplicate_object then null; end $$;
grant select (km_unreadable, km_unreadable_note), insert (km_unreadable, km_unreadable_note), update (km_unreadable, km_unreadable_note)
  on public.repair_orders to authenticated;

-- an issued invoice locks the km (from 136), now also "km tidak terbaca"
create or replace function public.lock_invoice_header() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status = 'invoice' then
    if (new.odometer_in, new.odometer_out, new.recommendations, new.driver_name, new.driver_phone, new.km_unreadable, new.km_unreadable_note)
       is distinct from (old.odometer_in, old.odometer_out, old.recommendations, old.driver_name, old.driver_phone, old.km_unreadable, old.km_unreadable_note) then
      raise exception 'This job is invoiced. Void the invoice to make changes.';
    end if;
    if new.due_date is distinct from old.due_date then
      if new.due_date is null then raise exception 'An issued invoice needs a due date'; end if;
      if auth.uid() is not null and not has_permission('void_invoices') then
        raise exception 'Only an owner or admin can change the due date of an issued invoice';
      end if;
    end if;
    if new.workflow_status not in ('invoiced','paid') then
      raise exception 'An invoiced job stays Invoiced (or Paid) on the board';
    end if;
  end if;
  -- "km tidak terbaca" needs a reason; a km entered clears it
  new.km_unreadable_note := nullif(btrim(new.km_unreadable_note), '');
  if new.odometer_in is not null and new.order_status = 'estimate' then
    new.km_unreadable := false; new.km_unreadable_note := null;
  end if;
  if new.km_unreadable and new.km_unreadable_note is null and new.order_status = 'estimate' then
    raise exception 'Say why the km can''t be read';
  end if;
  if not new.km_unreadable then new.km_unreadable_note := null; end if;
  return new;
end $$;

-- ===== 5. Invoice number = job number + version ====================================================================
-- invoice_no is a stored generated column; its formula changes by taking the column out and putting it back, with the
-- three views that show it (their definitions and grants are kept as they are).
do $$
declare
  v record; saved jsonb := '[]'; g record;
  f_new text := 'case when invoice_number is null then null::text when invoice_number >= 100000000 then ''INV-''::text || (invoice_number / 1000)::text || ''-''::text || (invoice_number % 1000)::text else ''INV-''::text || lpad(invoice_number::text, 6, ''0''::text) end';
  f_voids text := 'case when invoice_number >= 100000000 then ''INV-''::text || (invoice_number / 1000)::text || ''-''::text || (invoice_number % 1000)::text else ''INV-''::text || lpad(invoice_number::text, 6, ''0''::text) end';
begin
  if position('100000000' in coalesce((select generation_expression from information_schema.columns
                                         where table_schema = 'public' and table_name = 'repair_orders' and column_name = 'invoice_no'), '')) > 0 then
    return;   -- already done
  end if;
  for v in select c.oid, c.relname, pg_get_viewdef(c.oid) as def, c.reloptions
             from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
              and c.relname in ('repair_orders_read', 'invoice_register', 'invoice_voids_read')
            order by c.relname loop
    saved := saved || jsonb_build_array(jsonb_build_object('name', v.relname, 'def', v.def, 'opts', array_to_string(v.reloptions, ', '),
      'grants', coalesce((select jsonb_agg(jsonb_build_object('who', case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end,
                                                              'what', a.privilege_type))
                            from pg_class c2, aclexplode(c2.relacl) a where c2.oid = v.oid and a.grantee <> c2.relowner), '[]')));
    execute format('drop view public.%I', v.relname);
  end loop;
  if jsonb_array_length(saved) <> 3 then raise exception 'invoice number: the three views were not found as expected'; end if;

  alter table public.repair_orders drop column invoice_no;
  execute 'alter table public.repair_orders add column invoice_no text generated always as (' || f_new || ') stored';
  alter table public.invoice_voids drop column invoice_no;
  execute 'alter table public.invoice_voids add column invoice_no text generated always as (' || f_voids || ') stored';
  grant select (invoice_no) on public.repair_orders to authenticated;
  grant select (invoice_no) on public.invoice_voids to authenticated;

  for v in select * from jsonb_array_elements(saved) e(x) loop
    execute format('create view public.%I%s as %s', v.x->>'name',
                   case when coalesce(v.x->>'opts', '') <> '' then ' with (' || (v.x->>'opts') || ')' else '' end, v.x->>'def');
    execute format('revoke all on public.%I from public, anon, authenticated', v.x->>'name');
    for g in select * from jsonb_array_elements(v.x->'grants') e(y) loop
      execute format('grant %s on public.%I to %s', g.y->>'what', v.x->>'name', g.y->>'who');
    end loop;
  end loop;
end $$;

-- repair orders view (from 142) with "km tidak terbaca" at the end
create or replace view public.repair_orders_read with (security_barrier = true) as
with p as (
  select public.has_permission('view_reports') as money,
         public.has_permission('view_costs') as costs,
         (public.has_permission('view_costs') or public.has_permission('pay_supplier_bills')) as supplier
)
select t.id, t.job_number, t.invoice_number, t.customer_id, t.vehicle_id, t.odometer_in, t.odometer_out, t.order_status,
  case when t.workflow_status = 'paid' and not (p.money or m.works) then 'invoiced' else t.workflow_status end as workflow_status,
  t.priority, t.tags, t.service_advisor_id,
  case when (select public.is_staff()) then t.shop_notes else null::text end as shop_notes,
  t.recommendations, t.print_language, t.invoiced_at,
  case when p.money or m.works then t.due_date else null::date end as due_date,
  t.archived_at, t.faktur_pajak_number, t.bill_to_snapshot, t.shop_snapshot,
  case when p.money or m.works then t.parts_total else null::numeric end as parts_total,
  case when p.money or m.works then t.labor_total else null::numeric end as labor_total,
  case when p.money or m.works then t.other_total else null::numeric end as other_total,
  case when p.money or m.works then t.service_fees_total else null::numeric end as service_fees_total,
  case when p.money or m.works then t.item_discount_total else null::numeric end as item_discount_total,
  case when p.money or m.works then t.service_discount_total else null::numeric end as service_discount_total,
  case when p.money or m.works then t.job_fees_total else null::numeric end as job_fees_total,
  case when p.money or m.works then t.job_discount_total else null::numeric end as job_discount_total,
  case when p.money or m.works then t.subtotal else null::numeric end as subtotal,
  case when p.money or m.works then t.taxable_base else null::numeric end as taxable_base,
  case when p.money or m.works then t.tax_total else null::numeric end as tax_total,
  case when p.money or m.works then t.total else null::numeric end as total,
  case when p.money or m.works then t.paid_total else null::numeric end as paid_total,
  case when p.money or m.works then t.balance else null::numeric end as balance,
  case when p.money or m.works then t.payment_status else null::text end as payment_status,
  t.created_by, t.created_at, t.updated_at, t.job_no, t.invoice_no, t.closed_at, t.close_reason, t.closed_by,
  t.driver_name, t.driver_phone,
  case when p.money or m.works then t.labor_waived else null::numeric end as labor_waived,
  case when p.money or m.works then t.settled_direct else null::numeric end as settled_direct,
  t.km_unreadable, t.km_unreadable_note
from public.repair_orders t
  cross join p
  cross join lateral (select case when p.money then false else public.works_on_job(t.id) or public.fleet_job(t.id) end as works) m
where (select public.is_staff()) or t.id in (select public.fleet_job_ids());
revoke all on public.repair_orders_read from public, anon;
grant select on public.repair_orders_read to authenticated;

-- ===== 6. Invoicing (139's way of patching convert_to_invoice) =====================================================
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.convert_to_invoice(uuid)'::regprocedure);
  if position('-- job number + version (143)' in src) > 0 then return; end if;
  changed := src;
  -- km in, unless it can't be read (item 24)
  changed := replace(changed,
    '  perform recalc_repair_order(p_ro);                    -- final pricing while still an estimate',
    '  if ro.odometer_in is null and not ro.km_unreadable then raise exception ''Enter the km in before invoicing''; end if;   -- (143)' || chr(10) ||
    '  perform recalc_repair_order(p_ro);                    -- final pricing while still an estimate');
  -- the number: job number × 1000 + version (item 25)
  changed := replace(changed,
    '  v_inv := next_number(''invoice'');',
    '  v_inv := ro.job_number * 1000 + 1 + (select count(*) from invoice_voids where ro_id = p_ro);   -- job number + version (143)');
  -- the paying PT and the book, kept with the invoice (item 23)
  changed := replace(changed,
    '''contact'', (select name from customer_contacts where customer_id = c.id order by is_primary desc limit 1),',
    '''contact'', (select name from customer_contacts where customer_id = c.id order by is_primary desc limit 1),' || chr(10) ||
    '                                          ''payer'', canon_payer(coalesce(nullif(btrim(c.payer_name), ''''), c.display_name)), ''paid_direct'', c.paid_direct,' || chr(10) ||
    '                                          ''book'', regexp_replace(btrim(coalesce(nullif(btrim(c.book_name), ''''), c.display_name)), ''\s+'', '' '', ''g''),');
  changed := replace(changed, 'Invoice number % was already used (voided). Check the invoice counter in Settings.',
                              'Invoice number % was already used (voided).');
  if position('Enter the km in before invoicing' in changed) = 0 or position('-- job number + version (143)' in changed) = 0
     or position('''book'', regexp_replace' in changed) = 0 then
    raise exception 'convert_to_invoice: not as expected (143)';
  end if;
  execute changed;
end $$;

-- ===== 7. drum_use from the invoices so far (as 142's drum report worked it out) ==================================
do $$
declare r record;
begin
  if exists (select 1 from drum_use) then return; end if;   -- once: a second run leaves the invoices' drums as they are
  for r in select distinct catalog_item_id from oil_drums order by catalog_item_id loop
    perform drum_rebuild(r.catalog_item_id);
  end loop;
end $$;

-- ===== 8. Tanya Claude finds the new invoice numbers (INV-100045-1) =================================================
create or replace function public.tc_job_id(p_ref text)
 returns uuid language plpgsql stable set search_path to 'public' as $function$
declare v text := btrim(coalesce(p_ref, '')); d text; r uuid; m text[];
begin
  if v ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then
    select id into r from repair_orders_read where id = v::uuid; return r;
  end if;
  -- job number and version (143): INV-100045-1 → 100045001
  m := regexp_match(v, '^\s*(?:INV)?[\s.#-]*(\d{4,12})\s*[-/]\s*(\d{1,3})\s*$', 'i');
  if m is not null and v ~* 'inv' then
    select id into r from repair_orders_read where invoice_number = m[1]::bigint * 1000 + m[2]::bigint limit 1;
    if r is not null then return r; end if;
  end if;
  d := regexp_replace(v, '\D', '', 'g');
  if d = '' or length(d) > 15 then return null; end if;
  if v ~* 'inv' then
    select id into r from repair_orders_read where invoice_number = d::bigint limit 1; return r;
  end if;
  select id into r from repair_orders_read where job_number = d::bigint limit 1;
  if r is null then select id into r from repair_orders_read where invoice_number = d::bigint limit 1; end if;
  return r;
end $function$;

-- ===== 9. Overdue reminders name the invoice as the app does (INV-100045-1) ========================================
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.refresh_reminders(boolean)'::regprocedure);
  changed := replace(src, '''INV-'' || lpad(r.invoice_number::text, 6, ''0'') || '' is overdue''', 'r.invoice_no || '' is overdue''');
  if changed <> src then execute changed;
  elsif position('r.invoice_no || '' is overdue''' in src) = 0 then raise exception 'refresh_reminders: not as expected (143)';
  end if;
end $$;
