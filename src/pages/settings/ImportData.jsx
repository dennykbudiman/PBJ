import React, { useRef, useState } from 'react'
import { Button, Card, Notice, Select, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { supabase, errorText } from '../../lib/supabase'
import { shopToday } from '../../lib/customers'
import { selectAll } from '../customers/useCustomerData'
import { COLUMNS, IMPORT_PERMISSION, IMPORT_TYPES, checkRows, loadRows, parseCsv, readTable, templateCsv } from '../../lib/importer'

// Settings → Import data: download a template, fill it in a spreadsheet, save as CSV and load it here.
// Every row is checked first; nothing is loaded while a row has a problem.
export default function ImportData({ id }) {
  const { t } = useT()
  const toast = useToast()
  const { can } = useAuth()
  const { settings, timezone } = useShop()
  const types = IMPORT_TYPES.filter((x) => can(IMPORT_PERMISSION[x]))
  const [type, setType] = useState(types[0] || 'suppliers')
  const [check, setCheck] = useState(null) // { file, rows, skipped, errors, unknown, ctx } | { file, problem }
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const input = useRef(null)
  if (!types.length) return null

  const help = (k) => t(`imp.help.${k}`).split('|')
  function download() {
    const blob = new Blob([templateCsv(type, help(type))], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `axle-${type}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // What Axle already has, to find the companies, vehicles, suppliers and parts that rows point at.
  async function context() {
    const q = (table, cols) => selectAll(() => supabase.from(table).select(cols).order('id'))
    const [customers, vehicles, suppliers, categories, items, templates, schedules, stock] = await Promise.all([
      q('customers', 'id, display_name'), q('vehicles', 'id, plate, vin'), q('suppliers', 'id, name'), q('categories', 'id, name'),
      q('catalog_items', 'id, item_type, name, code, track_inventory'), q('service_templates', 'id, name'), q('service_schedules', 'id, vehicle_id, name'),
      q('stock_movements', 'catalog_item_id, reason, qty_change'),
    ])
    const failed = [customers, vehicles, suppliers, categories, items, templates, schedules, stock].find((r) => r.error)
    if (failed) throw failed.error
    return {
      customers: customers.data, vehicles: vehicles.data, suppliers: suppliers.data, categories: categories.data, items: items.data,
      templates: templates.data, schedules: schedules.data,
      stockMoves: stock.data.reduce((m, x) => { (m[x.catalog_item_id] ||= []).push(x); return m }, {}),
      settings, today: shopToday(timezone),
    }
  }

  async function pick(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setProgress(null)
    if (file.size > 5 * 1024 * 1024) return setCheck({ file: file.name, problem: t('imp.tooBig') })
    setBusy(true)
    try {
      const table = readTable(type, parseCsv(await file.text()))
      if (table.error === 'empty') return setCheck({ file: file.name, problem: t('imp.empty') })
      if (table.error === 'missingColumns') return setCheck({ file: file.name, problem: t('imp.missingColumns', { cols: table.columns.join(', ') }) })
      if (!table.records.length) return setCheck({ file: file.name, problem: t('imp.noRows') })
      const ctx = await context()
      setCheck({ file: file.name, unknown: table.unknown, ctx, ...checkRows(type, table.records, ctx) })
    } catch (err) {
      setCheck({ file: file.name, problem: errorText(err, t) })
    } finally {
      setBusy(false)
    }
  }

  async function load() {
    setBusy(true)
    setProgress(0)
    const res = await loadRows(supabase, type, check.rows, check.ctx, setProgress)
    setBusy(false)
    if (res.error) {
      toast(errorText(res.error, t), 'err')
      setCheck({ file: check.file, problem: t('imp.stopped', { done: res.done, total: check.rows.length, error: errorText(res.error, t) }) })
      return
    }
    toast(t('imp.done', { n: res.done }))
    setCheck(null)
  }

  const msg = (e) => t(`imp.err.${e.code}`, { ...e.vars, col: e.vars.col || '' })
  return (
    <Card title={t('settings.nav.import')} id={id}>
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.55 }}>{t('imp.intro')}</p>
      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div style={{ minWidth: 220 }}>
          <Select label={t('imp.what')} value={type} onChange={(e) => { setType(e.target.value); setCheck(null); setProgress(null) }}
            options={types.map((x) => ({ value: x, label: t(`imp.type.${x}`) }))} />
        </div>
        <Button icon="download" onClick={download}>{t('imp.template')}</Button>
        <Button variant="primary" icon="upload" loading={busy && progress === null} onClick={() => input.current?.click()}>{t('imp.choose')}</Button>
        <input ref={input} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={pick} data-testid="import-file" />
      </div>
      <div className="hint">{t('imp.columns', { cols: COLUMNS[type].join(', ') })}</div>
      <div className="hint">{t(`imp.order`)}</div>
      <div className="hint">{t('imp.excelTip')}</div>

      {check?.problem && <Notice kind="err" style={{ marginTop: 12 }}>{check.file}: {check.problem}</Notice>}
      {check && !check.problem && (
        <div style={{ marginTop: 12 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <b>{check.file}</b>
            <span className="muted">{t('imp.summary', { ok: check.rows.length, skipped: check.skipped, bad: check.errors.length })}</span>
          </div>
          {check.unknown?.length > 0 && <Notice kind="warn" style={{ marginTop: 8 }}>{t('imp.unknownColumns', { cols: check.unknown.join(', ') })}</Notice>}
          {check.errors.length > 0 ? (
            <Notice kind="err" style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('imp.fixFirst')}</div>
              <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflowY: 'auto' }}>
                {check.errors.slice(0, 100).map((e, i) => <li key={i}>{t('imp.rowN', { n: e.row })}: {msg(e)}</li>)}
              </ul>
              {check.errors.length > 100 && <div className="small">{t('imp.more', { n: check.errors.length - 100 })}</div>}
            </Notice>
          ) : check.rows.length > 0 ? (
            <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
              <Button variant="primary" icon="check" loading={busy} onClick={load}>{t('imp.load', { n: check.rows.length })}</Button>
              {progress !== null && <span className="muted small">{t('imp.progress', { done: progress, total: check.rows.length })}</span>}
            </div>
          ) : (
            <Notice kind="info" style={{ marginTop: 8 }}>{t('imp.nothingNew')}</Notice>
          )}
        </div>
      )}
      <div className="hint" style={{ marginTop: 10 }}><Icon name="info" size={12} /> {t('imp.noBalances')}</div>
    </Card>
  )
}
