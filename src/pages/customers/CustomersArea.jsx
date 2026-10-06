import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../../components/Layout'
import { Badge, Button, Empty, Notice, PageHead, SubTabs } from '../../components/ui'
import Icon from '../../components/Icon'
import CustomerPanel from './CustomerPanel'
import CustomerForm from './CustomerForm'
import VehiclePanel from './VehiclePanel'
import VehicleForm from './VehicleForm'
import JobLists from '../jobs/JobLists'
import { useCustomerData } from './useCustomerData'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { jobNo, km, rp } from '../../lib/format'
import { CUSTOMER_TYPES, TYPE_COLOR, VEHICLE_STATUS_COLOR, normalizePlate, npwpDigits, vehicleName } from '../../lib/customers'

const TABS = ['customers', 'vehicles', 'repair-orders', 'invoices', 'payments', 'deferred']
// /customers, /customers/<id>, /customers/vehicles, /customers/vehicles/<id>, /customers/<other tab>
function parsePath(pathname) {
  const parts = pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
  if (parts.length === 0) return { tab: 'customers', id: null }
  if (!TABS.includes(parts[0])) return { tab: 'customers', id: parts[0] }
  return { tab: parts[0], id: parts[1] || null }
}

function SearchInput({ value, onChange, placeholder }) {
  const { t } = useT()
  return (
    <div className="searchbox">
      <Icon name="search" size={14} color="var(--muted)" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button className="btn ghost sm" onClick={() => onChange('')} aria-label={t('common.clear')} style={{ padding: 2 }}><Icon name="x" size={13} /></button>}
    </div>
  )
}

export default function CustomersArea() {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { can } = useAuth()
  const { timezone } = useShop()
  const canEdit = can('edit_customers')
  const { tab, id } = parsePath(location.pathname)
  const wantsNew = new URLSearchParams(location.search).get('new') === '1'
  const { data, error, reload } = useCustomerData(timezone)

  const [custForm, setCustForm] = useState(undefined) // undefined closed · null new · object edit
  const [vehForm, setVehForm] = useState(undefined) // undefined closed · { vehicle?, customerId? }

  // "+ New customer" / "+ New vehicle" from the top bar arrive as ?new=1.
  useEffect(() => {
    if (!wantsNew || !canEdit || !data) return
    if (tab === 'customers') setCustForm(null)
    if (tab === 'vehicles') setVehForm({})
    navigate(location.pathname, { replace: true })
  }, [wantsNew, canEdit, data, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = (path) => navigate(path)

  const tabs = (
    <SubTabs
      tabs={TABS.map((x) => ({ value: x, label: t(`cust.area.${x}`) }))}
      active={tab}
      onChange={(x) => go(x === 'customers' ? '/customers' : `/customers/${x}`)}
    />
  )

  if (!['customers', 'vehicles'].includes(tab)) {
    return (
      <Page tabs={tabs}>
        <JobLists tab={tab} />
      </Page>
    )
  }

  return (
    <Page tabs={tabs}>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!data ? <div className="muted">{t('common.loading')}</div> : tab === 'customers' ? (
        <CustomersTab data={data} id={id} canEdit={canEdit} reload={reload} go={go}
          onNew={() => setCustForm(null)} onEdit={(c) => setCustForm(c)} onAddVehicle={(customerId) => setVehForm({ customerId })} />
      ) : (
        <VehiclesTab data={data} id={id} canEdit={canEdit} reload={reload} go={go}
          onNew={() => setVehForm({})} onEdit={(v) => setVehForm({ vehicle: v })} />
      )}

      {data && (
        <>
          <CustomerForm open={custForm !== undefined} customer={custForm} customers={data.customers}
            onClose={() => setCustForm(undefined)}
            onSaved={async (c) => { const isNew = !custForm; setCustForm(undefined); await reload(); if (isNew) go(`/customers/${c.id}`) }} />
          <VehicleForm open={vehForm !== undefined} vehicle={vehForm?.vehicle} defaultCustomerId={vehForm?.customerId}
            customers={data.customers} vehicles={data.vehicles}
            onClose={() => setVehForm(undefined)}
            onSaved={async (v) => { const isNew = !vehForm?.vehicle; setVehForm(undefined); await reload(); if (isNew && tab === 'vehicles') go(`/customers/vehicles/${v.id}`) }} />
        </>
      )}
    </Page>
  )
}

function CustomersTab({ data, id, canEdit, reload, go, onNew, onEdit, onAddVehicle }) {
  const { t, lang } = useT()
  const [q, setQ] = useState('')
  const [type, setType] = useState('all')
  const [showInactive, setShowInactive] = useState(false)
  const monthName = new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { month: 'short' }).format(new Date())

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const digits = npwpDigits(q)
    return data.customers.filter((c) => {
      if (!showInactive && !c.active && c.id !== id) return false
      if (type !== 'all' && c.type !== type) return false
      if (!needle) return true
      const s = data.stats[c.id]
      const hay = [c.display_name, c.legal_name, c.email, c.phone, ...(s?.contacts ?? []).flatMap((x) => [x.name, x.email, x.phone])]
        .filter(Boolean).join(' ').toLowerCase()
      // With 4+ digits, also compare phone numbers and NPWP by their digits only ("081234…" finds "0812-34…").
      const phones = [c.phone, ...(s?.contacts ?? []).map((x) => x.phone)].map(npwpDigits)
      return hay.includes(needle) || (digits.length >= 4 && (npwpDigits(c.npwp).includes(digits) || phones.some((ph) => ph.includes(digits))))
    })
  }, [data, q, type, showInactive, id])

  const selected = id ? data.customerById[id] : null
  const inactiveCount = data.customers.filter((c) => !c.active).length

  return (
    <div className={`split ${selected ? 'has-panel' : ''}`}>
      <div className="split-main">
        <div className="pagehead">
          <div>
            <h1>{t('nav.customers')}</h1>
            <div className="sub">{t('cust.sub')}</div>
          </div>
          <div className="spacer" />
          {canEdit && <Button variant="primary" icon="plus" onClick={onNew}>{t('cust.add')}</Button>}
        </div>
        <div className="filterbar">
          <SearchInput value={q} onChange={setQ} placeholder={t('cust.search')} />
          <select className="select chipselect" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('cust.type')}>
            <option value="all">{t('cust.typeAll')}</option>
            {CUSTOMER_TYPES.map((x) => <option key={x} value={x}>{t(`cust.type.${x}`)}</option>)}
          </select>
          {inactiveCount > 0 && (
            <label className="toggle small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /><span className="track" /><span>{t('cust.showInactive', { n: inactiveCount })}</span></label>
          )}
        </div>

        {data.customers.length === 0 ? (
          <div className="card"><Empty icon="users" title={t('cust.emptyTitle')} action={canEdit && <Button variant="primary" icon="plus" onClick={onNew}>{t('cust.add')}</Button>}>{t('cust.emptyText')}</Empty></div>
        ) : rows.length === 0 ? (
          <div className="card"><Empty icon="search" title={t('cust.noMatch')}>{t('cust.noMatchText')}</Empty></div>
        ) : (
          <div className="table">
            <table>
              <thead>
                <tr>
                  <th>{t('cust.company')}</th><th>{t('cust.type')}</th><th className="num">{t('cust.vehicles')}</th>
                  <th className="num wide-only">{t('cust.notInvoiced')}</th><th className="num wide-only">{t('cust.salesShort', { month: monthName })}</th>
                  <th className="num">{t('cust.outstanding')}</th><th className="wide-only">{t('cust.termsShort')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const s = data.stats[c.id] || {}
                  const terms = c.payment_terms_days
                  return (
                    <tr key={c.id} className={`click ${c.id === id ? 'selected' : ''}`} onClick={() => go(`/customers/${c.id}`)}>
                      <td>
                        <a className="rowlink" href={`/customers/${c.id}`} onClick={(e) => e.preventDefault()}>{c.display_name}</a>
                        {!c.active && <> <Badge color="red">{t('cust.inactive')}</Badge></>}
                        {c.legal_name && c.legal_name !== c.display_name && <div className="muted small">{c.legal_name}</div>}
                      </td>
                      <td><Badge color={TYPE_COLOR[c.type]}>{t(`cust.type.${c.type}`)}</Badge></td>
                      <td className="num">{s.vehicles ?? 0}</td>
                      <td className="num wide-only">{s.notInvoiced ?? 0}</td>
                      <td className="num wide-only">{rp(s.sales)}</td>
                      <td className="num" style={{ fontWeight: 700, color: s.overdue > 0 ? 'var(--red)' : undefined }}>{rp(s.balance)}</td>
                      <td className="muted wide-only">{terms == null ? t('cust.default') : terms === 0 ? t('cust.dueOnReceipt') : t('cust.netDays', { days: terms })}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint">{t('cust.listHint')}</div>
      </div>

      {id && !selected && (
        <div className="split-side"><div className="card"><Empty icon="info" title={t('cust.notFound')} action={<Button onClick={() => go('/customers')}>{t('common.back')}</Button>} /></div></div>
      )}
      {selected && (
        <div className="split-side">
          <CustomerPanel
            key={selected.id}
            customer={selected}
            stats={data.stats[selected.id]}
            vehicles={data.vehicles.filter((v) => v.customer_id === selected.id)}
            canEdit={canEdit}
            onEdit={() => onEdit(selected)}
            onReload={reload}
            onClose={() => go('/customers')}
            onAddVehicle={() => onAddVehicle(selected.id)}
            onOpenVehicle={(vid) => go(`/customers/vehicles/${vid}`)}
            onDeleted={() => { reload(); go('/customers') }}
          />
        </div>
      )}
    </div>
  )
}

const PAGE = 200

function VehiclesTab({ data, id, canEdit, reload, go, onNew, onEdit }) {
  const { t } = useT()
  const [q, setQ] = useState('')
  const [company, setCompany] = useState('all')
  const [status, setStatus] = useState('current')
  const [limit, setLimit] = useState(PAGE)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const plateNeedle = normalizePlate(q)
    return data.vehicles.filter((v) => {
      if (company !== 'all' && v.customer_id !== company) return false
      if (status === 'current' && (v.status === 'sold' || v.status === 'inactive') && v.id !== id) return false
      if (status !== 'current' && status !== 'all' && v.status !== status) return false
      if (!needle) return true
      if (plateNeedle && normalizePlate(v.plate).includes(plateNeedle)) return true
      return [v.vin, v.make, v.model, vehicleName(v)].filter(Boolean).join(' ').toLowerCase().includes(needle)
    })
  }, [data, q, company, status, id])

  useEffect(() => setLimit(PAGE), [q, company, status])

  const selected = id ? data.vehicles.find((v) => v.id === id) : null
  const companyName = (cid) => data.customerById[cid]?.display_name || '—'

  return (
    <div className={`split ${selected ? 'has-panel' : ''}`}>
      <div className="split-main">
        <div className="pagehead">
          <div>
            <h1>{t('cust.area.vehicles')}</h1>
            <div className="sub">{company === 'all' ? t('veh.subAll', { shown: rows.length, total: data.vehicles.length }) : t('veh.subCompany', { company: companyName(company), shown: rows.length })}</div>
          </div>
          <div className="spacer" />
          {canEdit && data.customers.length > 0 && <Button variant="primary" icon="plus" onClick={onNew}>{t('cust.addVehicle')}</Button>}
        </div>
        <div className="filterbar">
          <SearchInput value={q} onChange={setQ} placeholder={t('veh.search')} />
          <select className="select chipselect" value={company} onChange={(e) => setCompany(e.target.value)} aria-label={t('veh.company')}>
            <option value="all">{t('veh.companyAll')}</option>
            {data.customers.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
          </select>
          <select className="select chipselect" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('veh.status')}>
            <option value="current">{t('veh.statusCurrent')}</option>
            <option value="in_shop">{t('veh.st.in_shop')}</option>
            <option value="inactive">{t('veh.st.inactive')}</option>
            <option value="sold">{t('veh.st.sold')}</option>
            <option value="all">{t('veh.statusAll')}</option>
          </select>
        </div>

        {data.customers.length === 0 ? (
          <div className="card"><Empty icon="car" title={t('veh.needCompanyTitle')} action={<Button onClick={() => go('/customers')}>{t('veh.goCustomers')}</Button>}>{t('veh.needCompanyText')}</Empty></div>
        ) : data.vehicles.length === 0 ? (
          <div className="card"><Empty icon="car" title={t('veh.emptyTitle')} action={canEdit && <Button variant="primary" icon="plus" onClick={onNew}>{t('cust.addVehicle')}</Button>}>{t('veh.emptyText')}</Empty></div>
        ) : rows.length === 0 ? (
          <div className="card"><Empty icon="search" title={t('cust.noMatch')}>{t('cust.noMatchText')}</Empty></div>
        ) : (
          <>
            <div className="table">
              <table>
                <thead>
                  <tr><th>{t('veh.plate')}</th><th>{t('veh.vehicle')}</th><th>{t('veh.company')}</th><th className="num wide-only">{t('veh.odometer')}</th><th>{t('veh.status')}</th></tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((v) => {
                    const job = data.openJobByVehicle[v.id]
                    return (
                      <tr key={v.id} className={`click ${v.id === id ? 'selected' : ''}`} onClick={() => go(`/customers/vehicles/${v.id}`)}>
                        <td><b style={{ whiteSpace: 'nowrap' }}>{v.plate}</b></td>
                        <td>{vehicleName(v) || <span className="muted">—</span>}</td>
                        <td>{companyName(v.customer_id)}</td>
                        <td className="num wide-only">{km(v.mileage_km)}</td>
                        <td>
                          <div className="row wrap" style={{ gap: 4 }}>
                            <Badge color={VEHICLE_STATUS_COLOR[v.status]}>{t(`veh.st.${v.status}`)}</Badge>
                            {job && <Badge color="amber">{t('veh.estimateJob', { job: jobNo(job.job_number) })}</Badge>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > limit && (
              <div className="center" style={{ marginTop: 10 }}>
                <Button onClick={() => setLimit((l) => l + PAGE)}>{t('veh.showMore', { n: Math.min(PAGE, rows.length - limit) })}</Button>
              </div>
            )}
          </>
        )}
      </div>

      {id && !selected && (
        <div className="split-side"><div className="card"><Empty icon="info" title={t('veh.notFound')} action={<Button onClick={() => go('/customers/vehicles')}>{t('common.back')}</Button>} /></div></div>
      )}
      {selected && (
        <div className="split-side">
          <VehiclePanel
            key={selected.id}
            vehicle={selected}
            customers={data.customers}
            openJob={data.openJobByVehicle[selected.id]}
            canEdit={canEdit}
            onEdit={() => onEdit(selected)}
            onClose={() => go('/customers/vehicles')}
            onChanged={reload}
            onOpenCustomer={(cid) => go(`/customers/${cid}`)}
            onDeleted={() => { reload(); go('/customers/vehicles') }}
          />
        </div>
      )}
    </div>
  )
}
