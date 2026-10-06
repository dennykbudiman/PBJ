-- 115: Owner protection and username changes (decided Oct 6, 2026)
--
-- Rules enforced for people using the app (the SQL editor and server functions are not limited):
--   * Only an Owner can change or remove an Owner, or make someone an Owner.
--     An Admin can manage everyone else (including other Admins), but never an Owner.
--   * There is always at least one active Owner.
--   * Nobody can change their own role or status, or remove their own profile.
--   * Only user managers can change usernames (staff could change their own before).

create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := (select id from public.roles where name = 'Owner');
  v_me_owner boolean;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  v_me_owner := exists (select 1 from public.profiles
                        where id = auth.uid() and role_id = v_owner and status = 'active');

  if tg_op = 'INSERT' then
    if new.role_id = v_owner and not v_me_owner then
      raise exception 'Only an Owner can make someone an Owner.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.id = auth.uid() then
      raise exception 'You can''t remove your own account.';
    end if;
    if old.role_id = v_owner then
      if not v_me_owner then
        raise exception 'Only an Owner can remove an Owner.';
      end if;
      if old.status = 'active' and not exists (select 1 from public.profiles
           where role_id = v_owner and status = 'active' and id <> old.id) then
        raise exception 'There must always be at least one active Owner.';
      end if;
    end if;
    return old;
  end if;

  -- UPDATE
  if new.username is distinct from old.username and not has_permission('manage_users') then
    raise exception 'Only user managers can change usernames.';
  end if;

  if new.role_id is distinct from old.role_id or new.status is distinct from old.status then
    if not has_permission('manage_users') then
      raise exception 'Only user managers can change roles or status';
    end if;
    if new.id = auth.uid() then
      raise exception 'You can''t change your own role or status.';
    end if;
    if (old.role_id = v_owner or new.role_id = v_owner) and not v_me_owner then
      raise exception 'Only an Owner can change an Owner, or make someone an Owner.';
    end if;
    if old.role_id = v_owner and old.status = 'active'
       and (new.role_id is distinct from v_owner or new.status <> 'active')
       and not exists (select 1 from public.profiles
                       where role_id = v_owner and status = 'active' and id <> old.id) then
      raise exception 'There must always be at least one active Owner.';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
  before insert or update or delete on public.profiles
  for each row execute function public.protect_profile_role();

revoke all on function public.protect_profile_role() from public, anon, authenticated;
