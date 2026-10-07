import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Badge, Empty, Notice, PageHead } from '../components/ui'
import Icon from '../components/Icon'
import { supabase, errorText } from '../lib/supabase'
import { useT } from '../lib/i18n'
import { fmtDate, invoiceNo, jobNo, km, rp } from '../lib/format'
import { useShop } from '../context/ShopContext'
import { selectAll } from './customers/useCustomerData'
import { STATE_COLOR, jobState } from '../lib/jobs'
import { shopToday } from '../lib/customers'
import { TYPE_COLOR, normalizePlate, normalizeVin, npwpDigits, vehicleName } from '../lib/customers'

const MAX = 25

// Global search: companies (by name, NPWP or a contact's name, phone or email) and
// vehicles (by plate, VIN, make or model) and jobs (by job or invoice number, or the vehicles found).
export default function SearchPage() {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const q = new URLSearchParams(useLocation().search).get('q') || ''
  const [typed, setTyped] = useState(q)
  useEffect(() => setTyped(q), [q])
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [jobs, setJobs] = useState(null)
  const { timezone } = useShop()

  useEffect(() => {
    let cancelled = false
    Promise.all([
      // Every row, past the server's 1,000-row page (a big fleet has more vehicles than that).
      selectAll(() => supabase.from('customers').select('id, display_name, legal_name, npwp, phone, email, type, active').order('display_name').order('id')),
      selectAll(() => supabase.from('customer_contacts').select('id, customer_id, name, phone, email').order('id')),
      selectAll(() => supabase.from('vehicles').select('id, plate, year, make, model, vin, customer_id, mileage_km, status').order('plate').order('id')),
    ]).then(([c, ct, v]) => {
      if (cancelled) return
      setError(c.error || ct.error || v.error || null)
      setData({ customers: c.data ?? [], contacts: ct.data ?? [], vehicles: v.data ?? [] })
    })
    return () => { cancelled = true }
  }, [])

  const results = useMemo(() => {
    if (!data || !q.trim()) return null
    const needle = q.trim().toLowerCase()
    const plate = normalizePlate(q)
    const digits = npwpDigits(q)
    const byId = Object.fromEntries(data.customers.map((c) => [c.id, c]))
    const viaContact = {}
    const phoneHit = (ph) => digits.length >= 4 && npwpDigits(ph).includes(digits)
    for (const ct of data.contacts) {
      if ([ct.name, ct.phone, ct.email].filter(Boolean).join(' ').toLowerCase().includes(needle) || phoneHit(ct.phone)) viaContact[ct.customer_id] = ct.name
    }
    const direct = (c) => [c.display_name, c.legal_name, c.phone, c.email].filter(Boolean).join(' ').toLowerCase().includes(needle)
      || (digits.length >= 4 && npwpDigits(c.npwp).includes(digits)) || phoneHit(c.phone)
    const customers = data.customers.filter((c) => direct(c) || viaContact[c.id])
    // Only say "Contact: …" when the company matched through a contact, not by its own name.
    for (const c of customers) if (direct(c)) delete viaContact[c.id]
    const vehicles = data.vehicles.filter((v) =>
      (plate.length >= 2 && normalizePlate(v.plate).includes(plate))
      || (plate.length >= 4 && normalizeVin(v.vin).includes(plate))
      || [v.make, v.model, vehicleName(v)].filter(Boolean).join(' ').toLowerCase().includes(needle))
    return { customers, vehicles, byId, viaContact }
  }, [data, q])

  // Jobs: by job / invoice number, plus the latest jobs of the vehicles found.
  useEffect(() => {
    setJobs(null)
    if (!results) return
    let live = true
    const digits = q.replace(/\D/g, '')
    const vehIds = results.vehicles.slice(0, 5).map((v) => v.id)
    const cols = 'id, job_number, invoice_number, customer_id, vehicle_id, order_status, payment_status, balance, due_date, total, closed_at, workflow_status, created_at'
    Promise.all([
      digits.length >= 3 ? supabase.from('repair_orders').select(cols).or(`job_no.ilike.*${digits}*,invoice_no.ilike.*${digits}*`).limit(MAX) : { data: [] },
      vehIds.length ? supabase.from('repair_orders').select(cols).in('vehicle_id', vehIds).order('created_at', { ascending: false }).limit(10) : { data: [] },
    ]).then(([a, b]) => {
      if (!live) return
      const byNo = (a.data || []).filter((j) => jobNo(j.job_number).includes(digits) || (j.invoice_number && String(invoiceNo(j.invoice_number)).includes(digits)))
      const seen = new Set()
      setJobs([...byNo, ...(b.data || [])].filter((j) => (seen.has(j.id) ? false : seen.add(j.id))))
    })
    return () => { live = false }
  }, [results]) // eslint-disable-line react-hooks/exhaustive-deps

  // A full job or invoice number opens that job straight away.
  useEffect(() => {
    if (!jobs || !results) return
    const digits = q.replace(/\D/g, '')
    const exact = jobs.filter((j) => jobNo(j.job_number) === digits || (j.invoice_number && invoiceNo(j.invoice_number).replace(/\D/g, '') === digits))
    if (digits.length >= 6 && exact.length === 1 && results.customers.length === 0 && results.vehicles.length === 0) navigate(`/jobs/${exact[0].id}`, { replace: true })
  }, [jobs]) // eslint-disable-line react-hooks/exhaustive-deps

  // A single exact plate match opens that vehicle straight away.
  useEffect(() => {
    if (!results) return
    const exact = results.vehicles.filter((v) => normalizePlate(v.plate) === normalizePlate(q))
    if (exact.length === 1 && results.customers.length === 0) navigate(`/customers/vehicles/${exact[0].id}`, { replace: true })
  }, [results]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Page>
      <PageHead title={t('search.title')} sub={q ? t('search.for', { q }) : null} />
      <form className="filterbar" role="search" onSubmit={(e) => { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(typed.trim())}`, { replace: true }) }}>
        <div className="searchbox" style={{ width: 420 }}>
          <Icon name="search" size={14} color="var(--muted)" />
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('nav.search')} aria-label={t('nav.search')} autoFocus={!q} />
        </div>
        <button type="submit" className="btn primary">{t('search.go')}</button>
      </form>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!q.trim() ? (
        <div className="card"><Empty icon="search" title={t('search.typeTitle')}>{t('search.typeText')}</Empty></div>
      ) : !results ? <div className="muted">{t('common.loading')}</div> : (
        <div className="searchcols">
          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ padding: '14px 14px 8px' }}><Icon name="users" size={16} /><b>{t('nav.customers')}</b><span className="muted small">{results.customers.length}</span></div>
            {results.customers.length === 0 && <div className="muted small" style={{ padding: '6px 14px 16px' }}>{t('search.none')}</div>}
            {results.customers.slice(0, MAX).map((c) => (
              <Link key={c.id} className="resultrow" to={`/customers/${c.id}`}>
                <div className="row" style={{ gap: 6 }}><b>{c.display_name}</b><Badge color={TYPE_COLOR[c.type]}>{t(`cust.type.${c.type}`)}</Badge>{!c.active && <Badge color="red">{t('cust.inactive')}</Badge>}</div>
                <div className="muted small">{results.viaContact[c.id] ? t('search.contact', { name: results.viaContact[c.id] }) : (c.legal_name || c.npwp || c.phone || '')}</div>
              </Link>
            ))}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ padding: '14px 14px 8px' }}><Icon name="car" size={16} /><b>{t('cust.area.vehicles')}</b><span className="muted small">{results.vehicles.length}</span></div>
            {results.vehicles.length === 0 && <div className="muted small" style={{ padding: '6px 14px 16px' }}>{t('search.none')}</div>}
            {results.vehicles.slice(0, MAX).map((v) => (
              <Link key={v.id} className="resultrow" to={`/customers/vehicles/${v.id}`}>
                <div><b>{v.plate}</b> <span className="muted">· {vehicleName(v)}</span></div>
                <div className="muted small">{results.byId[v.customer_id]?.display_name} · {km(v.mileage_km)}</div>
              </Link>
            ))}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ padding: '14px 14px 8px' }}><Icon name="wrench" size={16} /><b>{t('search.jobs')}</b><span className="muted small">{jobs ? jobs.length : ''}</span></div>
            {!jobs ? <div className="muted small" style={{ padding: '6px 14px 16px' }}>{t('common.loading')}</div>
              : jobs.length === 0 ? <div className="muted small" style={{ padding: '6px 14px 16px' }}>{t('search.none')}</div>
                : jobs.slice(0, MAX).map((j) => {
                  const st = jobState(j, shopToday(timezone))
                  const v = data.vehicles.find((x) => x.id === j.vehicle_id)
                  return (
                    <Link key={j.id} className="resultrow" to={`/jobs/${j.id}`}>
                      <div className="row" style={{ gap: 6 }}><b>{j.invoice_number ? invoiceNo(j.invoice_number) : `#${jobNo(j.job_number)}`}</b><Badge color={STATE_COLOR[st]}>{t(`job.state.${st}`)}</Badge></div>
                      <div className="muted small">{[results.byId[j.customer_id]?.display_name, v?.plate, rp(j.total), fmtDate(j.created_at, lang, timezone)].filter(Boolean).join(' · ')}</div>
                    </Link>
                  )
                })}
          </div>
        </div>
      )}
    </Page>
  )
}
