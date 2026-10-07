-- Axle v2 · 126 dashboard and first reports (stage 9a)
-- Read-only: nothing here changes a table. Each report is a database function so the sums are done in one
-- place, on the shop's own calendar (shop time zone), and only for people with the view_reports permission.
--   dashboard_summary()          today's work for every staff member; money only with view_reports, supplier bills only with view_costs
--   report_sales(from, to)       one row per invoice issued in the period, with its parts / labor / sublet / fees / discounts / tax
--   report_voids(from, to)       invoices voided in the period (they no longer count as sales)
--   report_aging()               every invoice with money still owed, with how many days past due it is
--   report_open_credits()        unused company credit (shown next to what the company owes)
--   report_payments(from, to)    money in and out: payments, refunds, and credits paid back as money
-- Money moved to company credit when an invoice is voided is not cash and is left out of the payments report.
-- Periods are turned into two moments in time once (start of the first day, start of the day after the last),
-- so the time indexes are used.

-- The shop's time zone, the shop's calendar day of a moment, and the moment a shop day starts.
create or replace function public.shop_tz() returns text
language sql stable set search_path = public as $$
  select coalesce((select timezone from shop_settings limit 1), 'Asia/Jakarta')
$$;
create or replace function public.shop_day(p_at timestamptz) returns date
language sql stable set search_path = public as $$
  select (p_at at time zone shop_tz())::date
$$;
create or replace function public.shop_start(p_day date) returns timestamptz
language sql stable set search_path = public as $$
  select p_day::timestamp at time zone shop_tz()
$$;

create or replace function public.check_report_range(p_from date, p_to date) returns void
language plpgsql immutable as $$
begin
  if p_from is null or p_to is null then raise exception 'Choose a start and end date'; end if;
  if p_to < p_from then raise exception 'The end date is before the start date'; end if;
  if p_to - p_from > 1830 then raise exception 'Choose a period of at most 5 years'; end if;
end $$;

create index if not exists payments_paid_at_idx on public.payments (paid_at) where source = 'manual';
create index if not exists credit_memos_refunded_at_idx on public.credit_memos (refunded_at) where refunded_at is not null;
create index if not exists invoice_voids_voided_at_idx on public.invoice_voids (voided_at);

-- An invoice with no due date is due on its invoice date (the same rule everywhere: aging, dashboard, company balances).
create or replace view public.customer_balances as
  select c.id as customer_id, c.display_name,
    coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0), 0) as balance_due,
    coalesce(sum(r.balance) filter (where r.order_status = 'invoice' and r.balance > 0
      and coalesce(r.due_date, (r.invoiced_at at time zone coalesce((select s.timezone from shop_settings s limit 1), 'Asia/Jakarta'))::date) < local_date()), 0) as overdue,
    count(r.id) filter (where r.order_status = 'invoice' and r.balance > 0) as open_invoices,
    coalesce((select sum(m.amount) from credit_memos m where m.customer_id = c.id and m.applied_ro_id is null and m.refunded_at is null), 0) as available_credit
  from customers c left join repair_orders r on r.customer_id = c.id
  group by c.id, c.display_name;

-- ===== sales
create or replace function public.report_sales(p_from date, p_to date)
returns table (ro_id uuid, invoice_number bigint, invoiced_on date, job_number bigint, customer_id uuid, company text, vehicle_id uuid, plate text,
               parts numeric, labor numeric, sublet numeric, fees numeric, discounts numeric, subtotal numeric, tax numeric, total numeric,
               paid numeric, balance numeric, due_date date)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz;
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select r.id, r.invoice_number, shop_day(r.invoiced_at), r.job_number, r.customer_id, c.display_name, r.vehicle_id, v.plate,
         r.parts_total, r.labor_total, r.other_total, r.service_fees_total + r.job_fees_total,
         r.service_discount_total + r.job_discount_total, r.subtotal, r.tax_total, r.total, r.paid_total, r.balance, r.due_date
  from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
  where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
  order by r.invoiced_at, r.invoice_number;
end $$;

create or replace function public.report_voids(p_from date, p_to date)
returns table (id uuid, ro_id uuid, invoice_number bigint, invoiced_on date, voided_on date, total numeric, reason text, customer_id uuid, company text)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz;
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select x.id, x.ro_id, x.invoice_number, shop_day(x.invoiced_at), shop_day(x.voided_at), x.total, x.reason, r.customer_id, c.display_name
  from invoice_voids x left join repair_orders r on r.id = x.ro_id left join customers c on c.id = r.customer_id
  where x.voided_at >= a and x.voided_at < b
  order by x.voided_at;
end $$;

-- ===== receivables
create or replace function public.report_aging()
returns table (ro_id uuid, invoice_number bigint, invoiced_on date, due_date date, days_overdue int, job_number bigint, customer_id uuid,
               company text, plate text, total numeric, paid numeric, balance numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  return query
  select r.id, r.invoice_number, shop_day(r.invoiced_at), coalesce(r.due_date, shop_day(r.invoiced_at)),
         greatest(local_date() - coalesce(r.due_date, shop_day(r.invoiced_at)), 0)::int,
         r.job_number, r.customer_id, c.display_name, v.plate, r.total, r.paid_total, r.balance
  from repair_orders r left join customers c on c.id = r.customer_id left join vehicles v on v.id = r.vehicle_id
  where r.order_status = 'invoice' and r.balance > 0
  order by c.display_name, 4, r.invoice_number;
end $$;

create or replace function public.report_open_credits()
returns table (customer_id uuid, company text, credit numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  return query
  select m.customer_id, c.display_name, sum(m.amount)
  from credit_memos m left join customers c on c.id = m.customer_id
  where m.applied_ro_id is null and m.refunded_at is null
  group by m.customer_id, c.display_name
  order by c.display_name;
end $$;

-- ===== money in and out
create or replace function public.report_payments(p_from date, p_to date)
returns table (id uuid, kind text, paid_on date, paid_at timestamptz, customer_id uuid, company text, ro_id uuid, invoice_number bigint, job_number bigint,
               method text, reference text, amount numeric)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz;
begin
  if not has_permission('view_reports') then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select * from (
    select p.id, p.kind, shop_day(p.paid_at), p.paid_at, p.customer_id, c.display_name, p.ro_id, r.invoice_number, r.job_number,
           p.method, p.reference, p.amount
    from payments p left join customers c on c.id = p.customer_id left join repair_orders r on r.id = p.ro_id
    where p.source = 'manual' and p.paid_at >= a and p.paid_at < b
    union all
    -- company credit paid back as money
    select m.id, 'credit_refund', shop_day(m.refunded_at), m.refunded_at, m.customer_id, c.display_name, null::uuid, null::bigint, null::bigint,
           coalesce(m.refund_method, 'other'), m.refund_reference, m.amount
    from credit_memos m left join customers c on c.id = m.customer_id
    where m.refunded_at >= a and m.refunded_at < b
  ) x
  order by 4, 1;
end $$;

-- Net money received between two moments (payments minus refunds minus credits paid back), used by the dashboard.
create or replace function public.net_received(a timestamptz, b timestamptz) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(case when kind = 'payment' then amount else -amount end) from payments
                   where source = 'manual' and paid_at >= a and paid_at < b), 0)
       - coalesce((select sum(amount) from credit_memos where refunded_at >= a and refunded_at < b), 0)
$$;

-- ===== dashboard
create or replace function public.dashboard_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  tz text := shop_tz(); d date := local_date();
  m0 date := date_trunc('month', local_date())::date; p0 date := (date_trunc('month', local_date()) - interval '1 month')::date;
  s0 date := (date_trunc('month', local_date()) - interval '5 months')::date;
  t_today timestamptz := shop_start(local_date()); t_tomorrow timestamptz := shop_start(local_date() + 1);
  v_money boolean := has_permission('view_reports'); v_costs boolean := has_permission('view_costs');
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
    with inv as (select total, invoiced_at from repair_orders where order_status = 'invoice' and invoiced_at >= shop_start(p0) and invoiced_at < t_tomorrow),
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
      'overdue_90', (select coalesce(sum(balance), 0) from open_inv where due < d - 90))
    into money;
    -- six months in one pass per table
    with months as (select g::date as ms from generate_series(s0::timestamp, m0::timestamp, interval '1 month') g),
         inv as (select date_trunc('month', invoiced_at at time zone tz)::date as ms, sum(total) as v from repair_orders
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
    with owed as (
      select po_line_amount(pi.cost, pi.core_cost, pi.qty_delivered - pi.qty_paid, pi.taxable, po.tax_rate) as amt,
             coalesce(pi.payment_due, coalesce(pi.invoice_date, pi.delivered_at) + coalesce(po.payment_terms_days, s.payment_terms_days, 0)) as due
      from purchase_order_items pi join purchase_orders po on po.id = pi.po_id left join suppliers s on s.id = po.supplier_id
      where pi.qty_delivered > pi.qty_paid)
    select jsonb_build_object('owed', coalesce(sum(amt), 0),
                              'overdue', coalesce(sum(amt) filter (where due < d), 0),
                              'due_7', coalesce(sum(amt) filter (where due between d and d + 7), 0))
      into bills from owed;
  end if;
  return out || jsonb_build_object('money', money, 'series', series, 'bills', bills);
end $$;

revoke execute on function public.report_sales(date, date), public.report_voids(date, date), public.report_aging(), public.report_open_credits(),
  public.report_payments(date, date), public.dashboard_summary() from public, anon;
grant execute on function public.report_sales(date, date), public.report_voids(date, date), public.report_aging(), public.report_open_credits(),
  public.report_payments(date, date), public.dashboard_summary() to authenticated;
-- internal helpers: only the functions above use them (new functions are executable by the app unless revoked)
revoke execute on function public.net_received(timestamptz, timestamptz), public.shop_day(timestamptz), public.shop_start(date), public.shop_tz(),
  public.check_report_range(date, date) from public, anon, authenticated;
