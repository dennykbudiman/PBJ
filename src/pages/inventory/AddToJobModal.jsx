import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal, Notice } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { num, rp } from '../../lib/format'
import { Tick } from './bits'

// Put PO lines that aren't on the job onto its work order (141, Denny Nov 9). A line matching an unlinked job line
// (same part, or same name for a typed part / outside work) is linked to it; the others are added as new job lines to
// the chosen service, or to a new "Part tambahan" service. From then on the lines are connected.
// entries: [{ line, match }] from poLinesNotOnJob; poNoOf: PO line → PO number; services/items: the job's.
export default function AddToJobModal({ open, onClose, jobNoText, entries, services, items, poNoOf, showCost, onDone }) {
  const { t } = useT()
  const [picked, setPicked] = useState({})
  const [choice, setChoice] = useState({})
  const [service, setService] = useState('')
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState(null)
  const running = useRef(false)
  const live = useMemo(() => (services || []).filter((s) => s.approval_status === 'approved' || s.approval_status === 'pending')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), [services])
  const serviceName = (id) => (services || []).find((s) => s.id === id)?.name || '—'

  useEffect(() => {
    if (!open) return
    setPicked(Object.fromEntries((entries || []).map((e) => [e.line.id, true])))
    setChoice(Object.fromEntries((entries || []).map((e) => [e.line.id, e.match ? 'link' : 'add'])))
    // New lines go where most of the job's ordered lines are, else to the first service, else a new one.
    const count = {}
    for (const i of items || []) {
      if (i.po_item_id && live.some((s) => s.id === i.service_id)) count[i.service_id] = (count[i.service_id] || 0) + 1
    }
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0]
    setService(best || live[0]?.id || '__new')
    setFail(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (entries || []).filter((e) => picked[e.line.id])
  const toLink = chosen.filter((e) => e.match && choice[e.line.id] === 'link')
  const toAdd = chosen.filter((e) => !(e.match && choice[e.line.id] === 'link'))

  async function save() {
    if (running.current) return
    if (!chosen.length) return setFail(t('u141.pickSome'))
    running.current = true; setBusy(true); setFail(null)
    let done = 0
    try {
      for (const e of toLink) {
        const r = await supabase.from('purchase_order_items').update({ ro_service_item_id: e.match.id }).eq('id', e.line.id)
        if (r.error) throw r.error
        done++
      }
      if (toAdd.length) {
        const r = await supabase.rpc('add_po_lines_to_job', {
          p_lines: toAdd.map((e) => e.line.id),
          p_service: service === '__new' ? null : service,
          p_new_service: service === '__new' ? t('u141.newServiceName') : null,
        })
        if (r.error) throw r.error
        done += toAdd.length
      }
      onDone(done)
    } catch (e) {
      if (done) onDone(done, errorText(e, t))
      else setFail(errorText(e, t))
    } finally { running.current = false; setBusy(false) }
  }

  return (
    <Modal open={open} title={t('u141.addTitle', { no: jobNoText })} onClose={onClose} wide
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={!chosen.length} onClick={save}>{t('u141.save')}</Button>
      </>}>
      <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{t('u141.addIntro')}</div>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      <div className="table compact">
        <table>
          <thead><tr>
            <th style={{ width: 28 }} /><th>{t('inv.col.part')}</th><th className="num">{t('inv.col.qty')}</th>
            {showCost && <th className="num">{t('inv.col.unitCost')}</th>}<th>PO</th>
          </tr></thead>
          <tbody>
            {(entries || []).map(({ line: l, match }) => {
              const q = Number(l.qty_ordered) - Number(l.qty_cancelled) - Number(l.qty_returned || 0)
              return (
                <tr key={l.id} className={picked[l.id] ? '' : 'dim'}>
                  <td><Tick checked={!!picked[l.id]} onChange={(v) => setPicked((x) => ({ ...x, [l.id]: v }))} label={t('inv.order.pick', { name: l.name })} /></td>
                  <td>
                    <b>{l.name}</b>{l.part_number && <span className="muted small"> · {l.part_number}</span>}
                    {l.line_type === 'sublet' && <div className="small muted">{t('u141.subletNote')}</div>}
                    {match && (
                      <div className="small" style={{ marginTop: 4 }}>
                        <label className="row" style={{ gap: 6 }}>
                          <input type="radio" name={`c-${l.id}`} checked={choice[l.id] === 'link'} disabled={!picked[l.id]}
                            onChange={() => setChoice((x) => ({ ...x, [l.id]: 'link' }))} />
                          {t('u141.link', { name: match.name, service: serviceName(match.service_id) })}
                        </label>
                        <label className="row" style={{ gap: 6 }}>
                          <input type="radio" name={`c-${l.id}`} checked={choice[l.id] === 'add'} disabled={!picked[l.id]}
                            onChange={() => setChoice((x) => ({ ...x, [l.id]: 'add' }))} />
                          {t('u141.addNew')}
                        </label>
                      </div>
                    )}
                  </td>
                  <td className="num">{num(q, 2)}</td>
                  {showCost && <td className="num nowrap">{l.cost == null ? '—' : rp(l.cost)}</td>}
                  <td className="small nowrap">{poNoOf(l)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {toAdd.length > 0 && (
        <label className="mini" style={{ display: 'block', marginTop: 12 }}>{t('u141.service')}
          <select className="select" value={service} onChange={(e) => setService(e.target.value)} aria-label={t('u141.service')}>
            {live.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__new">{t('u141.newService', { name: t('u141.newServiceName') })}</option>
          </select>
        </label>
      )}
    </Modal>
  )
}
