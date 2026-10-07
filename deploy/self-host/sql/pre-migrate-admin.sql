-- Run by axle.sh as the database superuser before the app migrations.
-- Turns on pg_cron so migration 123 can schedule the 06:00 reminders job (the app also refreshes
-- reminders when someone opens it, so this is a nice-to-have). Skipped quietly where pg_cron isn't available.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      -- Supabase's own event trigger gives postgres what cron.schedule needs; no extra grants here.
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      raise notice 'pg_cron not enabled (%): reminders will refresh when the app is opened', sqlerrm;
    end;
  end if;
end $$;
