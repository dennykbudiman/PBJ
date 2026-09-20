# FleetOps / Axle — Stage 2: React frontend

The real frontend, wired to the Supabase backend from Stage 1. Vite + React 18
+ React Router + `@supabase/supabase-js` — no UI framework, no CSS library,
matching the original prototype's look by hand (colors/spacing live in
`src/lib/theme.js`).

## Before you run this

You need the Stage 1 database set up first (see the `fleetops-supabase`
files you already have — `001_schema.sql`, `002_rls.sql`, `003_seed.sql`,
run in that order in your Supabase project's SQL Editor).

## Running it locally

This project's dependencies were **not** installed in the sandbox that built
it — that environment's network access to the npm registry was blocked, so
`npm install` was never run here and the app was never bundled or started
with a dev server. Do this on your own machine:

```bash
npm install
cp .env.example .env.local
# edit .env.local: paste your Supabase project's URL and anon key
# (Project Settings -> API in the Supabase dashboard)
npm run dev
```

Then open the printed local URL, and sign in. **First-time login:** create
your first user from the Supabase dashboard (Authentication -> Users -> Add
user), which will auto-create a `profiles` row via the database trigger
(defaulting to the "Viewer" role) — then, in the Supabase SQL Editor, promote
yourself to Owner:

```sql
update public.profiles set role_id = (select id from public.roles where name = 'Owner')
where id = (select id from auth.users where email = 'you@example.com');
```

After that, use the app's own Settings -> Users page to invite teammates
(see the note below about what that form does and doesn't do yet).

## What's here

- `src/pages/Dashboard.jsx` — fleet stats, upcoming maintenance, recent
  alerts, fleet-status bar, 6-month maintenance-cost chart — all live
  queries against Supabase (no more mock data).
- `src/pages/Vehicles.jsx`, `Drivers.jsx` — list + add/edit + delete
  (delete gated by the `delete_vehicles` / `delete_drivers` permissions).
  Driver license expiry is edited as two dropdowns (month, year) exactly
  like the prototype, since Indonesian SIM licenses run on a 5-year cycle.
- `src/pages/Maintenance.jsx`, `WorkOrders.jsx` — Maintenance is the
  read-mostly Upcoming/In-progress/History summary; WorkOrders is the full
  detail page (create, edit, line items, technician/bay/ETA, status
  workflow, cost math with 11% PPN tax, delete).
- `src/pages/Parts.jsx` — inventory with stock-status badges, plus
  purchase orders (drafting, adding line items, receiving stock).
- `src/pages/Settings.jsx` — org settings, notification toggles,
  roles & permissions matrix, users list, integrations.
- `src/pages/Alerts.jsx` — filterable alert feed, mark-all-read, dismiss.
- `src/context/AuthContext.jsx` — session/profile/permissions, backed by
  Supabase Auth + the `profiles`/`role_permissions` tables.
- `src/components/` — shared `Sidebar`, `Layout`, `PageHeader`, `Badge`,
  `ConfirmModal` (the delete-confirmation dialog used everywhere).
- `src/lib/theme.js` — one place for colors, fonts, and formatting helpers
  (`formatRupiah`, `formatDate`, `severityPalette`, etc.) so every page
  looks and behaves consistently.

## Inviting new users

Settings' "Invite User" form calls a Supabase Edge Function,
`supabase/functions/invite-user/`, which is the only place the
`service_role` key is ever used — it sends a real invite email via
`auth.admin.inviteUserByEmail()`, then fills in the new user's name/phone/
role. See `DEPLOY.md` for the one-time setup to deploy that function.

## Deploying (Stage 3)

See `DEPLOY.md` for the full checklist: pushing this to a git repo,
connecting it to Netlify, setting environment variables, and deploying the
invite-user Edge Function to Supabase.

## Status

- This code has not been run through a bundler in this environment (npm
  registry access was blocked in the sandbox that built it) — I checked
  every file's syntax by hand and with TypeScript's parser in
  non-type-checking mode, but `npm run dev` and clicking through it is the
  real first test, ideally before you deploy it.
