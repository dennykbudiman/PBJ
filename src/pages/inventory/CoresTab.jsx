import React, { useMemo, useState } from 'react'
import { Badge, Button, Empty, PageHead } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { fmtDate, num, rp } from '../../lib/format'
import { CORE_COLOR, CORE_STEPS, RETRIEVAL_COLOR, lineAmount } from '../../lib/inventory'
import { MoreMenu, useRun } from '../jobs/common'
import { SearchBox } from '../catalog/common'
import { JobRef } from './bits'
import { StepModal } from './ReturnsTab'

const coreValue = (c) => lineAmount(0, c.core_cost, c.qty, false, 0)
const isOpen = (c) => c.return_status !== 'refunded' && c.return_status !== 'damaged' && c.retrieval_status !== 'damaged'

// Inventory → Cores: old parts (batteries, alternators…) taken off customers' vehicles and sent back for the core refund.
// Invoicing a part with a core adds it here.
export default function CoresTab({ data, reload, canEdit, showCost }) {
  const { t, lang } = useT()
  const { run } = useRun(reload)
  const [q, setQ] = useState('')
  const [show, setShow] = useState('open')
  const [step, setStep] = useState(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s/g, '')
    return data.cores.filter((c) => {
      if (show === 'open' && !isOpen(c)) return false
      if (show === 'retrieve' && c.retrieval_status !== 'to_be_retrieved') return false
      if (show === 'return' && !(c.retrieval_status === 'retrieved' && c.return_status === 'to_be_returned')) return false
      if (show === 'away' && !['marked', 'shipped', 'delivered'].includes(c.return_status)) return false
      if (!needle) return true
      const j = c.ro_id && data.jobById[c.ro_id]
      const v = j && data.vehicleById[j.vehicle_id]
      return [c.item_name, data.supplierById[c.supplier_id]?.name, j?.job_number, v?.plate, c.credit_number].filter(Boolean).join(' ').toLowerCase().replace(/\s/g, '').includes(needle)
    })
  }, [data, q, show])

  const counts = useMemo(() => ({
    retrieve: data.cores.filter((c) => c.retrieval_status === 'to_be_retrieved').length,
    ret: data.cores.filter((c) => c.retrieval_status === 'retrieved' && c.return_status === 'to_be_returned').length,
    value: data.cores.filter(isOpen).reduce((a, c) => a + coreValue(c), 0),
  }), [data])

  const set = (c, patch, text) => run(() => supabase.from('cores').update(patch).eq('id', c.id), text)

  return (
    <>
      <PageHead title={t('inv.core.title')} sub={t('inv.core.sub')} />
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <Badge color="amber">{t('inv.core.countRetrieve', { n: counts.retrieve })}</Badge>
        <Badge color="blue">{t('inv.core.countReturn', { n: counts.ret })}</Badge>
        {showCost && counts.value > 0 && <Badge color="gray">{t('inv.core.openValue', { amount: rp(counts.value) })}</Badge>}
      </div>
      <div className="filterbar">
        <SearchBox value={q} onChange={setQ} placeholder={t('inv.core.search')} />
        <select className="select chipselect" value={show} onChange={(e) => setShow(e.target.value)} aria-label={t('inv.show')}>
          <option value="open">{t('inv.core.f.open')}</option>
          <option value="retrieve">{t('inv.core.f.retrieve')}</option>
          <option value="return">{t('inv.core.f.return')}</option>
          <option value="away">{t('inv.core.f.away')}</option>
          <option value="all">{t('inv.core.f.all')}</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="card"><Empty icon="layers" title={data.cores.length ? t('inv.nothingFound') : t('inv.core.noneTitle')}>{data.cores.length ? t('inv.nothingFoundText') : t('inv.core.noneText')}</Empty></div>
      ) : (
        <div className="table">
          <table>
            <thead><tr>
              <th>{t('inv.col.part')}</th><th className="wide-only">{t('inv.col.from')}</th><th className="wide-only">{t('inv.col.supplier')}</th><th className="num">{t('inv.col.qty')}</th>
              {showCost && <th className="num">{t('inv.core.value')}</th>}<th>{t('inv.core.retrieval')}</th><th>{t('inv.core.return')}</th><th aria-label={t('inv.more')} />
            </tr></thead>
            <tbody>
              {rows.map((c) => {
                const i = CORE_STEPS.indexOf(c.return_status)
                const next = c.retrieval_status === 'retrieved' && i >= 0 && i < CORE_STEPS.length - 1 ? CORE_STEPS[i + 1] : null
                const date = { shipped: c.shipped_at, delivered: c.delivered_at, refunded: c.refunded_at }[c.return_status]
                return (
                  <tr key={c.id}>
                    <td><b>{c.item_name}</b><div className="muted small">{t('inv.core.added', { date: fmtDate(c.marked_at, lang) })}</div></td>
                    <td className="wide-only small"><JobRef data={data} roId={c.ro_id} /></td>
                    <td className="wide-only">{data.supplierById[c.supplier_id]?.name || <span className="muted">—</span>}</td>
                    <td className="num">{num(c.qty, 2)}</td>
                    {showCost && <td className="num nowrap">{rp(coreValue(c))}{c.return_status === 'refunded' && Number(c.refund_amount) > 0 && <div className="small" style={{ color: 'var(--green)' }}>{t('inv.ret.refundedAmount', { amount: rp(c.refund_amount) })}</div>}</td>}
                    <td><Badge color={RETRIEVAL_COLOR[c.retrieval_status]}>{t(`inv.core.rt.${c.retrieval_status}`)}</Badge></td>
                    <td><Badge color={CORE_COLOR[c.return_status]}>{t(`inv.core.st.${c.return_status}`)}</Badge>{date && <div className="muted small">{fmtDate(date, lang)}</div>}{c.credit_number && <div className="muted small">{c.credit_number}</div>}</td>
                    <td className="num">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {canEdit && c.retrieval_status === 'to_be_retrieved' && <Button size="sm" onClick={() => set(c, { retrieval_status: 'retrieved' }, t('inv.core.retrievedToast', { name: c.item_name }))}>{t('inv.core.markRetrieved')}</Button>}
                        {canEdit && next && <Button size="sm" onClick={() => setStep({ r: c, to: next })}>{t(`inv.ret.to.${next}`)}</Button>}
                        {canEdit && c.return_status === 'damaged' && <Button size="sm" onClick={() => set(c, { return_status: 'to_be_returned' })}>{t('inv.core.putBack')}</Button>}
                        <MoreMenu label={t('inv.core.menu', { name: c.item_name })} items={[
                          canEdit && c.retrieval_status === 'to_be_retrieved' && { label: t('inv.core.markDamaged'), icon: 'x', onClick: () => set(c, { retrieval_status: 'damaged' }) },
                          canEdit && c.retrieval_status !== 'to_be_retrieved' && ['to_be_returned', 'damaged'].includes(c.return_status) && { label: t('inv.core.notRetrieved'), icon: 'undo', onClick: () => set(c, { retrieval_status: 'to_be_retrieved' }) },
                          canEdit && next && next !== 'refunded' && { label: t('inv.ret.to.refunded'), icon: 'dollar', onClick: () => setStep({ r: c, to: 'refunded' }) },
                          canEdit && ['marked', 'shipped', 'delivered'].includes(c.return_status) && { label: t('inv.core.rejected'), icon: 'x', danger: true, onClick: () => set(c, { return_status: 'damaged' }) },
                        ]} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('inv.core.hint')}</div>
      <StepModal open={!!step} step={step} data={data} showCost={showCost} table="cores" statusField="return_status" onClose={() => setStep(null)}
        onDone={(text) => { setStep(null); run(async () => ({}), text) }} />
    </>
  )
}
