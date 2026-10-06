-- 116: A vehicle's ownership history can't be erased by deleting the vehicle (Oct 6, 2026)
--
-- Before: deleting a vehicle also deleted its transfer records (ON DELETE CASCADE), after which
-- the previous owner could be deleted too. Now a vehicle that has been transferred can't be
-- deleted; set it to Sold or Inactive instead. Vehicles without history delete as before.

alter table public.vehicle_transfers
  drop constraint vehicle_transfers_vehicle_id_fkey,
  add constraint vehicle_transfers_vehicle_id_fkey
    foreign key (vehicle_id) references public.vehicles(id);
