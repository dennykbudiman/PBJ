import React, { useMemo, useState } from 'react'
import { Badge, Input, Select, Toggle, useToast } from '../../components/ui'
import { EditorPanel, EmptyCard, ListShell, SearchBox, Section, StatusSelect, RowLink, deleteErrorText, statusMatch } from './common'
import { supabase, errorText } from '../../lib/supabase'
import History from './History'
import { useT } from '../../lib/i18n'
import { useShop } from '../../context/ShopContext'
import { fmtDate, num, parseDecimal, readAmount, rp } from '../../lib/format'
import { shopToday } from '../../lib/customers'

const dec = (v) => (v == null ? '' : String(Number(v)).replace('.', ','))

// Where a discount stands today: off, not started, running or over.
export function discountState(d, today) {
  if (!d.active) return 'inactive'
  if (d.valid_from && d.valid_from > today) return 'scheduled'
  if (d.valid_to && d.valid_to < today) return 'expired'
  return 'running'
}
const STATE_COLOR = { inactive: 'gray', scheduled: 'blue', expired: 'amber', running: 'green' }

export function discountValue(d) {
  return d.kind === 'percent' ? `${num(d.value, 2)}%` : rp(d.value)
}

export default function DiscountsTab({ data, id, canEdit, reload, go }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  const today = shopToday(timezone)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('active')
  const base = '/catalog/discounts'

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return data.discounts.filter((x) => statusMatch(x, status, id) && (!needle || x.name.toLowerCase().includes(needle)))
  }, [data.discounts, q, status, id])

  const isNew = id === 'new'
  const selected = isNew ? null : data.discounts.find((x) => x.id === id)
  const panel = id && (isNew || selected) ? (
    <DiscountEditor key={`${id}:${data.version}`} discount={selected} data={data} canEdit={canEdit} today={today}
      onClose={() => go(base)}
      onSaved={async (row) => { await reload(); go(`${base}/${row.id}`) }}
      onDeleted={async () => { await reload(); go(base) }} />
  ) : id ? <EmptyCard icon="info" title={t('cat.notFound')} /> : null

  const empty = data.discounts.length === 0
    ? <EmptyCard icon="percent" title={t('cat.empty.discounts')} text={t('cat.emptyText.discounts')} />
    : rows.length === 0 ? <EmptyCard icon="search" title={t('cust.noMatch')} text={t('cust.noMatchText')} /> : null
  const dateText = (d) => (d ? fmtDate(d, lang) : null)

  return (
    <ListShell title={t('cat.tab.discounts')} sub={t('cat.sub.discounts')} addLabel={t('cat.add.discounts')} onAdd={() => go(`${base}/new`)}
      canEdit={canEdit} panel={panel} empty={empty}
      filters={<><SearchBox value={q} onChange={setQ} placeholder={t('cat.search.discounts')} /><StatusSelect value={status} onChange={setStatus} /></>}>
      <div className="table">
        <table>
          <thead>
            <tr><th>{t('cat.name')}</th><th>{t('cat.appliesTo')}</th><th className="num">{t('cat.value')}</th><th className="num wide-only">{t('cat.maxDiscount')}</th><th className="wide-only">{t('cat.valid')}</th><th>{t('cat.status')}</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const st = discountState(x, today)
              const from = dateText(x.valid_from)
              const to = dateText(x.valid_to)
              return (
                <tr key={x.id} className={`click ${x.id === id ? 'selected' : ''}`} onClick={() => go(`${base}/${x.id}`)}>
                  <td><RowLink to={`${base}/${x.id}`} go={go}>{x.name}</RowLink></td>
                  <td>{t(`cat.level.${x.level}`)}</td>
                  <td className="num"><b>{discountValue(x)}</b></td>
                  <td className="num wide-only">{x.kind === 'percent' && x.max_amount != null ? rp(x.max_amount) : '—'}</td>
                  <td className="wide-only muted">{from || to ? `${from || '…'} – ${to || '…'}` : t('cat.always')}</td>
                  <td><Badge color={STATE_COLOR[st]}>{t(`cat.state.${st}`)}</Badge></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">{t('cat.listHint.discounts')}</div>
    </ListShell>
  )
}

function DiscountEditor({ discount, data, canEdit, today, onClose, onSaved, onDeleted }) {
  const { t } = useT()
  const toast = useToast()
  const isNew = !discount
  const [f, setF] = useState(() => ({
    name: discount?.name || '', level: discount?.level || 'job', kind: discount?.kind || 'percent',
    value: discount ? (discount.kind === 'percent' ? dec(discount.value) : num(discount.value)) : '',
    max: discount?.max_amount == null ? '' : num(discount.max_amount),
    from: discount?.valid_from || '', to: discount?.valid_to || '', active: discount ? discount.active : true,
  }))
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const dis = !canEdit
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }))

  async function save() {
    const e = {}
    if (!f.name.trim()) e.name = t('settings.required')
    const value = f.kind === 'percent' ? parseDecimal(f.value) : readAmount(f.value)
    if (value === null || Number.isNaN(value) || value <= 0 || (f.kind === 'percent' && value > 100)) {
      e.value = f.kind === 'percent' ? t('cat.percentRule') : t('settings.badAmount')
    }
    const max = f.kind === 'percent' ? readAmount(f.max) : null
    if (Number.isNaN(max)) e.max = t('settings.badAmount')
    if (f.from && f.to && f.to < f.from) e.to = t('cat.dateOrder')
    setErrors(e)
    if (Object.keys(e).length) return
    const row = {
      name: f.name.trim(), level: f.level, kind: f.kind, value, max_amount: max || null,
      valid_from: f.from || null, valid_to: f.to || null, active: f.active,
    }
    setBusy(true)
    setMsg(null)
    const res = isNew
      ? await supabase.from('discounts').insert(row).select().single()
      : await supabase.from('discounts').update(row).eq('id', discount.id).select().single()
    if (res.error) { setBusy(false); return setMsg(errorText(res.error, t)) }
    toast(t('cat.saved', { name: res.data.name }))
    await onSaved(res.data)
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    const { error } = await supabase.from('discounts').delete().eq('id', discount.id)
    setBusy(false)
    if (error) return setMsg(deleteErrorText(error, t))
    toast(t('cat.deleted', { name: discount.name }))
    onDeleted()
  }

  const st = discount ? discountState(discount, today) : null
  return (
    <EditorPanel title={isNew ? t('cat.new.discount') : discount.name} subtitle={!isNew ? `${discountValue(discount)} · ${t(`cat.level.${discount.level}`)}` : null}
      badges={st ? <Badge color={STATE_COLOR[st]}>{t(`cat.state.${st}`)}</Badge> : null}
      canEdit={canEdit} busy={busy} error={msg} onSave={save} onClose={onClose} onDelete={remove} isNew={isNew}>
      <div className="grid2">
        <Input fieldClass="span2" label={t('cat.name')} value={f.name} onChange={set('name')} error={errors.name} disabled={dis} autoFocus={isNew} placeholder={t('cat.discountExample')} />
        <Select label={t('cat.appliesTo')} value={f.level} onChange={set('level')} disabled={dis}
          options={[{ value: 'job', label: t('cat.level.job') }, { value: 'service', label: t('cat.level.service') }]} hint={t(`cat.levelHint.${f.level}`)} />
        <Select label={t('cat.discountKind')} value={f.kind} disabled={dis} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value, value: '', max: '' }))}
          options={[{ value: 'percent', label: t('cat.kind.percent') }, { value: 'amount', label: t('cat.kind.amount') }]} />
        <Input label={f.kind === 'percent' ? t('cat.percent') : t('cat.amount')} value={f.value} onChange={set('value')} disabled={dis}
          inputMode="decimal" prefix={f.kind === 'percent' ? null : 'Rp'} suffix={f.kind === 'percent' ? '%' : null} error={errors.value} />
        {f.kind === 'percent' && (
          <Input label={t('cat.maxDiscountOptional')} value={f.max} onChange={set('max')} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.max} hint={t('cat.maxHint')} />
        )}
      </div>
      <Section title={t('cat.valid')}>
        <div className="grid2">
          <Input type="date" label={t('cat.validFrom')} value={f.from} onChange={set('from')} disabled={dis} />
          <Input type="date" label={t('cat.validTo')} value={f.to} onChange={set('to')} disabled={dis} min={f.from || undefined} error={errors.to} />
        </div>
        <div className="hint">{t('cat.validHint')}</div>
      </Section>
      <Section title={t('cat.settings')}>
        <Toggle checked={f.active} onChange={set('active')} disabled={dis} label={t('cat.activeLabel')} />
      </Section>
      {!isNew && <Section title={t('cat.hist.section')}><History entityType={'discounts'} entityId={discount.id} data={data} /></Section>}
    </EditorPanel>
  )
}
