-- Axle v2 · 107 number formats (Oct 5 decision) + void invoice
-- Job 000001 · Invoice INV-000001 · Job PO 000001-101 · Stock PO 900001 (9 + 5 digits). All counters start at 1.
update public.number_sequences set next_value = 1;

alter table public.repair_orders
  add column job_no text generated always as (lpad(job_number::text, 6, '0')) stored,
  add column invoice_no text generated always as (case when invoice_number is null then null else 'INV-' || lpad(invoice_number::text, 6, '0') end) stored;

create or replace function public.set_po_number() returns trigger language plpgsql security definer set search_path = public as $$
declare jn text; n int;
begin
  if new.po_number is not null then return new; end if;
  if new.ro_id is null then
    new.po_number := '9' || lpad(next_number('stock_po')::text, 5, '0');
  else
    select lpad(job_number::text, 6, '0') into jn from repair_orders where id = new.ro_id for update;
    select coalesce(max(split_part(po_number, '-', 2)::int), 100) into n
      from purchase_orders where ro_id = new.ro_id and po_number ~ ('^' || jn || '-[0-9]+$');
    new.po_number := jn || '-' || (n + 1);
  end if;
  return new;
end $$;
revoke execute on function public.set_po_number() from public, anon, authenticated;

-- Void: the invoice number is kept forever (VOID / BATAL), the job reopens as an estimate to be corrected and re-invoiced
create table public.invoice_voids (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete restrict,
  invoice_number bigint not null unique,
  invoice_no text generated always as ('INV-' || lpad(invoice_number::text, 6, '0')) stored,
  invoiced_at timestamptz,
  total numeric(14,0) not null,
  reason text not null check (length(trim(reason)) > 0),
  voided_by uuid default auth.uid(),
  voided_at timestamptz not null default now(),
  snapshot jsonb not null                       -- the invoice as it was (job, services, lines, fees, discounts) for reprinting with a VOID watermark
);
create index on public.invoice_voids (ro_id);
alter table public.invoice_voids enable row level security;
create policy "staff read invoice_voids" on public.invoice_voids for select using (is_staff());
create trigger log_invoice_voids after insert on public.invoice_voids for each row execute function log_activity();

insert into public.role_permissions (role_id, permission_key)
select id, 'void_invoices' from public.roles where name in ('Owner','Admin') on conflict do nothing;

create or replace function public.void_invoice(p_ro uuid, p_reason text) returns text language plpgsql security definer set search_path = public as $$
declare ro repair_orders%rowtype; v_no text;
begin
  if auth.uid() is not null and not has_permission('void_invoices') then raise exception 'Not allowed'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required to void an invoice'; end if;
  select * into ro from repair_orders where id = p_ro for update;
  if not found then raise exception 'Job not found'; end if;
  if ro.order_status <> 'invoice' then raise exception 'This job is not invoiced'; end if;
  if ro.paid_total > 0 then raise exception 'Refund or move the payments on this invoice before voiding it'; end if;
  insert into invoice_voids (ro_id, invoice_number, invoiced_at, total, reason, snapshot)
  values (p_ro, ro.invoice_number, ro.invoiced_at, ro.total, trim(p_reason), jsonb_build_object(
    'job', to_jsonb(ro),
    'concerns', (select coalesce(jsonb_agg(to_jsonb(c) order by c.position), '[]') from ro_concerns c where c.ro_id = p_ro),
    'services', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('items',
                   (select coalesce(jsonb_agg(to_jsonb(i) order by i.position), '[]') from ro_service_items i where i.service_id = s.id)) order by s.position), '[]')
                 from ro_services s where s.ro_id = p_ro),
    'job_fees', (select coalesce(jsonb_agg(to_jsonb(f)), '[]') from ro_job_fees f where f.ro_id = p_ro),
    'job_discounts', (select coalesce(jsonb_agg(to_jsonb(d)), '[]') from ro_job_discounts d where d.ro_id = p_ro),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from payments p where p.ro_id = p_ro)))
  returning invoice_no into v_no;
  -- reopen the job; stock already taken out stays out (stock_deducted flags kept), so re-invoicing won't deduct twice
  update repair_orders set order_status = 'estimate', invoice_number = null, invoiced_at = null, due_date = null,
    bill_to_snapshot = null, shop_snapshot = null, workflow_status = 'completed'
  where id = p_ro;
  return v_no;
end $$;
revoke execute on function public.void_invoice(uuid, text) from public, anon;
grant execute on function public.void_invoice(uuid, text) to authenticated;

-- invoices list incl. voided ones (for the invoice register / reports)
create or replace view public.invoice_register with (security_invoker = true) as
select r.invoice_number, r.invoice_no, r.job_no, r.id as ro_id, r.customer_id, r.invoiced_at, r.due_date, r.total, r.paid_total, r.balance,
       r.payment_status, 'issued'::text as status, null::text as void_reason, null::timestamptz as voided_at
from repair_orders r where r.order_status = 'invoice'
union all
select v.invoice_number, v.invoice_no, lpad((v.snapshot->'job'->>'job_number'), 6, '0'), v.ro_id, (v.snapshot->'job'->>'customer_id')::uuid,
       v.invoiced_at, null, 0, 0, 0, 'void', 'void', v.reason, v.voided_at
from invoice_voids v;
