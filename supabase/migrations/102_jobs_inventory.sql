-- Axle v2 · 102 jobs (repair orders), payments, appointments, purchasing & inventory
create table public.repair_orders (
  id uuid primary key default gen_random_uuid(),
  job_number bigint unique,                       -- set from next_number('job')
  invoice_number bigint unique,                   -- set when converted to invoice
  customer_id uuid not null references public.customers(id),
  vehicle_id uuid not null references public.vehicles(id),
  odometer_in int, odometer_out int,
  order_status text not null default 'estimate' check (order_status in ('estimate','invoice')),
  workflow_status text not null default 'estimate'
    check (workflow_status in ('estimate','scheduled','arrived','in_progress','waiting_parts','completed','invoiced','paid')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  tags text[] not null default '{}',
  service_advisor_id uuid references public.profiles(id),
  shop_notes text,                                -- internal
  recommendations text,                           -- printed
  print_language text check (print_language in ('en','id')),
  invoiced_at timestamptz,
  due_date date,
  archived_at timestamptz,
  faktur_pajak_number text,
  bill_to_snapshot jsonb,                         -- frozen at invoicing
  shop_snapshot jsonb,
  -- cached totals (written by recalc_repair_order)
  parts_total numeric(14,0) not null default 0,
  labor_total numeric(14,0) not null default 0,
  other_total numeric(14,0) not null default 0,   -- sublet
  service_fees_total numeric(14,0) not null default 0,
  item_discount_total numeric(14,0) not null default 0,
  service_discount_total numeric(14,0) not null default 0,
  job_fees_total numeric(14,0) not null default 0,
  job_discount_total numeric(14,0) not null default 0,
  subtotal numeric(14,0) not null default 0,
  taxable_base numeric(14,0) not null default 0,
  tax_total numeric(14,0) not null default 0,
  total numeric(14,0) not null default 0,
  paid_total numeric(14,0) not null default 0,
  balance numeric(14,0) not null default 0,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.repair_orders (customer_id);
create index on public.repair_orders (vehicle_id);
create index on public.repair_orders (workflow_status) where archived_at is null;
create trigger touch_repair_orders before update on public.repair_orders for each row execute function touch_updated_at();

create table public.ro_concerns (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete cascade,
  position int not null default 0,
  text text not null
);

create table public.ro_services (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete cascade,
  position int not null default 0,
  name text not null,
  notes_external text,
  technician_id uuid references public.profiles(id),
  concern_id uuid references public.ro_concerns(id) on delete set null,
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','deferred','declined')),
  work_status text not null default 'todo' check (work_status in ('todo','in_progress','completed')),
  completed_at timestamptz,
  template_id uuid references public.service_templates(id),
  checklist_id uuid references public.inspection_checklists(id),
  service_schedule_id uuid references public.service_schedules(id) on delete set null,
  flat_price numeric(14,0),                       -- from a flat-rate template
  discount_pct numeric(5,2) not null default 0,
  discount_amount numeric(14,0) not null default 0,
  -- written by recalc
  service_total numeric(14,0) not null default 0,
  service_discount numeric(14,0) not null default 0,
  service_net numeric(14,0) not null default 0,
  created_at timestamptz not null default now()
);
create index on public.ro_services (ro_id);

create table public.ro_service_items (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.ro_services(id) on delete cascade,
  position int not null default 0,
  item_type text not null check (item_type in ('labor','part','fee','sublet')),
  catalog_item_id uuid references public.catalog_items(id),
  name text not null,
  description text,
  cost numeric(14,0) not null default 0,
  price numeric(14,0) not null default 0,
  qty numeric(10,2) not null default 1,          -- hours for labor
  hours_worked numeric(6,2),
  discount_pct numeric(5,2) not null default 0,
  discount_amount numeric(14,0) not null default 0,
  taxable boolean not null default false,
  core_charge numeric(14,0) not null default 0,
  show_qty_price boolean not null default true,
  stock_deducted boolean not null default false,
  po_item_id uuid,                                -- FK added below
  amount numeric(14,0) generated always as (round(price * qty)) stored,
  discount numeric(14,0) generated always as (
    case when discount_pct > 0 then round(price * qty * discount_pct / 100) else discount_amount end) stored,
  net numeric(14,0) generated always as (
    round(price * qty) - case when discount_pct > 0 then round(price * qty * discount_pct / 100) else discount_amount end) stored,
  created_at timestamptz not null default now()
);
create index on public.ro_service_items (service_id);

create table public.ro_job_fees (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete cascade,
  name text not null,
  kind text not null default 'fixed' check (kind in ('fixed','percent')),
  value numeric(14,2) not null default 0,
  amount numeric(14,0) not null default 0,       -- written by recalc
  taxable boolean not null default false,
  is_shop_supplies boolean not null default false,
  manual_override boolean not null default false -- true = amount typed by staff, not recalculated
);
create table public.ro_job_discounts (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete cascade,
  discount_id uuid references public.discounts(id),
  name text not null,
  kind text not null check (kind in ('percent','amount')),
  value numeric(14,2) not null,
  max_amount numeric(14,0),
  amount numeric(14,0) not null default 0        -- written by recalc
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete cascade,
  service_id uuid not null references public.ro_services(id) on delete cascade,
  decision text not null check (decision in ('approved','deferred','declined','pending')),
  method text not null default 'internal' check (method in ('in_person','phone','whatsapp','email','internal')),
  approved_by_name text,
  contact_id uuid references public.customer_contacts(id),
  recorded_by uuid default auth.uid(),
  decided_at timestamptz not null default now(),
  note text
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete restrict,
  customer_id uuid not null references public.customers(id),
  kind text not null default 'payment' check (kind in ('payment','refund')),
  method text not null default 'transfer' check (method in ('transfer','cash','card','giro','other')),
  amount numeric(14,0) not null check (amount > 0),
  paid_at timestamptz not null default now(),
  reference text,
  receipt_number text,
  recorded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create table public.credit_memos (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  amount numeric(14,0) not null check (amount > 0),
  reason text,
  applied_ro_id uuid references public.repair_orders(id),
  applied_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.ro_inspections (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid not null references public.repair_orders(id) on delete cascade,
  service_id uuid references public.ro_services(id) on delete set null,
  checklist_id uuid references public.inspection_checklists(id),
  technician_id uuid references public.profiles(id),
  status text not null default 'todo' check (status in ('todo','in_progress','completed')),
  created_at timestamptz not null default now()
);
create table public.ro_inspection_results (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.ro_inspections(id) on delete cascade,
  item_id uuid references public.inspection_items(id),
  item_name text not null,
  color text check (color in ('green','yellow','red')),
  note text,
  photo_path text,
  concern_id uuid references public.ro_concerns(id) on delete set null   -- linked as a finding
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  ro_id uuid references public.repair_orders(id) on delete set null,
  customer_id uuid references public.customers(id),
  vehicle_id uuid references public.vehicles(id),
  technician_id uuid references public.profiles(id),
  title text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  notes text,
  status text not null default 'scheduled' check (status in ('requested','scheduled','confirmed','arrived','cancelled','no_show')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index on public.appointments (start_time);

-- Purchasing & inventory
create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text unique,                          -- "{job#}-101…" for job POs, "P{n}" for stock POs
  supplier_id uuid not null references public.suppliers(id),
  ro_id uuid references public.repair_orders(id), -- null = stock order
  payment_terms_days int,
  notes text,
  status text not null default 'draft' check (status in ('draft','ordered','partially_delivered','delivered','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid')),
  ordered_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger touch_purchase_orders before update on public.purchase_orders for each row execute function touch_updated_at();

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  catalog_item_id uuid references public.catalog_items(id),
  ro_service_item_id uuid references public.ro_service_items(id) on delete set null,
  name text not null,
  part_number text,
  cost numeric(14,0) not null default 0,
  core_cost numeric(14,0) not null default 0,
  taxable boolean not null default false,
  qty_ordered numeric(10,2) not null check (qty_ordered > 0),
  qty_delivered numeric(10,2) not null default 0,
  qty_cancelled numeric(10,2) not null default 0,
  delivered_at date,
  supplier_invoice_no text,
  invoice_date date,
  payment_due date,
  paid_at date,
  created_at timestamptz not null default now(),
  check (qty_delivered + qty_cancelled <= qty_ordered)
);
create index on public.purchase_order_items (po_id);
alter table public.ro_service_items add constraint ro_service_items_po_item_fk
  foreign key (po_item_id) references public.purchase_order_items(id) on delete set null;

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  amount numeric(14,0) not null check (amount > 0),
  paid_at date not null default current_date,
  method text,
  reference text,
  po_item_ids uuid[] not null default '{}',
  recorded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.catalog_items(id),
  qty_change numeric(12,2) not null,
  reason text not null check (reason in ('opening','po_delivery','used_on_job','return','adjustment','job_reversal')),
  po_item_id uuid references public.purchase_order_items(id) on delete set null,
  ro_service_item_id uuid references public.ro_service_items(id) on delete set null,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.stock_movements (catalog_item_id, created_at desc);

create table public.returns (                        -- parts returned to supplier
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('inventory','ro')),
  po_item_id uuid references public.purchase_order_items(id),
  ro_id uuid references public.repair_orders(id),
  supplier_id uuid not null references public.suppliers(id),
  catalog_item_id uuid references public.catalog_items(id),
  item_name text not null,
  qty numeric(10,2) not null check (qty > 0),
  return_cost numeric(14,0) not null default 0,
  return_tax numeric(14,0) not null default 0,
  status text not null default 'marked' check (status in ('marked','shipped','delivered','refunded')),
  marked_at date not null default current_date,
  shipped_at date, delivered_at date, refunded_at date,
  supplier_invoice_no text,
  credit_number text,
  refund_amount numeric(14,0) not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create table public.cores (                          -- core charges (old part returned to supplier for refund)
  id uuid primary key default gen_random_uuid(),
  ro_service_item_id uuid references public.ro_service_items(id) on delete set null,
  po_item_id uuid references public.purchase_order_items(id),
  ro_id uuid references public.repair_orders(id),
  supplier_id uuid references public.suppliers(id),
  item_name text not null,
  core_cost numeric(14,0) not null default 0,
  qty numeric(10,2) not null default 1,
  retrieval_status text not null default 'to_be_retrieved' check (retrieval_status in ('to_be_retrieved','retrieved','damaged')),
  return_status text not null default 'to_be_returned' check (return_status in ('to_be_returned','marked','shipped','delivered','refunded','damaged')),
  marked_at date not null default current_date,
  delivered_at date, refunded_at date,
  credit_number text,
  refund_amount numeric(14,0) not null default 0,
  created_at timestamptz not null default now()
);
