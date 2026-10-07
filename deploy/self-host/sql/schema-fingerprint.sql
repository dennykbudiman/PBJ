-- One hash of every table and column in the app's schema (names, types, required or not).
-- Two databases with the same hash can swap data with axle.sh backup/restore.
select coalesce(md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text,
                               ',' order by c.relname, a.attname)), 'empty')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped;
