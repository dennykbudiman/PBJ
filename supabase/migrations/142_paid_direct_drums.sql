-- Axle v2 · 142: money while the PTs pay their suppliers directly; labour "tidak ditagih"; bulk oil per drum
-- (Denny, Nov 9, 2026; item 21 in claude/future-updates.md)
--
-- No shop bank account or cashier yet: every customer is a group PT, the shop makes the POs, the supplier bills the PT
-- and the PT pays. Labour isn't charged. Bulk oil is bought by one PT per drum, and that PT charges the others for what
-- their trucks used when the drum is empty.
--
--  * Per company: "Part dibayar langsung oleh PT ke supplier" (paid_direct) and "Jasa tidak ditagih"
--    (labour_not_charged), plus "PT pembayar" (payer_name) to group companies that are one paying PT.
--  * A job of such a company: part and sublet lines (and their PPN) are settled outside the shop (settled_direct), so
--    the balance owed to the shop leaves them out; labour keeps its price on the lines but isn't in the total
--    (labor_waived records its value). Frozen when the invoice is made, like every other figure.
--  * Its POs are "paid by the PT" (paid_by_pt): not the shop's supplier bills. A stock PO (a drum) can name the PT
--    that paid it (paid_by_name).
--  * oil_drums + drum_report(): litres per drum, used per company (first in, first out over invoiced job lines),
--    left, and what each other PT owes the drum's PT.
--  * PPN while the shop is non-PKP: on the job, a PO cost includes the supplier's PPN (the shop can't claim it back).
--    Suppliers that don't charge PPN: charges_tax on the supplier, and a per-PO switch.
--
-- This migration changes no data: the companies' settings and the clean-up of past invoices are a separate step.
-- Safe to run more than once. Every UPDATE/DELETE has a WHERE (Supabase loads safeupdate for app requests).

-- ===== 1. Company settings ========================================================================================
alter table public.customers add column if not exists paid_direct boolean not null default false;
alter table public.customers add column if not exists labour_not_charged boolean not null default false;
alter table public.customers add column if not exists payer_name text;
do $$ begin
  alter table public.customers add constraint customers_payer_name_len check (char_length(payer_name) <= 120);
exception when duplicate_object then null; end $$;
grant select (paid_direct, labour_not_charged, payer_name), insert (paid_direct, labour_not_charged, payer_name),
      update (paid_direct, labour_not_charged, payer_name) on public.customers to authenticated;

-- customers view (from 133) with the three settings at the end
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
    t.payer_name
   FROM (customers t
     CROSS JOIN p)
  WHERE (( SELECT is_staff() AS is_staff) OR (t.id IN ( SELECT fleet_customer_ids() AS fleet_customer_ids)));
revoke all on public.customers_read from public, anon;
grant select on public.customers_read to authenticated;

-- A paying PT's name, spelt one way (142c): " pt  Pulau Indah" and "PT PULAU INDAH" are the same PT. The spelling
-- used is the company of that name, else the first company that names it as its paying PT; any other name (a drum's
-- or a stock PO's payer) just has its spaces tidied.
create or replace function public.payer_key(p text) returns text
language sql immutable as $$ select nullif(lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')), '') $$;
create or replace function public.canon_payer(p text) returns text
language sql stable security definer set search_path = public as $$
  select case when payer_key(p) is null then null else coalesce(
    (select coalesce(nullif(btrim(c.payer_name), ''), c.display_name) from customers c
      where payer_key(coalesce(nullif(btrim(c.payer_name), ''), c.display_name)) = payer_key(p)
      order by payer_key(c.display_name) = payer_key(p) desc, c.created_at, c.id limit 1),
    regexp_replace(btrim(p), '\s+', ' ', 'g')) end
$$;
revoke execute on function public.canon_payer(text) from public, anon, authenticated;

-- the paying PT a company belongs to: its "PT pembayar", else its own name
create or replace function public.payer_of(p_customer uuid) returns text
language sql stable security definer set search_path = public as $$
  select canon_payer(coalesce(nullif(btrim(payer_name), ''), display_name)) from customers
   where id = p_customer and (auth.uid() is null or (select is_staff()) or id in (select fleet_customer_ids()))
$$;
revoke execute on function public.payer_of(uuid) from public, anon;
grant execute on function public.payer_of(uuid) to authenticated;

-- ===== 2. Job figures: labour not charged, settled outside the shop ==============================================
alter table public.repair_orders add column if not exists labor_waived numeric(14,0) not null default 0;
alter table public.repair_orders add column if not exists settled_direct numeric(14,0) not null default 0;
-- money, like the other totals: read through repair_orders_read only (an earlier copy of 142 granted them; 142c)
revoke select (labor_waived, settled_direct) on public.repair_orders from authenticated;

-- repair orders view (from 136) with the two figures at the end (money, like the other totals)
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
  case when p.money or m.works then t.settled_direct else null::numeric end as settled_direct
from public.repair_orders t
  cross join p
  cross join lateral (select case when p.money then false else public.works_on_job(t.id) or public.fleet_job(t.id) end as works) m
where (select public.is_staff()) or t.id in (select public.fleet_job_ids());
revoke all on public.repair_orders_read from public, anon;
grant select on public.repair_orders_read to authenticated;

-- The job's totals (from 131/132), plus:
--  * labour of a company with "Jasa tidak ditagih": its lines keep their prices, but count as if absent from the
--    totals; their value goes to labor_waived;
--  * a company with "Part dibayar langsung": its part and sublet lines (after their share of discounts) and the PPN on
--    them are settled outside the shop (settled_direct), so the balance owed to the shop leaves them out.
-- An issued invoice never re-prices; only the payment side moves.
create or replace function public.recalc_repair_order(p_ro uuid)
 returns void language plpgsql security definer set search_path = public as $function$
declare
  s record; st shop_settings%rowtype; ro repair_orders%rowtype; cu customers%rowtype;
  v_parts numeric := 0; v_labor numeric := 0; v_other numeric := 0; v_fees numeric := 0;
  v_item_disc numeric := 0; v_svc_disc numeric := 0; v_taxable numeric := 0;
  v_job_fees numeric := 0; v_job_disc numeric := 0; v_pre numeric; v_base numeric; v_amt numeric;
  v_subtotal numeric; v_tax numeric; v_paid numeric; v_total numeric; v_taxable_fees numeric := 0; v_rate numeric;
  line_sum numeric; line_taxable numeric; svc_total numeric; svc_disc numeric; svc_taxable numeric;
  c_p numeric; c_l numeric; c_o numeric; c_f numeric; c_disc numeric; k numeric; rem numeric; any_taxable boolean;
  c_lt numeric; c_ld numeric; c_pst numeric; c_set numeric; c_po numeric; v_waived numeric := 0; v_set_pre numeric := 0; v_set_tax numeric := 0;
  v_settled numeric := 0; v_due numeric; v_taxable_raw numeric; v_share numeric;
  f record; d record;
begin
  select * into ro from repair_orders where id = p_ro for no key update;
  if not found then return; end if;

  select coalesce(sum(case when kind = 'payment' then amount else -amount end),0) into v_paid from payments where ro_id = p_ro;
  if v_paid < 0 then raise exception 'Refunds can''t be more than the payments received on this job'; end if;
  select v_paid + coalesce(sum(amount),0) into v_paid from credit_memos where applied_ro_id = p_ro;

  if ro.order_status = 'invoice' then
    v_due := ro.total - ro.settled_direct;
    if v_paid > v_due then
      raise exception 'That is more than the balance due on this invoice (Rp %)', to_char(v_due, 'FM999G999G999G990');
    end if;
    -- an issued invoice never re-prices; only the payment side moves
    update repair_orders set paid_total = v_paid, balance = v_due - v_paid,
      payment_status = case when v_paid >= v_due then 'paid' when v_paid > 0 then 'partial' else 'unpaid' end,
      workflow_status = case when v_paid >= v_due then 'paid' when workflow_status = 'paid' then 'invoiced' else workflow_status end
    where id = p_ro;
    return;
  end if;

  select * into st from shop_settings limit 1;
  select * into cu from customers where id = ro.customer_id;
  v_rate := case when st.pkp_status = 'non_pkp' then 0 else st.tax_rate end;

  for s in select * from ro_services where ro_id = p_ro loop
    select coalesce(sum(net + round(core_charge * qty)),0),
           coalesce(sum(net + round(core_charge * qty)) filter (where taxable),0),
           coalesce(sum(net + round(core_charge * qty)) filter (where item_type = 'part'),0),
           coalesce(sum(net) filter (where item_type = 'labor'),0),
           coalesce(sum(net) filter (where item_type = 'sublet'),0),
           coalesce(sum(net) filter (where item_type = 'fee'),0),
           coalesce(sum(discount),0), bool_or(taxable),
           coalesce(sum(net) filter (where item_type = 'labor' and taxable),0),
           coalesce(sum(discount) filter (where item_type = 'labor'),0),
           -- parts and sublet the PT pays for itself (142): not bought by the shop; the share of each line the PT's
           -- POs (or drums) cover (142c: by quantity, see line_paid_share)
           coalesce(sum((net + round(core_charge * qty)) * line_paid_share(id, catalog_item_id, qty))
                      filter (where cu.paid_direct and item_type in ('part', 'sublet') and taxable),0),
           coalesce(sum((net + round(core_charge * qty)) * line_paid_share(id, catalog_item_id, qty))
                      filter (where cu.paid_direct and item_type in ('part', 'sublet')),0)
      into line_sum, line_taxable, c_p, c_l, c_o, c_f, c_disc, any_taxable, c_lt, c_ld, c_pst, c_set
      from ro_service_items where service_id = s.id;
    if s.flat_price is not null then
      if line_sum > 0 then
        k := s.flat_price / line_sum;
        c_po := c_p + c_o;
        c_p := round(c_p * k); c_l := round(c_l * k); c_o := round(c_o * k); c_f := round(c_f * k);
        rem := s.flat_price - (c_p + c_l + c_o + c_f);
        if c_p >= greatest(c_l, c_o, c_f) then c_p := c_p + rem; elsif c_l >= greatest(c_o, c_f) then c_l := c_l + rem;
        elsif c_o >= c_f then c_o := c_o + rem; else c_f := c_f + rem; end if;
        line_taxable := line_taxable * k; c_lt := c_lt * k; c_pst := c_pst * k;
        -- what the PT settled: its share of the parts and sublet as rounded above, so a package the PT settles in full
        -- leaves exactly Rp 0 (142c)
        c_set := case when c_po > 0 then c_set * (c_p + c_o) / c_po else 0 end;
      else
        -- no priced lines: taxed like its lines (any taxable one), or with no lines, like new items (Settings)
        c_p := 0; c_l := s.flat_price; c_o := 0; c_f := 0;
        line_taxable := case when coalesce(any_taxable, st.new_items_taxable, false) then s.flat_price else 0 end;
        c_lt := line_taxable; c_pst := 0; c_set := 0;
      end if;
      c_disc := 0; c_ld := 0;   -- the company pays the flat price: line discounts inside it aren't discounts given (132)
      svc_total := s.flat_price;
    else
      svc_total := line_sum;
    end if;
    -- labour not charged (142): it counts as if it weren't there; its value is kept as labor_waived
    if cu.labour_not_charged and s.approval_status in ('pending','approved') then
      v_waived := v_waived + c_l;
      svc_total := svc_total - c_l; line_taxable := line_taxable - c_lt; c_disc := c_disc - c_ld; c_l := 0;
    end if;
    svc_taxable := line_taxable;
    svc_disc := case when s.discount_pct > 0 then round(svc_total * s.discount_pct / 100) else least(s.discount_amount, svc_total) end;
    update ro_services set service_total = svc_total, service_discount = svc_disc, service_net = svc_total - svc_disc
      where id = s.id and (service_total, service_discount, service_net) is distinct from (svc_total, svc_disc, svc_total - svc_disc);
    if s.approval_status in ('pending','approved') then
      v_parts := v_parts + c_p; v_labor := v_labor + c_l; v_other := v_other + c_o; v_fees := v_fees + c_f;
      v_item_disc := v_item_disc + c_disc;
      v_svc_disc := v_svc_disc + svc_disc;
      if svc_total > 0 then
        v_taxable := v_taxable + svc_taxable * (svc_total - svc_disc) / svc_total;
        -- parts and sublet paid directly by the PT (142): their share after the service discount, and their taxable part
        v_set_pre := v_set_pre + c_set * (svc_total - svc_disc) / svc_total;
        v_set_tax := v_set_tax + c_pst * (svc_total - svc_disc) / svc_total;
      end if;
    end if;
  end loop;

  for f in select * from ro_job_fees where ro_id = p_ro loop
    if f.manual_override then
      v_amt := f.amount;
    elsif f.is_shop_supplies then
      -- the job's own rate (copied from Settings when the job was created, editable per job); base and min/max from Settings
      v_base := greatest(case st.shop_supplies_base when 'parts' then v_parts when 'labor' then v_labor else v_parts + v_labor end, 0);
      v_amt := case when f.kind = 'fixed' then round(f.value) else round(v_base * f.value / 100) end;
      if st.shop_supplies_min is not null then v_amt := greatest(v_amt, st.shop_supplies_min); end if;
      if st.shop_supplies_max is not null then v_amt := least(v_amt, st.shop_supplies_max); end if;
      if v_base = 0 then v_amt := 0; end if;
    elsif f.kind = 'percent' then
      v_amt := round(greatest(v_parts + v_labor, 0) * f.value / 100);
    else
      v_amt := round(f.value);
    end if;
    v_amt := greatest(v_amt, 0);
    update ro_job_fees set amount = v_amt where id = f.id and amount is distinct from v_amt;
    v_job_fees := v_job_fees + v_amt;
    if f.taxable then v_taxable_fees := v_taxable_fees + v_amt; end if;
  end loop;

  v_pre := v_parts + v_labor + v_other + v_fees - v_svc_disc + v_job_fees;

  for d in select * from ro_job_discounts where ro_id = p_ro loop
    v_amt := case when d.kind = 'percent' then round(v_pre * d.value / 100) else round(d.value) end;
    if d.max_amount is not null then v_amt := least(v_amt, d.max_amount); end if;
    v_amt := greatest(least(v_amt, v_pre - v_job_disc), 0);
    update ro_job_discounts set amount = v_amt where id = d.id and amount is distinct from v_amt;
    v_job_disc := v_job_disc + v_amt;
  end loop;

  v_subtotal := v_pre - v_job_disc;
  v_taxable := v_taxable + v_taxable_fees;
  if v_pre > 0 then
    v_taxable := v_taxable * (v_pre - v_job_disc) / v_pre;
    v_set_pre := v_set_pre * (v_pre - v_job_disc) / v_pre;
    v_set_tax := v_set_tax * (v_pre - v_job_disc) / v_pre;
  end if;
  if coalesce(cu.tax_exempt, false) then v_taxable := 0; v_set_tax := 0; end if;
  v_taxable_raw := v_taxable;
  v_taxable := round(v_taxable);
  v_tax := round(v_taxable * v_rate / 100);
  v_total := v_subtotal + v_tax;
  -- what the PT settled = the total less the shop's own share, rounded once (so a job the PT settles in full owes 0)
  if v_set_pre > 0 or v_set_tax > 0 then
    v_share := greatest(round((v_subtotal - v_set_pre) + (v_taxable_raw - v_set_tax) * v_rate / 100), 0);
    v_settled := least(greatest(v_total - v_share, 0), v_total);
  end if;

  update repair_orders set
    parts_total = v_parts, labor_total = v_labor, other_total = v_other, service_fees_total = v_fees,
    item_discount_total = v_item_disc, service_discount_total = v_svc_disc,
    job_fees_total = v_job_fees, job_discount_total = v_job_disc,
    subtotal = v_subtotal, taxable_base = v_taxable, tax_total = v_tax, total = v_total,
    labor_waived = round(v_waived), settled_direct = v_settled,
    paid_total = v_paid, balance = v_total - v_settled - v_paid,
    -- paid once payments cover what the shop is owed; a job the PT settles in full counts as paid only once it is
    -- invoiced (that path is above), so an estimate doesn't show "Lunas" (142c)
    payment_status = case when v_total - v_settled > 0 and v_paid >= v_total - v_settled then 'paid'
                          when v_paid > 0 then 'partial' else 'unpaid' end
  where id = p_ro;
end $function$;

-- what's still owed on a job (payments and applied credits) leaves out what the PT settled directly
create or replace function public.ro_open_balance(p_ro uuid, p_skip_credit uuid default null)
returns numeric language sql stable security definer set search_path = public as $$
  select r.total - r.settled_direct
       - coalesce((select sum(case when kind = 'payment' then amount else -amount end) from payments where ro_id = p_ro), 0)
       - coalesce((select sum(amount) from credit_memos where applied_ro_id = p_ro and id is distinct from p_skip_credit), 0)
  from repair_orders r where r.id = p_ro;
$$;

-- ===== 3. POs paid by the PT =======================================================================================
alter table public.purchase_orders add column if not exists paid_by_pt boolean not null default false;
alter table public.purchase_orders add column if not exists paid_by_name text;
do $$ begin
  alter table public.purchase_orders add constraint purchase_orders_paid_by_len check (char_length(paid_by_name) <= 120);
exception when duplicate_object then null; end $$;
grant select (paid_by_pt, paid_by_name), insert (paid_by_name), update (paid_by_pt, paid_by_name) on public.purchase_orders to authenticated;

-- a job's PO is paid by the PT when its company has "Part dibayar langsung" (decided when the PO is made; can be
-- switched while nothing on it is paid by the shop); a stock PO can name the PT that paid it (e.g. an oil drum)
create or replace function public.set_po_paid_by() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.paid_by_pt := new.ro_id is not null
      and coalesce((select c.paid_direct from repair_orders r join customers c on c.id = r.customer_id where r.id = new.ro_id), false);
  elsif new.paid_by_pt is distinct from old.paid_by_pt or new.paid_by_name is distinct from old.paid_by_name then
    if exists (select 1 from purchase_order_items where po_id = new.id and qty_paid > 0) then
      raise exception 'The shop has paid lines on this PO; undo those payments before changing who pays it';
    end if;
    -- the job's invoice was made with this payer (142c); the one-off clean-up (no one signed in) may still set it
    if auth.uid() is not null and exists (select 1 from repair_orders where id = new.ro_id and order_status = 'invoice') then
      raise exception 'This PO''s job is invoiced; void the invoice to change who pays the PO';
    end if;
    -- only a company with "Part dibayar langsung" has its job POs paid by the PT (142c, Denny Nov 9)
    if new.paid_by_pt and new.ro_id is not null
       and not coalesce((select c.paid_direct from repair_orders r join customers c on c.id = r.customer_id where r.id = new.ro_id), false) then
      raise exception 'This company pays the shop, so its PO can''t be paid by the PT';
    end if;
  end if;
  if new.ro_id is null then new.paid_by_pt := false; else new.paid_by_name := null; end if;
  new.paid_by_name := nullif(btrim(new.paid_by_name), '');
  return new;
end $$;
revoke execute on function public.set_po_paid_by() from public, anon, authenticated;
drop trigger if exists purchase_orders_paid_by on public.purchase_orders;
create trigger purchase_orders_paid_by before insert or update of paid_by_pt, paid_by_name, ro_id on public.purchase_orders
  for each row execute function public.set_po_paid_by();

create or replace function public.po_paid_by_pt(p_po uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select paid_by_pt or paid_by_name is not null from purchase_orders where id = p_po), false)
$$;
revoke execute on function public.po_paid_by_pt(uuid) from public, anon;
grant execute on function public.po_paid_by_pt(uuid) to authenticated;

-- the shop doesn't record payments on a PO the PT pays
create or replace function public.guard_pt_paid_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.qty_paid > old.qty_paid and po_paid_by_pt(new.po_id) then
    raise exception 'This PO is paid by the PT directly, not by the shop';
  end if;
  return new;
end $$;
revoke execute on function public.guard_pt_paid_line() from public, anon, authenticated;
drop trigger if exists po_items_pt_paid on public.purchase_order_items;
create trigger po_items_pt_paid before update of qty_paid on public.purchase_order_items
  for each row execute function public.guard_pt_paid_line();

-- the shop's supplier bills leave out POs the PT pays (from 131)
create or replace function public.supplier_bills_owed() returns table(amt numeric, due date)
language sql stable security definer set search_path = public as $$
  select po_line_amount(pi.cost, pi.core_cost, pi.qty_delivered - po_qty_returned(pi.id) - pi.qty_paid, pi.taxable, po.tax_rate),
         coalesce(pi.payment_due, coalesce(pi.invoice_date, pi.delivered_at) + coalesce(po.payment_terms_days, s.payment_terms_days, 0))
    from purchase_order_items pi join purchase_orders po on po.id = pi.po_id left join suppliers s on s.id = po.supplier_id
   where pi.qty_delivered - po_qty_returned(pi.id) > pi.qty_paid and not po.paid_by_pt and po.paid_by_name is null;
$$;

-- What each PT owes its suppliers in a month (delivered in that month, less returns), from the POs the PT pays.
create or replace function public.pt_supplier_bills(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', coalesce(p_month, local_date()))::date; m1 date;
begin
  -- people who see costs or pay supplier bills (server-side calls, with no one signed in, too)
  if auth.uid() is not null and not (has_permission('view_costs') or has_permission('pay_supplier_bills')) then raise exception 'Not allowed'; end if;
  m1 := (m0 + interval '1 month')::date;
  return jsonb_build_object('month', m0, 'lines', coalesce((select jsonb_agg(x order by x.payer, x.supplier, x.delivered_at, x.po_number) from (
    select coalesce(case when po.ro_id is not null then payer_of(r.customer_id) end, canon_payer(po.paid_by_name)) as payer,
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
revoke execute on function public.pt_supplier_bills(date) from public, anon;
grant execute on function public.pt_supplier_bills(date) to authenticated;

-- ===== 4. Dashboard (139's dashboard_summary): the shop's supplier bills leave out POs the PT pays; invoiced = the
-- shop's own share, with what each PT settled directly listed (142c) ==================================================
create or replace function public.dashboard_summary()
 returns jsonb language plpgsql stable security definer set search_path = public as $function$
declare
  tz text := shop_tz(); d date := local_date();
  m0 date := date_trunc('month', local_date())::date; p0 date := (date_trunc('month', local_date()) - interval '1 month')::date;
  s0 date := (date_trunc('month', local_date()) - interval '5 months')::date;
  t_today timestamptz := shop_start(local_date()); t_tomorrow timestamptz := shop_start(local_date() + 1);
  v_money boolean := has_permission('view_reports'); v_costs boolean := has_permission('view_costs') or has_permission('pay_supplier_bills');
  out jsonb; money jsonb := null; bills jsonb := null; series jsonb := null; v_over int; v_soon int;
begin
  if not is_staff() then raise exception 'Not allowed'; end if;
  select count(*) filter (where status = 'overdue'), count(*) filter (where status = 'due_soon') into v_over, v_soon from service_reminder_rows();
  out := jsonb_build_object(
    'today', d,
    -- bookings that overlap today on the shop calendar
    'bookings_today', (select count(*) from appointments a where a.status not in ('cancelled','no_show') and a.start_time < t_tomorrow and a.end_time > t_today),
    'requests', (select count(*) from appointments a where a.status = 'requested' and a.end_time > now()),
    'in_shop', (select coalesce(jsonb_object_agg(workflow_status, n), '{}') from (
                  select workflow_status, count(*) n from repair_orders
                  where order_status = 'estimate' and closed_at is null and workflow_status in ('scheduled','arrived','in_progress','waiting_parts','completed')
                  group by workflow_status) w),
    'open_estimates', (select count(*) from repair_orders where order_status = 'estimate' and closed_at is null and workflow_status = 'estimate'),
    -- open jobs with parts ordered that haven't all arrived
    'waiting_parts', (select count(distinct po.ro_id) from purchase_orders po join purchase_order_items pi on pi.po_id = po.id
                       join repair_orders r on r.id = po.ro_id
                       where po.status in ('ordered','partially_delivered') and pi.qty_ordered - pi.qty_delivered - pi.qty_cancelled > 0
                         and r.order_status = 'estimate' and r.closed_at is null),
    'service_overdue', v_over,
    'service_due_soon', v_soon,
    'low_stock', (select count(*) from catalog_items where item_type = 'part' and track_inventory and active
                   and (qty_on_hand <= 0 or (reorder_point is not null and qty_on_hand <= reorder_point))),
    'cores_to_retrieve', (select count(*) from cores where retrieval_status = 'to_be_retrieved' and return_status = 'to_be_returned'),
    'cores_to_return', (select count(*) from cores where retrieval_status = 'retrieved' and return_status = 'to_be_returned'),
    'returns_open', (select count(distinct coalesce(batch_id, id)) from returns where status <> 'refunded')
  );
  if v_money then
    -- invoiced = the shop's own share; what the PTs settled with their suppliers is listed per PT (142c, Denny Nov 9)
    with inv as (select total - settled_direct as total, settled_direct, customer_id, invoiced_at from repair_orders
                  where order_status = 'invoice' and invoiced_at >= shop_start(p0) and invoiced_at < t_tomorrow),
         open_inv as (select balance, coalesce(due_date, shop_day(invoiced_at)) as due from repair_orders where order_status = 'invoice' and balance > 0)
    select jsonb_build_object(
      'invoiced_mtd', (select coalesce(sum(total), 0) from inv where invoiced_at >= shop_start(m0)),
      'invoices_mtd', (select count(*) from inv where invoiced_at >= shop_start(m0)),
      -- last month up to the same day, so the comparison is fair early in the month
      'invoiced_prev', (select coalesce(sum(total), 0) from inv where invoiced_at >= shop_start(p0) and invoiced_at < shop_start(least(p0 + (d - m0), m0 - 1) + 1)),
      'received_mtd', net_received(shop_start(m0), t_tomorrow),
      'outstanding', (select coalesce(sum(balance), 0) from open_inv),
      'open_invoices', (select count(*) from open_inv),
      'overdue', (select coalesce(sum(balance), 0) from open_inv where due < d),
      'overdue_invoices', (select count(*) from open_inv where due < d),
      'overdue_90', (select coalesce(sum(balance), 0) from open_inv where due < d - 90),
      'settled_mtd', (select coalesce(sum(settled_direct), 0) from inv where invoiced_at >= shop_start(m0)),
      'settled_by_pt', (select coalesce(jsonb_agg(jsonb_build_object('payer', x.payer, 'amount', x.amount, 'invoices', x.n) order by x.amount desc, x.payer), '[]')
                          from (select payer_of(customer_id) as payer, sum(settled_direct) as amount, count(*) as n from inv
                                 where invoiced_at >= shop_start(m0) and settled_direct > 0 group by 1) x))
    into money;
    -- six months in one pass per table
    with months as (select g::date as ms from generate_series(s0::timestamp, m0::timestamp, interval '1 month') g),
         inv as (select date_trunc('month', invoiced_at at time zone tz)::date as ms, sum(total - settled_direct) as v from repair_orders
                 where order_status = 'invoice' and invoiced_at >= shop_start(s0) and invoiced_at < t_tomorrow group by 1),
         pay as (select date_trunc('month', paid_at at time zone tz)::date as ms, sum(case when kind = 'payment' then amount else -amount end) as v from payments
                 where source = 'manual' and paid_at >= shop_start(s0) and paid_at < t_tomorrow group by 1),
         crf as (select date_trunc('month', refunded_at at time zone tz)::date as ms, sum(amount) as v from credit_memos
                 where refunded_at >= shop_start(s0) and refunded_at < t_tomorrow group by 1)
    select jsonb_agg(jsonb_build_object('month', to_char(months.ms, 'YYYY-MM'), 'invoiced', coalesce(inv.v, 0),
                                        'received', coalesce(pay.v, 0) - coalesce(crf.v, 0)) order by months.ms)
      into series
      from months left join inv on inv.ms = months.ms left join pay on pay.ms = months.ms left join crf on crf.ms = months.ms;
  end if;
  if v_costs then
    -- the shop's own supplier bills (142: not the POs a PT pays directly)
    select jsonb_build_object('owed', coalesce(sum(amt), 0),
                              'overdue', coalesce(sum(amt) filter (where due < d), 0),
                              'due_7', coalesce(sum(amt) filter (where due between d and d + 7), 0))
      into bills from supplier_bills_owed();
  end if;
  return out || jsonb_build_object('money', money, 'series', series, 'bills', bills);
end $function$;

-- Hari ini (139's day_summary): invoiced = the shop's own share too (142c; patched in place, like convert_to_invoice)
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.day_summary(date)'::regprocedure);
  changed := replace(replace(src,
    $a$'total', case when v_money then r.total end)$a$,
    $a$'total', case when v_money then r.total - r.settled_direct end)$a$),
    $a$(select coalesce(sum(total), 0) from repair_orders$a$,
    $a$(select coalesce(sum(total - settled_direct), 0) from repair_orders$a$);
  if changed = src then
    if position('r.total - r.settled_direct' in src) = 0 then raise exception 'day_summary: totals not found as expected'; end if;
  elsif position('r.total - r.settled_direct' in changed) = 0 or position('sum(total - settled_direct)' in changed) = 0 then
    raise exception 'day_summary: totals not found as expected';
  else
    execute changed;
  end if;
end $$;

-- ===== 5. Sales report: labour not charged and what the PT settled directly, at the end ==========================
drop function if exists public.report_sales(date, date);
create function public.report_sales(p_from date, p_to date)
 returns table(ro_id uuid, invoice_number bigint, invoiced_on date, job_number bigint, customer_id uuid, company text, vehicle_id uuid,
               plate text, parts numeric, labor numeric, sublet numeric, fees numeric, discounts numeric, subtotal numeric, tax numeric,
               total numeric, paid numeric, balance numeric, due_date date, labor_waived numeric, settled_direct numeric)
 language plpgsql stable security definer set search_path = public as $function$
declare a timestamptz; b timestamptz;
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select r.id, r.invoice_number, shop_day(r.invoiced_at), r.job_number, r.customer_id, c.display_name, r.vehicle_id, v.plate,
         r.parts_total, r.labor_total, r.other_total, r.service_fees_total + r.job_fees_total,
         r.service_discount_total + r.job_discount_total, r.subtotal, r.tax_total, r.total, r.paid_total, r.balance, r.due_date,
         r.labor_waived, r.settled_direct
  from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
  where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
  order by r.invoiced_at, r.invoice_number;
end $function$;
revoke execute on function public.report_sales(date, date) from public, anon;
grant execute on function public.report_sales(date, date) to authenticated;

-- ===== 6. Bulk oil per drum ========================================================================================
create table if not exists public.oil_drums (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.catalog_items(id),
  litres numeric(10,2) not null check (litres > 0 and litres <= 100000),
  cost_per_l numeric(14,0) not null default 0 check (cost_per_l >= 0),
  paid_by_name text not null check (char_length(btrim(paid_by_name)) between 1 and 120),
  opened_on date not null default local_date(),
  po_item_id uuid references public.purchase_order_items(id) on delete set null,
  note text check (char_length(note) <= 500),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists oil_drums_item_idx on public.oil_drums (catalog_item_id, opened_on);
alter table public.oil_drums enable row level security;
revoke all on public.oil_drums from anon, authenticated;
-- the price per litre isn't readable from the table: drum_report shows it to people who see costs (142c)
grant select (id, catalog_item_id, litres, paid_by_name, opened_on, po_item_id, note, created_by, created_at), delete on public.oil_drums to authenticated;
grant insert (catalog_item_id, litres, cost_per_l, paid_by_name, opened_on, po_item_id, note),
      update (catalog_item_id, litres, cost_per_l, paid_by_name, opened_on, po_item_id, note) on public.oil_drums to authenticated;
drop policy if exists "staff read oil_drums" on public.oil_drums;
create policy "staff read oil_drums" on public.oil_drums for select to authenticated
  using ((select is_staff()) and ((select has_permission('view_costs')) or (select has_permission('pay_supplier_bills'))
                                  or (select has_permission('manage_inventory'))));
drop policy if exists "inventory edit oil_drums" on public.oil_drums;
create policy "inventory edit oil_drums" on public.oil_drums for all to authenticated
  using ((select has_permission('manage_inventory'))) with check ((select has_permission('manage_inventory')));
create or replace function public.check_oil_drum() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.paid_by_name := btrim(new.paid_by_name);
  new.note := nullif(btrim(new.note), '');
  if not exists (select 1 from catalog_items where id = new.catalog_item_id and item_type = 'part' and track_inventory) then
    raise exception 'A drum is a stocked part (e.g. a bulk oil)';
  end if;
  if new.po_item_id is not null and not exists (select 1 from purchase_order_items where id = new.po_item_id and catalog_item_id = new.catalog_item_id) then
    raise exception 'The PO line is a different part';
  end if;
  return new;
end $$;
revoke execute on function public.check_oil_drum() from public, anon, authenticated;
drop trigger if exists oil_drums_check on public.oil_drums;
create trigger oil_drums_check before insert or update on public.oil_drums for each row execute function public.check_oil_drum();
-- the activity log leaves out figures worked out by the app (from 119), now also labor_waived and settled_direct
create or replace function public.log_activity() returns trigger
language plpgsql security definer set search_path = public as $function$
declare diff jsonb; v_id uuid; skip text[];
begin
  skip := array['updated_at','parts_total','labor_total','other_total','service_fees_total','item_discount_total','service_discount_total',
                'job_fees_total','job_discount_total','subtotal','taxable_base','tax_total','total','paid_total','balance',
                'service_total','service_discount','service_net','qty_on_hand','labor_waived','settled_direct'];
  if tg_table_name in ('ro_job_fees','ro_job_discounts','ro_service_items') then skip := skip || array['amount','discount','net']; end if;
  if tg_table_name = 'shop_settings' then v_id := '00000000-0000-0000-0000-000000000000';
  elsif tg_op = 'DELETE' then v_id := (to_jsonb(old)->>'id')::uuid;
  else v_id := (to_jsonb(new)->>'id')::uuid; end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value and n.key <> all(skip);
    if diff is null then return new; end if;
    insert into public.activity_log (entity_type, entity_id, action, changes) values (tg_table_name, v_id, 'update', diff);
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.activity_log (entity_type, entity_id, action) values (tg_table_name, v_id, 'create');
    return new;
  else
    insert into public.activity_log (entity_type, entity_id, action, changes) values (tg_table_name, v_id, 'delete', to_jsonb(old));
    return old;
  end if;
end $function$;
drop trigger if exists log_oil_drums on public.oil_drums;
create trigger log_oil_drums after insert or update or delete on public.oil_drums for each row execute function public.log_activity();

-- a drum added, changed or removed: open jobs of "dibayar langsung" companies with that oil follow (drum oil is paid
-- by the PTs, 142c)
create or replace function public.drum_to_jobs() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select distinct ro.id from ro_service_items i join ro_services s on s.id = i.service_id
             join repair_orders ro on ro.id = s.ro_id join customers c on c.id = ro.customer_id
            where i.catalog_item_id in (case when tg_op <> 'INSERT' then old.catalog_item_id end,
                                        case when tg_op <> 'DELETE' then new.catalog_item_id end)
              and ro.order_status = 'estimate' and ro.closed_at is null and c.paid_direct
            order by ro.id loop
    perform recalc_repair_order(r.id);
  end loop;
  return null;
end $$;
revoke execute on function public.drum_to_jobs() from public, anon, authenticated;
drop trigger if exists oil_drums_to_jobs on public.oil_drums;
create trigger oil_drums_to_jobs after insert or update of catalog_item_id or delete on public.oil_drums
  for each row execute function public.drum_to_jobs();

-- Where each drum's oil went: invoiced job lines of that oil, oldest invoice first, fill the drums in the order they
-- were opened (first in, first out); anything beyond the last drum counts on the last one (it shows below zero). Only
-- invoices from the first drum's opening day on count (oil sold before that came from somewhere else).
-- Per drum: litres, used, left, use per company (with its paying PT and jobs), and what each other PT owes the drum's
-- PT at its price per litre. A company that pays the shop (not "dibayar langsung") counts as the shop (payer null):
-- the shop was paid for that oil and owes the drum's PT. Oil on open jobs (not invoiced yet) is shown per oil.
-- Prices and amounts only for people who see costs or pay supplier bills.
create or replace function public.drum_report(p_item uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb; v_money boolean;
begin
  if auth.uid() is not null and not is_staff() then raise exception 'Not allowed'; end if;
  v_money := auth.uid() is null or has_permission('view_costs') or has_permission('pay_supplier_bills');
  with dr as (
    select d.*, sum(d.litres) over w - d.litres as cap_start, sum(d.litres) over w as cap_end,
           row_number() over (partition by d.catalog_item_id order by d.opened_on desc, d.created_at desc, d.id desc) = 1 as last
      from oil_drums d where p_item is null or d.catalog_item_id = p_item
    window w as (partition by d.catalog_item_id order by d.opened_on, d.created_at, d.id rows between unbounded preceding and current row)),
  use as (
    select i.id as line_id, i.catalog_item_id, i.qty, r.id as ro_id, r.job_number, r.invoice_number, r.invoiced_at, r.customer_id,
           sum(i.qty) over w - i.qty as u_start, sum(i.qty) over w as u_end
      from ro_service_items i join ro_services s on s.id = i.service_id join repair_orders r on r.id = s.ro_id
     where i.item_type = 'part' and i.stock_deducted and i.qty > 0 and r.order_status = 'invoice'
       and i.catalog_item_id in (select catalog_item_id from dr)
       and (r.invoiced_at at time zone shop_tz())::date >= (select min(d0.opened_on) from oil_drums d0 where d0.catalog_item_id = i.catalog_item_id)
    window w as (partition by i.catalog_item_id order by r.invoiced_at, r.invoice_number, i.id rows between unbounded preceding and current row)),
  alloc as (
    select dr.id as drum_id, u.*, greatest(0, least(u.u_end, case when dr.last then 'infinity'::numeric else dr.cap_end end)
                                               - greatest(u.u_start, dr.cap_start)) as litres
      from dr join use u on u.catalog_item_id = dr.catalog_item_id),
  per_co as (
    select a.drum_id, a.customer_id,
           case when (select c0.paid_direct from customers c0 where c0.id = a.customer_id) then payer_of(a.customer_id) end as payer,
           sum(a.litres) as litres,
           jsonb_agg(jsonb_build_object('ro_id', a.ro_id, 'job_number', a.job_number, 'invoice_number', a.invoice_number,
                                        'litres', a.litres, 'invoiced_at', a.invoiced_at) order by a.invoiced_at) as jobs
      from alloc a where a.litres > 0 group by a.drum_id, a.customer_id),
  drums as (
    select dr.catalog_item_id, jsonb_build_object(
             'id', dr.id, 'litres', dr.litres, 'cost_per_l', case when v_money then dr.cost_per_l end, 'paid_by', canon_payer(dr.paid_by_name), 'opened_on', dr.opened_on,
             'po_item_id', dr.po_item_id, 'note', dr.note, 'last', dr.last,
             'used', coalesce((select sum(litres) from per_co where drum_id = dr.id), 0),
             'left', dr.litres - coalesce((select sum(litres) from per_co where drum_id = dr.id), 0),
             'companies', coalesce((select jsonb_agg(jsonb_build_object('customer_id', pc.customer_id, 'company', c.display_name,
                                                                       'payer', pc.payer, 'litres', pc.litres,
                                                                       'value', case when v_money then round(pc.litres * dr.cost_per_l) end, 'jobs', pc.jobs)
                                                    order by pc.payer nulls last, c.display_name)
                                    from per_co pc join customers c on c.id = pc.customer_id where pc.drum_id = dr.id), '[]'),
             'owed', coalesce((select jsonb_agg(jsonb_build_object('payer', x.payer, 'litres', x.litres,
                                                                  'amount', case when v_money then round(x.litres * dr.cost_per_l) end)
                                                order by x.payer nulls last)
                                 from (select pc.payer, sum(pc.litres) as litres from per_co pc
                                        where pc.drum_id = dr.id and (pc.payer is null or payer_key(pc.payer) <> payer_key(dr.paid_by_name))
                                        group by pc.payer) x), '[]')
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

-- ===== 7. PPN while the shop is non-PKP (Denny Nov 9) ===============================================================
-- The shop can't claim the supplier's PPN back, so on the job it is part of the cost: a PO line's cost (before PPN, as
-- on the supplier's bill) comes to the job with the PO's PPN added; a cost typed on the job goes to the PO with it taken
-- out. Suppliers that don't charge PPN: a supplier switch (charges_tax) sets the PO's PPN to 0, and each PO can be
-- switched until a payment is recorded on it. A PKP shop keeps today's behaviour (the job cost is the PO cost).
alter table public.suppliers add column if not exists charges_tax boolean not null default true;
grant insert (charges_tax), update (charges_tax) on public.suppliers to authenticated;
create or replace view public.suppliers_read with (security_barrier = true) as
select t.id, t.name, t.type, t.payment_terms_days,
       case when (has_permission('view_costs') or has_permission('pay_supplier_bills')) then t.account_number else null::text end as account_number,
       t.contact_name, t.phone, t.email, t.address, t.pinned_notes, t.active, t.created_at, t.updated_at,
       t.charges_tax
  from public.suppliers t
 where (select is_staff());
grant update (tax_rate) on public.purchase_orders to authenticated;

create or replace function public.shop_is_non_pkp() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select pkp_status = 'non_pkp' from shop_settings limit 1), false)
$$;
-- the PO line's PPN as a factor (1 when the line or the PO has none)
create or replace function public.po_tax_factor(p_taxable boolean, p_rate numeric) returns numeric
language sql immutable as $$
  select case when coalesce(p_taxable, false) and coalesce(p_rate, 0) > 0 then 1 + p_rate / 100 else 1 end
$$;
-- PO cost (before the supplier's PPN) → the cost on the job
create or replace function public.po_to_job_cost(p_cost numeric, p_taxable boolean, p_rate numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select case when p_cost is null then null when shop_is_non_pkp() then round(p_cost * po_tax_factor(p_taxable, p_rate)) else p_cost end
$$;
-- the cost on the job → PO cost (before the supplier's PPN). po_to_job_cost(job_to_po_cost(x)) can be 1 rupiah off x,
-- so the two sides are compared in PO terms: job_to_po_cost(po_to_job_cost(p)) = p always.
create or replace function public.job_to_po_cost(p_cost numeric, p_taxable boolean, p_rate numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select case when p_cost is null then null when shop_is_non_pkp() then round(p_cost / po_tax_factor(p_taxable, p_rate)) else p_cost end
$$;
revoke execute on function public.shop_is_non_pkp() from public, anon;
revoke execute on function public.po_to_job_cost(numeric, boolean, numeric) from public, anon;
revoke execute on function public.job_to_po_cost(numeric, boolean, numeric) from public, anon;
grant execute on function public.shop_is_non_pkp() to authenticated;
grant execute on function public.po_to_job_cost(numeric, boolean, numeric) to authenticated;
grant execute on function public.job_to_po_cost(numeric, boolean, numeric) to authenticated;

-- a new PO takes its PPN from the supplier; a draft PO moved to another supplier takes that one's; the PPN can be
-- switched until a payment is recorded on the PO
create or replace function public.stamp_purchase_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_shop numeric := coalesce((select tax_rate from shop_settings limit 1), 0);
        v_sup boolean;
begin
  if tg_op = 'INSERT' or (new.supplier_id is distinct from old.supplier_id and new.status = 'draft') then
    v_sup := coalesce((select charges_tax from suppliers where id = new.supplier_id), true);
    if tg_op = 'INSERT' or new.tax_rate is not distinct from old.tax_rate then
      new.tax_rate := case when v_sup then v_shop else 0 end;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.tax_rate is distinct from old.tax_rate then
    if new.tax_rate is null or new.tax_rate < 0 or new.tax_rate > 100 then raise exception 'PPN must be between 0 and 100%%'; end if;
    if exists (select 1 from purchase_order_items where po_id = new.id and qty_paid > 0) then
      raise exception 'A payment is recorded on this PO; undo it to change its PPN';
    end if;
    if exists (select 1 from returns where po_item_id in (select id from purchase_order_items where po_id = new.id)) then
      raise exception 'Parts on this PO were returned; its PPN can''t change';
    end if;
  end if;
  -- ordered (or received straight from a draft): the PO has an order date from then on
  if new.status <> 'draft' and new.status <> 'cancelled' and new.ordered_at is null then new.ordered_at := now(); end if;
  if new.notes is not null then new.notes := nullif(btrim(new.notes), ''); end if;
  return new;
end $$;
revoke execute on function public.stamp_purchase_order() from public, anon, authenticated;

-- PO line → job line cost (replaces 141's): in job terms, and also when the line's or the PO's PPN changes.
-- The PO line and its job line share one cost (Denny, Nov 9): the last one changed wins, on an open job, while the PO
-- line isn't cancelled (a paid line can't change its cost). The job's price follows only while it was never set by
-- hand: Rp 0, or the cost × the default markup (before or after this change). A typed price is never touched.
create or replace function public.sync_po_line_to_job(p_line uuid, p_prev numeric) returns void
language plpgsql security definer set search_path = public as $$
declare p purchase_order_items%rowtype; l ro_service_items%rowtype; v_rate numeric; v_m numeric; v_jc numeric; v_new numeric;
        v_cost numeric; v_price numeric; v_sug boolean; v_flag text;
begin
  select * into p from purchase_order_items where id = p_line;
  if not found or p.ro_service_item_id is null or coalesce(p.cost, 0) <= 0 or p.qty_cancelled >= p.qty_ordered then return; end if;
  select tax_rate into v_rate from purchase_orders where id = p.po_id;
  select i.* into l from ro_service_items i where i.id = p.ro_service_item_id for update;
  if not found or l.item_type not in ('part', 'sublet') then return; end if;
  if not exists (select 1 from ro_services s join repair_orders ro on ro.id = s.ro_id
                  where s.id = l.service_id and ro.order_status = 'estimate' and ro.closed_at is null) then
    return;
  end if;
  v_m := coalesce((select default_markup_pct from shop_settings limit 1), 0);
  v_jc := po_to_job_cost(p.cost, p.taxable, v_rate);
  -- the job's cost already is this PO cost (e.g. typed on the job, then sent to the PO without the PPN): it stays as
  -- typed, not 1 rupiah off from going there and back (142c)
  if coalesce(l.cost, 0) > 0 and job_to_po_cost(l.cost, p.taxable, v_rate) = p.cost then v_jc := l.cost; end if;
  v_new := round(v_jc * (1 + v_m / 100));
  -- the price was a suggestion from the cost (the job's own cost, the PO line's before this change, or another PO line's)
  v_sug := l.price = round(coalesce(l.cost, 0) * (1 + v_m / 100))
           or l.price = round(p_prev * (1 + v_m / 100))
           or exists (select 1 from purchase_order_items o join purchase_orders op on op.id = o.po_id
                       where o.ro_service_item_id = l.id and o.id <> p.id
                         and round(po_to_job_cost(o.cost, o.taxable, op.tax_rate) * (1 + v_m / 100)) = l.price);
  v_cost := v_jc;
  v_price := case when coalesce(l.price, 0) = 0 or coalesce(v_sug, false) then v_new else l.price end;
  if v_cost is distinct from l.cost or v_price is distinct from l.price then
    -- this change came from this PO line: the job line doesn't send it on to its other PO lines (142c)
    v_flag := current_setting('axle.po_to_job', true);
    perform set_config('axle.po_to_job', 'on', true);
    update ro_service_items set cost = v_cost, price = v_price where id = l.id;
    perform set_config('axle.po_to_job', coalesce(nullif(v_flag, ''), 'off'), true);
    -- the totals trigger skips writes made inside other triggers, so the job's totals are worked out here
    perform recalc_repair_order((select ro_id from ro_services where id = l.service_id));
  end if;
end $$;
revoke execute on function public.sync_po_line_to_job(uuid, numeric) from public, anon, authenticated;

create or replace function public.po_cost_to_job_line() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.ro_service_item_id is null or coalesce(new.cost, 0) <= 0 then return null; end if;
  if current_setting('axle.job_to_po', true) = 'on' then return null; end if;
  if tg_op = 'UPDATE' and new.cost is not distinct from old.cost and new.taxable is not distinct from old.taxable
     and new.ro_service_item_id is not distinct from old.ro_service_item_id then
    return null;
  end if;
  perform sync_po_line_to_job(new.id,
    case when tg_op = 'UPDATE' and coalesce(old.cost, 0) > 0 and old.ro_service_item_id is not distinct from new.ro_service_item_id
         then po_to_job_cost(old.cost, old.taxable, (select tax_rate from purchase_orders where id = new.po_id)) end);
  return null;
end $$;
revoke execute on function public.po_cost_to_job_line() from public, anon, authenticated;
drop trigger if exists po_items_cost_to_job on public.purchase_order_items;
create trigger po_items_cost_to_job after insert or update of cost, taxable, ro_service_item_id on public.purchase_order_items
  for each row execute function public.po_cost_to_job_line();

-- the PO's PPN switched: its job lines follow (while they still have the PO's cost)
create or replace function public.po_tax_to_job() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.tax_rate is not distinct from old.tax_rate then return null; end if;
  for r in select id, cost, taxable from purchase_order_items where po_id = new.id and ro_service_item_id is not null order by created_at, id loop
    perform sync_po_line_to_job(r.id, case when coalesce(r.cost, 0) > 0 then po_to_job_cost(r.cost, r.taxable, old.tax_rate) end);
  end loop;
  return null;
end $$;
revoke execute on function public.po_tax_to_job() from public, anon, authenticated;
drop trigger if exists purchase_orders_tax_to_job on public.purchase_orders;
-- (any update: the PPN also changes inside stamp_purchase_order when a draft moves to another supplier)
create trigger purchase_orders_tax_to_job after update on public.purchase_orders
  for each row when (new.tax_rate is distinct from old.tax_rate) execute function public.po_tax_to_job();

-- job line → PO line (141's, with the cost in PO terms)
create or replace function public.job_line_to_po() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(left(btrim(coalesce(new.name, '')), 200));
begin
  if new.item_type not in ('part', 'sublet') then return null; end if;
  if not exists (select 1 from ro_services s join repair_orders ro on ro.id = s.ro_id
                  where s.id = new.service_id and ro.order_status = 'estimate' and ro.closed_at is null) then
    return null;
  end if;
  -- the name, on every PO line for it that isn't fully cancelled
  -- (a PO line holds 200 characters; both sides compare the same trimmed first 200)
  if new.name is distinct from old.name and v_name <> '' then
    update purchase_order_items set name = v_name
     where ro_service_item_id = new.id and qty_cancelled < qty_ordered and name is distinct from v_name;
  end if;
  -- the cost, on its current PO line, while that line is unpaid and not cancelled: the two share one cost, the last
  -- one changed wins (Denny, Nov 9)
  -- (not when the change came from one of its PO lines: another supplier's line keeps its own cost, 142c)
  if new.cost is distinct from old.cost and coalesce(new.cost, 0) > 0 and coalesce(current_setting('axle.po_to_job', true), '') <> 'on' then
    perform set_config('axle.job_to_po', 'on', true);
    -- (in PO terms: before the supplier's PPN while the shop is non-PKP, 142)
    update purchase_order_items p set cost = job_to_po_cost(new.cost, p.taxable, po.tax_rate)
      from purchase_orders po
     where po.id = p.po_id and po.status <> 'cancelled'
       and p.id = new.po_item_id and p.ro_service_item_id = new.id
       and p.qty_paid = 0 and p.qty_cancelled < p.qty_ordered
       and p.cost is distinct from job_to_po_cost(new.cost, p.taxable, po.tax_rate);
    perform set_config('axle.job_to_po', 'off', true);
  end if;
  -- the quantity, only while the PO is still a draft (once ordered, the supplier has the number)
  if new.qty is distinct from old.qty and new.qty > 0 then
    update purchase_order_items p set qty_ordered = new.qty
     where p.ro_service_item_id = new.id and p.qty_delivered = 0 and p.qty_cancelled = 0 and p.qty_ordered is distinct from new.qty
       and exists (select 1 from purchase_orders po where po.id = p.po_id and po.status = 'draft');
  end if;
  return null;
end $$;
revoke execute on function public.job_line_to_po() from public, anon, authenticated;

-- PO lines put on the job (141's, with the cost in job terms)
create or replace function public.add_po_lines_to_job(p_lines uuid[], p_service uuid default null, p_new_service text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_ro uuid; v_svc uuid; v_pos int; v_m numeric; l record; v_cat uuid; v_qty numeric; v_item uuid; n int := 0;
  v_desc text; v_price numeric; v_taxable boolean; v_showqty boolean; v_core numeric; v_jc numeric;
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
    v_qty := l.qty_ordered - l.qty_cancelled - po_qty_returned(l.id);
    if v_qty <= 0 then raise exception 'Nothing is left of "%" on its PO to add', l.name; end if;
    -- the job line is the PO line's own part (a typed-in line added to the catalog after it arrived is refused by
    -- guard_po_item when it is linked below)
    v_cat := l.catalog_item_id;
    v_desc := null; v_price := null; v_taxable := null; v_showqty := null; v_core := 0;
    if v_cat is not null then
      select description, nullif(price, 0), taxable, show_qty_price, case when has_core then coalesce(core_cost, 0) else 0 end
        into v_desc, v_price, v_taxable, v_showqty, v_core from catalog_items where id = v_cat;
    end if;
    -- the job's cost: the PO cost, plus the supplier's PPN while the shop is non-PKP (142)
    v_jc := po_to_job_cost(l.cost, l.taxable, (select tax_rate from purchase_orders where id = l.po_id));
    insert into ro_service_items (service_id, position, item_type, catalog_item_id, name, description, cost, price, qty, taxable, show_qty_price, core_charge)
    values (v_svc, v_pos, l.line_type, v_cat, l.name, v_desc, v_jc, coalesce(v_price, round(v_jc * (1 + v_m / 100))),
            v_qty, coalesce(v_taxable, new_line_taxable()), coalesce(v_showqty, true), case when l.line_type = 'part' then v_core else 0 end)
    returning id into v_item;
    update purchase_order_items set ro_service_item_id = v_item where id = l.id;
    v_pos := v_pos + 1; n := n + 1;
  end loop;
  -- new work on the job: its status follows (e.g. back from Selesai)
  perform refresh_job_workflow(v_ro);
  return jsonb_build_object('added', n, 'service_id', v_svc);
end $$;
revoke execute on function public.add_po_lines_to_job(uuid[], uuid, text) from public, anon;
grant execute on function public.add_po_lines_to_job(uuid[], uuid, text) to authenticated;

-- ===== 8. Jobs and their POs kept in step (review of 142) ===========================================================
-- How much of a part or sublet line the PT paid for itself, not the shop (0 to 1, 142c: by quantity):
--  * ordered on POs: the quantity on POs the PT pays (ordered, less cancelled and returned), out of the job's quantity;
--    the rest came from the shop (its stock, or a PO the shop pays);
--  * a stocked part with no PO: all of it when it is drum oil (the PTs settle drums between them), else none (shop stock);
--  * anything else (typed, not from the shop's stock or a shop PO): all of it, the shop didn't buy it.
drop function if exists public.line_paid_outside(uuid, uuid);
create or replace function public.line_paid_share(p_item uuid, p_cat uuid, p_qty numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(p_qty, 0) <= 0 then 0
    when exists (select 1 from purchase_order_items o where o.ro_service_item_id = p_item and o.qty_cancelled < o.qty_ordered)
      then least(coalesce((select sum(greatest(o.qty_ordered - o.qty_cancelled - po_qty_returned(o.id), 0))
                             from purchase_order_items o join purchase_orders po on po.id = o.po_id
                            where o.ro_service_item_id = p_item and (po.paid_by_pt or po.paid_by_name is not null)), 0) / p_qty, 1)
    when p_cat is not null and exists (select 1 from catalog_items ci where ci.id = p_cat and ci.track_inventory)
      then case when exists (select 1 from oil_drums d where d.catalog_item_id = p_cat) then 1 else 0 end
    else 1
  end
$$;
revoke execute on function public.line_paid_share(uuid, uuid, numeric) from public, anon, authenticated;

-- the job page's profit card: the share of each line the PT paid for (the shop earns nothing on it)
create or replace function public.job_paid_shares(p_ro uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(i.id, line_paid_share(i.id, i.catalog_item_id, i.qty)), '{}')
    from repair_orders r join customers c on c.id = r.customer_id
    join ro_services s on s.ro_id = r.id join ro_service_items i on i.service_id = s.id
   where r.id = p_ro and c.paid_direct and i.item_type in ('part', 'sublet') and has_permission('view_costs') and is_staff()
     and line_paid_share(i.id, i.catalog_item_id, i.qty) > 0
$$;
revoke execute on function public.job_paid_shares(uuid) from public, anon;
grant execute on function public.job_paid_shares(uuid) to authenticated;

-- a company's "dibayar langsung" / "jasa tidak ditagih" switched: its open jobs follow, and their POs (while the shop
-- hasn't paid anything on them)
create or replace function public.customer_pay_follows() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.paid_direct is not distinct from old.paid_direct and new.labour_not_charged is not distinct from old.labour_not_charged then
    return null;
  end if;
  for r in select id from repair_orders where customer_id = new.id and order_status = 'estimate' and closed_at is null order by id loop
    if new.paid_direct is distinct from old.paid_direct then
      update purchase_orders po set paid_by_pt = new.paid_direct
       where po.ro_id = r.id and po.paid_by_pt is distinct from new.paid_direct and po.status <> 'cancelled'
         and not exists (select 1 from purchase_order_items pi where pi.po_id = po.id and pi.qty_paid > 0);
    end if;
    perform recalc_repair_order(r.id);
  end loop;
  return null;
end $$;
revoke execute on function public.customer_pay_follows() from public, anon, authenticated;
drop trigger if exists customers_pay_follows on public.customers;
create trigger customers_pay_follows after update of paid_direct, labour_not_charged on public.customers
  for each row execute function public.customer_pay_follows();

-- a job moved to another company, or its invoice voided (142c: the company's settings may have changed since): its
-- POs follow the company (while the shop hasn't paid anything on them)
create or replace function public.job_po_payer_follows() returns trigger
language plpgsql security definer set search_path = public as $$
declare v boolean;
begin
  if new.order_status <> 'estimate'
     or (new.customer_id is not distinct from old.customer_id and old.order_status is not distinct from new.order_status) then
    return null;
  end if;
  v := coalesce((select paid_direct from customers where id = new.customer_id), false);
  update purchase_orders po set paid_by_pt = v
   where po.ro_id = new.id and po.paid_by_pt is distinct from v and po.status <> 'cancelled'
     and not exists (select 1 from purchase_order_items pi where pi.po_id = po.id and pi.qty_paid > 0);
  perform recalc_repair_order(new.id);
  return null;
end $$;
revoke execute on function public.job_po_payer_follows() from public, anon, authenticated;
drop trigger if exists repair_orders_po_payer on public.repair_orders;
create trigger repair_orders_po_payer after update of customer_id, order_status on public.repair_orders
  for each row execute function public.job_po_payer_follows();

-- who pays a PO changed, or a PO line was linked, unlinked, re-counted or cancelled, or parts on it went back to the
-- supplier: the job's settlement follows
create or replace function public.po_payer_to_job() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ro uuid;
begin
  if tg_table_name = 'purchase_orders' then
    if new.paid_by_pt is not distinct from old.paid_by_pt and new.paid_by_name is not distinct from old.paid_by_name then return null; end if;
    v_ro := new.ro_id;
  elsif tg_table_name = 'returns' then
    -- parts sent back to the supplier: the PT's PO covers less of the job line (142c)
    v_ro := (select po.ro_id from purchase_order_items pi join purchase_orders po on po.id = pi.po_id
              where pi.id = case when tg_op = 'DELETE' then old.po_item_id else new.po_item_id end);
  else
    v_ro := (select ro_id from purchase_orders where id = case when tg_op = 'DELETE' then old.po_id else new.po_id end);
  end if;
  if v_ro is not null and exists (select 1 from repair_orders r join customers c on c.id = r.customer_id
                                   where r.id = v_ro and r.order_status = 'estimate' and c.paid_direct) then
    perform recalc_repair_order(v_ro);
  end if;
  return null;
end $$;
revoke execute on function public.po_payer_to_job() from public, anon, authenticated;
drop trigger if exists purchase_orders_payer_to_job on public.purchase_orders;
create trigger purchase_orders_payer_to_job after update on public.purchase_orders
  for each row when (new.paid_by_pt is distinct from old.paid_by_pt or new.paid_by_name is distinct from old.paid_by_name)
  execute function public.po_payer_to_job();
drop trigger if exists po_items_payer_to_job on public.purchase_order_items;
create trigger po_items_payer_to_job after insert or update of ro_service_item_id, qty_cancelled, qty_ordered or delete on public.purchase_order_items
  for each row execute function public.po_payer_to_job();
drop trigger if exists returns_payer_to_job on public.returns;
create trigger returns_payer_to_job after insert or update of qty, po_item_id or delete on public.returns
  for each row execute function public.po_payer_to_job();

-- invoicing: payments are checked against what the shop is owed, not the whole total (139's way of patching)
do $$
declare src text; changed text;
begin
  src := pg_get_functiondef('public.convert_to_invoice(uuid)'::regprocedure);
  changed := replace(src, '  select total into v_total from repair_orders where id = p_ro;',
                          '  select total - settled_direct into v_total from repair_orders where id = p_ro;   -- what the shop is owed (142)');
  -- (and the message says so, 142c)
  changed := replace(changed, 'are more than the invoice total (Rp %)', 'are more than the shop is owed on this invoice (Rp %)');
  if changed = src then
    if position('select total - settled_direct into v_total' in src) = 0 then raise exception 'convert_to_invoice: total check not found as expected'; end if;
  else
    execute changed;
  end if;
end $$;

-- the change history keeps a drum's price back from people who don't see costs (132's mask_activity, one key added)
CREATE OR REPLACE FUNCTION public.mask_activity(p_type text, p_changes jsonb, p_costs boolean, p_supplier boolean, p_money boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  t text := coalesce(p_changes->>'table', p_type);
  hide text[] := '{}';
  r jsonb := p_changes;
begin
  if r is null or jsonb_typeof(r) <> 'object' then return r; end if;
  if not p_costs then r := public.strip_keys(r, array['cost', 'core_cost', 'markup_pct', 'cost_per_l']); end if;
  if not p_supplier and (p_type in ('purchase_order_items', 'supplier_payments', 'returns', 'cores')
                         or t in ('purchase_order_items', 'supplier_payments', 'returns', 'cores')) then
    hide := hide || array['cost', 'core_cost', 'amount', 'lines', 'return_cost', 'return_tax', 'refund_amount'];
  end if;
  if not p_money and (p_type in ('repair_orders', 'ro_services', 'ro_service_items', 'ro_job_fees', 'ro_job_discounts', 'payments', 'credit_memos', 'invoice_voids')
                      or t in ('ro_services', 'ro_service_items', 'ro_job_fees', 'ro_job_discounts', 'payments', 'credit_memos', 'invoice_voids')) then
    hide := hide || array['price', 'discount_pct', 'discount_amount', 'core_charge', 'amount', 'discount', 'net', 'flat_price',
                          'service_total', 'service_discount', 'service_net', 'value', 'max_amount', 'parts_total', 'labor_total',
                          'other_total', 'service_fees_total', 'item_discount_total', 'service_discount_total', 'job_fees_total',
                          'job_discount_total', 'subtotal', 'taxable_base', 'tax_total', 'total', 'paid_total', 'balance', 'snapshot',
                          'due_date', 'payment_status'];
    -- "Paid" on the board is money too: a change to or from it isn't shown (132)
    if r->'diff'->>'workflow_status' like '%paid%' then r := jsonb_set(r, '{diff}', (r->'diff') - 'workflow_status'); end if;
    if r->>'workflow_status' like '%paid%' then r := r - 'workflow_status'; end if;
    if r->'row'->>'workflow_status' = 'paid' then r := jsonb_set(r, '{row,workflow_status}', '"invoiced"'); end if;
  end if;
  if not p_money and (p_type in ('catalog_items', 'labor_rates', 'service_templates', 'discounts', 'customers')
                      or t in ('catalog_item_fees', 'service_template_items')) then
    hide := hide || array['price', 'fee_value', 'rate_per_hour', 'flat_price', 'price_override', 'value', 'max_amount', 'credit_limit'];
  end if;
  if not p_supplier and (p_type = 'suppliers' or t = 'suppliers') then
    hide := hide || array['account_number'];
  end if;
  if cardinality(hide) = 0 then return r; end if;
  r := r - hide;
  if jsonb_typeof(r->'row') = 'object' then r := jsonb_set(r, '{row}', (r->'row') - hide); end if;
  if jsonb_typeof(r->'diff') = 'object' then r := jsonb_set(r, '{diff}', (r->'diff') - hide); end if;
  return r;
end $function$;
