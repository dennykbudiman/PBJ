import React, { useEffect, useMemo, useState } from 'react'
import { useT } from '../lib/i18n'
import { supabase, errorText, writeRow } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { Button, Input, Modal, Notice, useConfirm } from './ui'
import { nameChecks, catalogVocabulary, numberTaken, looksInvented } from '../lib/partnames'
import { catalogMatches } from '../lib/alternatives'
import { readAmount, rp } from '../lib/format'

// Update 150 (item 49): every part has a part number and is in the catalog.
// usePartWords: the part-name dictionary (Pemilik/Admin keep it); PartNameCheck: the hints under a part's name and
// number while it is typed; NoNumberTick: "Part ini tidak punya nomor part" with its confirmation;
// NewPartModal: a new part from a job (into the catalog, then onto the job).

let wordsCache = null
export function usePartWords() {
  const [words, setWords] = useState(wordsCache || [])
  useEffect(() => {
    if (wordsCache) return
    let live = true
    supabase.from('part_name_words').select('id, wrong, right_text').order('wrong').then(({ data }) => {
      wordsCache = data || []
      if (live) setWords(wordsCache)
    })
    return () => { live = false }
  }, [])
  return words
}
export function forgetPartWords() { wordsCache = null }

export function PartNameCheck({ name, number, brand, items, selfId, vehicle, onName, onUse, words }) {
  const { t } = useT()
  const vocab = useMemo(() => catalogVocabulary(items), [items])
  const brands = useMemo(() => [...new Set((items || []).map((x) => x.brand).filter(Boolean))], [items])
  const checks = useMemo(() => nameChecks(name, { words, vocab, brands, brand }), [name, words, vocab, brands, brand])
  const taken = useMemo(() => (String(number || '').trim() ? numberTaken(items, number, selfId) : []), [items, number, selfId])
  const similar = useMemo(() => (taken.length || String(name || '').trim().length < 4 ? []
    : catalogMatches(items, { name, vehicle, selfId, limit: 3 }).filter((m) => m.why === 'name')), [items, name, vehicle, selfId, taken])
  const fix = checks.find((c) => c.fix)?.fix
  if (!checks.length && !taken.length && !similar.length && !(number && looksInvented(number))) return null
  return (
    <div className="namecheck" role="status" aria-live="polite">
      {fix && fix !== String(name).trim() && (
        <div className="nc-row">
          <span>{t('u150.didYouMean')} <b>{fix}</b>?</span>
          {onName && <Button size="sm" onClick={() => onName(fix)}>{t('u150.useThis')}</Button>}
        </div>
      )}
      {checks.filter((c) => c.kind === 'dict' || c.kind === 'spell').map((c, i) => (
        <div key={`s${i}`} className="small muted">{t(`u150.why.${c.kind}`, { from: c.from, to: c.to })}</div>
      ))}
      {checks.filter((c) => c.kind === 'service' || c.kind === 'brand' || c.kind === 'number').map((c, i) => (
        <div key={`w${i}`} className="small nc-warn">{t(`u150.why.${c.kind}`, { word: c.word })}</div>
      ))}
      {taken.map((x) => (
        <div key={x.id} className="nc-row nc-warn">
          <span>{t('u150.numberTaken', { name: x.name, code: x.code || '—' })}</span>
          {onUse && <Button size="sm" onClick={() => onUse(x)}>{t('u150.usePart')}</Button>}
        </div>
      ))}
      {similar.map(({ item: x }) => (
        <div key={x.id} className="nc-row">
          <span className="small">{t('u150.similar', { name: x.name, code: x.code || t('u150.noNumberShort') })}</span>
          {onUse && <Button size="sm" onClick={() => onUse(x)}>{t('u150.usePart')}</Button>}
        </div>
      ))}
      {number && looksInvented(number) && !taken.length && <div className="small muted">{t('u150.invented')}</div>}
    </div>
  )
}

// the tick, with "Yakin part ini tidak punya nomor part?" before it goes on
export function NoNumberTick({ checked, onChange, disabled, name }) {
  const { t } = useT()
  const [confirm, confirmEl] = useConfirm()
  async function toggle(e) {
    if (!e.target.checked) return onChange(false)
    const ok = await confirm({ title: t('u150.noNumberTitle'), text: t('u150.noNumberAsk', { name: name || t('u150.thisPart') }), yes: t('u150.noNumberYes') })
    onChange(!!ok)
  }
  return (
    <>
      <label className="check" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <input type="checkbox" checked={!!checked} onChange={toggle} disabled={disabled} />
        <span>{t('u150.noNumber')}</span>
      </label>
      {confirmEl}
    </>
  )
}

// A new part from a job: name, number (or the tick), brand, cost, price → catalog, then onCreated(item).
// onUse(item): use an existing catalog part instead.
export function NewPartModal({ open, onClose, items, vehicle, onCreated, onUse, showCost, showPrice, markupPct }) {
  const { t } = useT()
  const { can } = useAuth()
  const words = usePartWords()
  const blank = { name: '', code: '', noNumber: false, brand: '', cost: '', price: '' }
  const [f, setF] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  useEffect(() => { if (open) { setF(blank); setMsg(null) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const taken = String(f.code).trim() ? numberTaken(items, f.code) : []
  const allowed = can('edit_catalog')

  async function save() {
    const name = f.name.replace(/\s+/g, ' ').trim()
    if (name.length < 2) return setMsg(t('u150.errName'))
    if (!f.code.trim() && !f.noNumber) return setMsg(t('u150.errNumber'))
    if (taken.length) return setMsg(t('u150.errTaken'))
    const cost = f.cost.trim() ? readAmount(f.cost) : 0
    let price = f.price.trim() ? readAmount(f.price) : null
    if (Number.isNaN(cost) || (price !== null && Number.isNaN(price))) return setMsg(t('settings.badAmount'))
    if (price === null) price = Math.round(Number(cost || 0) * (1 + Number(markupPct || 0) / 100))
    setBusy(true)
    setMsg(null)
    const row = { item_type: 'part', name, code: f.code.trim() || null, no_part_number: !f.code.trim() && f.noNumber,
      brand: f.brand.trim() || null, cost: cost || 0, price: price || 0, track_inventory: true, active: true,
      show_on_invoice: true, show_qty_price: true, default_qty: 1 }
    const { data, error } = await writeRow('catalog_items', row)
    setBusy(false)
    if (error) return setMsg(errorText(error, t))
    onCreated(data)
  }

  return (
    <Modal open={open} title={t('u150.newPart')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={save} loading={busy} disabled={!allowed}>{t('u150.addToJob')}</Button></>}>
      {!allowed && <Notice kind="warn" style={{ marginBottom: 10 }}>{t('u150.noCatalogRight')}</Notice>}
      <p className="small muted" style={{ marginTop: 0 }}>{t('u150.newPartIntro')}</p>
      <div className="grid2">
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={set('name')} autoFocus maxLength={200} placeholder={t('u150.namePh')} />
        <div className="span2">
          <PartNameCheck name={f.name} number={f.code} brand={f.brand} items={items} vehicle={vehicle} words={words}
            onName={(v) => setF((x) => ({ ...x, name: v }))} onUse={onUse ? (x) => onUse(x) : null} />
        </div>
        <div>
          <Input label={t('cat.partNo')} value={f.code} onChange={(e) => setF((x) => ({ ...x, code: e.target.value, noNumber: e.target.value.trim() ? false : x.noNumber }))}
            maxLength={60} disabled={f.noNumber} />
          {!f.code.trim() && <NoNumberTick checked={f.noNumber} onChange={(v) => setF((x) => ({ ...x, noNumber: v }))} name={f.name.trim()} />}
        </div>
        <Input label={t('cat.brand')} value={f.brand} onChange={set('brand')} maxLength={80} />
        {showCost && <Input label={t('cat.cost')} value={f.cost} onChange={set('cost')} inputMode="numeric" prefix="Rp" />}
        {showPrice && <Input label={t('cat.price')} value={f.price} onChange={set('price')} inputMode="numeric" prefix="Rp"
          hint={showCost && !f.price.trim() && f.cost.trim() && !Number.isNaN(readAmount(f.cost)) ? t('u150.priceFromCost', { price: rp(Math.round(readAmount(f.cost) * (1 + Number(markupPct || 0) / 100))) }) : null} />}
      </div>
      {msg && <Notice kind="err" style={{ marginTop: 10 }}>{msg}</Notice>}
    </Modal>
  )
}
