-- Axle v2 · 135 Shop branding before sign-in, and signing people out after a password reset (Oct 31, 2026)
--
-- The app shows the shop's own name, logo and colours everywhere, including the sign-in page, the browser tab title
-- and the tab icon (Settings → Shop profile and Appearance). Before signing in nobody can read shop_settings, so this
-- returns only those public bits: the name, the logo file (already in the public shop-assets bucket) and the colour
-- theme. Nothing else from the settings (bank details, tax number, address, opening hours…) is exposed.
--
-- It also adds end_user_sessions() (bottom of this file), used by the reset-password function.
--
-- Run once in the SQL Editor, after 134. Safe to re-run.

create or replace function public.shop_branding() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', s.shop_name, 'logo_path', s.logo_path, 'theme', s.theme)
  from shop_settings s limit 1;
$$;
revoke all on function public.shop_branding() from public;
grant execute on function public.shop_branding() to anon, authenticated;

-- Ending someone's sessions on every device (Oct 31, Denny: a password change always signs the person out). Used by
-- the edge function reset-password after an Owner or Admin sets a temporary password; a person who changes their own
-- password signs themselves out everywhere from the app. Deleting the sessions also removes their refresh tokens, so
-- each device is sent to the sign-in page within the hour at most (when its current access token runs out).
create or replace function public.end_user_sessions(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  if to_regclass('auth.sessions') is null then return 0; end if;   -- local test databases have no session table
  execute 'delete from auth.sessions where user_id = $1' using p_user;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.end_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.end_user_sessions(uuid) to service_role;
