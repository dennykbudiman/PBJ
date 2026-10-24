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

## Run locally

```bash
cp .env.example .env.local   # then paste the staging anon key
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
- `supabase/migrations` — database migrations 100–129 (129: see the file's header — money kept back by the database through `<table>_read` views, `pay_supplier_bills`, `set_faktur_pajak`, attachments of kind `payment`, `notification_reads`, `user_logins`, `login_attempts`; 128 adds the Cashier role — payments, deposits, refunds and paying company credit back, while the Service advisor works a job up to the invoice — plus fixes from the October full review: `customer_balances` respects row security again, profiles and role permissions can't be changed around the Owner, payments on closed jobs and future-dated payments are refused, an issued invoice's due date is Owner/Admin only)
- `supabase/functions/invite-user` — invites a person; `supabase/functions/delete-user` removes a login; `supabase/functions/login` — signs people in by username or email (deploy with JWT verification off: `supabase functions deploy login --no-verify-jwt`)
- `scripts/check-release.mjs` — the release check Netlify runs before each build
- `deploy/staging-reset.sql` — empties the staging database for a fresh rehearsal (keeps people, roles, shop settings and labor rates)
- `deploy/self-host` — kit for running Axle on your own Linux server (self-hosted Supabase + the app + HTTPS, backups, moving data from supabase.co). Start with `deploy/self-host/README.md`. Netlify ignores this folder.

## Rules the screens rely on

- The database does the money maths, numbering and permission checks. Screens only ask.
- Money columns of `catalog_items`, `ro_service_items`, `purchase_order_items`, `supplier_payments`, `returns`, `cores`, `repair_orders`, `ro_services`, `ro_job_fees` and `ro_job_discounts` can't be read from the tables (migration 129). `src/lib/supabase.js` sends reads of these tables to their `<table>_read` views, which blank figures a person may not see; writes still go to the tables. A write that needs the row back uses `writeRow()`. A new column on one of these tables must be added to its view too. `activity_log` is read through `activity_log_read`.
- A blank (null) money figure means "hidden for this person": `rp(null)` shows "—" and `sumOf()` adds up to blank.
- Use plain `insert` / `update`, not `upsert`, on tables with column-level grants.
- Text shown to people goes through `t('key')`; add both `en` and `id` in `src/lib/strings.js`.
- Money is whole Rupiah, shown as `Rp 1.234.567` (`rp()` in `src/lib/format.js`).
- Job `100001`, invoice `INV-000001`, stock PO `900001`, job PO `100042-101` (`jobNo`, `invoiceNo`, `stockPoNo`).
- Every PO delivery lands on the shelf; invoicing a job takes its approved parts off. PO money sums use `lineAmount()` in `src/lib/inventory.js`, the same as `po_line_amount()` in the database.

## Going live (summary)

1. New Supabase Pro project (Singapore). Turn on pg_cron, then run migrations 100–129 in order. Deploy `invite-user`, `delete-user` and `login` (`--no-verify-jwt` for `login`). Authentication: sign-ups off, Site URL and Redirect URLs for the shop's own domain, custom SMTP with the company mail server.
2. Netlify (live site): set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the production project, add the domain, then merge this branch into `main`. The release check refuses the build until the variables point at the new project.
3. First Owner: invite yourself, choose a password, set the profile to Owner (one SQL update), then invite the team.
4. Settings → Import data: suppliers, companies, vehicles, catalog, service schedules, opening stock.
