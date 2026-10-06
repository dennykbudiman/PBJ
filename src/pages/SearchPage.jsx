import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Badge, Empty, Notice, PageHead } from '../components/ui'
import Icon from '../components/Icon'
import { supabase, errorText } from '../lib/supabase'
import { useT } from '../lib/i18n'
import { km } from '../lib/format'
import { TYPE_COLOR, normalizePlate, normalizeVin, npwpDigits, vehicleName } from '../lib/customers'

const MAX = 25

// Global search: companies (by name, NPWP or a contact's name, phone or email) and
// vehicles (by plate, VIN, make or model). Repair orders join in stage 4.
export default function SearchPage() {
  const { t } = useT()
  const navigate = useNavigate()
  const q = new URLSearchParams(useLocation().search).get('q') || ''
  const [typed, setTyped] = useState(q)
  useEffect(() => setTyped(q), [q])
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('customers').select('id, display_name, legal_name, npwp, phone, email, type, active').order('display_name'),
      supabase.from('customer_contacts').select('customer_id, name, phone, email'),
      supabase.from('vehicles').select('id, plate, year, make, model, vin, customer_id, mileage_km, status').order('plate'),
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
            <div className="row" style={{ padding: '14px 14px 8px' }}><Icon name="wrench" size={16} /><b>{t('cust.area.repair-orders')}</b></div>
            <div className="muted small" style={{ padding: '6px 14px 16px' }}>{t('soon.text', { stage: 4, name: t('stage.jobs') })}</div>
          </div>
        </div>
      )}
    </Page>
  )
}
