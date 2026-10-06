-- Axle v2 · 101 customers (PTs), vehicles, schedules, catalog
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'fleet_internal' check (type in ('fleet_internal','fleet_external','regular')),
  display_name text not null,
  legal_name text,
  npwp text,
  billing_address text,
  phone text, email text,
  payment_terms_days int,                 -- null = shop default
  credit_limit numeric(14,0),
  charge_account boolean not null default true,
  tax_exempt boolean not null default false,
  pinned_notes text,
  tags text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger touch_customers before update on public.customers for each row execute function touch_updated_at();

create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null,
  role text not null default 'other' check (role in ('fleet_manager','billing','other')),
  phone text, email text,
  is_primary boolean not null default false,
  can_approve boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.customer_contacts (customer_id);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  plate text not null,
  make text, model text, year int, vin text,
  type text,
  fuel_type text,
  status text not null default 'active' check (status in ('active','in_shop','inactive','sold')),
  mileage_km int,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index vehicles_plate_unique on public.vehicles (upper(replace(plate,' ','')));
create index on public.vehicles (customer_id);
create trigger touch_vehicles before update on public.vehicles for each row execute function touch_updated_at();

create table public.vehicle_transfers (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  from_customer_id uuid references public.customers(id),
  to_customer_id uuid not null references public.customers(id),
  transferred_at date not null default current_date,
  odometer_km int,
  note text,
  recorded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- Catalog
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_id uuid references public.categories(id),
  applies_to text not null default 'part' check (applies_to in ('part','labor','fee','any')),
  created_at timestamptz not null default now()
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'internal' check (type in ('internal','sublet')),
  payment_terms_days int,
  account_number text,
  contact_name text, phone text, email text, address text,
  pinned_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger touch_suppliers before update on public.suppliers for each row execute function touch_updated_at();

create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('labor','part','fee')),
  name text not null,
  code text,                              -- part number / labor code
  description text,
  category_id uuid references public.categories(id),
  supplier_id uuid references public.suppliers(id),
  brand text,
  cost numeric(14,0) not null default 0,
  price numeric(14,0) not null default 0,
  markup_pct numeric(6,2),
  default_qty numeric(10,2) not null default 1,
  labor_hours numeric(6,2),
  labor_rate_id uuid references public.labor_rates(id),
  fee_kind text check (fee_kind in ('fixed','percent')),
  fee_value numeric(14,2),
  taxable boolean not null default false,
  show_on_invoice boolean not null default true,
  show_qty_price boolean not null default true,
  track_inventory boolean not null default false,
  qty_on_hand numeric(12,2) not null default 0,
  reorder_point numeric(12,2),
  has_core boolean not null default false,
  core_cost numeric(14,0) not null default 0,
  tire_size text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.catalog_items (item_type, active);
create index on public.catalog_items (code);
create trigger touch_catalog_items before update on public.catalog_items for each row execute function touch_updated_at();

create table public.catalog_item_fees (            -- fee auto-added with an item; qty follows the item
  item_id uuid not null references public.catalog_items(id) on delete cascade,
  fee_item_id uuid not null references public.catalog_items(id) on delete cascade,
  primary key (item_id, fee_item_id)
);

create table public.discounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  level text not null check (level in ('job','service')),
  kind text not null check (kind in ('percent','amount')),
  value numeric(14,2) not null,
  max_amount numeric(14,0),
  valid_from date, valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.inspection_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.inspection_item_notes (          -- canned notes, tagged by colour
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inspection_items(id) on delete cascade,
  note text not null,
  green boolean not null default false, yellow boolean not null default false, red boolean not null default false
);
create table public.inspection_checklists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.inspection_checklist_items (
  checklist_id uuid not null references public.inspection_checklists(id) on delete cascade,
  item_id uuid not null references public.inspection_items(id) on delete cascade,
  position int not null default 0,
  primary key (checklist_id, item_id)
);

create table public.service_templates (              -- service bundles; flat_price set = flat-rate item
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tags text[] not null default '{}',
  flat_price numeric(14,0),
  checklist_id uuid references public.inspection_checklists(id),
  default_interval_km int,                            -- suggested schedule when completed
  default_interval_months int,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.service_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.service_templates(id) on delete cascade,
  catalog_item_id uuid not null references public.catalog_items(id),
  qty numeric(10,2) not null default 1,
  price_override numeric(14,0),
  position int not null default 0
);

create table public.service_schedules (              -- preventive maintenance per vehicle
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  name text not null,
  template_id uuid references public.service_templates(id),
  interval_km int,
  interval_months int,
  last_done_km int,
  last_done_date date,
  next_due_km int generated always as (last_done_km + interval_km) stored,
  next_due_date date generated always as ((last_done_date + make_interval(months => interval_months))::date) stored,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (interval_km is not null or interval_months is not null)
);
create index on public.service_schedules (vehicle_id);
create trigger touch_service_schedules before update on public.service_schedules for each row execute function touch_updated_at();
