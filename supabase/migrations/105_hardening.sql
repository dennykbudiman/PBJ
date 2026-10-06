-- Axle v2 · 105 hardening (from Supabase security advisor)
-- fixed search_path on the two functions that lacked it; job numbering runs as owner so next_number can be private
alter function public.touch_updated_at() set search_path = public;
create or replace function public.set_job_number() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.job_number is null then new.job_number := next_number('job'); end if;
  return new;
end $$;

-- trigger-only functions: nobody calls these over the API (triggers don't need EXECUTE to fire)
revoke execute on function public.add_shop_supplies(), public.apply_stock_movement(), public.handle_new_user(), public.log_activity(),
  public.on_service_completed(), public.protect_profile_role(), public.refresh_po_status(), public.set_po_number(), public.trg_recalc(),
  public.set_job_number(), public.touch_updated_at() from public, anon, authenticated;
-- internal helpers only used by other database functions
revoke execute on function public.next_number(text), public.recalc_repair_order(uuid) from public, anon, authenticated;
-- permission checks are used inside security rules for signed-in users only
revoke execute on function public.is_staff(), public.has_permission(text) from public, anon;
grant execute on function public.is_staff(), public.has_permission(text) to authenticated;
-- kept callable on purpose: get_email_for_username (username login before sign-in);
-- convert_to_invoice, transfer_vehicle, mark_po_items_delivered/cancelled (signed-in, permission-checked inside)
