import React, { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Badge, Button, Empty, Notice, PageHead, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { initials, invoiceNo, jobNo, num, rp } from '../../lib/format'
import { shopToday, vehicleName } from '../../lib/customers'
import { PRIORITIES, PRIORITY_COLOR, WORKFLOW_COLOR, WORKFLOW_MANUAL } from '../../lib/jobs'
import { APPT_COLOR, addDays, clock, dayLabel, daysBetween, shopParts } from '../../lib/calendar'
import { MoreMenu } from '../jobs/common'
import { useStaff } from '../jobs/useJobData'
import AppointmentModal from '../calendar/AppointmentModal'
import { useBoardData } from './useBoardData'

// Board columns, left to right. Invoiced and Paid are set by invoicing and payments, so cards can't be dropped there.
export const COLUMNS = ['estimate', 'scheduled', 'arrived', 'in_progress', 'waiting_parts', 'completed', 'invoiced', 'paid']

function SearchBox({ value, onChange, placeholder }) {
  const { t } = useT()
  return (
    <div className="searchbox">
      <Icon name="search" size={14} color="var(--muted)" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button className="btn ghost sm" onClick={() => onChange('')} aria-label={t('common.clear')} style={{ padding: 2 }}><Icon name="x" size={13} /></button>}
    </div>
  )
}

// Work board: every job still in the shop, as cards in workflow columns (Kanban) or as a table (List).
export default function BoardPage() {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const { can } = useAuth()
  const { timezone } = useShop()
  const staff = useStaff()
  const { data, error, reload } = useBoardData()
  const view = new URLSearchParams(location.search).get('view') === 'list' ? 'list' : 'kanban'
  const [q, setQ] = useState('')
  const [tech, setTech] = useState('')
  const [advisor, setAdvisor] = useState('')
  const [priority, setPriority] = useState('')
  const [moved, setMoved] = useState({}) // optimistic column changes while saving
  const [booking, setBooking] = useState(null)
  const canEdit = can('edit_jobs')
  const today = shopToday(timezone)

  const needle = q.trim().toLowerCase()
  const jobs = useMemo(() => {
    if (!data) return []
    return data.jobs.map((j) => (moved[j.id] ? { ...j, workflow_status: moved[j.id] } : j)).filter((j) => {
      if (tech === 'none' ? j.techs.length > 0 : tech && !j.techs.includes(tech)) return false
      if (advisor && j.service_advisor_id !== advisor) return false
      if (priority && j.priority !== priority) return false
      if (!needle) return true
      const c = data.customer[j.customer_id]
      const v = data.vehicle[j.vehicle_id]
      const hay = [jobNo(j.job_number), j.invoice_number && invoiceNo(j.invoice_number), c?.display_name, v?.plate, v?.plate?.replace(/\s/g, ''), v && vehicleName(v), data.contact[j.customer_id]?.name]
      return hay.filter(Boolean).join(' ').toLowerCase().includes(needle)
    })
  }, [data, moved, tech, advisor, priority, needle])

  async function move(job, status) {
    if (job.workflow_status === status) return
    setMoved((m) => ({ ...m, [job.id]: status }))
    const { error: err } = await supabase.from('repair_orders').update({ workflow_status: status }).eq('id', job.id)
    if (err) toast(errorText(err, t), 'err')
    else toast(t('board.moved', { no: jobNo(job.job_number), status: t(`job.wf.${status}`) }))
    await reload()
    setMoved((m) => { const x = { ...m }; delete x[job.id]; return x })
  }
  async function pickedUp(job) {
    const { error: err } = await supabase.from('repair_orders').update({ archived_at: new Date().toISOString() }).eq('id', job.id)
    if (err) toast(errorText(err, t), 'err')
    else toast(t('board.pickedUp', { no: jobNo(job.job_number) }))
    reload()
  }

  const setView = (v) => navigate(v === 'list' ? '/board?view=list' : '/board', { replace: true })
  const techs = staff.filter((s) => s.roles?.name === 'Technician' || (data?.jobs || []).some((j) => j.techs.includes(s.id)))
  const filtered = Boolean(needle || tech || advisor || priority)

  return (
    <main className="content board-page">
      <PageHead title={t('nav.board')} sub={t('board.sub')}
        actions={<>
          <Link className="btn" to="/calendar"><Icon name="calendar" size={15} />{t('nav.calendar')}</Link>
          {canEdit && <Button variant="primary" icon="plus" onClick={() => navigate('/jobs/new')}>{t('create.job')}</Button>}
        </>} />
      <div className="filterbar">
        <div className="seg" role="tablist" aria-label={t('board.view')}>
          <button type="button" role="tab" aria-selected={view === 'kanban'} className={`seg-btn ${view === 'kanban' ? 'on' : ''}`} onClick={() => setView('kanban')}><Icon name="layout-kanban" size={14} /> {t('board.kanban')}</button>
          <button type="button" role="tab" aria-selected={view === 'list'} className={`seg-btn ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}><Icon name="list" size={14} /> {t('board.list')}</button>
        </div>
        <SearchBox value={q} onChange={setQ} placeholder={t('board.search')} />
        <select className="select chipselect" value={tech} onChange={(e) => setTech(e.target.value)} aria-label={t('board.technician')}>
          <option value="">{t('board.allTechs')}</option>
          <option value="none">{t('board.noTech')}</option>
          {techs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="select chipselect" value={advisor} onChange={(e) => setAdvisor(e.target.value)} aria-label={t('job.advisor')}>
          <option value="">{t('board.allAdvisors')}</option>
          {staff.filter((s) => s.roles?.name !== 'Technician').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="select chipselect" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label={t('job.priority')}>
          <option value="">{t('board.allPriorities')}</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{t(`job.pri.${p}`)}</option>)}
        </select>
        {filtered && <button type="button" className="linkbtn small" onClick={() => { setQ(''); setTech(''); setAdvisor(''); setPriority('') }}>{t('board.clearFilters')}</button>}
      </div>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{errorText(error, t)}</Notice>}
      {!data ? <div className="muted">{t('common.loading')}</div> : data.jobs.length === 0 ? (
        <div className="card"><Empty icon="layout-kanban" title={t('board.empty')}
          action={canEdit && <Button variant="primary" icon="plus" onClick={() => navigate('/jobs/new')}>{t('create.job')}</Button>}>{t('board.emptyText')}</Empty></div>
      ) : view === 'kanban' ? (
        <Kanban jobs={jobs} data={data} staff={staff} today={today} canEdit={canEdit} onMove={move} onPickedUp={pickedUp} onBook={setBooking} filtered={filtered} />
      ) : (
        <BoardList jobs={jobs} data={data} today={today} />
      )}
      <AppointmentModal open={!!booking} onClose={() => setBooking(null)} defaults={booking ? { ro_id: booking.id, customer_id: booking.customer_id, vehicle_id: booking.vehicle_id } : null}
        onSaved={() => { setBooking(null); reload() }} />
    </main>
  )
}

const canDrag = (j, canEdit) => canEdit && j.order_status === 'estimate'

function Kanban({ jobs, data, staff, today, canEdit, onMove, onPickedUp, onBook, filtered }) {
  const { t } = useT()
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(null)
  const byCol = Object.fromEntries(COLUMNS.map((c) => [c, []]))
  for (const j of jobs) (byCol[j.workflow_status] || byCol.estimate).push(j)
  const droppable = (col) => dragging && WORKFLOW_MANUAL.includes(col) && col !== dragging.workflow_status
  return (
    <div className="board" role="list" aria-label={t('nav.board')}>
      {COLUMNS.map((col) => {
        const list = byCol[col]
        const sum = list.reduce((a, j) => a + Number(j.total || 0), 0)
        return (
          <section key={col} role="listitem" aria-label={t(`job.wf.${col}`)}
            className={`bcol ${droppable(col) ? 'can-drop' : ''} ${over === col && droppable(col) ? 'over' : ''}`}
            onDragOver={(e) => { if (droppable(col)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(col) } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver((o) => (o === col ? null : o)) }}
            onDrop={(e) => { e.preventDefault(); const j = dragging; setOver(null); setDragging(null); if (j && droppable(col)) onMove(j, col) }}>
            <header className="bcol-head">
              <span className={`dot d-${WORKFLOW_COLOR[col]}`} />
              <h2>{t(`job.wf.${col}`)}</h2>
              <span className="bcol-count">{list.length}</span>
              <div className="spacer" />
              {list.length > 0 && <span className="muted small">{rp(sum)}</span>}
            </header>
            <div className="bcol-body">
              {list.length === 0 && <div className="bcol-empty">{filtered ? t('board.noneMatch') : t('board.noneHere')}</div>}
              {list.map((j) => (
                <JobCard key={j.id} job={j} data={data} staff={staff} today={today} canEdit={canEdit}
                  draggable={canDrag(j, canEdit)} dragging={dragging?.id === j.id}
                  onDragStart={() => setDragging(j)} onDragEnd={() => { setDragging(null); setOver(null) }}
                  onMove={onMove} onPickedUp={onPickedUp} onBook={onBook} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// "Today 09.00", "Tomorrow 14.30", "Thu 8 Oct 09.00": when the booking is, on the shop clock.
export function apptWhen(a, today, tz, lang, t) {
  const p = shopParts(a.start_time, tz)
  const time = clock(p.minutes, lang)
  if (p.date === today) return t('board.todayAt', { time })
  if (p.date === addDays(today, 1)) return t('board.tomorrowAt', { time })
  return `${dayLabel(p.date, lang)} ${time}`
}

function JobCard({ job, data, staff, today, canEdit, draggable, dragging, onDragStart, onDragEnd, onMove, onPickedUp, onBook }) {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { timezone } = useShop()
  const c = data.customer[job.customer_id]
  const v = data.vehicle[job.vehicle_id]
  const contact = data.contact[job.customer_id]
  const phone = contact?.phone || c?.phone
  const age = Math.max(0, daysBetween(shopParts(job.created_at, timezone).date, today))
  const estimate = job.order_status === 'estimate'
  const open = () => navigate(`/jobs/${job.id}`)
  const menu = [
    { label: t('board.openJob'), icon: 'wrench', onClick: open },
    ...(estimate && canEdit ? WORKFLOW_MANUAL.filter((w) => w !== job.workflow_status).map((w) => ({ label: t('board.moveTo', { status: t(`job.wf.${w}`) }), onClick: () => onMove(job, w) })) : []),
    estimate && canEdit && { label: t('board.book'), icon: 'calendar', onClick: () => onBook(job) },
    !estimate && canEdit && { label: t('job.markPickedUp'), icon: 'car', onClick: () => onPickedUp(job) },
    { label: estimate ? t('board.printEstimate') : t('board.printInvoice'), icon: 'print', onClick: () => navigate(`/print/jobs/${job.id}?doc=${estimate ? 'estimate' : 'invoice'}`) },
  ]
  const appt = job.appt
  const apptPast = appt && shopParts(appt.start_time, timezone).date < today
  return (
    <article className={`bcard ${dragging ? 'dragging' : ''} ${draggable ? 'grab' : ''} pri-${job.priority}`} draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', job.id); onDragStart() }} onDragEnd={onDragEnd}
      aria-label={t('board.cardLabel', { no: jobNo(job.job_number), company: c?.display_name || '', plate: v?.plate || '' })}>
      <div className="bcard-top">
        {appt ? (
          <span className={`chip c-${APPT_COLOR[appt.status]} ${apptPast ? 'past' : ''}`} title={t(`appt.st.${appt.status}`)}>
            <Icon name="calendar" size={12} />{apptWhen(appt, today, timezone, lang, t)}
          </span>
        ) : estimate && canEdit ? (
          <button type="button" className="chip ghost" onClick={() => onBook(job)}><Icon name="calendar" size={12} />{t('board.book')}</button>
        ) : <span />}
        <div className="spacer" />
        <span className="chip plain" title={t('board.ageTitle')}>{t('board.days', { n: age })}</span>
        <MoreMenu label={t('board.cardMenu', { no: jobNo(job.job_number) })} items={menu} />
      </div>
      <button type="button" className="bcard-main" onClick={open}>
        <div className="row" style={{ gap: 6 }}>
          <span className={`dot d-${WORKFLOW_COLOR[job.workflow_status]}`} />
          <b>#{jobNo(job.job_number)}</b>
          {job.invoice_number && <span className="muted small">{invoiceNo(job.invoice_number)}</span>}
          {(job.priority === 'high' || job.priority === 'urgent') && <Badge color={PRIORITY_COLOR[job.priority]}>{t(`job.pri.${job.priority}`)}</Badge>}
        </div>
        <div className="bcard-company">{c?.display_name || '—'}</div>
        <div className="bcard-vehicle"><b>{v?.plate}</b> <span className="muted">{v ? vehicleName(v) : ''}</span></div>
        {phone && <div className="muted small"><Icon name="phone" size={11} /> {phone}{contact?.name ? ` · ${contact.name}` : ''}</div>}
      </button>
      <div className="bcard-people">
        {job.pending > 0 ? <span className="chip c-amber" title={t('board.pendingTitle')}>{t('board.pending', { n: job.pending })}</span>
          : job.approved > 0 ? <span className="chip c-green"><Icon name="check" size={12} />{t('board.approved')}</span> : null}
        <div className="spacer" />
        {job.techs.length === 0 ? <span className="muted small">{t('board.noTechShort')}</span> : job.techs.slice(0, 4).map((id) => {
          const name = staff.find((s) => s.id === id)?.name || '?'
          return <span key={id} className="avatar tiny" title={name} aria-label={name}>{initials(name)}</span>
        })}
      </div>
      <div className="bcard-foot">
        <span title={t('board.servicesTitle')}><Icon name="wrench" size={12} /> {job.done}/{job.services}</span>
        <span title={t('board.inspTitle')}><Icon name="clipboard" size={12} /> {job.inspections}</span>
        <span title={t('board.hoursTitle')}><Icon name="clock" size={12} /> {num(job.hours, 2)} {t('board.h')}</span>
        <div className="spacer" />
        <b>{rp(job.total)}</b>
      </div>
    </article>
  )
}

const SORTS = {
  job: (a, b) => (b.job_number || 0) - (a.job_number || 0),
  appt: (a, b) => (a.appt ? new Date(a.appt.start_time).getTime() : Infinity) - (b.appt ? new Date(b.appt.start_time).getTime() : Infinity),
  total: (a, b) => Number(b.total) - Number(a.total),
  status: (a, b) => COLUMNS.indexOf(a.workflow_status) - COLUMNS.indexOf(b.workflow_status),
}

function BoardList({ jobs, data, today }) {
  const { t, lang } = useT()
  const navigate = useNavigate()
  const { timezone } = useShop()
  const [sort, setSort] = useState('status')
  const rows = [...jobs].sort((a, b) => SORTS[sort](a, b) || SORTS.job(a, b))
  const th = (key, label, cls = '') => (
    <th className={cls} aria-sort={sort === key ? 'descending' : 'none'}>
      <button type="button" className={`thsort ${sort === key ? 'on' : ''}`} onClick={() => setSort(key)}>{label}{sort === key && ' ▾'}</button>
    </th>
  )
  if (!rows.length) return <div className="card"><Empty icon="search" title={t('cust.noMatch')}>{t('cust.noMatchText')}</Empty></div>
  return (
    <>
      <div className="table">
        <table>
          <thead>
            <tr>
              {th('job', t('jobs.col.job'))}<th>{t('board.col.invoice')}</th><th>{t('job.company')}</th><th>{t('job.vehicle')}</th>
              {th('status', t('job.workflow'))}<th>{t('job.priority')}</th><th>{t('board.col.approval')}</th>
              {th('appt', t('board.col.appt'))}<th className="num">{t('board.col.hours')}</th>{th('total', t('job.total'), 'num')}
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => {
              const v = data.vehicle[j.vehicle_id]
              return (
                <tr key={j.id} className="click" onClick={() => navigate(`/jobs/${j.id}`)}>
                  <td><Link className="rowlink" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>#{jobNo(j.job_number)}</Link></td>
                  <td className="muted nowrap">{j.invoice_number ? invoiceNo(j.invoice_number) : '—'}</td>
                  <td>{data.customer[j.customer_id]?.display_name || '—'}</td>
                  <td><b>{v?.plate}</b> <span className="muted small">{v ? vehicleName(v) : ''}</span></td>
                  <td><Badge color={WORKFLOW_COLOR[j.workflow_status]}>{t(`job.wf.${j.workflow_status}`)}</Badge></td>
                  <td><Badge color={PRIORITY_COLOR[j.priority]}>{t(`job.pri.${j.priority}`)}</Badge></td>
                  <td>{j.pending > 0 ? <Badge color="amber">{t('board.pending', { n: j.pending })}</Badge> : j.approved > 0 ? <Badge color="green">{t('board.approved')}</Badge> : <span className="muted">—</span>}</td>
                  <td>{j.appt ? <span className="nowrap"><span className={`dot d-${APPT_COLOR[j.appt.status]}`} /> {apptWhen(j.appt, today, timezone, lang, t)}</span> : <span className="muted">—</span>}</td>
                  <td className="num">{num(j.hours, 2)}</td>
                  <td className="num">{rp(j.total)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">{t('board.listTotal', { n: rows.length, amount: rp(rows.reduce((a, j) => a + Number(j.total || 0), 0)) })}</div>
    </>
  )
}
