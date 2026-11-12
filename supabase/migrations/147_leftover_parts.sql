-- 147 · Nov 12, 2026 (Denny, item 40): leftover PO parts.
-- A part bought on a job's PO that the PT paid (paid_by_pt) and that the job didn't use is that PT · book's leftover
-- once the job is invoiced (or closed). It sits in the shop's stock as before; now it is traced:
--   * a later job that takes that part from stock uses the oldest leftover of ITS OWN PT · book first (recorded when
--     the invoice is made, like the drum oil; voiding the invoice frees it again);
--   * when what the job takes from the shelf can only be another PT · book's leftover, the invoice is refused
--     ("Parts on the shelf belong to another book: …"); Pemilik/Admin can go ahead with a reason
--     (convert_to_invoice_reason), kept on the invoice (invoice_leftover_note);
--   * bulk oil (parts with a drum) keeps its own drum rule; parts not in the catalog aren't stock.
-- Leftovers already on the shelf are linked once: earlier invoices took their own book's leftovers first.

-- ===== 1. what was used from a leftover ===========================================================================
create table if not exists public.leftover_uses (
  id uuid primary key default gen_random_uuid(),
  po_item_id uuid not null references public.purchase_order_items(id) on delete cascade,  -- the leftover (a PO line)
  ro_id uuid not null references public.repair_orders(id) on delete cascade,              -- the job that used it
  ro_item_id uuid references public.ro_service_items(id) on delete set null,
  qty numeric(12,2) not null check (qty > 0),
  other_book boolean not null default false,     -- another PT · book's leftover, with Pemilik/Admin's reason
  backfilled boolean not null default false,     -- linked once by this migration (earlier invoices)
  created_at timestamptz not null default now()
);
create index if not exists leftover_uses_po_item_idx on public.leftover_uses (po_item_id);
create index if not exists leftover_uses_ro_idx on public.leftover_uses (ro_id);
alter table public.leftover_uses enable row level security;
revoke all on public.leftover_uses from public, anon, authenticated;

alter table public.repair_orders add column if not exists invoice_leftover_note text;
do $$ begin
  alter table public.repair_orders add constraint repair_orders_leftover_note_len check (char_length(invoice_leftover_note) <= 400);
exception when duplicate_object then null; end $$;
grant select (invoice_leftover_note) on public.repair_orders to authenticated;

-- ===== 2. the leftovers ============================================================================================
-- Per PO line of a PT-paid job PO whose job is invoiced or closed: what came in (less returns), what the job used of
-- that part (matched as the PO page does: catalog part, lines in PO order), the leftover, what later jobs took of it
-- and what remains. Only catalog parts that are counted in stock and aren't bulk oil.
create or replace function public.po_leftovers()
returns table(po_item_id uuid, po_id uuid, po_number text, src_ro uuid, src_job bigint, src_invoice text, catalog_item_id uuid,
              payer text, book text, got numeric, left_qty numeric, used numeric, remaining numeric, since timestamptz)
language sql stable security definer set search_path = public as $$
  with lines as (
    select l.id, l.po_id, po.po_number, po.ro_id, coalesce(l.catalog_item_id, tl.catalog_item_id) as cid,
           l.qty_delivered - po_qty_returned(l.id) as got, coalesce(l.delivered_at::timestamptz, l.created_at) as since, l.created_at
    from purchase_order_items l
    join purchase_orders po on po.id = l.po_id
    join repair_orders r on r.id = po.ro_id
    left join typed_part_links tl on tl.line_id = l.id
    where po.paid_by_pt and po.status <> 'cancelled' and coalesce(l.line_type, 'part') <> 'sublet'
      and (r.order_status = 'invoice' or r.closed_at is not null)
  ), keyed as (
    select x.* from lines x join catalog_items ci on ci.id = x.cid
    where x.got > 0 and ci.track_inventory and not exists (select 1 from oil_drums d where d.catalog_item_id = x.cid)
  ), need as (
    select s.ro_id, coalesce(i.catalog_item_id, pl.catalog_item_id, tl.catalog_item_id) as cid, sum(i.qty) as n
    from ro_service_items i
    join ro_services s on s.id = i.service_id
    left join purchase_order_items pl on pl.id = i.po_item_id
    left join typed_part_links tl on tl.line_id = i.po_item_id
    where i.item_type = 'part' and s.approval_status = 'approved' and s.ro_id in (select k.ro_id from keyed k)
    group by 1, 2
  ), alloc as (
    select k.*, coalesce(nd.n, 0) as n,
           coalesce(sum(k.got) over (partition by k.ro_id, k.cid order by k.created_at, k.id rows between unbounded preceding and 1 preceding), 0) as before
    from keyed k left join need nd on nd.ro_id = k.ro_id and nd.cid = k.cid
  ), lo as (
    select a.*, a.got - least(a.got, greatest(0, a.n - a.before)) as left_qty,
           coalesce((select sum(u.qty) from leftover_uses u where u.po_item_id = a.id), 0) as used
    from alloc a
  )
  select lo.id, lo.po_id, lo.po_number, lo.ro_id, r.job_number, r.invoice_no, lo.cid, pb.payer, pb.book,
         lo.got, lo.left_qty, lo.used, greatest(0, lo.left_qty - lo.used), lo.since
  from lo join repair_orders r on r.id = lo.ro_id cross join lateral ro_payer_book(lo.ro_id) pb
  where lo.left_qty > 0 and pb.payer is not null
$$;
revoke execute on function public.po_leftovers() from public, anon, authenticated;

-- ===== 3. which leftovers an invoice will take ======================================================================
-- For each catalog part the job takes from the shelf (approved part lines not covered by their own PO's delivery):
-- first its own PT · book's leftovers (oldest first), then the shop's own stock (the shelf less this job's own
-- deliveries, other open jobs' deliveries and every leftover), and only then another book's leftovers (other_book).
create or replace function public.leftover_plan(p_ro uuid)
returns table(catalog_item_id uuid, ro_item_id uuid, po_item_id uuid, qty numeric, other_book boolean,
              payer text, book text, po_number text, src_job bigint, src_invoice text, item_name text)
language plpgsql stable security definer set search_path = public as $$
declare me record; c record; it record; src record;
        v_shelf numeric; v_own numeric; v_pending numeric; v_all numeric; v_free numeric; v_left numeric; v_take numeric;
        q_ids uuid[]; q_left numeric[]; q_other boolean[]; k int;
begin
  select * into me from ro_payer_book(p_ro);
  for c in
    select i.catalog_item_id as cid, ci.qty_on_hand as shelf, min(ci.name) as cname
    from ro_service_items i join ro_services s on s.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
    where s.ro_id = p_ro and s.approval_status = 'approved' and i.item_type = 'part' and ci.track_inventory and not i.stock_deducted
      and not exists (select 1 from oil_drums d where d.catalog_item_id = i.catalog_item_id)
    group by i.catalog_item_id, ci.qty_on_hand
  loop
    -- this job's own deliveries of the part (on the shelf until this invoice takes them off)
    select coalesce(sum(l.qty_delivered - po_qty_returned(l.id)), 0) into v_own
    from purchase_order_items l join purchase_orders po on po.id = l.po_id left join typed_part_links tl on tl.line_id = l.id
    where po.ro_id = p_ro and po.status <> 'cancelled' and coalesce(l.catalog_item_id, tl.catalog_item_id) = c.cid;
    -- other open jobs' deliveries of it (still on the shelf, kept for those jobs)
    select coalesce(sum(l.qty_delivered - po_qty_returned(l.id)), 0) into v_pending
    from purchase_order_items l join purchase_orders po on po.id = l.po_id join repair_orders r on r.id = po.ro_id
         left join typed_part_links tl on tl.line_id = l.id
    where po.ro_id <> p_ro and po.status <> 'cancelled' and r.order_status <> 'invoice' and r.closed_at is null
      and coalesce(l.catalog_item_id, tl.catalog_item_id) = c.cid;
    -- the leftovers: own book first, then the others; oldest first
    q_ids := '{}'; q_left := '{}'; q_other := '{}'; v_all := 0;
    for src in
      select x.po_item_id, x.remaining, not (me.payer is not null and payer_key(x.payer) = payer_key(me.payer) and payer_key(x.book) = payer_key(me.book)) as other
      from po_leftovers() x where x.catalog_item_id = c.cid and x.remaining > 0 and x.src_ro <> p_ro
      order by 3, x.since, x.po_item_id
    loop
      q_ids := q_ids || src.po_item_id; q_left := q_left || src.remaining; q_other := q_other || src.other;
      v_all := v_all + src.remaining;
    end loop;
    v_free := greatest(0, coalesce(c.shelf, 0) - v_own - v_pending - v_all);
    -- the job's lines of this part, unlinked ones first; each takes what its own PO line didn't bring
    for it in
      select i.id, i.name, greatest(0, i.qty - coalesce((select l.qty_delivered - po_qty_returned(l.id) from purchase_order_items l
                                                          join purchase_orders po on po.id = l.po_id
                                                          where l.id = i.po_item_id and po.ro_id = p_ro and po.status <> 'cancelled'), 0)) as need
      from ro_service_items i join ro_services s on s.id = i.service_id
      where s.ro_id = p_ro and s.approval_status = 'approved' and i.item_type = 'part' and i.catalog_item_id = c.cid and not i.stock_deducted
      order by (i.po_item_id is not null), s.position, i.position, i.id
    loop
      v_left := it.need;
      -- 1) own book's leftovers
      for k in 1 .. coalesce(array_length(q_ids, 1), 0) loop
        exit when v_left <= 0;
        continue when q_other[k] or q_left[k] <= 0;
        v_take := least(v_left, q_left[k]); q_left[k] := q_left[k] - v_take; v_left := v_left - v_take;
        select x.payer, x.book, x.po_number, x.src_job, x.src_invoice into src from po_leftovers() x where x.po_item_id = q_ids[k];
        catalog_item_id := c.cid; ro_item_id := it.id; po_item_id := q_ids[k]; qty := v_take; other_book := false;
        payer := src.payer; book := src.book; po_number := src.po_number; src_job := src.src_job; src_invoice := src.src_invoice; item_name := it.name;
        return next;
      end loop;
      -- 2) the shop's own stock
      v_take := least(v_left, v_free); v_free := v_free - v_take; v_left := v_left - v_take;
      -- 3) another book's leftovers
      for k in 1 .. coalesce(array_length(q_ids, 1), 0) loop
        exit when v_left <= 0;
        continue when not q_other[k] or q_left[k] <= 0;
        v_take := least(v_left, q_left[k]); q_left[k] := q_left[k] - v_take; v_left := v_left - v_take;
        select x.payer, x.book, x.po_number, x.src_job, x.src_invoice into src from po_leftovers() x where x.po_item_id = q_ids[k];
        catalog_item_id := c.cid; ro_item_id := it.id; po_item_id := q_ids[k]; qty := v_take; other_book := true;
        payer := src.payer; book := src.book; po_number := src.po_number; src_job := src.src_job; src_invoice := src.src_invoice; item_name := it.name;
        return next;
      end loop;
      -- what is still missing simply goes below zero on the shelf, as before (a warning in the invoice dialog)
    end loop;
  end loop;
end $$;
revoke execute on function public.leftover_plan(uuid) from public, anon, authenticated;

-- records the plan when the invoice is made; refuses another book's leftover without Pemilik/Admin's reason
create or replace function public.leftover_allocate(p_ro uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_other text; v_reason text;
begin
  select string_agg(x.item_name || ' (' || rtrim(to_char(x.qty, 'FM999990.##'), '.') || ') → ' || x.payer || coalesce(' · ' || x.book, ''), '; ' order by x.item_name)
    into v_other from leftover_plan(p_ro) x where x.other_book;
  if v_other is not null then
    v_reason := nullif(btrim(coalesce(current_setting('axle.leftover_reason', true), '')), '');
    if v_reason is null then raise exception 'Parts on the shelf belong to another book: %', v_other; end if;
  end if;
  insert into leftover_uses (po_item_id, ro_id, ro_item_id, qty, other_book)
  select x.po_item_id, p_ro, x.ro_item_id, x.qty, x.other_book from leftover_plan(p_ro) x;
  return case when v_other is null then null else left(v_reason, 250) || ' · ' || left(v_other, 140) end;
end $$;
revoke execute on function public.leftover_allocate(uuid) from public, anon, authenticated;

-- a voided invoice gives its leftovers back
create or replace function public.leftover_uses_void() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status is distinct from 'invoice' then
    delete from leftover_uses where ro_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists repair_orders_leftover_void on public.repair_orders;
create trigger repair_orders_leftover_void after update of order_status on public.repair_orders
  for each row execute function public.leftover_uses_void();

-- ===== 4. invoicing =================================================================================================
-- an issued invoice locks the km, the driver, the open-PO reason (145) and now the leftover reason
create or replace function public.lock_invoice_header() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.order_status = 'invoice' and new.order_status = 'invoice' then
    if (new.odometer_in, new.odometer_out, new.recommendations, new.driver_name, new.driver_phone, new.km_unreadable, new.km_unreadable_note, new.invoice_open_po_note, new.invoice_leftover_note)
       is distinct from (old.odometer_in, old.odometer_out, old.recommendations, old.driver_name, old.driver_phone, old.km_unreadable, old.km_unreadable_note, old.invoice_open_po_note, old.invoice_leftover_note) then
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
  -- a voided invoice drops its leftover reason with it
  if new.order_status is distinct from 'invoice' then new.invoice_leftover_note := null; end if;
  return new;
end $$;

-- convert_to_invoice (145's way of patching): the leftovers are recorded before the invoice is made
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.convert_to_invoice(uuid)'::regprocedure);
  if position('-- leftovers of other jobs'' POs (147)' in src) > 0 then return; end if;
  changed := src;
  changed := replace(changed, 'declare v_open text; v_open_note text;', 'declare v_left_note text; v_open text; v_open_note text;');
  changed := replace(changed,
    '  perform recalc_repair_order(p_ro);                    -- final pricing while still an estimate',
    '  -- leftovers of other jobs'' POs (147)' || chr(10) ||
    '  v_left_note := leftover_allocate(p_ro);' || chr(10) ||
    '  perform recalc_repair_order(p_ro);                    -- final pricing while still an estimate');
  changed := replace(changed, 'invoice_open_po_note = v_open_note,', 'invoice_open_po_note = v_open_note, invoice_leftover_note = v_left_note,');
  if position('-- leftovers of other jobs'' POs (147)' in changed) = 0 or position('invoice_leftover_note = v_left_note' in changed) = 0
     or position('v_left_note text;' in changed) = 0 then
    raise exception 'convert_to_invoice: not as expected (147)';
  end if;
  execute changed;
end $$;

-- invoicing anyway (Pemilik or Admin, with a reason): covers an open PO (145) and another book's leftover (147)
create or replace function public.convert_to_invoice_reason(p_ro uuid, p_reason text) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_owner_or_admin() then
    raise exception 'Only the Owner or an Admin can invoice a job whose PO is still open';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Write why the invoice is made before the PO is received'; end if;
  perform set_config('axle.open_po_reason', left(btrim(p_reason), 250), true);
  perform set_config('axle.leftover_reason', left(btrim(p_reason), 250), true);
  return convert_to_invoice(p_ro);
end $$;
revoke execute on function public.convert_to_invoice_reason(uuid, text) from public, anon;
grant execute on function public.convert_to_invoice_reason(uuid, text) to authenticated;

-- ===== 5. for the app ===============================================================================================
-- p_po: per line of that PO its leftover (PT · book, left, remaining) and the jobs that used it.
-- p_ro: what the job took from leftovers (an issued invoice) or will take (an open job: the plan; other_book = blocked).
-- Staff only; nothing for fleet managers.
create or replace function public.leftover_info(p_ro uuid default null, p_po uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb := '{}'::jsonb;
begin
  if not is_staff() then return null; end if;
  if p_po is not null then
    out := out || jsonb_build_object('lines', coalesce((
      select jsonb_agg(jsonb_build_object('line_id', x.po_item_id, 'payer', x.payer, 'book', x.book, 'left', x.left_qty, 'remaining', x.remaining,
        'uses', coalesce((select jsonb_agg(jsonb_build_object('ro_id', u.ro_id, 'job_number', r.job_number, 'invoice_no', r.invoice_no, 'qty', u.qty,
                                                              'other_book', u.other_book) order by u.created_at)
                          from leftover_uses u join repair_orders r on r.id = u.ro_id where u.po_item_id = x.po_item_id), '[]'::jsonb)))
      from po_leftovers() x where x.po_id = p_po), '[]'::jsonb));
  end if;
  if p_ro is not null then
    if exists (select 1 from repair_orders where id = p_ro and order_status = 'invoice') then
      out := out || jsonb_build_object('planned', false, 'uses', coalesce((
        select jsonb_agg(jsonb_build_object('ro_item_id', u.ro_item_id, 'qty', u.qty, 'other_book', u.other_book, 'po_id', po.id, 'po_number', po.po_number,
                                            'src_ro', r.id, 'src_job', r.job_number, 'src_invoice', r.invoice_no, 'payer', pb.payer, 'book', pb.book) order by u.created_at)
        from leftover_uses u join purchase_order_items l on l.id = u.po_item_id join purchase_orders po on po.id = l.po_id
             join repair_orders r on r.id = po.ro_id cross join lateral ro_payer_book(r.id) pb
        where u.ro_id = p_ro), '[]'::jsonb));
    else
      out := out || jsonb_build_object('planned', true, 'uses', coalesce((
        select jsonb_agg(jsonb_build_object('ro_item_id', x.ro_item_id, 'qty', x.qty, 'other_book', x.other_book, 'po_id', l.po_id, 'po_number', x.po_number,
                                            'src_ro', po.ro_id, 'src_job', x.src_job, 'src_invoice', x.src_invoice, 'payer', x.payer, 'book', x.book, 'name', x.item_name))
        from leftover_plan(p_ro) x join purchase_order_items l on l.id = x.po_item_id join purchase_orders po on po.id = l.po_id), '[]'::jsonb));
    end if;
  end if;
  return out;
end $$;
revoke execute on function public.leftover_info(uuid, uuid) from public, anon;
grant execute on function public.leftover_info(uuid, uuid) to authenticated;

-- repair orders view (from 145) with the leftover note at the end
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
  t.km_unreadable, t.km_unreadable_note, t.invoice_open_po_note, t.invoice_leftover_note
from public.repair_orders t
  cross join p
  cross join lateral (select case when p.money then false else public.works_on_job(t.id) or public.fleet_job(t.id) end as works) m
where (select public.is_staff()) or t.id in (select public.fleet_job_ids());
revoke all on public.repair_orders_read from public, anon;
grant select on public.repair_orders_read to authenticated;

-- ===== 6. leftovers already on the shelf: linked once ===============================================================
-- Earlier invoices are replayed in order: each took its own PT · book's leftovers (from jobs invoiced before it) first
-- for the parts it took from the shelf. Nothing is refused and nothing else changes. Runs only while nothing is linked.
do $$
declare j record; it record; x record; v_left numeric; v_take numeric; n int := 0;
begin
  if exists (select 1 from leftover_uses) then return; end if;
  for j in
    select r.id, r.invoiced_at, pb.payer, pb.book
    from repair_orders r cross join lateral ro_payer_book(r.id) pb
    where r.order_status = 'invoice' and pb.payer is not null
    order by r.invoiced_at, r.id
  loop
    for it in
      select i.id, i.catalog_item_id as cid,
             greatest(0, i.qty - coalesce((select l.qty_delivered - po_qty_returned(l.id) from purchase_order_items l join purchase_orders po on po.id = l.po_id
                                           where l.id = i.po_item_id and po.ro_id = j.id and po.status <> 'cancelled'), 0)) as need
      from ro_service_items i join ro_services s on s.id = i.service_id join catalog_items ci on ci.id = i.catalog_item_id
      where s.ro_id = j.id and s.approval_status = 'approved' and i.item_type = 'part' and ci.track_inventory
        and not exists (select 1 from oil_drums d where d.catalog_item_id = i.catalog_item_id)
      order by (i.po_item_id is not null), s.position, i.position, i.id
    loop
      v_left := it.need;
      continue when v_left <= 0;
      for x in
        select lo.po_item_id, lo.remaining from po_leftovers() lo join repair_orders sr on sr.id = lo.src_ro
        where lo.catalog_item_id = it.cid and lo.remaining > 0 and lo.src_ro <> j.id and sr.invoiced_at < j.invoiced_at
          and payer_key(lo.payer) = payer_key(j.payer) and payer_key(lo.book) = payer_key(j.book)
        order by lo.since, lo.po_item_id
      loop
        exit when v_left <= 0;
        v_take := least(v_left, x.remaining);
        insert into leftover_uses (po_item_id, ro_id, ro_item_id, qty, backfilled) values (x.po_item_id, j.id, it.id, v_take, true);
        v_left := v_left - v_take; n := n + 1;
      end loop;
    end loop;
  end loop;
  raise notice 'leftovers linked to earlier invoices: % row(s)', n;
end $$;
