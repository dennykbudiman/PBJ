-- 122: Opening hours, and board moves that update bookings (Oct 7, 2026)
--
-- 1. shop_settings.opening_hours: open days and times. Bookings must start and end inside them
--    (checked when a booking is made or its time changes; old bookings are left alone).
-- 2. Moving a job on the board to Arrived (or further) marks its booking Arrived too.

-- ===== 1. Opening hours =====
create or replace function public.valid_opening_hours(h jsonb) returns boolean language plpgsql immutable set search_path = public as $$
declare d text; x jsonb;
begin
  if h is null or jsonb_typeof(h) <> 'object' then return false; end if;
  foreach d in array array['mon','tue','wed','thu','fri','sat','sun'] loop
    x := h->d;
    if x is null or jsonb_typeof(x) <> 'object' or coalesce(jsonb_typeof(x->'open'), '') <> 'boolean' then return false; end if;
    if coalesce(x->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(x->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$' then return false; end if;
    if (x->>'open')::boolean and (x->>'start') >= (x->>'end') then return false; end if;
  end loop;
  -- At least one open day, or nothing could ever be booked.
  return exists (select 1 from unnest(array['mon','tue','wed','thu','fri','sat','sun']) as wd(k) where (h->wd.k->>'open')::boolean);
end $$;

alter table public.shop_settings add column opening_hours jsonb not null default
  '{"mon":{"open":true,"start":"08:00","end":"17:00"},"tue":{"open":true,"start":"08:00","end":"17:00"},
    "wed":{"open":true,"start":"08:00","end":"17:00"},"thu":{"open":true,"start":"08:00","end":"17:00"},
    "fri":{"open":true,"start":"08:00","end":"17:00"},"sat":{"open":true,"start":"08:00","end":"17:00"},
    "sun":{"open":false,"start":"08:00","end":"17:00"}}'::jsonb;
alter table public.shop_settings add constraint shop_settings_opening_hours check (valid_opening_hours(opening_hours));
grant update (opening_hours) on public.shop_settings to authenticated;

-- A booking's start and end must fall in opening hours, on the shop clock.
-- Checked when it is made or its time changes, so changing the hours later doesn't block edits to old bookings.
create or replace function public.check_appointment_hours() returns trigger language plpgsql security definer set search_path = public as $$
declare h jsonb; tz text; ls timestamp; le timestamp; ds jsonb; de jsonb; le_txt text; le_day date;
  days text[] := array['mon','tue','wed','thu','fri','sat','sun'];
begin
  if tg_op = 'UPDATE' and new.start_time = old.start_time and new.end_time = old.end_time then return new; end if;
  select opening_hours, timezone into h, tz from shop_settings limit 1;
  if h is null then return new; end if;
  ls := new.start_time at time zone coalesce(tz, 'Asia/Jakarta');
  le := new.end_time at time zone coalesce(tz, 'Asia/Jakarta');
  ds := h->(days[extract(isodow from ls)::int]);
  if not (ds->>'open')::boolean then raise exception 'The shop is closed on that day'; end if;
  if to_char(ls, 'HH24:MI') < ds->>'start' then raise exception 'That is before the shop opens'; end if;
  if to_char(ls, 'HH24:MI') >= ds->>'end' then raise exception 'That is after the shop closes'; end if;
  -- Ending exactly at midnight counts as 24:00 of the day before.
  le_txt := case when to_char(le, 'HH24:MI') = '00:00' and le::date > ls::date then '24:00' else to_char(le, 'HH24:MI') end;
  le_day := case when le_txt = '24:00' then le::date - 1 else le::date end;
  if le_day = ls::date then
    if le_txt > ds->>'end' then raise exception 'That is after the shop closes'; end if;
  else
    -- A booking over several days ends inside the opening hours of its last day.
    de := h->(days[extract(isodow from le_day)::int]);
    if not (de->>'open')::boolean then raise exception 'The shop is closed on the day the booking ends'; end if;
    if le_txt > de->>'end' or le_txt <= de->>'start' then raise exception 'That is after the shop closes'; end if;
  end if;
  return new;
end $$;
revoke execute on function public.check_appointment_hours() from public, anon, authenticated;
create trigger appointments_hours_check before insert or update of start_time, end_time on public.appointments
  for each row execute function check_appointment_hours();

-- ===== 2. Board moves update bookings =====
-- (When the job moves because a booking changed — 121's appointment_moves_job — the booking is already right:
-- that function sets axle.from_appointment for the length of its own update, and this trigger then does nothing.)
-- Moving a job from Estimate / Scheduled to Arrived or further means the vehicle is here:
-- its booking (the earliest one still open) becomes Arrived. That booking's own trigger then leaves the job alone.
create or replace function public.job_moves_appointment() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('axle.from_appointment', true) = 'on' then return null; end if;
  if new.order_status = 'estimate' and new.closed_at is null
     and old.workflow_status in ('estimate', 'scheduled')
     and new.workflow_status in ('arrived', 'in_progress', 'waiting_parts', 'completed') then
    update appointments set status = 'arrived'
    where id = (select a.id from appointments a
                where a.ro_id = new.id and a.status in ('requested', 'scheduled', 'confirmed')
                  and a.end_time > now() - interval '1 day' and a.start_time < now() + interval '1 day'   -- today's visit, not next week's
                order by a.start_time limit 1);
  end if;
  return null;
end $$;
revoke execute on function public.job_moves_appointment() from public, anon, authenticated;
create trigger job_moves_appointment after update of workflow_status on public.repair_orders
  for each row when (new.workflow_status is distinct from old.workflow_status) execute function job_moves_appointment();

-- 121's appointment_moves_job, now marking its own job updates so the trigger above leaves bookings alone.
create or replace function public.appointment_moves_job() returns trigger language plpgsql security definer set search_path = public as $$
declare v_prev text := coalesce(current_setting('axle.from_appointment', true), 'off');
begin
  perform set_config('axle.from_appointment', 'on', true);
  if tg_op in ('UPDATE', 'DELETE') and old.ro_id is not null
     and (tg_op = 'DELETE' or new.ro_id is distinct from old.ro_id) then
    update repair_orders set workflow_status = 'estimate'
    where id = old.ro_id and order_status = 'estimate' and closed_at is null and workflow_status = 'scheduled'
      and not exists (select 1 from appointments a where a.ro_id = old.ro_id and a.id <> old.id
                      and a.status in ('requested', 'scheduled', 'confirmed') and a.end_time > now());
  end if;
  if tg_op <> 'DELETE' and new.ro_id is not null then
    if new.status in ('scheduled', 'confirmed') then
      update repair_orders set workflow_status = 'scheduled'
      where id = new.ro_id and order_status = 'estimate' and closed_at is null and workflow_status = 'estimate';
    elsif new.status = 'arrived' then
      update repair_orders set workflow_status = 'arrived'
      where id = new.ro_id and order_status = 'estimate' and closed_at is null and workflow_status in ('estimate', 'scheduled');
    elsif new.status in ('cancelled', 'no_show') then
      update repair_orders set workflow_status = 'estimate'
      where id = new.ro_id and order_status = 'estimate' and closed_at is null and workflow_status = 'scheduled'
        and not exists (select 1 from appointments a where a.ro_id = new.ro_id and a.id <> new.id
                        and a.status in ('requested', 'scheduled', 'confirmed') and a.end_time > now());
    end if;
  end if;
  perform set_config('axle.from_appointment', v_prev, true);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
