# Axle v2

Workshop and fleet-maintenance app (AutoLeap-style), rebuilt on a new database.
React 18 + Vite + React Router, Supabase (Postgres, auth, storage, edge functions), Netlify.

**Previews and branch builds of this branch talk to the STAGING Supabase project "Axle v2 staging"** (`wuwabhwvnzhlcctxwpda`).
The live app on `main` and its database are not touched. `netlify.toml` pins the staging address for previews and
branch builds, so they can never reach live data. Production builds take the database address from the Netlify site's
environment variables, and `scripts/check-release.mjs` stops a production build that would use the old v1 database or
staging. **Do not merge this branch into `main`** until the planned cut-over (see "Going live" below).

## Build stages

1. **Foundations** ✓: sign-in by username, invite / reset password, app layout, EN/ID, notifications bell, Settings (shop profile and logo, appearance / colour theme, language and printing, numbering, fees and tax, labor rates, users and access)
2. **Customers & vehicles** ✓
3. **Catalog** ✓: labor, parts, fees, discounts, flat rate items, service bundles, inspections, checklists, categories, suppliers
4. **Jobs, estimates, invoices & payments** ✓: job page, approvals, invoicing and voiding, payments and credits, inspections, activity, job lists
5. **Printed invoices & estimates** ✓: A4 estimate and invoice in Indonesian or English (`/print/jobs/<id>`)
6. **Work board & calendar** ✓: Kanban / list board by workflow (`/board`), calendar by day (per technician) / week / month with appointments (`/calendar`), bookings on the job page, deferred work carried into new estimates or dismissed
7. **Inventory & purchase orders** ✓ (update 8: returns per PO, received quantities can be corrected): Inventory → Stock (on hand / on estimates / available / on order, order low parts), Purchase orders (stock and job POs, receive with supplier invoice, cancel, print `/print/po/<id>`), Returns to suppliers, Cores, Supplier bills (pay delivered parts, undo); "Order parts" and On order / Arrived badges on the job page
8. **Service schedules** ✓ (built before stage 7): schedules per vehicle by km and/or months, Customers → Service due, due work on open estimates, bundles that start their own schedule on completion, service-due and overdue-invoice reminders in the bell, next service on the invoice
9. **Dashboard & reports** ✓: 9a dashboard (today's work, money, needs attention, 6-month chart) and Reports → Sales, Receivables aging, Payments received; 9b Profit, Technicians, Fleet spend, Inventory, Service compliance. Every report has CSV download
10. **Go-live update (migration 129)** ✓: money kept back by the database (cost prices only for people who see costs; job money only for people who handle money and the technicians on that job), Cashier pays supplier bills, enters the faktur pajak number and attaches transfer slips, files on jobs, sign-in through the server (`login` function), per-person notification read, Invited status on Users, one default labor rate, Settings → Import data (CSV templates), staging reset script and release check
11. **Audit fixes (migration 131)** ✓: see `supabase/migrations/131_audit_fixes.sql`
12. **Smaller audit fixes and printouts (migration 132)** ✓: completed work can't be declined, deferred or closed without an invoice; money details kept back (payment status, supplier bank accounts); files locked on invoiced jobs; faktur pajak number checks; exact line rounding; invoice warnings (stock, credit limit, not on account); Indonesian database messages; page error screen; and **service history / vehicle list printouts and Excel (CSV) downloads** for one vehicle or a whole company (`/print/history`, buttons on the vehicle and company pages)
13. **Fleet manager access (migration 133)** ✓: a login for a customer's own fleet person, linked by an Owner or Admin to one or more companies (Settings → Users → Companies…). It sees only those companies — company details, vehicles, service due, work orders and invoices with prices, payments and what is owed — read-only, with a reduced menu (Dashboard, My fleet). On an open estimate it can approve, defer or decline waiting work once (`fleet_decide`, method "Online"); after that only the shop can change the decision. Never cost prices, internal notes, attachments, activity, other companies or staff. Also: the customer panel's "Service appointment" button opens the calendar, Viewers no longer appear as mechanics, and the vehicle notes column is staff-only (`vehicles_read`)
14. **Logins without email (migration 134)** ✓: in Settings → Users → Invite user, an Owner or Admin can choose "Temporary password (no email)": the person gets a login with only a username (a hidden placeholder address `…@no-email.invalid` that never receives mail), signs in with the username and the temporary password, and must choose their own password first. "Reset password" on each person sets a new temporary password (edge function `reset-password`; Owner/Admin only, an Owner's only by an Owner, never your own) and clears the failed-sign-in pause. Settings → Users shows "no email" and "temporary password not changed yet". Invites no longer offer the Owner role (promote someone afterwards).

## Run locally

```bash
cp .env.example .env.local   # then paste the staging publishable key (sb_publishable_…)
npm install
npm run dev
```

`npm run build` must pass before pushing.

## Folders

- `src/context` — signed-in person (profile, role, permissions) and shop settings
- `src/lib` — Supabase client, EN/ID text (`strings.js`), number and date formatting
- `src/components` — app layout (top bar), shared UI pieces
- `src/pages` — screens; `pages/settings` is the Settings page
- `src/pages/customers`, `src/pages/catalog`, `src/pages/jobs`, `src/pages/board`, `src/pages/calendar`, `src/pages/inventory`, `src/pages/reports` — Customers & vehicles, Catalog, Jobs, Work board, Calendar, Inventory, Reports
- `supabase/migrations` — database migrations 100–134 (134: see build stage 14 above and the file's header; 133: see build stage 13 above and the file's header; 132: see build stage 12 above and the file's header; 131: fixes from the October 25 audit — a service schedule moves back when its service is un-completed or deleted, percent fees at most 100%, PPN on flat-price services with no priced lines, typed-in job lines follow the shop's taxable setting, payments can't follow a job to another company, approvals locked with the invoice, supplier bills leave out returned parts, voided invoices also listed in the month they were issued, `app_environment` marker for the staging reset; 130: storage limits, price list and void copies hidden like other money, faktur only via `set_faktur_pajak`, race-proof sign-in limits; 129: see the file's header — money kept back by the database through `<table>_read` views, `pay_supplier_bills`, `set_faktur_pajak`, attachments of kind `payment`, `notification_reads`, `user_logins`, `login_attempts`; 128 adds the Cashier role — payments, deposits, refunds and paying company credit back, while the Service advisor works a job up to the invoice — plus fixes from the October full review: `customer_balances` respects row security again, profiles and role permissions can't be changed around the Owner, payments on closed jobs and future-dated payments are refused, an issued invoice's due date is Owner/Admin only)
- `supabase/functions/invite-user` — invites a person (by email, or with a temporary password and no email); `supabase/functions/reset-password` — an Owner or Admin sets a new temporary password; `supabase/functions/delete-user` removes a login; `supabase/functions/login` — signs people in by username or email. Deploy all four with the platform JWT check off (`supabase functions deploy <name> --no-verify-jwt`): each checks the caller itself, and the platform check doesn't understand Supabase's new API keys. They use the new keys (`SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS`) when the project has them, else the legacy anon / service_role keys
- `scripts/check-release.mjs` — the release check Netlify runs before each build
- `scripts/write-headers.mjs` — run by Netlify after each build: writes `dist/_headers` with the Content-Security-Policy for this build's own Supabase project
- `deploy/staging-reset.sql` — empties the staging database for a fresh rehearsal (keeps people, roles, shop settings and labor rates). It only runs on a database marked as staging (`app_environment`, migration 131)
- `deploy/self-host` — kit for running Axle on your own Linux server (self-hosted Supabase + the app + HTTPS, backups, moving data from supabase.co). Start with `deploy/self-host/README.md`. Netlify ignores this folder.

## Rules the screens rely on

- The database does the money maths, numbering and permission checks. Screens only ask.
- Money columns of `catalog_items`, `ro_service_items`, `purchase_order_items`, `supplier_payments`, `returns`, `cores`, `repair_orders`, `ro_services`, `ro_job_fees` and `ro_job_discounts` (migration 129), and the price list in `labor_rates`, `service_templates`, `service_template_items`, `discounts` and `customers.credit_limit`, plus `invoice_voids.snapshot` (migration 130), can't be read from the tables. `src/lib/supabase.js` sends reads of these tables to their `<table>_read` views, which blank figures a person may not see; writes still go to the tables. A write that needs the row back uses `writeRow()`. A new column on one of these tables must be added to its view too. `activity_log` is read through `activity_log_read`.
- A blank (null) money figure means "hidden for this person": `rp(null)` shows "—" and `sumOf()` adds up to blank.
- Use plain `insert` / `update`, not `upsert`, on tables with column-level grants.
- Since migration 132, a new table, function or sequence gets no rights for `anon` / `authenticated` by default: every migration grants what the app needs explicitly (as the existing ones do).
- Daily reminders: migration 123 schedules them only if pg_cron was on when it ran. If pg_cron is switched on later, run once in the SQL Editor: `select cron.schedule('axle-reminders', '0 23 * * *', 'select public.refresh_reminders(true)');` (06:00 Jakarta time).
- Text shown to people goes through `t('key')`; add both `en` and `id` in `src/lib/strings.js`.
- Money is whole Rupiah, shown as `Rp 1.234.567` (`rp()` in `src/lib/format.js`).
- Job `100001`, invoice `INV-000001`, stock PO `900001`, job PO `100042-101` (`jobNo`, `invoiceNo`, `stockPoNo`).
- Every PO delivery lands on the shelf; invoicing a job takes its approved parts off. PO money sums use `lineAmount()` in `src/lib/inventory.js`, the same as `po_line_amount()` in the database.

## Going live (summary)

1. New Supabase Pro project (Singapore). Turn on pg_cron, then run every file in `supabase/migrations` in name order (100 … 107, 107b, 108 … 134), each in its own SQL Editor run. Then mark the project as production (this can't be changed later, and stops the staging reset from ever running there): `insert into public.app_environment (name) values ('production');`. Deploy `invite-user`, `reset-password`, `delete-user` and `login`, all with `--no-verify-jwt`. Raise Authentication → Rate Limits → sign-ins (all sign-ins now come from the `login` function's address); after the first sign-ins, check `login_attempts.ip` is filled (the function reads `cf-connecting-ip`; set the function secret `AXLE_CLIENT_IP_HEADER` if Supabase uses another header). Authentication: sign-ups off, Site URL `https://pulaubarumotor.netlify.app` and Redirect URL `https://pulaubarumotor.netlify.app/**` (plus the shop's own domain once it has one), custom SMTP (a shop Gmail with an App Password to start; Resend once there's a domain).
2. Netlify: the live site is **`pulaubarumotor`** (https://pulaubarumotor.netlify.app; until go-live it is the staging preview site). In Site configuration → Build & deploy → Branches: set the production branch to `main`, and keep branch deploys for `axle-v2` (the staging preview, https://axle-v2--pulaubarumotor.netlify.app, which `netlify.toml` pins to the staging database). In Environment variables, set `VITE_SUPABASE_URL` to the production project's address and `VITE_SUPABASE_ANON_KEY` to its **publishable** key (`sb_publishable_…`, Project Settings → API Keys; not the secret key, and not the legacy anon key, which Supabase retires by the end of 2026), and remove `AXLE_ALLOW_STAGING` if it is set. Then merge this branch into `main`. The release check refuses the build until the variables point at the new project. The old v1 site `singular-faun-a1f8a7` also builds from `main`: before the merge, stop its builds (Build & deploy → Stop builds) so it keeps its last v1 version until it is retired. In the staging project's Authentication → URL Configuration, keep `https://axle-v2--pulaubarumotor.netlify.app/**` as a Redirect URL.
3. First Owner: in Supabase → Authentication → Users, invite yourself and choose a password from the email. Then, in the SQL Editor (change the email, name and username):
   ```sql
   update public.profiles
   set role_id = (select id from public.roles where name = 'Owner'), status = 'active', name = 'Your Name', username = 'yourname'
   where id = (select id from auth.users where email = 'you@company.co.id');
   ```
   Sign in, then invite the team from Settings → Users.
4. Settings → Import data: suppliers, companies, vehicles, catalog, service schedules, opening stock.
