-- FleetOps / Axle — Username-only login
-- Supabase Auth is email/phone-based under the hood; this adds a `username`
-- column and a lookup function so the app can accept just a username at
-- sign-in, resolve it to the matching email server-side, and never show or
-- ask for an email address anywhere in the UI.

alter table public.profiles
  add column username text unique;

-- Backfill existing users with something usable rather than leaving this
-- null (unique constraint would otherwise be fine with multiple nulls, but
-- an unusable blank username isn't useful either) — derive from their name.
update public.profiles
  set username = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '.', 'g'))
  where username is null;

alter table public.profiles
  alter column username set not null;

-- Looks up the email for a username, WITHOUT requiring the caller to be
-- signed in (this runs before login) and WITHOUT exposing anyone else's
-- email through normal table access (auth.users is never queryable from
-- the client; profiles' own RLS never selects email either — this function
-- is the one deliberate, narrow exception, and it returns only an email,
-- nothing else about the account).
create or replace function public.get_email_for_username(p_username text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  where lower(p.username) = lower(p_username)
  limit 1;
$$;

-- Callable by anonymous visitors (they aren't signed in yet — that's the
-- whole point) and by already-signed-in users alike.
grant execute on function public.get_email_for_username(text) to anon, authenticated;
