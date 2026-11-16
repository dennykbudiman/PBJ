import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useT } from '../lib/i18n'
import { supabase, errorText } from '../lib/supabase'
import { useShop } from '../context/ShopContext'
import { shopToday } from '../lib/customers'
import { periodRange } from '../lib/reports'
import { payerBookLabel } from '../lib/books'
import { fmtDate } from '../lib/format'
import { Button, Modal, Notice, Select } from './ui'

// Update 150 (item 53): "Tagihan bulanan" on the Dasbor. Pick the period (last month by default), one book or all of
// them, and how drum oil is billed; opens /print/statement. Owner/Admin see every book, a PT's fleet login (with
// "Lihat tagihan & biaya" on) only its own books — the database decides which (statement_books).
export default function StatementMenu({ back = '/' }) {
  const { t, lang } = useT()
  const { settings, timezone } = useShop()
  const navigate = useNavigate()
  const today = shopToday(timezone)
  const [open, setOpen] = useState(false)
  const [preset, setPreset] = useState('last_month')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [mode, setMode] = useState(settings?.statement_drum_mode || 'month')
  const [books, setBooks] = useState(null)
  const [pick, setPick] = useState('')
  const [error, setError] = useState(null)
  const { from, to } = periodRange(preset, today, custom)
  useEffect(() => { if (open) setMode(settings?.statement_drum_mode || 'month') }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined
    let live = true
    setBooks(null); setError(null)
    supabase.rpc('statement_books', { p_from: from, p_to: to }).then(({ data, error: err }) => {
      if (!live) return
      setError(err || null)
      const list = data || []
      setBooks(list)
      setPick((p) => (list.some((b) => `${b.payer}|${b.book}` === p) ? p : list.length === 1 ? `${list[0].payer}|${list[0].book}` : ''))
    })
    return () => { live = false }
  }, [open, from, to])

  function go(all) {
    const p = new URLSearchParams({ from, to, mode, back })
    if (all) p.set('all', '1')
    else { const [payer, book] = pick.split('|'); p.set('payer', payer); p.set('book', book) }
    navigate(`/print/statement?${p.toString()}`)
  }
  const presets = ['last_month', 'this_month', 'custom']
  return (
    <>
      <Button icon="print" onClick={() => setOpen(true)}>{t('u150.st.menu')}</Button>
      <Modal open={open} title={t('u150.st.menuTitle')} onClose={() => setOpen(false)}
        footer={<>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          {(books || []).length > 1 && <Button onClick={() => go(true)}>{t('u150.st.printAll')}</Button>}
          <Button variant="primary" onClick={() => go(false)} disabled={!pick}>{t('u150.st.print')}</Button>
        </>}>
        <div className="field">
          <label>{t('u150.st.period')}</label>
          <div className="seg" role="group">
            {presets.map((k) => <button key={k} type="button" className={`seg-btn ${preset === k ? 'on' : ''}`} onClick={() => setPreset(k)}>{t(`u150.st.p.${k}`)}</button>)}
          </div>
          {preset === 'custom' ? (
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <label className="mini">{t('u145.from')} <input type="date" className="input" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
              <label className="mini">{t('u145.to')} <input type="date" className="input" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
            </div>
          ) : <div className="small muted" style={{ marginTop: 4 }}>{fmtDate(from, lang)} – {fmtDate(to, lang)}</div>}
        </div>
        {error ? <Notice kind="err">{errorText(error, t)}</Notice>
          : !books ? <div className="muted small">{t('common.loading')}</div>
          : books.length === 0 ? <Notice kind="info">{t('u150.st.noBooks')}</Notice>
          : (
            <Select label={t('u143.book')} value={pick} onChange={(e) => setPick(e.target.value)}
              options={[{ value: '', label: t('u150.st.pickBook') }, ...books.map((b) => ({ value: `${b.payer}|${b.book}`,
                label: `${payerBookLabel(b.payer, b.book)}${Number(b.invoices) ? ` · ${t('dash.nInvoices', { n: b.invoices })}` : ''}` }))]} />
          )}
        <div className="field">
          <label>{t('u150.st.drumMode')}</label>
          <div className="seg" role="group">
            {['month', 'drum'].map((m) => <button key={m} type="button" className={`seg-btn ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{t(`u150.st.mode.${m}`)}</button>)}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>{t(`u150.st.modeHint.${mode}`)}</div>
        </div>
        {(books || []).length > 1 && <div className="small muted">{t('u150.st.allHint')}</div>}
      </Modal>
    </>
  )
}
