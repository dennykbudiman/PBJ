// The lookups Claude may make. Each one calls a fixed, read-only database function (migration 140, tc_*):
// STABLE (the database refuses writes inside them), SECURITY INVOKER (run as the person asking, through the same
// views and row rules as the app), and called over GET, which PostgREST runs in a read-only transaction.
// There is no write tool and no free SQL.

// deno-lint-ignore no-explicit-any
type Json = any

export type ToolDef = {
  name: string
  fn: string
  description: string
  input_schema: Json
  staffOnly?: boolean
  // turns the model's input into the database function's arguments
  args: (input: Json) => Record<string, unknown>
  // short label for "Dari data:" under the answer
  label: (input: Json, result: Json) => string
}

const ref = (what: string) => ({
  type: 'object',
  properties: { ref: { type: 'string', description: what } },
  required: ['ref'],
})
const s = (v: unknown, max = 120) => String(v ?? '').trim().slice(0, max)

export const TOOLS: ToolDef[] = [
  {
    name: 'search', fn: 'tc_search',
    description: 'Search jobs, vehicles, companies, catalog parts, purchase orders and suppliers by any word: a plate (any spacing), job or invoice number, PO number, part name or part number, company or driver name. Use it first when you only have a fragment.',
    input_schema: { type: 'object', properties: { q: { type: 'string', description: 'What to look for, at least 2 characters' } }, required: ['q'] },
    args: (i) => ({ p_q: s(i.q) }),
    label: (i) => `cari "${s(i.q, 40)}"`,
  },
  {
    name: 'get_job', fn: 'tc_job',
    description: 'One job (work order / estimate / invoice) with everything on its page: statuses, km, driver, complaints, services with technician and work status, part and labour lines (with PO status), approvals, purchase orders, bookings, money and payments (when this login may see money), and what the job is waiting for.',
    input_schema: ref('Job number like #100005 or 100005, invoice number like INV-100005-1 or INV-000021, or the job id'),
    args: (i) => ({ p_ref: s(i.ref, 60) }),
    label: (_i, r) => r?.job_number ? `pekerjaan #${r.job_number}` : 'pekerjaan',
  },
  {
    name: 'get_vehicle', fn: 'tc_vehicle',
    description: 'One vehicle by plate (any spacing, e.g. "DA 8123 TAQ" or "8123") or id: details, owner company, driver, its last 15 jobs with services and parts, and service schedules due (km/days left).',
    input_schema: ref('Plate or vehicle id'),
    args: (i) => ({ p_ref: s(i.ref, 60) }),
    label: (_i, r) => r?.plate ? `kendaraan ${r.plate}` : 'kendaraan',
  },
  {
    name: 'get_part', fn: 'tc_part', staffOnly: true,
    description: 'One catalog item (usually a part) by name, part number or id: price (and cost when allowed), unit, supplier, stock on the shelf, how much is already on open jobs, how much is free for new work, what is on order, use in the last 7 days and the last 15 stock movements (the stock card). Returns several_match when the name is ambiguous.',
    input_schema: ref('Part name, part number or id'),
    args: (i) => ({ p_ref: s(i.ref, 80) }),
    label: (_i, r) => r?.name ? `part ${r.name}` : 'part',
  },
  {
    name: 'low_stock', fn: 'tc_stock_low', staffOnly: true,
    description: 'Parts whose free stock is at or below their reorder point (candidates to order).',
    input_schema: { type: 'object', properties: {} },
    args: () => ({}),
    label: () => 'stok menipis',
  },
  {
    name: 'get_po', fn: 'tc_po', staffOnly: true,
    description: 'One purchase order by number (e.g. 100005-101 or 900004) or id: supplier, status, payment, its job, and each line with ordered / received / cancelled / returned / paid quantities and the shelf count the PO page shows next to the line ("di rak").',
    input_schema: ref('PO number or id'),
    args: (i) => ({ p_ref: s(i.ref, 40) }),
    label: (_i, r) => r?.po_number ? `PO ${r.po_number}` : 'PO',
  },
  {
    name: 'open_jobs', fn: 'tc_open_jobs',
    description: 'All open jobs (the Work board): first a summary over every open job (count, per status, per "waiting for" reason, unfinished work per mechanic), then the jobs oldest first (at most 120) with status, plate, company and what each is waiting for.',
    input_schema: { type: 'object', properties: {} },
    args: () => ({}),
    label: () => 'papan kerja',
  },
  {
    name: 'day_summary', fn: 'tc_day', staffOnly: true,
    description: 'One day at the shop (the "Hari ini" page): jobs opened, vehicles that came in and left, invoices made, money received, parts used and received, supplier bills due. Defaults to today.',
    input_schema: { type: 'object', properties: { day: { type: 'string', description: 'YYYY-MM-DD, default today' } } },
    args: (i) => (i?.day && /^\d{4}-\d\d-\d\d$/.test(i.day) ? { p_day: i.day } : {}),
    label: (i) => (i?.day ? `hari ${i.day}` : 'hari ini'),
  },
  {
    name: 'get_company', fn: 'tc_company',
    description: 'One customer company by name or id: details, contacts, vehicles, open jobs, what it owes and unpaid invoices (when this login may see money).',
    input_schema: ref('Company name (part of it is fine) or id'),
    args: (i) => ({ p_ref: s(i.ref, 80) }),
    label: (_i, r) => r?.name ? `perusahaan ${r.name}` : 'perusahaan',
  },
  {
    name: 'company_balances', fn: 'tc_balances',
    description: 'What each company owes (and overdue, open invoices, credit held), largest first, with the totals across all companies. Use for "total piutang" or "who owes the most".',
    input_schema: { type: 'object', properties: {} },
    args: () => ({}),
    label: () => 'piutang per perusahaan',
  },
  {
    name: 'list_invoices', fn: 'tc_invoices',
    description: 'Invoices: "unpaid" (balance left), "overdue" (unpaid and past the due date) or "recent" (latest 60).',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['unpaid', 'overdue', 'recent'] } }, required: ['kind'] },
    args: (i) => ({ p_kind: ['unpaid', 'overdue', 'recent'].includes(i?.kind) ? i.kind : 'unpaid' }),
    label: (i) => `invoice ${s(i?.kind, 10) || 'unpaid'}`,
  },
  {
    name: 'bookings', fn: 'tc_bookings',
    description: 'Bookings on the calendar (Janji servis) between two dates (at most 31 days), with plate, company, technician and linked job. Defaults to the next 7 days.',
    input_schema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } } },
    args: (i) => {
      const a: Record<string, string> = {}
      if (i?.from && /^\d{4}-\d\d-\d\d$/.test(i.from)) a.p_from = i.from
      if (i?.to && /^\d{4}-\d\d-\d\d$/.test(i.to)) a.p_to = i.to
      return a
    },
    label: () => 'kalender',
  },
]

// Only for Haiku in "auto": hands the question to Sonnet.
export const ESCALATE_TOOL = {
  name: 'ask_senior',
  description: 'Hand this question to a more careful model instead of answering yourself. Use it when the question needs analysis across many records or a period of time, when numbers in the data do not add up or seem to contradict each other, when it is about money, stock or accounting reasoning beyond reading one value, or whenever you are not confident your answer is correct. Do not use it for simple how-to questions or a single lookup.',
  input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'One short sentence: why' } }, required: ['reason'] },
}

export function toolsFor(fleet: boolean) {
  return TOOLS.filter((t) => !fleet || !t.staffOnly)
}

// The app links under the answer: the record a lookup was about.
export function linkFrom(tool: ToolDef, result: Json, fleet: boolean): { kind: string; id: string; label: string } | null {
  if (!result || typeof result !== 'object' || result.error || result.several_match || !result.id) return null
  switch (tool.name) {
    case 'get_job': return { kind: 'job', id: result.id, label: `#${result.job_number}` }
    case 'get_po': return fleet ? null : { kind: 'po', id: result.id, label: `PO ${result.po_number}` }
    case 'get_part': return fleet || result.type !== 'part' ? null : { kind: 'part', id: result.id, label: String(result.name).slice(0, 40) }
    case 'get_company': return { kind: 'company', id: result.id, label: String(result.name).slice(0, 40) }
    case 'get_vehicle': return { kind: 'vehicle', id: result.id, label: result.plate }
    default: return null
  }
}
