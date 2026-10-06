-- Axle v2 · 106 job PO numbers use the highest existing suffix (not a count), so deleting a PO never causes a duplicate number
create or replace function public.set_po_number() returns trigger language plpgsql security definer set search_path = public as $$
declare jn bigint; n int;
begin
  if new.po_number is not null then return new; end if;
  if new.ro_id is null then
    new.po_number := 'P' || next_number('stock_po');
  else
    select job_number into jn from repair_orders where id = new.ro_id for update;
    select coalesce(max(split_part(po_number, '-', 2)::int), 100) into n
      from purchase_orders where ro_id = new.ro_id and po_number ~ ('^' || jn || '-[0-9]+$');
    new.po_number := jn || '-' || (n + 1);
  end if;
  return new;
end $$;
revoke execute on function public.set_po_number() from public, anon, authenticated;
