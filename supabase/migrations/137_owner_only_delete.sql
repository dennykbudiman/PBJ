-- Axle v2 · 137 Only the Owner can delete vehicles, companies and contacts (Nov 4, 2026)
--
-- Denny (Nov 4): "Delete vehicle should only be for owner. Not even admin." — and the same for companies (customers)
-- and their contact people. Before, anyone allowed to edit customers (Owner, Admin, Service advisor) could delete them.
--
-- The rule goes by the Owner role itself, not by a permission, so an Admin can't hand it to someone else. It is a
-- trigger that raises a clear message (a row-level policy would silently delete nothing). Everyone else keeps
-- "Sold" / "Inactive" for vehicles and "Inactive" for companies. The existing rules still apply on top: a vehicle that
-- was transferred, or a company or vehicle with jobs, can't be deleted by anyone.
-- People not signed in to the app (SQL Editor, server functions) aren't limited, as in 115.
--
-- Run once in the SQL Editor, after 136. Safe to re-run.

create or replace function public.owner_only_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return old;
  end if;
  if not exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
                 where p.id = auth.uid() and r.name = 'Owner' and p.status = 'active') then
    raise exception 'Only the Owner can delete vehicles, companies and contacts.';
  end if;
  return old;
end;
$$;
revoke execute on function public.owner_only_delete() from public, anon, authenticated;

drop trigger if exists vehicles_owner_only_delete on public.vehicles;
create trigger vehicles_owner_only_delete before delete on public.vehicles
  for each row execute function public.owner_only_delete();
drop trigger if exists customers_owner_only_delete on public.customers;
create trigger customers_owner_only_delete before delete on public.customers
  for each row execute function public.owner_only_delete();
drop trigger if exists customer_contacts_owner_only_delete on public.customer_contacts;
create trigger customer_contacts_owner_only_delete before delete on public.customer_contacts
  for each row execute function public.owner_only_delete();
