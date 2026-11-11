-- Axle v2 · 145: drum-oil statements and payments, drum oil in Tagihan PT, driver paid first (talangan), PPN once
-- per PO, no invoice while a job's PO is open, alternate part numbers as rows (Denny, Nov 11, 2026; items 28, 29,
-- 35, 36, 37 and 38 in claude/future-updates.md)
--
--  * Drum-oil debts (28): drum_statement() lists, per drum and per book that used its oil, every invoiced oil line
--    (date, invoice, truck, litres, amount), what was paid and what is still open; also the drum owner's own use (no
--    amount to pay). "Tandai lunas" (drum_mark_paid / drum_unmark_paid, Pemilik and Admin) records a payment.
--  * Tagihan PT (29): pt_supplier_bills() also returns the month's drum oil per book (whom to pay) and talangan lines.
--  * Talangan (35): a PO can be "paid by the driver first": driver, phone, nota number. The shop never pays the
--    supplier for it; whoever pays the PO (the PT · book, or the shop) pays the driver back, recorded with
--    po_reimburse() (Pemilik and Admin).
--  * PPN (36): worked out once per PO (per supplier invoice when a PO arrives in parts) on the taxable lines'
--    total, like the supplier's faktur, instead of rounding each line. Payments already made stay as recorded.
--  * Open PO lines (37): an invoice is refused while a line of the job's POs is still open (ordered − received −
--    cancelled > 0). Pemilik or Admin can invoice anyway with a written reason (convert_to_invoice_open_po), kept on
--    the invoice (invoice_open_po_note) and in the job's activity.
--  * Alternate part numbers (38): catalog_items.alt_parts, rows of {brand, number}. alt_numbers (136) stays, kept in
--    step with the rows (numbers only), so search and alternatives work as before.
--
-- Changes no business data except: alternate part numbers already typed are turned into rows (same numbers). Safe to
-- run more than once. Every UPDATE/DELETE has a WHERE.

-- ===== 0. Owner or Admin ==========================================================================================
create or replace function public.is_owner_or_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p join roles r on r.id = p.role_id
                  where p.id = auth.uid() and p.status = 'active' and r.name in ('Owner', 'Admin'))
$$;
revoke execute on function public.is_owner_or_admin() from public, anon;
grant execute on function public.is_owner_or_admin() to authenticated;

-- ===== 1. Alternate part numbers as rows (38) ======================================================================
alter table public.catalog_items add column if not exists alt_parts jsonb not null default '[]'::jsonb;
do $$ begin
  alter table public.catalog_items add constraint catalog_items_alt_parts_shape
    check (jsonb_typeof(alt_parts) = 'array' and jsonb_array_length(alt_parts) <= 30 and char_length(alt_parts::text) <= 6000);
exception when duplicate_object then null; end $$;
grant select (alt_parts), insert (alt_parts), update (alt_parts) on public.catalog_items to authenticated;

-- Free text ("Sakura C-1007, ME 013307") → rows [{brand: "Sakura", number: "C-1007"}, {brand: null, number: "ME 013307"}].
-- An entry is split at , ; / or a new line. Words before the first word with a digit are the brand, except a short
-- prefix of up to 3 letters right before it ("ME 013307"), which belongs to the number (as in lib/alternatives.js).
create or replace function public.catalog_alt_parse(p_text text) returns jsonb
language plpgsql immutable set search_path = public as $$
declare e text; w text[]; i int; k int; v_brand text; v_num text; out jsonb := '[]';
begin
  for e in select btrim(x) from regexp_split_to_table(coalesce(p_text, ''), '[,;/\n]+') x loop
    continue when e = '';
    w := regexp_split_to_array(e, '\s+');
    k := null;
    for i in 1 .. coalesce(array_length(w, 1), 0) loop
      if w[i] ~ '\d' then k := i; exit; end if;
    end loop;
    if k is null then
      v_brand := null; v_num := e;                                    -- no digit at all: keep it as typed
    else
      if k > 1 and char_length(regexp_replace(w[k - 1], '[^A-Za-z]', '', 'g')) between 1 and 3 and w[k - 1] !~ '\d' then
        k := k - 1;                                                   -- "ME 013307": the prefix goes with the number
      end if;
      v_brand := nullif(btrim(array_to_string(w[1:k - 1], ' ')), '');
      v_num := btrim(array_to_string(w[k:], ' '));
    end if;
    out := out || jsonb_build_array(jsonb_build_object('brand', v_brand, 'number', v_num));
  end loop;
  return out;
end $$;

-- rows tidied (brand and number trimmed, empty numbers dropped, at most 30) and alt_numbers = the numbers; typing
-- into alt_numbers (the import) turns into rows the same way
create or replace function public.catalog_alt_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb; v_text text;
begin
  if tg_op = 'UPDATE' and new.alt_parts is not distinct from old.alt_parts and new.alt_numbers is distinct from old.alt_numbers then
    new.alt_parts := catalog_alt_parse(new.alt_numbers);
  elsif tg_op = 'INSERT' and coalesce(jsonb_array_length(new.alt_parts), 0) = 0 and nullif(btrim(new.alt_numbers), '') is not null then
    new.alt_parts := catalog_alt_parse(new.alt_numbers);
  end if;
  if new.alt_parts is null or jsonb_typeof(new.alt_parts) <> 'array' then new.alt_parts := '[]'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('brand', b, 'number', n) order by o), '[]')
    into v_rows
    from (select nullif(regexp_replace(btrim(coalesce(x->>'brand', '')), '\s+', ' ', 'g'), '') as b,
                 nullif(regexp_replace(btrim(coalesce(x->>'number', '')), '\s+', ' ', 'g'), '') as n, o
            from jsonb_array_elements(new.alt_parts) with ordinality t(x, o)) r
   where r.n is not null;
  if jsonb_array_length(v_rows) > 30 then raise exception 'At most 30 alternate part numbers'; end if;
  if exists (select 1 from jsonb_array_elements(v_rows) x where char_length(x->>'number') > 40 or char_length(coalesce(x->>'brand', '')) > 60) then
    raise exception 'A part number is at most 40 characters and a brand 60';
  end if;
  new.alt_parts := v_rows;
  select string_agg(x->>'number', ', ' order by o) into v_text from jsonb_array_elements(v_rows) with ordinality t(x, o);
  if char_length(v_text) > 500 then raise exception 'The alternate part numbers are too long together (500 characters at most)'; end if;
  new.alt_numbers := v_text;
  if new.item_type <> 'part' then new.alt_parts := '[]'; new.alt_numbers := null; end if;
  return new;
end $$;
revoke execute on function public.catalog_alt_sync() from public, anon, authenticated;
drop trigger if exists catalog_items_alt_sync on public.catalog_items;
create trigger catalog_items_alt_sync before insert or update of alt_parts, alt_numbers, item_type on public.catalog_items
  for each row execute function public.catalog_alt_sync();

-- the numbers typed so far become rows (once: only items without rows yet)
update public.catalog_items set alt_parts = public.catalog_alt_parse(alt_numbers)
 where nullif(btrim(alt_numbers), '') is not null and jsonb_array_length(alt_parts) = 0;

-- catalog view (from 139) with the rows at the end
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
  t.alt_numbers, t.fits, t.unit, t.alt_parts
from public.catalog_items t cross join p
where (select public.is_staff());
revoke all on public.catalog_items_read from public, anon;
grant select on public.catalog_items_read to authenticated;

-- ===== 2. PPN once per PO (36) ====================================================================================
-- What a set of PO lines comes to: per line the cost and core for the quantity (rounded per line, as before), and
-- the PPN worked out once on the taxable total of each PO (and supplier invoice, when a PO arrives in parts), like
-- the supplier's faktur. Each line gets its share so the lines add up exactly to the rounded PPN: the running PPN
-- total is rounded and each line takes the step (lines in id order). Quantity: 'owed' (delivered − returned − paid),
-- 'delivered' (delivered − returned) or 'wanted' (ordered − cancelled). lib/inventory.js poAmounts() does the same.
create or replace function public.po_amounts(p_kind text, p_lines uuid[])
returns table (line_id uuid, po_id uuid, qty numeric, base numeric, tax numeric, amount numeric)
language sql stable security definer set search_path = public as $$
  with l as (
    select i.id, i.po_id, coalesce(btrim(i.supplier_invoice_no), '') as inv,
           case p_kind when 'owed' then greatest(i.qty_delivered - po_qty_returned(i.id) - i.qty_paid, 0)
                       when 'delivered' then greatest(i.qty_delivered - po_qty_returned(i.id), 0)
                       else greatest(i.qty_ordered - i.qty_cancelled, 0) end as q,
           i.cost, i.core_cost, i.taxable, coalesce(po.tax_rate, 0) as rate
      from purchase_order_items i join purchase_orders po on po.id = i.po_id
     where i.id = any(p_lines)),
  b as (
    select l.*, round(l.cost * l.q) as c, round(l.core_cost * l.q) as k,
           case when l.taxable then round(l.cost * l.q) * l.rate / 100 else 0 end as ex
      from l),
  w as (
    select b.*, sum(b.ex) over (partition by b.po_id, b.inv order by b.id rows between unbounded preceding and current row) as cum
      from b)
  select w.id, w.po_id, w.q, w.c + w.k, round(w.cum) - round(w.cum - w.ex), w.c + w.k + round(w.cum) - round(w.cum - w.ex)
    from w
$$;
revoke execute on function public.po_amounts(text, uuid[]) from public, anon, authenticated;

-- paying lines (from 131): the amounts as above (the PPN rounded once over the lines paid together of one PO)
create or replace function public.pay_po_items(p_items uuid[], p_paid_at date, p_method text, p_reference text, p_expected numeric default null)
returns numeric
language plpgsql security definer set search_path = public as $$
declare n int; v_sup uuid; v_amt numeric := 0; v_lines jsonb := '[]'; v_id uuid; v_date date := coalesce(p_paid_at, local_date()); v_ids uuid[];
begin
  if not has_permission('pay_supplier_bills') then raise exception 'Not allowed'; end if;
  if p_items is null or cardinality(p_items) = 0 then raise exception 'Pick at least one delivered line to pay'; end if;
  if v_date > local_date() then raise exception 'The payment date can''t be in the future'; end if;
  if p_method is not null and p_method not in ('transfer','cash','card','giro','other') then raise exception 'Unknown payment method'; end if;
  perform 1 from purchase_order_items where id = any(p_items) order by id for update;
  if exists (select 1 from purchase_order_items i join purchase_orders po on po.id = i.po_id
              where i.id = any(p_items) and po.talangan_name is not null) then
    raise exception 'The driver paid this PO; record "Sudah diganti" on the PO instead';
  end if;
  select count(distinct po.supplier_id), min(po.supplier_id::text)::uuid into n, v_sup
  from purchase_order_items i join purchase_orders po on po.id = i.po_id
  where i.id = any(p_items) and i.qty_delivered - po_qty_returned(i.id) > i.qty_paid;
  if n = 0 then raise exception 'Nothing left to pay on these lines'; end if;
  if n > 1 then raise exception 'Pay one supplier at a time'; end if;
  select array_agg(i.id order by i.id) into v_ids from purchase_order_items i
   where i.id = any(p_items) and i.qty_delivered - po_qty_returned(i.id) > i.qty_paid;
  select coalesce(sum(a.amount), 0),
         coalesce(jsonb_agg(jsonb_build_object('item', a.line_id, 'qty', a.qty, 'amount', a.amount) order by a.line_id), '[]')
    into v_amt, v_lines
    from po_amounts('owed', v_ids) a;
  if p_expected is not null and p_expected <> v_amt then
    raise exception 'The amount to pay has changed since this was opened. Check it and try again.';
  end if;
  insert into supplier_payments (supplier_id, amount, paid_at, method, reference, po_item_ids, lines)
  values (v_sup, v_amt, v_date, p_method, nullif(left(btrim(p_reference), 200), ''),
          array(select (x->>'item')::uuid from jsonb_array_elements(v_lines) x), v_lines)
  returning id into v_id;
  update purchase_order_items i set qty_paid = i.qty_paid + (x->>'qty')::numeric, paid_at = v_date
  from jsonb_array_elements(v_lines) x where i.id = (x->>'item')::uuid;
  return v_amt;
end $$;

-- ===== 3. Driver paid first: talangan (35) ========================================================================
alter table public.purchase_orders add column if not exists talangan_name text;
alter table public.purchase_orders add column if not exists talangan_phone text;
alter table public.purchase_orders add column if not exists talangan_nota text;
alter table public.purchase_orders add column if not exists reimbursed_on date;
alter table public.purchase_orders add column if not exists reimbursed_method text;
alter table public.purchase_orders add column if not exists reimbursed_reference text;
alter table public.purchase_orders add column if not exists reimbursed_by uuid references public.profiles(id);
do $$ begin
  alter table public.purchase_orders add constraint purchase_orders_talangan_len
    check (char_length(talangan_name) <= 120 and char_length(talangan_phone) <= 40 and char_length(talangan_nota) <= 80
           and char_length(reimbursed_reference) <= 200);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.purchase_orders add constraint purchase_orders_reimbursed_method
    check (reimbursed_method is null or reimbursed_method in ('transfer','cash','giro','other'));
exception when duplicate_object then null; end $$;
grant select (talangan_name, talangan_phone, talangan_nota, reimbursed_on, reimbursed_method, reimbursed_reference, reimbursed_by),
      insert (talangan_name, talangan_phone, talangan_nota),
      update (talangan_name, talangan_phone, talangan_nota) on public.purchase_orders to authenticated;

-- the driver's details tidied; set only while the shop has paid nothing on the PO; kept as they are once the driver
-- has been paid back (undo "Sudah diganti" first); "Sudah diganti" only through po_reimburse()
create or replace function public.check_po_talangan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.talangan_name := nullif(regexp_replace(btrim(coalesce(new.talangan_name, '')), '\s+', ' ', 'g'), '');
  new.talangan_phone := nullif(btrim(coalesce(new.talangan_phone, '')), '');
  new.talangan_nota := nullif(btrim(coalesce(new.talangan_nota, '')), '');
  if tg_op = 'UPDATE' and coalesce(current_setting('axle.reimburse', true), '') <> 'on'
     and (new.reimbursed_on, new.reimbursed_method, new.reimbursed_reference, new.reimbursed_by)
         is distinct from (old.reimbursed_on, old.reimbursed_method, old.reimbursed_reference, old.reimbursed_by) then
    raise exception 'Use "Sudah diganti" on the PO to record that the driver was paid back';
  end if;
  if tg_op = 'UPDATE' and old.reimbursed_on is not null and coalesce(current_setting('axle.reimburse', true), '') <> 'on'
     and (new.talangan_name, new.talangan_phone, new.talangan_nota) is distinct from (old.talangan_name, old.talangan_phone, old.talangan_nota) then
    raise exception 'The driver has been paid back; undo "Sudah diganti" before changing the driver''s details';
  end if;
  if new.talangan_name is not null and (tg_op = 'INSERT' or old.talangan_name is null)
     and exists (select 1 from purchase_order_items where po_id = new.id and qty_paid > 0) then
    raise exception 'The shop has paid lines on this PO; undo those payments first';
  end if;
  if new.talangan_name is null then
    new.talangan_phone := null; new.talangan_nota := null;
    new.reimbursed_on := null; new.reimbursed_method := null; new.reimbursed_reference := null; new.reimbursed_by := null;
  end if;
  return new;
end $$;
revoke execute on function public.check_po_talangan() from public, anon, authenticated;
drop trigger if exists purchase_orders_talangan on public.purchase_orders;
create trigger purchase_orders_talangan before insert or update on public.purchase_orders
  for each row execute function public.check_po_talangan();

-- the shop doesn't record supplier payments on a PO the PT pays (142) or the driver paid
create or replace function public.guard_pt_paid_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.qty_paid > old.qty_paid and po_paid_by_pt(new.po_id) then
    raise exception 'This PO is paid by the PT directly, not by the shop';
  end if;
  if new.qty_paid > old.qty_paid and exists (select 1 from purchase_orders where id = new.po_id and talangan_name is not null) then
    raise exception 'The driver paid this PO; record "Sudah diganti" on the PO instead';
  end if;
  return new;
end $$;

-- "Sudah diganti": the driver was paid back (date, how, reference), or undone with a null date. Pemilik and Admin.
create or replace function public.po_reimburse(p_po uuid, p_on date, p_method text default null, p_reference text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare po purchase_orders%rowtype;
begin
  if auth.uid() is not null and not is_owner_or_admin() then raise exception 'Only the Owner or an Admin can record this'; end if;
  select * into po from purchase_orders where id = p_po for update;
  if not found then raise exception 'PO not found'; end if;
  if po.talangan_name is null then raise exception 'This PO wasn''t paid by the driver'; end if;
  if p_on is not null and p_on > local_date() then raise exception 'The date can''t be in the future'; end if;
  if p_method is not null and p_method not in ('transfer','cash','giro','other') then raise exception 'Unknown payment method'; end if;
  perform set_config('axle.reimburse', 'on', true);
  update purchase_orders set reimbursed_on = p_on,
         reimbursed_method = case when p_on is null then null else p_method end,
         reimbursed_reference = case when p_on is null then null else nullif(left(btrim(p_reference), 200), '') end,
         reimbursed_by = case when p_on is null then null else auth.uid() end
   where id = p_po;
  perform set_config('axle.reimburse', '', true);
end $$;
revoke execute on function public.po_reimburse(uuid, date, text, text) from public, anon;
grant execute on function public.po_reimburse(uuid, date, text, text) to authenticated;

-- the shop's supplier bills (142) leave out POs the PT pays and POs the driver paid; PPN once per PO (36)
create or replace function public.supplier_bills_owed() returns table(amt numeric, due date)
language sql stable security definer set search_path = public as $$
  select a.amount,
         coalesce(pi.payment_due, coalesce(pi.invoice_date, pi.delivered_at) + coalesce(po.payment_terms_days, s.payment_terms_days, 0))
    from po_amounts('owed', array(select pi2.id from purchase_order_items pi2 join purchase_orders po2 on po2.id = pi2.po_id
                                   where pi2.qty_delivered - po_qty_returned(pi2.id) > pi2.qty_paid
                                     and not po2.paid_by_pt and po2.paid_by_name is null and po2.talangan_name is null)) a
    join purchase_order_items pi on pi.id = a.line_id join purchase_orders po on po.id = pi.po_id
    left join suppliers s on s.id = po.supplier_id;
$$;

-- ===== 4. Drum-oil statements and "Tandai lunas" (28) ==============================================================
-- Who used an invoice's oil, as the invoice was made: its paying PT and book (older invoices: the company's now);
-- null payer = a company that pays the shop.
create or replace function public.ro_payer_book(p_ro uuid, out payer text, out book text)
language sql stable security definer set search_path = public as $$
  select case when coalesce((r.bill_to_snapshot->>'paid_direct')::boolean, c.paid_direct, false)
              then canon_payer(coalesce(nullif(r.bill_to_snapshot->>'payer', ''), coalesce(nullif(btrim(c.payer_name), ''), c.display_name))) end,
         coalesce(nullif(r.bill_to_snapshot->>'book', ''), regexp_replace(btrim(coalesce(nullif(btrim(c.book_name), ''), c.display_name)), '\s+', ' ', 'g'))
    from repair_orders r join customers c on c.id = r.customer_id where r.id = p_ro
$$;
revoke execute on function public.ro_payer_book(uuid) from public, anon, authenticated;

create table if not exists public.drum_debt_payments (
  id uuid primary key default gen_random_uuid(),
  drum_id uuid not null references public.oil_drums(id) on delete cascade,
  payer text,                                   -- the PT that paid (null: companies that pay the shop)
  book text,
  amount numeric(14,0) not null check (amount > 0),
  paid_on date not null,
  method text check (method is null or method in ('transfer','cash','giro','other')),
  reference text check (char_length(reference) <= 200),
  recorded_by uuid default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists drum_debt_payments_drum_idx on public.drum_debt_payments (drum_id);
alter table public.drum_debt_payments enable row level security;
revoke all on public.drum_debt_payments from public, anon, authenticated;

-- Per drum: oil, owner (PT · book), litres, price, opened, used, left; per book that used its oil: each invoiced
-- line in the period (default: since the drum was opened), litres and amount, and all-time owed, paid, still open,
-- with the payments. The owner's own use is listed too (owes = false, nothing to pay). People who see costs or pay
-- supplier bills.
create or replace function public.drum_statement(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if auth.uid() is not null and not (is_staff() and (has_permission('view_costs') or has_permission('pay_supplier_bills'))) then
    raise exception 'Not allowed';
  end if;
  with u as (
    select u.drum_id, u.ro_id, u.litres, r.invoice_no, r.job_number, (r.invoiced_at at time zone shop_tz())::date as day,
           v.plate, c.display_name as company, pb.payer, pb.book
      from drum_use u join repair_orders r on r.id = u.ro_id join customers c on c.id = r.customer_id
      left join vehicles v on v.id = r.vehicle_id
      cross join lateral ro_payer_book(r.id) pb
     where r.order_status = 'invoice'),
  deb as (
    select u.drum_id, u.payer, case when u.payer is null then null else u.book end as book,
           sum(u.litres) as litres_all,
           jsonb_agg(jsonb_build_object('ro_id', u.ro_id, 'invoice_no', u.invoice_no, 'job_number', u.job_number, 'day', u.day,
                                        'plate', u.plate, 'company', u.company, 'litres', u.litres)
                     order by u.day, u.invoice_no) filter (where (p_from is null or u.day >= p_from) and (p_to is null or u.day <= p_to)) as lines,
           coalesce(sum(u.litres) filter (where (p_from is null or u.day >= p_from) and (p_to is null or u.day <= p_to)), 0) as litres
      from u group by 1, 2, 3)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'catalog_item_id', d.catalog_item_id, 'oil', ci.name, 'unit', ci.unit,
           'payer', canon_payer(d.paid_by_name), 'book', d.paid_by_book, 'litres', d.litres, 'cost_per_l', d.cost_per_l,
           'estimated', d.cost_estimated, 'opened_on', d.opened_on, 'note', d.note,
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
revoke execute on function public.drum_statement(date, date) from public, anon;
grant execute on function public.drum_statement(date, date) to authenticated;

-- "Tandai lunas": a payment from a book to the drum's owner (default: everything still open). Pemilik and Admin.
create or replace function public.drum_mark_paid(p_drum uuid, p_payer text, p_book text, p_amount numeric, p_paid_on date,
                                                p_method text default null, p_reference text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare d oil_drums%rowtype; v_id uuid;
begin
  if auth.uid() is not null and not is_owner_or_admin() then raise exception 'Only the Owner or an Admin can record this'; end if;
  select * into d from oil_drums where id = p_drum;
  if not found then raise exception 'Drum not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid'; end if;
  if p_paid_on is null or p_paid_on > local_date() then raise exception 'The date can''t be empty or in the future'; end if;
  if not drum_owes(d.paid_by_name, d.paid_by_book, nullif(btrim(p_payer), ''), nullif(btrim(p_book), '')) then
    raise exception 'This book doesn''t owe the drum''s owner anything';
  end if;
  insert into drum_debt_payments (drum_id, payer, book, amount, paid_on, method, reference)
  values (p_drum, canon_payer(nullif(btrim(p_payer), '')), case when nullif(btrim(p_payer), '') is not null then nullif(btrim(p_book), '') end,
          round(p_amount), p_paid_on, p_method, nullif(left(btrim(p_reference), 200), ''))
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.drum_mark_paid(uuid, text, text, numeric, date, text, text) from public, anon;
grant execute on function public.drum_mark_paid(uuid, text, text, numeric, date, text, text) to authenticated;

create or replace function public.drum_unmark_paid(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_owner_or_admin() then raise exception 'Only the Owner or an Admin can record this'; end if;
  delete from drum_debt_payments where id = p_id;
  if not found then raise exception 'Payment not found'; end if;
end $$;
revoke execute on function public.drum_unmark_paid(uuid) from public, anon;
grant execute on function public.drum_unmark_paid(uuid) to authenticated;

-- ===== 5. Tagihan PT: PPN once per PO, talangan, and the month's drum oil (29, 35, 36) ============================
-- What each PT owes in a month (143): lines delivered that month on the POs the PT pays, with each line's book, its
-- amount (PPN once per PO and supplier invoice), and for a PO the driver paid first, the driver and whether he has
-- been paid back. Plus drum_oil: the oil on the month's invoices that came from another PT's or book's drum
-- (debtor PT · book, the drum's owner, litres, amount; open = what is still unpaid on that drum for that book).
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
             greatest((select round(sum(u2.litres) * d.cost_per_l) from drum_use u2 join repair_orders r2 on r2.id = u2.ro_id
                        cross join lateral ro_payer_book(r2.id) pb2
                       where u2.drum_id = d.id and r2.order_status = 'invoice'
                         and payer_key(pb2.payer) is not distinct from payer_key(pb.payer) and payer_key(pb2.book) is not distinct from payer_key(pb.book))
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

-- ===== 6. No invoice while a job's PO is open (37) ================================================================
alter table public.repair_orders add column if not exists invoice_open_po_note text;
do $$ begin
  alter table public.repair_orders add constraint repair_orders_open_po_note_len check (char_length(invoice_open_po_note) <= 400);
exception when duplicate_object then null; end $$;
grant select (invoice_open_po_note) on public.repair_orders to authenticated;

-- an issued invoice locks the km and the driver (143), now also the reason it was made with open PO lines
create or replace function public.lock_invoice_header() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status = 'invoice' then
    if (new.odometer_in, new.odometer_out, new.recommendations, new.driver_name, new.driver_phone, new.km_unreadable, new.km_unreadable_note, new.invoice_open_po_note)
       is distinct from (old.odometer_in, old.odometer_out, old.recommendations, old.driver_name, old.driver_phone, old.km_unreadable, old.km_unreadable_note, old.invoice_open_po_note) then
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

-- repair orders view (from 143) with the open-PO note at the end
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
  t.km_unreadable, t.km_unreadable_note, t.invoice_open_po_note
from public.repair_orders t
  cross join p
  cross join lateral (select case when p.money then false else public.works_on_job(t.id) or public.fleet_job(t.id) end as works) m
where (select public.is_staff()) or t.id in (select public.fleet_job_ids());
revoke all on public.repair_orders_read from public, anon;
grant select on public.repair_orders_read to authenticated;

-- Invoicing (143's way of patching convert_to_invoice): refused while a line of the job's POs is open (ordered −
-- received − cancelled > 0, draft POs and outside work too; cancelled POs don't count), unless convert_to_invoice_open_po
-- (Pemilik or Admin, with a reason) asked for it. The reason and the open POs are kept on the invoice.
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.convert_to_invoice(uuid)'::regprocedure);
  if position('-- open PO lines (145)' in src) > 0 then return; end if;
  changed := src;
  changed := replace(changed,
    'declare ro repair_orders%rowtype; c customers%rowtype;',
    'declare v_open text; v_open_note text; ro repair_orders%rowtype; c customers%rowtype;');
  changed := replace(changed,
    '  if ro.odometer_in is null and not ro.km_unreadable then raise exception ''Enter the km in before invoicing''; end if;   -- (143)',
    '  if ro.odometer_in is null and not ro.km_unreadable then raise exception ''Enter the km in before invoicing''; end if;   -- (143)' || chr(10) ||
    '  -- open PO lines (145)' || chr(10) ||
    '  select string_agg(x.po_number || '' ('' || x.n || '')'', '', '' order by x.po_number) into v_open' || chr(10) ||
    '    from (select po.po_number, count(*) as n from purchase_order_items pi join purchase_orders po on po.id = pi.po_id' || chr(10) ||
    '           where po.ro_id = p_ro and po.status <> ''cancelled'' and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0' || chr(10) ||
    '           group by po.po_number) x;' || chr(10) ||
    '  if v_open is not null then' || chr(10) ||
    '    v_open_note := nullif(btrim(coalesce(current_setting(''axle.open_po_reason'', true), '''')), '''');' || chr(10) ||
    '    if v_open_note is null then raise exception ''Receive or cancel the open PO lines before invoicing: %'', v_open; end if;' || chr(10) ||
    '    v_open_note := left(v_open_note, 250) || '' · PO: '' || left(v_open, 140);' || chr(10) ||
    '  end if;');
  changed := replace(changed,
    '    workflow_status = ''invoiced'',',
    '    workflow_status = ''invoiced'', invoice_open_po_note = v_open_note,');
  if position('-- open PO lines (145)' in changed) = 0 or position('invoice_open_po_note = v_open_note' in changed) = 0
     or position('v_open text; v_open_note text;' in changed) = 0 then
    raise exception 'convert_to_invoice: not as expected (145)';
  end if;
  execute changed;
end $$;

-- invoicing with open PO lines anyway: Pemilik or Admin, with a written reason
create or replace function public.convert_to_invoice_open_po(p_ro uuid, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_owner_or_admin() then
    raise exception 'Only the Owner or an Admin can invoice a job whose PO is still open';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Write why the invoice is made before the PO is received'; end if;
  perform set_config('axle.open_po_reason', left(btrim(p_reason), 250), true);
  return convert_to_invoice(p_ro);
end $$;
revoke execute on function public.convert_to_invoice_open_po(uuid, text) from public, anon;
grant execute on function public.convert_to_invoice_open_po(uuid, text) to authenticated;
