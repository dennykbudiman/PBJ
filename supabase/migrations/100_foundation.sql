-- Axle v2 · 100 foundation: users & roles, shop settings, numbering, logs
create extension if not exists pgcrypto;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_key text not null,
  primary key (role_id, permission_key)
);
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  username text unique,
  phone text,
  role_id uuid references public.roles(id),
  status text not null default 'active' check (status in ('active','invited','disabled')),
  language text check (language in ('en','id')),          -- null = use shop default
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger touch_profiles before update on public.profiles for each row execute function touch_updated_at();

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active');
$$;
create or replace function public.has_permission(perm text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p join public.role_permissions rp on rp.role_id = p.role_id
                 where p.id = auth.uid() and p.status = 'active' and rp.permission_key = perm);
$$;
create or replace function public.get_email_for_username(p_username text) returns text language sql stable security definer set search_path = public as $$
  select u.email from public.profiles p join auth.users u on u.id = p.id where lower(p.username) = lower(p_username) limit 1;
$$;
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, username, role_id, status)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), new.raw_user_meta_data->>'username',
          coalesce((select id from public.roles where name = new.raw_user_meta_data->>'role'), (select id from public.roles where name = 'Viewer')),
          'active');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Shop profile & configuration (single row)
create table public.shop_settings (
  id boolean primary key default true check (id),
  shop_name text not null default 'Axle',
  logo_path text,
  legal_name text, npwp text, address text, phone text, email text,
  bank_details text,
  pkp_status text not null default 'unknown' check (pkp_status in ('unknown','pkp','non_pkp')),
  timezone text not null default 'Asia/Jakarta',
  default_app_language text not null default 'en' check (default_app_language in ('en','id')),
  default_print_language text not null default 'id' check (default_print_language in ('en','id')),
  terms_id text, terms_en text,
  tax_name text not null default 'PPN',
  tax_rate numeric(5,2) not null default 11,
  new_items_taxable boolean not null default false,
  shop_supplies_enabled boolean not null default true,
  shop_supplies_type text not null default 'percent' check (shop_supplies_type in ('percent','fixed')),
  shop_supplies_rate numeric(12,2) not null default 2,
  shop_supplies_base text not null default 'parts_labor' check (shop_supplies_base in ('parts_labor','parts','labor')),
  shop_supplies_min numeric(14,0),
  shop_supplies_max numeric(14,0),
  shop_supplies_taxable boolean not null default false,
  default_payment_terms_days int not null default 30,
  due_soon_days int not null default 14,
  due_soon_km int not null default 1000,
  updated_at timestamptz not null default now()
);
create trigger touch_shop_settings before update on public.shop_settings for each row execute function touch_updated_at();

-- Locked counters: job #, invoice # (one sequence for all PTs), stock PO #
create table public.number_sequences (name text primary key, next_value bigint not null);
create or replace function public.next_number(seq text) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  update public.number_sequences set next_value = next_value + 1 where name = seq returning next_value - 1 into v;
  if v is null then raise exception 'Unknown number sequence %', seq; end if;
  return v;
end $$;

create table public.labor_rates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rate_per_hour numeric(14,0) not null,
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.activity_log (
  id bigint generated always as identity primary key,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  changes jsonb,
  user_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.activity_log (entity_type, entity_id, created_at desc);

create or replace function public.log_activity() returns trigger language plpgsql security definer set search_path = public as $$
declare diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value and n.key not in ('updated_at','parts_total','labor_total','other_total','service_fees_total','item_discount_total',
      'service_discount_total','job_fees_total','job_discount_total','subtotal','taxable_base','tax_total','total','paid_total','balance',
      'service_total','service_discount','service_net','amount','qty_on_hand');
    if diff is null then return new; end if;
    insert into public.activity_log (entity_type, entity_id, action, changes) values (tg_table_name, new.id, 'update', diff);
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.activity_log (entity_type, entity_id, action) values (tg_table_name, new.id, 'create');
    return new;
  else
    insert into public.activity_log (entity_type, entity_id, action, changes) values (tg_table_name, old.id, 'delete', to_jsonb(old));
    return old;
  end if;
end $$;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,                     -- service_due, invoice_overdue, parts_overdue, approval_needed …
  severity text not null default 'info' check (severity in ('info','warning','urgent')),
  title text not null,
  body text,
  entity_type text, entity_id uuid,
  user_id uuid references public.profiles(id) on delete cascade,  -- null = everyone
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  file_path text not null,
  file_name text,
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.attachments (entity_type, entity_id);

-- Seed
insert into public.roles (name) values ('Owner'),('Admin'),('Service advisor'),('Technician'),('Fleet manager'),('Viewer');
insert into public.role_permissions (role_id, permission_key)
select r.id, p from public.roles r, unnest(array['manage_users','edit_settings','edit_catalog','edit_customers','edit_jobs','delete_jobs',
  'record_payments','manage_inventory','view_reports','view_costs']) p where r.name in ('Owner','Admin');
insert into public.role_permissions (role_id, permission_key)
select r.id, p from public.roles r, unnest(array['edit_catalog','edit_customers','edit_jobs','record_payments','manage_inventory','view_reports','view_costs']) p where r.name = 'Service advisor';
insert into public.role_permissions (role_id, permission_key)
select r.id, p from public.roles r, unnest(array['edit_jobs']) p where r.name = 'Technician';
insert into public.shop_settings (id, terms_id, terms_en) values (true,
  'Terima kasih atas kepercayaan Anda. Pembayaran jatuh tempo sesuai tanggal di atas. Harap hubungi kami bila ada pertanyaan mengenai pekerjaan yang kami lakukan.',
  'Thank you for your business. Payment is due by the date above. Please contact us promptly if you have any questions about the work we did.');
insert into public.number_sequences values ('job', 1001), ('invoice', 100001), ('stock_po', 1);
insert into public.labor_rates (name, rate_per_hour, is_default) values ('Standard', 150000, true);
