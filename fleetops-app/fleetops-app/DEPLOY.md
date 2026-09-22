# Deploying FleetOps / Axle

Do these in order. Steps 1–2 you've already done if you followed Stage 1's
README; skip to Step 3 if so.

## 1. Supabase project + database

1. Create a project at [supabase.com](https://supabase.com).
2. SQL Editor → run `001_schema.sql`, `002_rls.sql`, `003_seed.sql`, then
   `004_username_login.sql`, in that order (the last one adds username-only
   login, so people sign in with a username instead of their email).
3. Authentication → Providers → confirm **Email** is enabled (this is still
   used behind the scenes — the app just never shows it to anyone).
4. Authentication → URL Configuration → set **Site URL** to your future
   Netlify URL once you know it (Step 4) — this is what invite-email links
   point to. You can come back and fix this after the first deploy.

## 2. Create your first user (Owner)

Authentication → Users → **Add user** (enter your own email + a password).
The `on_auth_user_created` trigger creates a matching `profiles` row
automatically (defaulted to the "Viewer" role, and a username auto-derived
from your email by `004_username_login.sql`'s backfill). In the SQL Editor,
promote yourself to Owner and set the username you actually want to sign in
with:

```sql
update public.profiles
set role_id = (select id from public.roles where name = 'Owner'),
    username = 'your-preferred-username'
where id = (select id from auth.users where email = 'you@example.com');
```

Every user invited through the app's own Settings page afterward picks
their username in that form — this manual step is only needed for this
first account, since it didn't go through that flow.

## 3. Deploy the invite-user Edge Function

This needs the [Supabase CLI](https://supabase.com/docs/guides/cli) installed
on your own machine (not this sandbox — it had no registry access to install
it). The CLI is no longer installable via `npm install -g`; use one of:

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase

# Windows (Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# Linux
curl -fsSL https://cli.supabase.com/install.sh | sh
```

Then:

```bash
supabase login
supabase link --project-ref <your-project-ref>   # find this in the dashboard URL
supabase functions deploy invite-user
```

The function reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` — Supabase sets all three automatically for
every Edge Function, so there's nothing extra to configure here. (Never put
the service role key in `.env`, Netlify's env vars, or anywhere client-side —
it only ever lives inside this function, on Supabase's servers.)

## 4. Push this project to a git repo

```bash
cd fleetops-app
git init
git add -A
git commit -m "FleetOps frontend"
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```

## 5. Connect Netlify

1. [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import
   an existing project** → pick your git repo.
2. Build settings are already in `netlify.toml` (`npm run build`, publishes
   `dist/`) — Netlify should detect them automatically.
3. Before the first deploy, add environment variables (**Site
   configuration → Environment variables**):
   - `VITE_SUPABASE_URL` — your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` — your Supabase anon public key
   (Same two values as your local `.env.local` — never add the
   `service_role` key here.)
4. Deploy. Netlify gives you a `*.netlify.app` URL (or attach a custom
   domain in Site configuration → Domain management).
5. Go back to Supabase → Authentication → URL Configuration and set the
   **Site URL** to that real URL, so invite/reset-password emails link to
   the right place.

## 6. Smoke-test the live site

- Sign in as the Owner user you created in Step 2.
- Settings → Users → Invite someone with a real email you can check —
  confirm the invite email arrives and the new person can set a password
  and sign in.
- Try a delete action as a role without that permission (e.g. Driver) and
  confirm it's blocked — the RLS policies from Stage 1 are what's actually
  enforcing this, not just the UI hiding a button.

## Ongoing changes

Any push to your git repo's main branch triggers a new Netlify build
automatically. Database migrations (new tables/columns) are just more `.sql`
files run in the Supabase SQL Editor, same as Stage 1 — there's no separate
migration tool wired up here.
