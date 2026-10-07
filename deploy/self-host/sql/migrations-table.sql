-- Which app migrations this database has had (kept outside the schemas the app/API can see).
create schema if not exists axle_deploy;
revoke all on schema axle_deploy from public;
create table if not exists axle_deploy.migrations (
  name text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
