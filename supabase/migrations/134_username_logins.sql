-- Axle v2 · 134 Logins without email (Oct 31, 2026)
--
-- Staff who have no email address can now get a login with only a username: the Owner or Admin sets a temporary
-- password when inviting them (edge function invite-user, "temporary password" option), the person must choose their
-- own password the first time they sign in, and an Owner or Admin can set a new temporary password when it's forgotten
-- (edge function reset-password). Such a login gets a hidden placeholder address that can never receive mail
-- (…@no-email.invalid); people never see it and sign in with their username.
--
-- Which logins still have a temporary password is kept here, on the server, not in the login's own settings (which
-- the person could edit): the functions record it right after setting the password, and it is cleared by the database
-- itself as soon as the password changes. The app asks my_temp_password() and sends the person to "choose your
-- password" until it's cleared. Creating a login and resetting a password are written to the activity log.
--
-- Run once in the SQL Editor, after 133. Safe to re-run.

-- 1. Temporary passwords not yet replaced ------------------------------------------------------------------------
create table if not exists public.temp_passwords (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pw_hash text not null,                   -- the password hash at the moment it was set, to notice any change
  set_at timestamptz not null default now(),
  set_by uuid references public.profiles(id) on delete set null
);
alter table public.temp_passwords enable row level security;
revoke all on public.temp_passwords from public, anon, authenticated;

-- Called by invite-user and reset-password (service role) right after they set a temporary password.
create or replace function public.mark_temp_password(p_user uuid, p_by uuid) returns void
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  select encrypted_password into h from auth.users where id = p_user;
  if h is null or h = '' then raise exception 'That login has no password yet'; end if;
  insert into temp_passwords (user_id, pw_hash, set_at, set_by) values (p_user, h, now(), p_by)
  on conflict (user_id) do update set pw_hash = excluded.pw_hash, set_at = excluded.set_at, set_by = excluded.set_by;
end $$;
revoke all on function public.mark_temp_password(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_temp_password(uuid, uuid) to service_role;

-- Any change of the password (the person choosing their own, or a later reset) clears the old temporary one.
create or replace function public.clear_temp_password() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    delete from temp_passwords where user_id = new.id and pw_hash is distinct from new.encrypted_password;
  end if;
  return new;
end $$;
revoke all on function public.clear_temp_password() from public, anon, authenticated;
drop trigger if exists on_auth_password_changed on auth.users;
create trigger on_auth_password_changed after update of encrypted_password on auth.users
  for each row execute function public.clear_temp_password();

-- The signed-in person: still on a temporary password?
create or replace function public.my_temp_password() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from temp_passwords where user_id = auth.uid());
$$;
revoke all on function public.my_temp_password() from public, anon;
grant execute on function public.my_temp_password() to authenticated;

-- 2. Settings → Users: which logins have no email, and which still have a temporary password ---------------------
drop function if exists public.user_logins();
create function public.user_logins()
returns table (id uuid, invited boolean, last_sign_in_at timestamptz, no_email boolean, temp_password boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('manage_users') then raise exception 'Not allowed'; end if;
  return query
  select u.id,
         (u.invited_at is not null and coalesce(u.raw_user_meta_data->>'password_set', '') <> 'true'),
         u.last_sign_in_at,
         coalesce(u.raw_app_meta_data->>'no_email', '') = 'true',
         exists (select 1 from temp_passwords t where t.user_id = u.id)
  from auth.users u join profiles p on p.id = u.id;
end $$;
revoke execute on function public.user_logins() from public, anon;
grant execute on function public.user_logins() to authenticated;
