# Axle v2

Workshop and fleet-maintenance app (AutoLeap-style), rebuilt on a new database.
React 18 + Vite + React Router, Supabase (Postgres, auth, storage, edge functions), Netlify.

**This branch talks to the STAGING Supabase project "Axle v2 staging"** (`wuwabhwvnzhlcctxwpda`).
The live app on `main` and its database are not touched. `netlify.toml` pins the staging
address for every Netlify context of this branch, so a preview can never reach live data.
**Do not merge this branch into `main`** until the planned cut-over.

## Build stages

1. **Foundations** ✓: sign-in by username, invite / reset password, app layout, EN/ID, notifications bell, Settings (shop profile and logo, appearance / colour theme, language and printing, numbering, fees and tax, labor rates, users and access)
2. **Customers & vehicles** ✓
3. **Catalog** ✓: labor, parts, fees, discounts, flat rate items, service bundles, inspections, checklists, categories, suppliers
4. **Jobs, estimates, invoices & payments** ✓: job page, approvals, invoicing and voiding, payments and credits, inspections, activity, job lists
5. **Printed invoices & estimates** ✓: A4 estimate and invoice in Indonesian or English (`/print/jobs/<id>`)
6. **Work board & calendar** ✓: Kanban / list board by workflow (`/board`), calendar by day (per technician) / week / month with appointments (`/calendar`), bookings on the job page, deferred work carried into new estimates or dismissed
7. **Inventory & purchase orders** ✓ (update 8: returns per PO, received quantities can be corrected): Inventory → Stock (on hand / on estimates / available / on order, order low parts), Purchase orders (stock and job POs, receive with supplier invoice, cancel, print `/print/po/<id>`), Returns to suppliers, Cores, Supplier bills (pay delivered parts, undo); "Order parts" and On order / Arrived badges on the job page
8. **Service schedules** ✓ (built before stage 7): schedules per vehicle by km and/or months, Customers → Service due, due work on open estimates, bundles that start their own schedule on completion, service-due and overdue-invoice reminders in the bell, next service on the invoice
9. **Dashboard & reports** ✓: 9a dashboard (today's work, money, needs attention, 6-month chart) and Reports → Sales, Receivables aging, Payments received; 9b (this delivery) Profit, Technicians, Fleet spend, Inventory, Service compliance. Every report has CSV download

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
- `supabase/migrations` — database migrations 100–127 (100–126 applied to staging; 127 adds the stage 9b reports `report_profit`, `report_technicians`, `report_fleet`, `report_inventory`, `report_service_status`, `report_service_done`, the one-call wrapper `report_rows`, and `service_schedule_log`, which records whether scheduled services were done on time)
- `supabase/functions/invite-user` — invites a person (deployed to staging); `supabase/functions/delete-user` removes a login
- `deploy/self-host` — kit for running Axle on your own Linux server (self-hosted Supabase + the app + HTTPS, backups, moving data from supabase.co). Start with `deploy/self-host/README.md`. Netlify ignores this folder.

## Rules the screens rely on

- The database does the money maths, numbering and permission checks. Screens only ask.
- Use plain `insert` / `update`, not `upsert`, on tables with column-level grants.
- Text shown to people goes through `t('key')`; add both `en` and `id` in `src/lib/strings.js`.
- Money is whole Rupiah, shown as `Rp 1.234.567` (`rp()` in `src/lib/format.js`).
- Job `100001`, invoice `INV-000001`, stock PO `900001`, job PO `100042-101` (`jobNo`, `invoiceNo`, `stockPoNo`).
- Every PO delivery lands on the shelf; invoicing a job takes its approved parts off. PO money sums use `lineAmount()` in `src/lib/inventory.js`, the same as `po_line_amount()` in the database.
