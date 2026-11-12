import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import Icon from '../../components/Icon'
import { nameKey } from '../../lib/books'
import { Badge, Button, Empty, Input, Modal, Notice, PageHead, Select, Textarea, Toggle, useConfirm, useToast } from '../../components/ui'
import { booksOfPayer, payerBookLabel } from '../../lib/books'
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
  // 145: payments per book ("Tandai lunas", Pemilik/Admin) and the print of the statements, for people who see costs
  const { can, roleName } = useAuth()
  const money = can('view_costs') || can('pay_supplier_bills')
  const ownerAdmin = roleName === 'Owner' || roleName === 'Admin'
  const [stmt, setStmt] = useState(null)
  const [payFor, setPayFor] = useState(null) // { drum, debtor }
  const [priceAsk, setPriceAsk] = useState(null) // a new drum price that differs from the catalog (item 31)
  useEffect(() => {
    let live = true
    supabase.rpc('drum_report').then((r) => { if (live) setRep(r) })
    if (money) supabase.rpc('drum_statement').then((r) => { if (live) setStmt(r.data || null) })
    return () => { live = false }
  }, [version]) // eslint-disable-line react-hooks/exhaustive-deps
  const debtorOf = (drumId, o) => (stmt?.drums || []).find((x) => x.id === drumId)?.debtors
    ?.find((x) => nameKey(x.payer) === nameKey(o.payer) && nameKey(x.book) === nameKey(o.book))
  async function unpay(p) {
    const ok = await confirm({ title: t('u145.unpayTitle'), text: t('u145.unpayText', { amount: rp(p.amount), date: fmtDate(p.paid_on, lang) }), yes: t('u145.unpayYes'), danger: true })
    if (ok !== true) return
    const { error } = await supabase.rpc('drum_unmark_paid', { p_id: p.id })
    if (error) toast(errorText(error, t), 'err'); else { toast(t('u145.unpaid')); reload() }
  }
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
        actions={<div className="row" style={{ gap: 6 }}>
          {money && <Link className="btn" to="/print/drums"><Icon name="print" size={15} /> {t('u145.printDrums')}</Link>}
          {canEdit && <Button variant="primary" icon="plus" onClick={() => setModal({})}>{t('u142.drumAdd')}</Button>}
        </div>} />
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
                  <span className="small">{t('u142.drumLine', { litres: num(d.litres, 2), unit: oil.unit || 'L', date: fmtDate(d.opened_on, lang), payer: payerBookLabel(d.paid_by, d.paid_by_book) })}</span>
                  {d.cost_per_l > 0 && <span className="small muted">{t('u142.perL', { amount: rp(d.cost_per_l), unit: oil.unit || 'L' })}</span>}
                  {d.cost_estimated && <Badge color="amber">{t('u143.estimate')}</Badge>}
                  <div className="spacer" />
                  {/* 149: a drum marked empty shows what the app still counts in it as "tidak tercatat" */}
                  {d.emptied_on && !neg
                    ? <><Badge color="gray">{t('u149.emptied', { date: fmtDate(d.emptied_on, lang) })}</Badge>{Number(d.untracked) > 0 && <Badge color="amber">{t('u149.untracked', { n: num(d.untracked, 2), unit: oil.unit || 'L' })}</Badge>}</>
                    : <Badge color={neg ? 'red' : Number(d.left) === 0 ? 'gray' : 'green'}>{t('u142.drumLeft', { n: num(d.left, 2), unit: oil.unit || 'L' })}</Badge>}
                  <span className="small">{t('u142.drumUsed', { n: num(d.used, 2), unit: oil.unit || 'L' })}{Number(d.preapp) > 0 && <span className="muted"> {t('u149.ofWhichPre', { n: num(d.preapp, 2), unit: oil.unit || 'L' })}</span>}</span>
                  <button type="button" className="linkbtn small" onClick={() => setOpen((x) => ({ ...x, [key]: !x[key] }))}>{open[key] ? t('u142.hide') : t('u142.details')}</button>
                  {canEdit && <button type="button" className="linkbtn small" onClick={() => setModal({ drum: d, item: oil.catalog_item_id })}>{t('common.edit')}</button>}
                  {canEdit && <button type="button" className="linkbtn small danger" onClick={() => remove(d, oil.name)}>{t('common.delete')}</button>}
                </div>
                {d.note && <div className="small muted">{d.note}</div>}
                {neg && d.last && <div className="small text-red">{t('u142.drumOverdrawn')}</div>}
                {(d.owed || []).length > 0 && (
                  <div className="small" style={{ marginTop: 4 }}>
                    {d.owed.map((o) => {
                      const x = debtorOf(d.id, o)
                      return (
                        <div key={(o.payer || '-shop') + '|' + (o.book || '')} className="row wrap" style={{ gap: '2px 8px' }}>
                          <span>{t(o.amount == null ? 'u142.owedLineNoAmount' : 'u142.owedLine', { from: o.payer ? payerBookLabel(o.payer, o.book) : t('u142.theShop'), to: payerBookLabel(d.paid_by, d.paid_by_book), litres: num(o.litres, 2), unit: oil.unit || 'L', amount: rp(o.amount) })}</span>
                          {x && (Number(x.open) <= 0 && Number(x.owed_all) > 0 ? <Badge color="green">{t('u145.lunas')}</Badge>
                            : Number(x.paid) > 0 ? <span className="muted">{t('u145.paidOpen', { paid: rp(x.paid), open: rp(x.open) })}</span> : null)}
                          {x && ownerAdmin && Number(x.open) > 0 && <button type="button" className="linkbtn small" onClick={() => setPayFor({ drum: d, debtor: x, oil })}>{t('u145.markPaid')}</button>}
                          {x && (x.payments || []).map((p) => (
                            <span key={p.id} className="muted">· {t('u145.paidChip', { amount: rp(p.amount), date: fmtDate(p.paid_on, lang) })}
                              {ownerAdmin && <button type="button" className="linkbtn small danger" onClick={() => unpay(p)} aria-label={t('u145.unpayYes')}> ×</button>}</span>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}
                {open[key] && (
                  <div className="table compact flush" style={{ marginTop: 8 }}>
                    <table>
                      <thead><tr><th>{t('u142.company')}</th><th>{t('u142.payerCol')}</th><th className="num">{t('u142.litres')}</th><th className="num">{t('u142.value')}</th><th className="wide-only">{t('u142.jobs')}</th></tr></thead>
                      <tbody>
                        {(d.companies || []).map((c) => (
                          <tr key={c.customer_id}>
                            <td>{c.company}</td><td className="small">{c.payer ? payerBookLabel(c.payer, c.book) : <span className="muted">{t('u142.theShopPaid')}</span>}</td>
                            <td className="num">{num(c.litres, 2)}</td><td className="num nowrap">{c.value == null ? '—' : rp(c.value)}</td>
                            <td className="wide-only small">{(c.jobs || []).map((j, k) => (j.preapp
                              ? <span key={k} className="muted nowrap" style={{ marginRight: 8 }} title={t('u149.preappTitle')}>{t('u149.preappJob', { plate: j.plate || '', date: fmtDate(j.done_on, lang) })} ({num(j.litres, 2)})</span>
                              : <Link key={k} to={`/jobs/${j.ro_id}`} style={{ marginRight: 8 }}>{invoiceNo(j.invoice_number)} ({num(j.litres, 2)})</Link>))}</td>
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
      <DrumModal open={!!modal} onClose={() => setModal(null)} drum={modal?.drum} itemId={modal?.item} oils={oils} payers={payerNames} customers={data.customers}
        onSaved={(row) => {
          setModal(null); reload(); toast(t('u142.drumSaved'))
          // a drum at a price other than the oil's catalog price: offer to change the catalog (item 31)
          const item = data.items.find((x) => x.id === row?.catalog_item_id)
          if (item && row.cost_per_l > 0 && item.price != null && Number(item.price) !== Number(row.cost_per_l) && can('edit_catalog')) setPriceAsk({ item, price: Number(row.cost_per_l) })
        }} />
      {payFor && <MarkPaidModal {...payFor} onClose={() => setPayFor(null)} onDone={() => { setPayFor(null); reload(); toast(t('u145.markedPaid')) }} />}
      {priceAsk && <CatalogPriceModal {...priceAsk} onClose={() => setPriceAsk(null)} onDone={(msg) => { setPriceAsk(null); toast(msg) }} />}
    </>
  )
}

function DrumModal({ open, onClose, drum, itemId, oils, payers, customers, onSaved }) {
  const { t } = useT()
  const { timezone } = useShop()
  const [f, setF] = useState({})
  const [err, setErr] = useState({})
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  useEffect(() => {
    if (!open) return
    setF(drum ? { item: itemId, litres: num(drum.litres, 2), cost: drum.cost_per_l ? num(drum.cost_per_l) : '', payer: drum.paid_by || '', book: drum.paid_by_book || '', estimated: !!drum.cost_estimated, opened: drum.opened_on, emptied: drum.emptied_on || '', note: drum.note || '' }
      : { item: oils.find((o) => o.unit === 'L')?.id || '', litres: '209', cost: '', payer: '', book: '', estimated: false, opened: shopToday(timezone), emptied: '', note: '' })
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
    if (f.emptied && (f.emptied < f.opened || f.emptied > shopToday(timezone))) e.emptied = t('u149.errEmptied')
    setErr(e)
    if (Object.keys(e).length) return
    running.current = true; setBusy(true); setFail(null)
    const row = { catalog_item_id: f.item, litres, paid_by_name: f.payer.trim(), paid_by_book: f.book || null, opened_on: f.opened, emptied_on: f.emptied || null, note: f.note.trim() || null, ...(hideCost ? {} : { cost_per_l: cost, cost_estimated: !!f.estimated }) }
    const r = drum ? await supabase.from('oil_drums').update(row).eq('id', drum.id) : await supabase.from('oil_drums').insert(row)
    running.current = false; setBusy(false)
    if (r.error) return setFail(errorText(r.error, t))
    onSaved(row)
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
      <Input label={t('u142.paidBy')} value={f.payer || ''} error={err.payer} list="drum-payers" maxLength={120} hint={t('u142.paidByHint')}
        onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, payer: v, book: booksOfPayer(customers, v).some((b) => b.toLowerCase() === (x.book || '').toLowerCase()) ? x.book : '' })) }} />
      <datalist id="drum-payers">{payers.map((n) => <option key={n} value={n} />)}</datalist>
      {/* the book inside the PT that bought it (143); none = the whole PT */}
      <Select label={t('u143.book')} value={f.book || ''} onChange={set('book')} hint={t('u143.drumBookHint')}
        options={[{ value: '', label: t('u143.wholePt') }, ...booksOfPayer(customers, f.payer).map((b) => ({ value: b, label: b })),
                  ...(f.book && !booksOfPayer(customers, f.payer).some((b) => b.toLowerCase() === f.book.toLowerCase()) ? [{ value: f.book, label: f.book }] : [])]} />
      {!hideCost && <Toggle checked={!!f.estimated} onChange={set('estimated')} label={t('u143.estimateToggle')} />}
      <div className="formgrid">
        <Input label={t('u142.openedOn')} type="date" value={f.opened || ''} onChange={set('opened')} error={err.opened} />
        <Input label={t('u149.emptiedOn')} type="date" value={f.emptied || ''} onChange={set('emptied')} error={err.emptied} hint={t('u149.emptiedHint')} />
      </div>
      <Textarea label={t('u142.note')} value={f.note || ''} onChange={set('note')} rows={2} maxLength={500} placeholder={t('u142.noteEx')} />
      <div className="hint">{t('u142.drumFormHint')}</div>
    </Modal>
  )
}

// "Tandai lunas" (145, item 28): a payment from one book to the drum's owner; default everything still open.
function MarkPaidModal({ drum, debtor, oil, onClose, onDone }) {
  const { t } = useT()
  const { timezone } = useShop()
  const [f, setF] = useState({ amount: num(debtor.open), date: shopToday(timezone), method: 'transfer', ref: '' })
  const [fail, setFail] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))
  async function save() {
    const amount = readAmount(f.amount)
    if (!(amount > 0)) return setFail(t('u145.errAmount'))
    setBusy(true); setFail(null)
    const { error } = await supabase.rpc('drum_mark_paid', { p_drum: drum.id, p_payer: debtor.payer, p_book: debtor.book, p_amount: amount,
      p_paid_on: f.date, p_method: f.method || null, p_reference: f.ref.trim() || null })
    setBusy(false)
    if (error) return setFail(errorText(error, t))
    onDone()
  }
  return (
    <Modal open title={t('u145.markPaidTitle', { oil: oil.name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('u145.markPaid')}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      <div className="kvlist" style={{ marginBottom: 10 }}>
        <div><span>{t('u145.debtor')}</span><b>{debtor.payer ? payerBookLabel(debtor.payer, debtor.book) : t('u142.theShop')}</b></div>
        <div><span>{t('u145.drumOwner')}</span><b>{payerBookLabel(drum.paid_by, drum.paid_by_book)}</b></div>
        <div><span>{t('u145.owedAll')}</span><b>{rp(debtor.owed_all)}</b></div>
        {Number(debtor.paid) > 0 && <div><span>{t('u145.paidAll')}</span><b>{rp(debtor.paid)}</b></div>}
        <div><span>{t('u145.stillOpen')}</span><b>{rp(debtor.open)}</b></div>
      </div>
      <div className="formgrid">
        <Input label={t('u145.amountPaid')} value={f.amount} onChange={set('amount')} prefix="Rp" inputMode="numeric" />
        <Input label={t('u145.paidOn')} type="date" value={f.date} onChange={set('date')} />
      </div>
      <Select label={t('u145.how')} value={f.method} onChange={set('method')}
        options={[{ value: '', label: '—' }, ...['transfer', 'cash', 'giro', 'other'].map((m) => ({ value: m, label: t(`inv.pay.m.${m}`) }))]} />
      <Input label={t('u145.reference')} value={f.ref} onChange={set('ref')} maxLength={200} />
      <div className="hint">{t('u145.markPaidHint')}</div>
    </Modal>
  )
}

// A drum at a new price (145, item 31): change the oil's catalog price (selling price and cost) to it, and optionally
// the oil lines on open jobs (not yet invoiced). Invoices are never changed.
function CatalogPriceModal({ item, price, onClose, onDone }) {
  const { t } = useT()
  const [lines, setLines] = useState(null)
  const [pick, setPick] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      const r = await supabase.from('ro_service_items').select('id, qty, price, service_id').eq('catalog_item_id', item.id).eq('stock_deducted', false)
      const svc = (r.data || []).length ? await supabase.from('ro_services').select('id, ro_id').in('id', [...new Set(r.data.map((l) => l.service_id))]) : { data: [] }
      const jobs = (svc.data || []).length ? await supabase.from('repair_orders').select('id, job_number, order_status, closed_at').in('id', [...new Set(svc.data.map((x) => x.ro_id))]) : { data: [] }
      if (!live) return
      const jobOf = (l) => (jobs.data || []).find((j) => j.id === (svc.data || []).find((x) => x.id === l.service_id)?.ro_id)
      const open = (r.data || []).map((l) => ({ ...l, job: jobOf(l) }))
        .filter((l) => l.job && l.job.order_status === 'estimate' && !l.job.closed_at && Number(l.price) !== price)
      setLines(open); setPick(new Set(open.map((l) => l.id)))
    })()
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    setBusy(true); setFail(null)
    const c = await supabase.from('catalog_items').update({ price, cost: price, markup_pct: 0 }).eq('id', item.id)
    if (c.error) { setBusy(false); return setFail(errorText(c.error, t)) }
    let n = 0
    for (const id of pick) {
      const u = await supabase.from('ro_service_items').update({ price, cost: price }).eq('id', id)
      if (u.error) { setBusy(false); return setFail(errorText(u.error, t)) }
      n++
    }
    setBusy(false)
    onDone(t('u145.priceDone', { name: item.name, amount: rp(price), n }))
  }
  return (
    <Modal open title={t('u145.priceTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('u145.priceKeep')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('u145.priceYes', { amount: rp(price) })}</Button></>}>
      {fail && <Notice kind="err" style={{ marginBottom: 10 }}>{fail}</Notice>}
      <p style={{ marginTop: 0 }}>{t('u145.priceText', { name: item.name, now: rp(item.price), amount: rp(price) })}</p>
      {lines == null ? <div className="muted">{t('common.loading')}</div> : lines.length === 0 ? <div className="muted small">{t('u145.priceNoJobs')}</div> : <>
        <div className="sectionlabel">{t('u145.priceJobs')}</div>
        {lines.map((l) => (
          <label key={l.id} className="inlinecheck" style={{ display: 'flex' }}>
            <input type="checkbox" checked={pick.has(l.id)} onChange={(e) => setPick((s) => { const x = new Set(s); if (e.target.checked) x.add(l.id); else x.delete(l.id); return x })} />
            <span>#{l.job.job_number} · {num(l.qty, 2)} L · {rp(l.price)} → {rp(price)}</span>
          </label>
        ))}
      </>}
      <div className="hint">{t('u145.priceHint')}</div>
    </Modal>
  )
}
