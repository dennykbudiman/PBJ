-- 146 · Nov 12, 2026 (Denny, item 43): "Rekap servis" — what each company's vehicles had done, with prices.
-- One row per invoiced job line (approved services of issued invoices, by invoice date). Selling prices for staff with
-- view_reports (Pemilik, Admin, Service advisor, Kasir) and for a fleet manager's own companies; cost only for
-- Pemilik/Admin. Labour on a job whose labour isn't charged: billed 0, its value kept. Whatever the lines don't add up
-- to (service discounts, fixed-price packages, job fees and discounts, tax) is the invoice total minus the lines, worked
-- out by the app from inv_total. Read-only (STABLE); no table changes.

create or replace function public.report_rekap(p_from date, p_to date)
returns table(ro_id uuid, invoice_no text, invoice_number bigint, invoiced_on date, job_number bigint, km integer, km_unreadable boolean,
              customer_id uuid, company text, payer text, book text, vehicle_id uuid, plate text, make text, model text, year integer,
              inv_total numeric, service_id uuid, service_name text, service_pos integer, line_id uuid, line_pos integer,
              kind text, name text, qty numeric, unit text, price numeric, value numeric, billed numeric, cost numeric)
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz; b timestamptz; tz text := shop_tz();
        v_staff boolean := has_permission('view_reports');
        v_fleet boolean := is_fleet();
        v_cost boolean := is_owner_or_admin();
begin
  if not (v_staff or v_fleet) then raise exception 'Not allowed'; end if;
  perform check_report_range(p_from, p_to);
  a := shop_start(p_from); b := shop_start(p_to + 1);
  return query
  select r.id, r.invoice_no, r.invoice_number, (r.invoiced_at at time zone tz)::date, r.job_number, r.odometer_in, r.km_unreadable,
         r.customer_id, c.display_name,
         coalesce(nullif(trim(r.bill_to_snapshot->>'payer'), ''), nullif(trim(c.payer_name), ''), c.display_name),
         coalesce(nullif(trim(r.bill_to_snapshot->>'book'), ''), nullif(trim(c.book_name), ''), c.display_name),
         r.vehicle_id, v.plate, v.make, v.model, v.year,
         r.total, s.id, s.name, s.position, i.id, i.position,
         case when i.item_type = 'part' and exists (select 1 from oil_drums d where d.catalog_item_id = i.catalog_item_id) then 'oil'
              when i.item_type in ('part', 'labor', 'sublet') then i.item_type::text
              else 'other' end,
         i.name, i.qty, ci.unit, i.price,
         i.net + case when i.item_type = 'part' then round(coalesce(i.core_charge, 0) * i.qty) else 0 end,
         case when i.item_type = 'labor' and coalesce(r.labor_waived, 0) > 0 then 0
              else i.net + case when i.item_type = 'part' then round(coalesce(i.core_charge, 0) * i.qty) else 0 end end,
         case when v_cost and i.item_type in ('part', 'sublet') then round(coalesce(i.cost, 0) * i.qty) end
  from repair_orders r
  join ro_services s on s.ro_id = r.id and s.approval_status = 'approved'
  join ro_service_items i on i.service_id = s.id
  left join catalog_items ci on ci.id = i.catalog_item_id
  left join customers c on c.id = r.customer_id
  left join vehicles v on v.id = r.vehicle_id
  where r.order_status = 'invoice' and r.invoiced_at >= a and r.invoiced_at < b
    and (v_staff or r.customer_id in (select fleet_customer_ids()))
  order by c.display_name, v.plate, r.invoiced_at, r.id, s.position, s.id, i.position, i.id;
end $$;
revoke all on function public.report_rekap(date, date) from public, anon;
grant execute on function public.report_rekap(date, date) to authenticated;

-- the app fetches reports through report_rows (one JSON list, no 1.000-row limit): add the rekap
create or replace function public.report_rows(p_report text, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable set search_path = public as $$
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
    else raise exception 'Unknown report';
  end case;
  return coalesce(out, '[]'::jsonb);
end $$;
