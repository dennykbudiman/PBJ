import React, { useState } from 'react'
import { Badge, Button, Empty, Modal, Notice, Select } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { WORK_STATUS } from '../../lib/jobs'
import { BlurInput, MoreMenu } from './common'

const COLORS = ['green', 'yellow', 'red']
const BADGE = { green: 'green', yellow: 'amber', red: 'red' }

// Inspections on this job: start one from a checklist, then mark each point green / yellow / red with a note.
export default function JobInspections({ job, cat, staff, editable, run, busy }) {
  const { t } = useT()
  const [startOpen, setStartOpen] = useState(false)
  const [pick, setPick] = useState({ checklist: '', service: '' })
  const canConcern = editable && job.ro.order_status === 'estimate'

  async function start(checklistId, serviceId) {
    const items = cat.checklistItems.filter((x) => x.checklist_id === checklistId)
      .map((x) => cat.insp.find((i) => i.id === x.item_id)).filter(Boolean)
    const ok = await run(async () => {
      const { data, error } = await supabase.from('ro_inspections').insert({ ro_id: job.ro.id, checklist_id: checklistId || null, service_id: serviceId || null }).select().single()
      if (error) return { error }
      if (!items.length) return { data }
      return supabase.from('ro_inspection_results').insert(items.map((i) => ({ inspection_id: data.id, item_id: i.id, item_name: i.name })))
    }, t('job.inspStarted'))
    if (ok) setStartOpen(false)
  }

  const waiting = job.services.filter((s) => s.checklist_id && !job.inspections.some((x) => x.service_id === s.id))
  return (
    <div>
      {job.ro.order_status === 'invoice' && <Notice kind="info" style={{ marginBottom: 14 }}>{t('job.inspLocked')}</Notice>}
      {editable && (
        <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
          {waiting.map((s) => {
            const cl = cat.checklists.find((c) => c.id === s.checklist_id)
            return <Button key={s.id} icon="clipboard" onClick={() => start(s.checklist_id, s.id)} loading={busy}>{t('job.startFor', { name: cl?.name || '?', service: s.name })}</Button>
          })}
          <Button icon="plus" onClick={() => { setPick({ checklist: '', service: '' }); setStartOpen(true) }}>{t('job.startInspection')}</Button>
        </div>
      )}
      {job.inspections.length === 0 ? (
        <div className="card"><Empty icon="clipboard" title={t('job.noInspections')}>{t('job.noInspectionsText')}</Empty></div>
      ) : job.inspections.map((ins) => (
        <InspectionCard key={ins.id} ins={ins} job={job} cat={cat} staff={staff} editable={editable} canConcern={canConcern} run={run} />
      ))}
      <Modal open={startOpen} title={t('job.startInspection')} onClose={() => setStartOpen(false)}
        footer={<><Button onClick={() => setStartOpen(false)}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={() => start(pick.checklist, pick.service)}>{t('job.start')}</Button></>}>
        <div className="grid2">
          <Select fieldClass="span2" label={t('cat.checklist')} value={pick.checklist} onChange={(e) => setPick((x) => ({ ...x, checklist: e.target.value }))}
            options={[{ value: '', label: t('job.emptyInspection') }, ...cat.checklists.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))]} />
          <Select fieldClass="span2" label={t('job.forService')} value={pick.service} onChange={(e) => setPick((x) => ({ ...x, service: e.target.value }))}
            options={[{ value: '', label: '—' }, ...job.services.map((s) => ({ value: s.id, label: s.name }))]} />
        </div>
      </Modal>
    </div>
  )
}

function InspectionCard({ ins, job, cat, staff, editable, canConcern, run }) {
  const { t } = useT()
  const results = job.results.filter((r) => r.inspection_id === ins.id)
  const cl = cat.checklists.find((c) => c.id === ins.checklist_id)
  const svc = job.services.find((s) => s.id === ins.service_id)
  const counts = Object.fromEntries(COLORS.map((c) => [c, results.filter((r) => r.color === c).length]))
  const updIns = (patch) => run(() => supabase.from('ro_inspections').update(patch).eq('id', ins.id))
  const updRes = (id, patch) => run(() => supabase.from('ro_inspection_results').update(patch).eq('id', id))
  const existing = new Set(results.map((r) => r.item_id))
  const addable = cat.insp.filter((i) => i.active && !existing.has(i.id))

  async function toConcern(r) {
    const text = [r.item_name, r.note].filter(Boolean).join(': ')
    const pos = job.concerns.reduce((m, c) => Math.max(m, c.position), -1) + 1
    await run(async () => {
      const { data, error } = await supabase.from('ro_concerns').insert({ ro_id: job.ro.id, text, position: pos }).select().single()
      if (error) return { error }
      return supabase.from('ro_inspection_results').update({ concern_id: data.id }).eq('id', r.id)
    }, t('job.addedAsConcern'))
  }

  return (
    <section className="card">
      <div className="row wrap" style={{ gap: 8 }}>
        <h3 className="svc-title">{cl?.name || t('job.inspection')}</h3>
        {svc && <span className="muted small">· {svc.name}</span>}
        <div className="spacer" />
        {COLORS.map((c) => counts[c] > 0 && <Badge key={c} color={BADGE[c]}>{counts[c]} {t(`cat.flag.${c}`)}</Badge>)}
        <select className="select bare" value={ins.technician_id || ''} disabled={!editable} onChange={(e) => updIns({ technician_id: e.target.value || null })} aria-label={t('job.technician')}>
          <option value="">{t('job.noTechnician')}</option>
          {staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="select bare work" value={ins.status} disabled={!editable} onChange={(e) => updIns({ status: e.target.value })} aria-label={t('job.inspStatus')}>
          {WORK_STATUS.map((w) => <option key={w} value={w}>{t(`job.work.${w}`)}</option>)}
        </select>
        {editable && <MoreMenu label={t('job.inspMenu')} items={[{ label: t('job.deleteInspection'), icon: 'trash', danger: true, onClick: () => run(() => supabase.from('ro_inspections').delete().eq('id', ins.id)) }]} />}
      </div>
      <div className="lines" style={{ marginTop: 10 }}>
        {results.length === 0 && <div className="muted small">{t('job.noPointsYet')}</div>}
        {results.map((r) => {
          const notes = cat.notes.filter((n) => n.item_id === r.item_id && (!r.color || n[r.color]))
          return (
            <div key={r.id} className={`line insp-row c-${r.color || 'none'}`}>
              <span className="insp-name"><b>{r.item_name}</b></span>
              <span className="flagpick" role="radiogroup" aria-label={t('cat.flagFor', { note: r.item_name })}>
                {COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={r.color === c} disabled={!editable} title={t(`cat.flag.${c}`)} aria-label={t(`cat.flag.${c}`)}
                    className={`flag ${c} ${r.color === c ? 'on' : ''}`} onClick={() => updRes(r.id, { color: r.color === c ? null : c })} />
                ))}
              </span>
              {editable && notes.length > 0 && (
                <select className="select bare small" style={{ maxWidth: 200 }} value="" aria-label={t('job.pickNote')}
                  onChange={(e) => { const n = notes.find((x) => x.id === e.target.value); if (n) updRes(r.id, { note: n.note, color: r.color || (n.red ? 'red' : n.yellow ? 'yellow' : 'green') }) }}>
                  <option value="">{t('job.pickNote')}</option>
                  {notes.map((n) => <option key={n.id} value={n.id}>{n.note}</option>)}
                </select>
              )}
              {editable ? (
                <BlurInput className="input line-grow" value={r.note || ''} placeholder={t('job.inspNote')} aria-label={t('job.inspNoteFor', { name: r.item_name })}
                  onCommit={(v) => updRes(r.id, { note: v.trim() || null })} />
              ) : <span className="line-grow">{r.note || <span className="muted">—</span>}</span>}
              {r.concern_id ? <Badge color="blue">{t('job.isConcern')}</Badge>
                : canConcern && (r.color === 'yellow' || r.color === 'red') && <button type="button" className="linkbtn small" onClick={() => toConcern(r)}>{t('job.addAsConcern')}</button>}
              {editable && <button type="button" className="btn ghost sm" onClick={() => run(() => supabase.from('ro_inspection_results').delete().eq('id', r.id))} aria-label={t('cat.removeRow', { name: r.item_name })}><Icon name="x" size={14} /></button>}
            </div>
          )
        })}
      </div>
      {editable && addable.length > 0 && (
        <select className="select mt" style={{ width: 'auto' }} value="" aria-label={t('cat.addPoint')}
          onChange={(e) => { const i = cat.insp.find((x) => x.id === e.target.value); if (i) run(() => supabase.from('ro_inspection_results').insert({ inspection_id: ins.id, item_id: i.id, item_name: i.name })) }}>
          <option value="">{t('cat.addPoint')}</option>
          {addable.map((i) => <option key={i.id} value={i.id}>{i.category ? `${i.category} · ` : ''}{i.name}</option>)}
        </select>
      )}
    </section>
  )
}
