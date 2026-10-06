-- Axle v2 · 111 technicians are view-only (Denny, Oct 5)
-- They can still be assigned to services and appear on the calendar, but can't change anything.
delete from public.role_permissions where role_id = (select id from public.roles where name = 'Technician');
drop policy if exists "technician updates own services" on public.ro_services;
drop policy if exists "technician updates own inspections" on public.ro_inspections;
