import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Page } from '../../components/Layout'
import { Button, Card, Input, Notice, PageHead, Select, Textarea, Toggle, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import LaborRates from './LaborRates'
import Users from './Users'
import Appearance, { themeError } from './Appearance'
import OpeningHours, { hoursError } from './OpeningHours'
import { normHours } from '../../lib/hours'
import { applyTheme, DEFAULT_THEME, normTheme } from '../../lib/theme'
import { useScrollSpy } from '../../lib/useScrollSpy'
import { supabase, errorText, LOGO_BUCKET } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { initials, invoiceNo, jobNo, stockPoNo, readAmount, parseDecimal, rp, num } from '../../lib/format'

const ALL_SECTIONS = ['shop', 'appearance', 'language', 'hours', 'numbering', 'fees', 'labor', 'users']

// shop_settings columns edited on this page, with how each is read from the form.
const TEXT = ['shop_name', 'legal_name', 'npwp', 'address', 'phone', 'email', 'bank_details', 'terms_id', 'terms_en', 'tax_name']
const CHOICE = ['pkp_status', 'timezone', 'default_app_language', 'default_print_language', 'shop_supplies_type', 'shop_supplies_base']
const FLAG = ['shop_supplies_enabled', 'shop_supplies_taxable', 'new_items_taxable']
const DECIMAL = ['tax_rate']
const MONEY = ['shop_supplies_min', 'shop_supplies_max']
const INT = ['default_payment_terms_days', 'due_soon_days', 'due_soon_km']

const TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']

function toForm(s) {
  const f = {}
  for (const k of [...TEXT, ...CHOICE]) f[k] = s?.[k] ?? ''
  for (const k of FLAG) f[k] = !!s?.[k]
  for (const k of DECIMAL) f[k] = s?.[k] == null ? '' : String(Number(s[k])).replace('.', ',')
  for (const k of MONEY) f[k] = s?.[k] == null ? '' : num(s[k])
  for (const k of INT) f[k] = s?.[k] == null ? '' : String(s[k])
  // Shop supplies rate is a percentage, or a Rupiah amount when the type is "fixed".
  const r = s?.shop_supplies_rate
  f.shop_supplies_rate = r == null ? '' : s.shop_supplies_type === 'fixed' ? num(r) : String(Number(r)).replace('.', ',')
  f.theme = normTheme(s?.theme)
  f.opening_hours = normHours(s?.opening_hours)
  return f
}

// Builds the update for the fields that changed; returns { patch, errors }.
function fromForm(f, s, t) {
  const patch = {}
  const errors = {}
  for (const k of TEXT) {
    const v = f[k].trim() || null
    if (v !== (s[k] ?? null)) patch[k] = v
  }
  if (!f.shop_name.trim()) errors.shop_name = t('settings.required')
  if (!f.tax_name.trim()) errors.tax_name = t('settings.required')
  for (const k of CHOICE) if (f[k] !== (s[k] ?? '')) patch[k] = f[k]
  for (const k of FLAG) if (f[k] !== !!s[k]) patch[k] = f[k]
  for (const k of DECIMAL) {
    const v = parseDecimal(f[k])
    if (v === null || v < 0) errors[k] = t('settings.badNumber')
    else if (Number(s[k]) !== v) patch[k] = v
  }
  for (const k of MONEY) {
    const v = readAmount(f[k]) // empty = no minimum / maximum
    if (Number.isNaN(v)) errors[k] = t('settings.badAmount')
    else if ((s[k] == null ? null : Number(s[k])) !== v) patch[k] = v
  }
  for (const k of INT) {
    const v = readAmount(f[k])
    if (v === null || Number.isNaN(v)) errors[k] = t('settings.badNumber')
    else if (Number(s[k]) !== v) patch[k] = v
  }
  const ss = f.shop_supplies_type === 'fixed' ? readAmount(f.shop_supplies_rate) : parseDecimal(f.shop_supplies_rate)
  if (ss === null || Number.isNaN(ss) || ss < 0) errors.shop_supplies_rate = t('settings.badNumber')
  else if (Number(s.shop_supplies_rate) !== ss) patch.shop_supplies_rate = ss
  const rate = parseDecimal(f.tax_rate)
  if (rate !== null && rate > 100) errors.tax_rate = t('settings.max100')
  if (f.shop_supplies_type === 'percent' && ss !== null && ss > 100) errors.shop_supplies_rate = t('settings.max100')
  const mn = readAmount(f.shop_supplies_min)
  const mx = readAmount(f.shop_supplies_max)
  if (mn !== null && mx !== null && !Number.isNaN(mn) && !Number.isNaN(mx) && mn > mx) errors.shop_supplies_max = t('settings.minMax')
  if (f.email.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim())) errors.email = t('settings.badEmail')
  const he = hoursError(f.opening_hours, t)
  if (he) errors.opening_hours = he
  else if (JSON.stringify(f.opening_hours) !== JSON.stringify(normHours(s.opening_hours))) patch.opening_hours = f.opening_hours
  const te = themeError(f.theme, t)
  if (te) errors.theme = te
  else if (JSON.stringify(normTheme(f.theme)) !== JSON.stringify(normTheme(s.theme))) patch.theme = normTheme(f.theme)
  return { patch, errors }
}

function useSequences() {
  const [seq, setSeq] = useState(null)
  useEffect(() => {
    supabase.from('number_sequences').select('name, next_value').then(({ data }) => {
      const m = {}
      for (const r of data ?? []) m[r.name] = r.next_value
      setSeq(m)
    })
  }, [])
  return seq
}

function LogoPicker({ disabled }) {
  const { t } = useT()
  const toast = useToast()
  const { settings, shopName, logoUrl, setSettings } = useShop()
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)

  async function upload(file) {
    if (!file) return
    if (!/^image\/(png|svg\+xml|jpeg|webp)$/.test(file.type)) return toast(t('settings.logoType'), 'err')
    if (file.size > 2 * 1024 * 1024) return toast(t('settings.logoSize'), 'err')
    setBusy(true)
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
    const path = `logo-${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage.from(LOGO_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
    if (upErr) {
      setBusy(false)
      return toast(errorText(upErr, t), 'err')
    }
    const old = settings?.logo_path
    const { data, error } = await supabase.from('shop_settings').update({ logo_path: path }).eq('id', true).select().single()
    if (error) {
      await supabase.storage.from(LOGO_BUCKET).remove([path])
      setBusy(false)
      return toast(errorText(error, t), 'err')
    }
    if (old) await supabase.storage.from(LOGO_BUCKET).remove([old])
    setSettings(data)
    setBusy(false)
    toast(t('settings.logoSaved'))
  }

  async function removeLogo() {
    const old = settings?.logo_path
    setBusy(true)
    const { data, error } = await supabase.from('shop_settings').update({ logo_path: null }).eq('id', true).select().single()
    if (!error && old) await supabase.storage.from(LOGO_BUCKET).remove([old])
    setBusy(false)
    if (error) return toast(errorText(error, t), 'err')
    setSettings(data)
  }

  return (
    <div className="row wrap" style={{ gap: 16, marginBottom: 14, alignItems: 'center' }}>
      <div className="logo-box">{logoUrl ? <img src={logoUrl} alt={shopName} /> : initials(shopName)}</div>
      <div style={{ minWidth: 0, flex: '1 1 240px' }}>
        {!disabled && (
          <div className="row">
            <Button icon="upload" loading={busy} onClick={() => fileRef.current?.click()}>{logoUrl ? t('settings.replaceLogo') : t('settings.uploadLogo')}</Button>
            {logoUrl && <Button variant="ghost" className="danger" onClick={removeLogo} disabled={busy}>{t('common.remove')}</Button>}
            <input ref={fileRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
          </div>
        )}
        <div className="hint">{t('settings.logoHint')}</div>
      </div>
    </div>
  )
}

export default function Settings() {
  const { t } = useT()
  const toast = useToast()
  const { can } = useAuth()
  const { settings, setSettings } = useShop()
  const seq = useSequences()
  const editable = can('edit_settings')
  const [form, setForm] = useState(() => toForm(settings))
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  // Appearance (colour theme) is only for people who can change settings (Owner, Admin).
  const SECTIONS = editable ? ALL_SECTIONS : ALL_SECTIONS.filter((x) => x !== 'appearance')
  const [active, go] = useScrollSpy(SECTIONS, { prefix: 'set-' })
  const navRef = useRef(null)

  // On phones the section menu is a sideways strip: keep the highlighted entry in view.
  useEffect(() => {
    const nav = navRef.current
    const btn = nav?.querySelector('button.on')
    if (nav && btn && nav.scrollWidth > nav.clientWidth) {
      const left = nav.scrollLeft + btn.getBoundingClientRect().left - nav.getBoundingClientRect().left - 16
      nav.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
    }
  }, [active])

  // Fill the form when settings first arrive. After that the form only resets on
  // Save or Discard, so e.g. uploading a logo never wipes unsaved edits.
  const filled = useRef(Boolean(settings))
  useEffect(() => {
    if (settings && !filled.current) { filled.current = true; setForm(toForm(settings)) }
  }, [settings])

  // Anything typed differently from what's saved counts, including entries that
  // don't parse yet, so Save stays clickable and can point at the problem.
  const dirty = useMemo(() => Boolean(settings) && JSON.stringify(form) !== JSON.stringify(toForm(settings)), [form, settings])

  // Warn before leaving with unsaved changes (browser close / reload).
  useEffect(() => {
    if (!dirty) return
    const h = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // Preview the theme being chosen; go back to the saved one when leaving the page.
  useEffect(() => {
    if (!settings) return // keep the remembered theme until the saved settings arrive
    if (form.theme && !themeError(form.theme, t)) applyTheme(form.theme)
  }, [form.theme, settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const savedTheme = useRef(settings?.theme)
  savedTheme.current = settings?.theme
  useEffect(() => () => applyTheme(savedTheme.current ?? DEFAULT_THEME), [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }))

  async function save() {
    const { patch, errors: errs } = fromForm(form, settings, t)
    setErrors(errs)
    if (Object.keys(errs).length) return toast(t('settings.fixErrors'), 'err')
    if (!Object.keys(patch).length) { setForm(toForm(settings)); return } // same values, typed differently
    setBusy(true)
    const { data, error } = await supabase.from('shop_settings').update(patch).eq('id', true).select().single()
    setBusy(false)
    if (error) return toast(errorText(error, t), 'err')
    setSettings(data)
    setForm(toForm(data))
    toast(t('settings.saved'))
  }

  if (!settings) {
    return (
      <Page>
        <PageHead title={t('nav.settings')} />
        <Notice kind="warn">{t('settings.notLoaded')}</Notice>
      </Page>
    )
  }

  const dis = !editable
  const pct = form.shop_supplies_type === 'percent'

  return (
    <Page>
      <PageHead
        title={t('nav.settings')}
        sub={editable ? t('settings.sub') : t('settings.readOnly')}
        actions={editable && <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>{t('settings.save')}</Button>}
      />
      <div className="settings">
        <nav className="settings-nav" aria-label={t('nav.settings')} ref={navRef}>
          {SECTIONS.map((s) => (
            <button key={s} className={active === s ? 'on' : ''} aria-current={active === s ? 'true' : undefined} onClick={() => go(s)}>{t(`settings.nav.${s}`)}</button>
          ))}
        </nav>

        <div>
          <Card title={t('settings.nav.shop')} id="set-shop">
            <LogoPicker disabled={dis} />
            <div className="grid2">
              <Input label={t('settings.shopName')} value={form.shop_name} onChange={set('shop_name')} disabled={dis} error={errors.shop_name} />
              <Input label={t('settings.legalName')} value={form.legal_name} onChange={set('legal_name')} disabled={dis} />
              <Input label="NPWP" value={form.npwp} onChange={set('npwp')} disabled={dis} placeholder={t('settings.npwpHint')} />
              <Input label={t('settings.phone')} value={form.phone} onChange={set('phone')} disabled={dis} />
              <Input label={t('settings.address')} value={form.address} onChange={set('address')} disabled={dis} />
              <Input label={t('settings.email')} type="email" value={form.email} onChange={set('email')} disabled={dis} error={errors.email} />
              <Input label={t('settings.bank')} value={form.bank_details} onChange={set('bank_details')} disabled={dis} />
              <Select
                label={t('settings.pkp')}
                value={form.pkp_status}
                onChange={set('pkp_status')}
                disabled={dis}
                hint={t('settings.pkpHint')}
                options={[
                  { value: 'unknown', label: t('settings.pkp.unknown') },
                  { value: 'pkp', label: t('settings.pkp.pkp') },
                  { value: 'non_pkp', label: t('settings.pkp.non_pkp') },
                ]}
              />
            </div>
          </Card>

          {editable && (
            <Appearance id="set-appearance" value={form.theme} error={errors.theme}
              onChange={(theme) => { setForm((f) => ({ ...f, theme })); setErrors((e) => ({ ...e, theme: null })) }} />
          )}

          <Card title={t('settings.nav.language')} id="set-language">
            <div className="grid3">
              <Select label={t('settings.appLang')} value={form.default_app_language} onChange={set('default_app_language')} disabled={dis}
                options={[{ value: 'en', label: 'English' }, { value: 'id', label: 'Bahasa Indonesia' }]} />
              <Select label={t('settings.printLang')} value={form.default_print_language} onChange={set('default_print_language')} disabled={dis}
                options={[{ value: 'id', label: 'Bahasa Indonesia' }, { value: 'en', label: 'English' }]} />
              <Select label={t('settings.timezone')} value={form.timezone} onChange={set('timezone')} disabled={dis}
                options={(TIMEZONES.includes(form.timezone) ? TIMEZONES : [form.timezone, ...TIMEZONES]).map((z) => ({ value: z, label: t(`tz.${z}`) === `tz.${z}` ? z : t(`tz.${z}`) }))} />
            </div>
            <div className="hint">{t('settings.langHint')}</div>
            <div className="sectionlabel">{t('settings.terms')}</div>
            <div className="grid2">
              <Textarea label="Bahasa Indonesia" value={form.terms_id} onChange={set('terms_id')} disabled={dis} rows={3} />
              <Textarea label="English" value={form.terms_en} onChange={set('terms_en')} disabled={dis} rows={3} />
            </div>
          </Card>

          <OpeningHours id="set-hours" value={form.opening_hours} disabled={dis} error={errors.opening_hours}
            onChange={(opening_hours) => { setForm((f) => ({ ...f, opening_hours })); setErrors((e) => ({ ...e, opening_hours: null })) }} />

          <Card title={t('settings.nav.numbering')} id="set-numbering">
            <div className="grid3">
              <div className="field"><span className="fieldlabel">{t('settings.nextJob')}</span><div className="readonly">{seq ? jobNo(seq.job) : '…'}</div></div>
              <div className="field"><span className="fieldlabel">{t('settings.nextInvoice')}</span><div className="readonly">{seq ? invoiceNo(seq.invoice) : '…'}</div></div>
              <div className="field"><span className="fieldlabel">{t('settings.nextStockPo')}</span><div className="readonly">{seq ? stockPoNo(seq.stock_po) : '…'}</div></div>
            </div>
            <div className="hint">{t('settings.numberingHint')}</div>
            <div className="sectionlabel">{t('settings.defaults')}</div>
            <div className="grid3">
              <Input label={t('settings.terms_days')} value={form.default_payment_terms_days} onChange={set('default_payment_terms_days')} disabled={dis} inputMode="numeric" suffix={t('common.days')} error={errors.default_payment_terms_days} />
              <Input label={t('settings.dueSoonDays')} value={form.due_soon_days} onChange={set('due_soon_days')} disabled={dis} inputMode="numeric" suffix={t('common.days')} error={errors.due_soon_days} />
              <Input label={t('settings.dueSoonKm')} value={form.due_soon_km} onChange={set('due_soon_km')} disabled={dis} inputMode="numeric" suffix="km" error={errors.due_soon_km} />
            </div>
            <div className="hint">{t('settings.defaultsHint')}</div>
          </Card>

          <Card title={t('settings.nav.fees')} id="set-fees">
            <div className="sectionlabel" style={{ marginTop: 0 }}>{t('settings.shopSupplies')}</div>
            <Toggle checked={form.shop_supplies_enabled} onChange={set('shop_supplies_enabled')} disabled={dis} label={t('settings.ssEnabled')} />
            <div className="grid4" style={{ marginTop: 12, opacity: form.shop_supplies_enabled ? 1 : 0.55 }}>
              <Select label={t('settings.ssType')} value={form.shop_supplies_type} disabled={dis}
                onChange={(e) => {
                  // A percentage and a Rupiah amount aren't interchangeable: ask for a new value.
                  const v = e.target.value
                  setForm((f) => ({ ...f, shop_supplies_type: v, shop_supplies_rate: v === settings.shop_supplies_type ? toForm(settings).shop_supplies_rate : '' }))
                }}
                options={[{ value: 'percent', label: t('settings.ssPercent') }, { value: 'fixed', label: t('settings.ssFixed') }]} />
              {pct ? (
                <Input label={t('settings.ssRate')} value={form.shop_supplies_rate} onChange={set('shop_supplies_rate')} disabled={dis} inputMode="decimal" suffix="%" error={errors.shop_supplies_rate} />
              ) : (
                <Input label={t('settings.ssAmount')} value={form.shop_supplies_rate} onChange={set('shop_supplies_rate')} disabled={dis} inputMode="numeric" prefix="Rp" error={errors.shop_supplies_rate} />
              )}
              <Select label={t('settings.ssBase')} value={form.shop_supplies_base} onChange={set('shop_supplies_base')} disabled={dis || !pct}
                options={[{ value: 'parts_labor', label: t('settings.base.parts_labor') }, { value: 'parts', label: t('settings.base.parts') }, { value: 'labor', label: t('settings.base.labor') }]} />
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Input label={t('settings.ssMin')} value={form.shop_supplies_min} onChange={set('shop_supplies_min')} disabled={dis || !pct} inputMode="numeric" prefix="Rp" error={errors.shop_supplies_min} />
                <Input label={t('settings.ssMax')} value={form.shop_supplies_max} onChange={set('shop_supplies_max')} disabled={dis || !pct} inputMode="numeric" prefix="Rp" error={errors.shop_supplies_max} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <Toggle checked={form.shop_supplies_taxable} onChange={set('shop_supplies_taxable')} disabled={dis} label={t('settings.ssTaxable')} />
            </div>
            <div className="hint">{t('settings.ssHint')}</div>
            {pct && settings.shop_supplies_rate != null && (
              <div className="hint">{t('settings.ssExample', { base: rp(1431500), rate: form.shop_supplies_rate || '0', fee: rp(exampleFee(form)) })}</div>
            )}

            <div className="sectionlabel">{t('settings.tax')}</div>
            <div className="grid3">
              <Input label={t('settings.taxName')} value={form.tax_name} onChange={set('tax_name')} disabled={dis} error={errors.tax_name} />
              <Input label={t('settings.taxRate')} value={form.tax_rate} onChange={set('tax_rate')} disabled={dis} inputMode="decimal" suffix="%" error={errors.tax_rate} />
              <Select label={t('settings.newItems')} value={form.new_items_taxable ? 'yes' : 'no'} onChange={(e) => set('new_items_taxable')(e.target.value === 'yes')} disabled={dis}
                options={[{ value: 'no', label: t('settings.notTaxable') }, { value: 'yes', label: t('settings.taxable') }]} />
            </div>
            {form.pkp_status === 'non_pkp' && <Notice kind="warn" style={{ marginTop: 12 }}>{t('settings.nonPkpNote')}</Notice>}
          </Card>

          <LaborRates id="set-labor" />
          <Users id="set-users" />

          {editable && dirty && (
            <div className="savebar">
              <Icon name="info" size={16} color="var(--amber)" />
              <span style={{ fontWeight: 700 }}>{t('settings.unsaved')}</span>
              <div className="spacer" />
              <Button onClick={() => { setForm(toForm(settings)); setErrors({}) }}>{t('settings.discard')}</Button>
              <Button variant="primary" onClick={save} loading={busy}>{t('settings.save')}</Button>
            </div>
          )}
        </div>
      </div>
    </Page>
  )
}

// Worked example under the shop-supplies fields (the prototype's job 100042: base Rp 1.431.500).
function exampleFee(f) {
  const rate = parseDecimal(f.shop_supplies_rate) || 0
  let fee = Math.round(1431500 * rate / 100)
  const mn = readAmount(f.shop_supplies_min)
  const mx = readAmount(f.shop_supplies_max)
  if (mn !== null && !Number.isNaN(mn) && fee < mn) fee = mn
  if (mx !== null && !Number.isNaN(mx) && fee > mx) fee = mx
  return fee
}
