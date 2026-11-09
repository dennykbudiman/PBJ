import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Empty, Input, Modal, Notice, PageHead, Select, Textarea, useConfirm, useToast } from '../../components/ui'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { fmtDate, invoiceNo, num, parseDecimal, readAmount, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'

// Inventory → Drum (142, Denny Nov 9): bulk oil is bought one drum at a time, each paid by one PT. Oil used on invoiced
// jobs fills the drums in the order they were opened (oldest first); when a drum is empty, the PT that bought it
// charges the other PTs for what their trucks used, at the drum's price per litre.
export default function DrumsTab({ data, canEdit }) {
  const { t, lang } = useT()
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [rep, setRep] = useState(null)
  const [version, setVersion] = useState(0)
  const [modal, setModal] = useState(null) // { drum? }
  const [open, setOpen] = useState({})
  useEffect(() => {
    let live = true
    supabase.rpc('drum_report').then((r) => { if (live) setRep(r) })
    return () => { live = false }
  }, [version])
  const reload = () => setVersion((v) => v + 1)
  const oils = data.items.filter((x) => x.item_type === 'part' && x.track_inventory && x.active)
  const payerNames = [...new Set(data.customers.map((c) => c.payer_name || c.display_name).filter(Boolean))].sort()
  async function remove(d, name) {
    const ok = await confirm({ title: t('u142.drumDeleteTitle', { name }), text: t('u142.drumDeleteText'), yes: t('common.delete'), danger: true })
    if (ok !== true) return
    const { error } = await supabase.from('oil_drums').delete().eq('id', d.id)
    if (error) toast(errorText(error, t), 'err'); else { toast(t('u142.drumDeleted')); reload() }
  }

  return (
    <>
      <PageHead title={t('u142.drumsTitle')} sub={t('u142.drumsSub')}
        actions={canEdit && <Button variant="primary" icon="plus" onClick={() => setModal({})}>{t('u142.drumAdd')}</Button>} />
      {rep?.error && <Notice kind="err">{errorText(rep.error, t)}</Notice>}
      {!rep ? <div className="muted">{t('common.loading')}</div> : (rep.data || []).length === 0 ? (
        <div className="card"><Empty icon="layers" title={t('u142.drumsNone')}>{t('u142.drumsNoneText')}</Empty></div>
      ) : rep.data.map((oil) => (
        <section key={oil.catalog_item_id} className="card" style={{ marginBottom: 16 }}>
          <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}><Link className="plainlink" to={`/inventory/stock/${oil.catalog_item_id}`}>{oil.name}</Link></h2>
            <span className="muted small">{t('u142.onOpenJobs', { n: num(oil.on_open_jobs, 2), unit: oil.unit || '' })}</span>
          </div>
          {(oil.drums || []).map((d, i) => {
            const key = d.id
            const neg = Number(d.left) < 0
            return (
              <div key={key} className="drum" style={{ borderTop: i ? '1px solid var(--line)' : undefined, paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
                <div className="row wrap" style={{ gap: 8 }}>
                  <b>{t('u142.drumN', { n: i + 1 })}</b>
                  <span className="small">{t('u142.drumLine', { litres: num(d.litres, 2), unit: oil.unit || 'L', date: fmtDate(d.opened_on, lang), payer: d.paid_by })}</span>
                  {d.cost_per_l > 0 && <span className="small muted">{t('u142.perL', { amount: rp(d.cost_per_l), unit: oil.unit || 'L' })}</span>}
                  <div className="spacer" />
                  <Badge color={neg ? 'red' : Number(d.left) === 0 ? 'gray' : 'green'}>{t('u142.drumLeft', { n: num(d.left, 2), unit: oil.unit || 'L' })}</Badge>
                  <span className="small">{t('u142.drumUsed', { n: num(d.used, 2), unit: oil.unit || 'L' })}</span>
                  <button type="button" className="linkbtn small" onClick={() => setOpen((x) => ({ ...x, [key]: !x[key] }))}>{open[key] ? t('u142.hide') : t('u142.details')}</button>
                  {canEdit && <button type="button" className="linkbtn small" onClick={() => setModal({ drum: d, item: oil.catalog_item_id })}>{t('common.edit')}</button>}
                  {canEdit && <button type="button" className="linkbtn small danger" onClick={() => remove(d, oil.name)}>{t('common.delete')}</button>}
                </div>
                {d.note && <div className="small muted">{d.note}</div>}
                {neg && d.last && <div className="small text-red">{t('u142.drumOverdrawn')}</div>}
                {(d.owed || []).length > 0 && (
                  <div className="small" style={{ marginTop: 4 }}>
                    {d.owed.map((o) => (
                      <div key={o.payer || '-shop'}>{t(o.amount == null ? 'u142.owedLineNoAmount' : 'u142.owedLine', { from: o.payer || t('u142.theShop'), to: d.paid_by, litres: num(o.litres, 2), unit: oil.unit || 'L', amount: rp(o.amount) })}</div>
                    ))}
                  </div>
                )}
                {open[key] && (
                  <div className="table compact flush" style={{ marginTop: 8 }}>
                    <table>
                      <thead><tr><th>{t('u142.company')}</th><th>{t('u142.payerCol')}</th><th className="num">{t('u142.litres')}</th><th className="num">{t('u142.value')}</th><th className="wide-only">{t('u142.jobs')}</th></tr></thead>
                      <tbody>
                        {(d.companies || []).map((c) => (
                          <tr key={c.customer_id}>
                            <td>{c.company}</td><td className="small">{c.payer || <span className="muted">{t('u142.theShopPaid')}</span>}</td>
                            <td className="num">{num(c.litres, 2)}</td><td className="num nowrap">{c.value == null ? '—' : rp(c.value)}</td>
                            <td className="wide-only small">{(c.jobs || []).map((j, k) => <Link key={k} to={`/jobs/${j.ro_id}`} style={{ marginRight: 8 }}>{invoiceNo(j.invoice_number)} ({num(j.litres, 2)})</Link>)}</td>
                          </tr>
                        ))}
                        {(d.companies || []).length === 0 && <tr><td colSpan={5} className="muted small">{t('u142.drumUnused')}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </section>
      ))}
      <div className="hint">{t('u142.drumsHint')}</div>
      {confirmEl}
      <DrumModal open={!!modal} onClose={() => setModal(null)} drum={modal?.drum} itemId={modal?.item} oils={oils} payers={payerNames}
        onSaved={() => { setModal(null); reload(); toast(t('u142.drumSaved')) }} />
    </>
  )
}

function DrumModal({ open, onClose, drum, itemId, oils, payers, onSaved }) {
  const { t } = useT()
  const { timezone } = useShop()
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  useEffect(() => {
    if (!open) return
    setF(drum ? { item: itemId, litres: num(drum.litres, 2), cost: drum.cost_per_l ? num(drum.cost_per_l) : '', payer: drum.paid_by || '', opened: drum.opened_on, note: drum.note || '' }
      : { item: oils.find((o) => o.unit === 'L')?.id || '', litres: '209', cost: '', payer: '', opened: shopToday(timezone), note: '' })
    setErr({}); setFail(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  // someone who doesn't see costs gets no price from the report: an edit leaves the drum's price as it is
  const hideCost = !!drum && drum.cost_per_l == null
  async function save() {
    if (running.current) return
    const e = {}
    const litres = parseDecimal(f.litres)
    const cost = String(f.cost || '').trim() === '' ? 0 : readAmount(f.cost)
    if (!f.item) e.item = t('u142.errOil')
    if (litres == null || !(litres > 0) || litres > 100000) e.litres = t('u142.errLitres')
    if (cost == null || Number.isNaN(cost) || cost < 0) e.cost = t('inv.err.cost')
    if (!String(f.payer || '').trim()) e.payer = t('u142.errPayer')
    if (!f.opened) e.opened = t('u142.errDate')
    setErr(e)
    if (Object.keys(e).length) return
    running.current = true; setBusy(true); setFail(null)
    const row = { catalog_item_id: f.item, litres, paid_by_name: f.payer.trim(), opened_on: f.opened, note: f.note.trim() || null, ...(hideCost ? {} : { cost_per_l: cost }) }
    const r = drum ? await supabase.from('oil_drums').update(row).eq('id', drum.id) : await supabase.from('oil_drums').insert(row)
    running.current = false; setBusy(false)
    if (r.error) return setFail(errorText(r.error, t))
    onSaved()
  }
  return (
    <Modal open={open} title={drum ? t('u142.drumEditTitle') : t('u142.drumAddTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      <Select label={t('u142.oil')} value={f.item || ''} onChange={set('item')} error={err.item}
        options={[{ value: '', label: t('u142.chooseOil') }, ...oils.map((o) => ({ value: o.id, label: `${o.name}${o.unit ? ` (${o.unit})` : ''}` }))]} />
      <div className="formgrid">
        <Input label={t('u142.litres')} value={f.litres || ''} onChange={set('litres')} error={err.litres} inputMode="decimal" />
        {!hideCost && <Input label={t('u142.costPerL')} value={f.cost || ''} onChange={set('cost')} error={err.cost} prefix="Rp" inputMode="numeric" />}
      </div>
      <Input label={t('u142.paidBy')} value={f.payer || ''} onChange={set('payer')} error={err.payer} list="drum-payers" maxLength={120} hint={t('u142.paidByHint')} />
      <datalist id="drum-payers">{payers.map((n) => <option key={n} value={n} />)}</datalist>
      <Input label={t('u142.openedOn')} type="date" value={f.opened || ''} onChange={set('opened')} error={err.opened} />
      <Textarea label={t('u142.note')} value={f.note || ''} onChange={set('note')} rows={2} maxLength={500} placeholder={t('u142.noteEx')} />
      <div className="hint">{t('u142.drumFormHint')}</div>
    </Modal>
  )
}
