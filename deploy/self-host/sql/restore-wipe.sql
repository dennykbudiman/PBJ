-- Run by axle.sh restore as the database superuser, in the same transaction as the backup's data.
-- Empties every app table and the login tables so the backup can be loaded as-is.
-- session_replication_role = replica switches off the app's triggers and foreign-key checks while
-- loading, so rows go back exactly as they were saved (no totals recalculated, no guards tripped).
set session_replication_role = replica;
do $$
declare t text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into t
  from pg_tables where schemaname = 'public';
  if t is not null then
    execute 'truncate table ' || t || ' restart identity';
  end if;
  -- Logins: users, their identities, sessions, MFA... (Auth's own bookkeeping tables stay).
  for t in select format('%I.%I', schemaname, tablename) from pg_tables
           where schemaname = 'auth' and tablename not in ('schema_migrations', 'instances')
  loop
    execute 'delete from ' || t;
  end loop;
end $$;
