import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../../components/Layout'
import { Button, Card, Empty, Notice, SubTabs } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { shopToday } from '../../lib/customers'
import { PERIODS, periodRange } from '../../lib/reports'
import { num } from '../../lib/format'
import SalesReport from './SalesReport'
import AgingReport from './AgingReport'
import PaymentsReport from './PaymentsReport'
import ProfitReport from './ProfitReport'
import TechniciansReport from './TechniciansReport'
import FleetReport from './FleetReport'
import InventoryReport from './InventoryReport'
import ServiceReport from './ServiceReport'

export const REPORT_TABS = ['sales', 'aging', 'payments', 'profit', 'technicians', 'fleet', 'inventory', 'service']
// Reports that show cost prices also need the view_costs permission.
const NEEDS_COSTS = ['profit', 'inventory']

// /reports → Sales, /reports/<tab>
export default function ReportsArea() {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { can } = useAuth()
  const part = location.pathname.split('/').filter(Boolean)[1]
  const tab = REPORT_TABS.includes(part) ? part : 'sales'
  const tabs = <SubTabs tabs={REPORT_TABS.map((x) => ({ value: x, label: t(`rep.tab.${x}`) }))} active={tab} onChange={(x) => navigate(`/reports/${x}`)} />
  if (!can('view_reports')) {
    return <Page><Card><Empty icon="chart-bar" title={t('rep.noAccessTitle')}>{t('rep.noAccessText')}</Empty></Card></Page>
  }
  return (
    <Page tabs={tabs}>
      {tab === 'sales' && <SalesReport />}
      {tab === 'aging' && <AgingReport />}
      {tab === 'payments' && <PaymentsReport />}
      {NEEDS_COSTS.includes(tab) && !can('view_costs') ? (
        <Card><Empty icon="lock" title={t('rep.costsTitle')}>{t('rep.costsText')}</Empty></Card>
      ) : (
        <>
          {tab === 'profit' && <ProfitReport />}
          {tab === 'technicians' && <TechniciansReport />}
          {tab === 'fleet' && <FleetReport />}
          {tab === 'inventory' && <InventoryReport />}
          {tab === 'service' && <ServiceReport />}
        </>
      )}
    </Page>
  )
}

// A report's period: a preset or two dates, on the shop's calendar.
export function usePeriod(initial = 'this_month') {
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [preset, setPreset] = useState(initial)
  const [custom, setCustom] = useState(() => periodRange(initial, today))
  const range = periodRange(preset, today, custom)
  // A year still being typed (0002…) isn't sent to the database.
  const valid = [range.from, range.to].every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && x >= '2000-01-01' && x <= '2100-12-31')
  return { preset, setPreset, custom, setCustom, today, valid, ...range }
}

// The API hands back at most 1.000 rows per request (Supabase's "Max rows"), so every report is fetched through
// report_rows, which returns the whole report as one JSON list in a single call.
export async function fetchAllRows(fn, args) {
  const { data, error } = await supabase.rpc('report_rows', { p_report: fn, ...args })
  return { data: error ? null : data || [], error }
}

// Calls a report function again whenever its arguments change; a slower earlier answer never overwrites a newer one.
export function useReport(fn, args, deps, enabled = true) {
  const [state, setState] = useState({ rows: null, error: null })
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled) return
    const n = ++seq.current
    setState((s) => ({ rows: s.rows, error: null, loading: true }))
    fetchAllRows(fn, args).then(({ data, error }) => {
      if (n !== seq.current) return
      setState({ rows: error ? null : data || [], error, loading: false })
    })
  }, [...deps, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

// A company picked for one period stays picked only while it appears in the rows.
export function useCompany(rows) {
  const [company, setCompany] = useState('')
  useEffect(() => {
    if (company && rows && !rows.some((r) => r.customer_id === company)) setCompany('')
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  return [company, setCompany]
}

// The filter row above a report: period, company and the report's own controls, then CSV.
export function ReportBar({ period, companies, company, setCompany, children, onCsv, csvDisabled, noPeriod }) {
  const { t } = useT()
  return (
    <>
      <div className="filterbar repbar">
        {!noPeriod && (
          <>
            <select className="select chipselect" value={period.preset} aria-label={t('rep.period')}
              onChange={(e) => { const p = e.target.value; if (p === 'custom') period.setCustom({ from: period.from, to: period.to }); period.setPreset(p) }}>
              {PERIODS.map((p) => <option key={p} value={p}>{t(`rep.p.${p}`)}</option>)}
            </select>
            {period.preset === 'custom' && (
              <span className="row" style={{ gap: 6 }}>
                <input type="date" className="input datein" value={period.custom.from} max={period.today} aria-label={t('rep.from')}
                  onChange={(e) => e.target.value && period.setCustom({ ...period.custom, from: e.target.value })} />
                <span className="muted">–</span>
                <input type="date" className="input datein" value={period.custom.to} min={period.custom.from} aria-label={t('rep.to')}
                  onChange={(e) => e.target.value && period.setCustom({ ...period.custom, to: e.target.value })} />
              </span>
            )}
          </>
        )}
        {companies && (
          <select className="select chipselect" value={company} onChange={(e) => setCompany(e.target.value)} aria-label={t('rep.company')}>
            <option value="">{t('rep.allCompanies')}</option>
            {companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        {children}
        <div className="spacer" />
        <Button icon="upload" onClick={onCsv} disabled={csvDisabled}>{t('rep.csv')}</Button>
      </div>
    </>
  )
}

// Companies that appear in the report rows, by name, for the company filter.
export function companiesOf(rows) {
  const m = new Map()
  for (const r of rows || []) if (r.customer_id && !m.has(r.customer_id)) m.set(r.customer_id, r.company || '—')
  return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
}

export function ReportError({ error }) {
  const { t } = useT()
  if (!error) return null
  return <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>
}

// A share as a whole percentage ("—" when there's nothing to divide by).
export function pct(part, whole, digits = 0) {
  if (!whole) return '—'
  return `${num((part / whole) * 100, digits)}%`
}

// Rows can open to show more; remembers which are open.
export function useOpenRows() {
  const [open, setOpen] = useState(() => new Set())
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return [open, toggle]
}

// One KPI tile.
export function Kpi({ label, value, note, tone }) {
  return (
    <div className="kpi card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={tone === 'red' ? { color: 'var(--red)' } : undefined}>{value}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  )
}
