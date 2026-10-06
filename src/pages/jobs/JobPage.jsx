import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Page } from '../../components/Layout'
import { Badge, Button, Card, Empty, Modal, Notice, SubTabs, usePopover } from '../../components/ui'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { invoiceNo, jobNo, km, num } from '../../lib/format'
import { vehicleName } from '../../lib/customers'
import { PRIORITY_COLOR, WORKFLOW_COLOR } from '../../lib/jobs'
import { useCatalogData } from '../catalog/useCatalogData'
import { useJobData, useStaff } from './useJobData'
import { BlurInput, MoreMenu, useRun } from './common'
import ServicesTab from './ServicesTab'
import JobInspections from './JobInspections'
import JobActivity from './JobActivity'
import { AppointmentsCard, ApprovalsCard, ProfitCard, StatusCard, TotalsCard } from './JobSide'
import { DeferredBanner } from './Deferred'
import AppointmentModal from '../calendar/AppointmentModal'
import { ApprovalModal, CreditModal, DiscountModal, FeeModal, InvoiceModal, PaymentModal, ReasonModal } from './JobModals'

const TABS = ['services', 'concerns', 'inspections', 'activity']

export default function JobPage({ id }) {
  const { t } = useT()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { settings } = useShop()
  const { job, error, missing, reload } = useJobData(id)
  const { data: cat, reload: reloadCat } = useCatalogData()
  const staff = useStaff()
  const { run, busy } = useRun(reload)
  // Invoicing and voiding move stock, so the catalog (stock badges) is reloaded after those.
  const runStock = async (fn, okText) => { const ok = await run(fn, okText); reloadCat(); return ok }
  const [tab, setTab] = useState('services')
  const [modal, setModal] = useState(null) // { kind, ...}

  if (missing) return <Page><Card><Empty icon="info" title={t('job.notFound')} action={<Link className="btn" to="/customers/repair-orders">{t('job.backToList')}</Link>} /></Card></Page>
  if (!job || !cat) return <Page><div className="muted">{error ? errorText(error, t) : t('common.loading')}</div></Page>

  const ro = job.ro
  const canEdit = can('edit_jobs')
  const invoiced = ro.order_status === 'invoice'
  const closed = !!ro.closed_at
  const editable = canEdit && !invoiced && !closed
  const workEditable = canEdit && !closed
  const showCost = can('view_costs')
  const canPay = can('record_payments')
  const canVoid = can('void_invoices')
  const canIssue = can('issue_credits')
  const open = (kind, extra = {}) => setModal({ kind, ...extra })
  const close = () => setModal(null)
  const v = job.vehicle
  const c = job.customer
  const primary = job.contacts.find((x) => x.is_primary) || job.contacts[0]

  const menu = [
    editable && { label: t('job.closeNoInvoice'), icon: 'lock', onClick: () => open('close') },
    closed && canEdit && { label: t('job.reopen'), icon: 'edit', onClick: () => run(() => supabase.rpc('reopen_job', { p_ro: ro.id }), t('job.reopened')) },
    // Jobs with money or invoice history are kept (the database refuses to delete them).
    !invoiced && can('delete_jobs') && !job.payments.length && !job.voids.length && !job.appliedCredits.length
      && { label: t('job.deleteEstimate'), icon: 'trash', danger: true, onClick: () => open('delete') },
  ]

  const tabs = <SubTabs tabs={TABS.map((x) => ({ value: x, label: t(`job.tab.${x}`) + (x === 'concerns' && job.concerns.length ? ` (${job.concerns.length})` : '') }))} active={tab} onChange={setTab} />

  return (
    <Page>
      <div className="jobgrid">
        <div className="jobmain">
          <section className="card jobhead">
            <div className="row wrap" style={{ gap: 10, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                <h1 className="jobtitle">
                  {t('job.jobNo', { no: jobNo(ro.job_number) })} <span className="muted">({invoiced ? invoiceNo(ro.invoice_number) : closed ? t('job.closed') : t('job.estimate')})</span>
                  {' — '}<Link to={`/customers/${c?.id}`} className="plainlink">{c?.display_name}</Link>
                </h1>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  <Badge color={PRIORITY_COLOR[ro.priority]}>{t(`job.pri.${ro.priority}`)}</Badge>
                  <Badge color={WORKFLOW_COLOR[ro.workflow_status]}>{t(`job.wf.${ro.workflow_status}`)}</Badge>
                  {closed && <Badge color="gray">{t('job.closed')}</Badge>}
                  {ro.archived_at && invoiced && <Badge color="gray">{t('job.pickedUpBadge')}</Badge>}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <PrintButton invoiced={invoiced} onPrint={(doc) => navigate(`/print/jobs/${ro.id}?doc=${doc}`)} />
                {editable && job.services.length > 0 && <Button onClick={() => open('approval')}>{t('job.recordApproval')}</Button>}
                <MoreMenu label={t('job.more')} items={menu} />
              </div>
            </div>
            {closed && <Notice kind="warn" style={{ marginTop: 12 }}>{t('job.closedNotice', { reason: ro.close_reason || '' })}</Notice>}
            {invoiced && <Notice kind="info" style={{ marginTop: 12 }}>{t('job.invoicedNotice')}</Notice>}
            <div className="jobhead-grid">
              <div className="jobhead-who">
                <div className="muted small">{t('job.customer')}</div>
                <div><b>{c?.display_name}</b>{primary && <span className="muted"> · {t('job.attn', { name: primary.name })}</span>}</div>
                <div className="muted small" style={{ marginTop: 8 }}>{t('job.vehicle')}</div>
                <div><Link to={`/customers/vehicles/${v?.id}`} className="plainlink"><b>{v?.plate}</b></Link> · {vehicleName(v) || '—'}{v?.mileage_km != null && <span className="muted"> · {km(v.mileage_km)}</span>}</div>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <label className="mini">{t('job.odoIn')}
                    <BlurInput className="input cell num" style={{ width: 110 }} disabled={!editable} value={ro.odometer_in != null ? num(ro.odometer_in) : ''} placeholder="km" aria-label={t('job.odometerIn')}
                      onCommit={(val, reset) => { const n = String(val).trim() ? Number(String(val).replace(/[.\s]/g, '')) : null; if (n !== null && (!Number.isInteger(n) || n < 0 || n > 9999999)) { reset(); return } run(() => supabase.from('repair_orders').update({ odometer_in: n }).eq('id', ro.id)) }} />
                  </label>
                  <label className="mini">{t('job.odoOut')}
                    <BlurInput className="input cell num" style={{ width: 110 }} disabled={!editable} value={ro.odometer_out != null ? num(ro.odometer_out) : ''} placeholder="km" aria-label={t('job.odometerOut')}
                      onCommit={(val, reset) => { const n = String(val).trim() ? Number(String(val).replace(/[.\s]/g, '')) : null; if (n !== null && (!Number.isInteger(n) || n < 0 || n > 9999999)) { reset(); return } run(() => supabase.from('repair_orders').update({ odometer_out: n }).eq('id', ro.id)) }} />
                  </label>
                </div>
              </div>
              <div className="notebox">
                <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.customerConcern')}</div>
                {job.concerns.length === 0 ? <div className="muted small">{t('job.noConcerns')}</div> : (
                  <ul className="concernlist">{job.concerns.map((x) => <li key={x.id}>{x.text}</li>)}</ul>
                )}
                {editable && <button type="button" className="linkbtn small" onClick={() => setTab('concerns')}>{job.concerns.length ? t('job.editConcerns') : t('job.addConcern')}</button>}
              </div>
              <div className="notebox">
                <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.shopNotes')}</div>
                <BlurInput multiline rows={3} className="textarea bare" disabled={!canEdit} value={ro.shop_notes || ''} placeholder={t('job.shopNotesHint')} aria-label={t('job.shopNotes')}
                  onCommit={(val) => run(() => supabase.from('repair_orders').update({ shop_notes: val.trim() || null }).eq('id', ro.id))} />
              </div>
            </div>
          </section>

          <DeferredBanner job={job} editable={editable} onCarried={reload} />

          <div className="card tabcard">{tabs}</div>

          {tab === 'services' && (
            <ServicesTab job={job} cat={cat} staff={staff} editable={editable} workEditable={workEditable} showCost={showCost}
              run={run} busy={busy} openApproval={(ids) => open('approval', { preselect: ids })} />
          )}
          {tab === 'concerns' && <ConcernsTab job={job} editable={editable} run={run} busy={busy} />}
          {tab === 'inspections' && <JobInspections job={job} cat={cat} staff={staff} editable={editable} run={run} busy={busy} />}
          {tab === 'activity' && <JobActivity job={job} cat={cat} staff={staff} showCost={showCost} />}

          {(editable || invoiced) && (
            <section className="card" style={{ marginTop: 16 }}>
              <div className="sectionlabel" style={{ marginTop: 0 }}>{t('job.recommendations')}</div>
              <BlurInput multiline rows={2} disabled={!editable} value={ro.recommendations || ''} placeholder={t('job.recommendationsHint')} aria-label={t('job.recommendations')}
                onCommit={(val) => run(() => supabase.from('repair_orders').update({ recommendations: val.trim() || null }).eq('id', ro.id))} />
            </section>
          )}
        </div>

        <aside className="jobside">
          <ApprovalsCard job={job} editable={editable} onRecord={() => open('approval')} />
          <AppointmentsCard job={job} staff={staff} canBook={editable} onOpen={(a) => open('appt', { appointment: a })} onNew={() => open('appt', {})} />
          <StatusCard job={job} staff={staff} settings={settings} canEdit={canEdit} editable={editable} canVoid={canVoid && invoiced}
            run={run} onInvoice={() => open('invoice')} onVoid={() => open('void')} />
          <TotalsCard job={job} settings={settings} editable={editable} canPay={canPay} canRefund={canVoid} canCredit={canPay || canIssue}
            run={run} onPayment={() => open('payment')} onCredit={() => open('credit')} onFee={() => open('fee')} onDiscount={() => open('discount')} />
          {showCost && <ProfitCard job={job} />}
        </aside>
      </div>

      <AppointmentModal open={modal?.kind === 'appt'} onClose={close} appointment={modal?.appointment}
        defaults={{ ro_id: ro.id, customer_id: ro.customer_id, vehicle_id: ro.vehicle_id }}
        onSaved={() => { close(); reload() }} onDeleted={() => { close(); reload() }} />
      <ApprovalModal open={modal?.kind === 'approval'} onClose={close} job={job} preselect={modal?.preselect} run={run} busy={busy} />
      <InvoiceModal open={modal?.kind === 'invoice'} onClose={close} job={job} settings={settings} run={runStock} busy={busy} />
      <PaymentModal open={modal?.kind === 'payment'} onClose={close} job={job} canRefund={!invoiced || canVoid} run={run} busy={busy} />
      <CreditModal open={modal?.kind === 'credit'} onClose={close} job={job} canApply={canPay} canIssue={canIssue} canUnapplyInvoiced={canVoid} run={run} busy={busy} />
      <FeeModal open={modal?.kind === 'fee'} onClose={close} job={job} cat={cat} run={run} busy={busy} />
      <DiscountModal open={modal?.kind === 'discount'} onClose={close} job={job} cat={cat} run={run} busy={busy} />
      <ReasonModal open={modal?.kind === 'close'} onClose={close} title={t('job.closeNoInvoice')} text={t('job.closeText')} label={t('job.reason')}
        confirm={t('job.closeYes')} busy={busy} onConfirm={(reason) => run(() => supabase.rpc('close_job', { p_ro: ro.id, p_reason: reason }), t('job.closedToast')).then((ok) => ok && close())} />
      <ReasonModal open={modal?.kind === 'void'} onClose={close} title={t('job.voidInvoice')} text={t('job.voidText', { no: invoiceNo(ro.invoice_number) })} label={t('job.reason')}
        confirm={t('job.voidYes')} danger busy={busy} onConfirm={(reason) => runStock(() => supabase.rpc('void_invoice', { p_ro: ro.id, p_reason: reason }), t('job.voidedToast')).then((ok) => ok && close())} />
      <Modal open={modal?.kind === 'delete'} title={t('job.deleteEstimate')} onClose={close}
        footer={<><Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="danger" className="solid" loading={busy} onClick={async () => {
            const { error: err } = await supabase.from('repair_orders').delete().eq('id', ro.id)
            if (err) { close(); return run(async () => ({ error: err })) }
            navigate('/customers/repair-orders', { replace: true })
          }}>{t('job.deleteYes')}</Button></>}>
        {t('job.deleteText', { no: jobNo(ro.job_number) })}
      </Modal>
    </Page>
  )
}

function ConcernsTab({ job, editable, run, busy }) {
  const { t } = useT()
  const [text, setText] = useState('')
  const concerns = job.concerns
  const add = async () => {
    if (!text.trim()) return
    const pos = concerns.reduce((m, c) => Math.max(m, c.position), -1) + 1
    if (await run(() => supabase.from('ro_concerns').insert({ ro_id: job.ro.id, text: text.trim(), position: pos }))) setText('')
  }
  const swap = (i, d) => {
    const a = concerns[i]; const b = concerns[i + d]
    if (!b) return
    run(() => Promise.all([
      supabase.from('ro_concerns').update({ position: i + d }).eq('id', a.id),
      supabase.from('ro_concerns').update({ position: i }).eq('id', b.id),
    ]))
  }
  return (
    <section className="card">
      <h2>{t('job.concerns')}</h2>
      <div className="hint" style={{ marginTop: -6, marginBottom: 12 }}>{t('job.concernsHint')}</div>
      {concerns.length === 0 && <div className="muted small" style={{ marginBottom: 10 }}>{t('job.noConcerns')}</div>}
      <div className="lines">
        {concerns.map((c, i) => (
          <div key={c.id} className="line">
            <span className="line-no">{i + 1}</span>
            {editable ? (
              <BlurInput className="input line-grow" value={c.text} aria-label={t('job.concernN', { n: i + 1 })}
                onCommit={(v, reset) => (v.trim() ? run(() => supabase.from('ro_concerns').update({ text: v.trim() }).eq('id', c.id)) : reset())} />
            ) : <span className="line-grow">{c.text}</span>}
            {editable && (
              <span className="rowbtns">
                <button type="button" className="btn ghost sm" disabled={i === 0} onClick={() => swap(i, -1)} aria-label={t('cat.moveUp', { name: i + 1 })}><Icon name="chevronUp" size={14} /></button>
                <button type="button" className="btn ghost sm" disabled={i === concerns.length - 1} onClick={() => swap(i, 1)} aria-label={t('cat.moveDown', { name: i + 1 })}><Icon name="chevronDown" size={14} /></button>
                <button type="button" className="btn ghost sm" onClick={() => run(() => supabase.from('ro_concerns').delete().eq('id', c.id))} aria-label={t('cat.removeRow', { name: i + 1 })}><Icon name="x" size={14} /></button>
              </span>
            )}
          </div>
        ))}
      </div>
      {editable && (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('job.concernExample')} aria-label={t('job.addConcern')}
            onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Button onClick={add} loading={busy}>{t('job.add')}</Button>
        </div>
      )}
    </section>
  )
}

// Print: an estimate any time; once invoiced, the invoice (or the estimate again).
function PrintButton({ invoiced, onPrint }) {
  const { t } = useT()
  const pop = usePopover()
  if (!invoiced) return <Button icon="print" onClick={() => onPrint('estimate')}>{t('job.print')}</Button>
  return (
    <div style={{ position: 'relative' }} ref={pop.ref}>
      <Button icon="print" onClick={pop.toggle} aria-expanded={pop.open}>{t('job.print')}</Button>
      {pop.open && (
        <div className="popover" style={{ minWidth: 180 }}>
          <button type="button" className="menuitem" onClick={() => onPrint('invoice')}>{t('pr.invoiceUi')}</button>
          <button type="button" className="menuitem" onClick={() => onPrint('estimate')}>{t('pr.estimateUi')}</button>
        </div>
      )}
    </div>
  )
}
