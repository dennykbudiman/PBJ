import React, { useEffect, useState } from 'react'
import { Button, Card, Input, Notice, Select, Spinner, Toggle, useConfirm, useToast } from '../../components/ui'
import Icon from '../../components/Icon'
import { AnswerText, askClaude, TANYA_STATUS_EVENT } from '../../components/TanyaClaude'
import { supabase, errorText } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { useT } from '../../lib/i18n'
import { num, rp } from '../../lib/format'

// Settings → Tanya Claude (Owner/Admin, migration 140): on/off, model, limits, this month's use, the question log, and
// a side-by-side comparison of Haiku, Sonnet and Opus on the same question.

// Questions for comparing the models on the shop's own data (Denny, Nov 6: 20–30 real staff questions).
export const COMPARE_QUESTIONS = [
  'Truk mana yang paling lama belum keluar, dan kenapa?',
  'Kenapa pekerjaan yang paling lama di bengkel belum bisa dibuatkan invoice?',
  'Berapa liter oli Meditran yang tersisa, dan berapa yang terpakai 7 hari terakhir?',
  'Apa arti "1 di rak" di PO, padahal stoknya sudah habis?',
  'Bagaimana cara menerima part yang sudah datang?',
  'Part apa saja yang perlu dipesan sekarang?',
  'Pekerjaan mana yang sedang menunggu part, dan dari supplier mana?',
  'Hari ini sudah berapa invoice dibuat dan berapa uang masuk?',
  'Invoice mana yang sudah lewat jatuh tempo?',
  'Kendaraan mana yang paling sering masuk bengkel, dan untuk apa saja?',
  'Saya service advisor, kenapa saya tidak bisa mencatat pembayaran?',
  'Bagaimana cara membatalkan invoice yang salah?',
  'Ubah harga filter di pekerjaan terakhir jadi 90.000',
  'Hapus pekerjaan yang masih kosong',
  'Kenapa stok oli bulk minus?',
  'Bagaimana cara menambahkan part yang diketik manual ke katalog?',
  'Mekanik siapa yang paling banyak pekerjaan terbuka sekarang?',
  'Ada janji servis apa saja minggu ini?',
  'Tagihan supplier mana yang jatuh tempo dalam 7 hari?',
  'PO mana yang belum dikirim ke supplier?',
  'Kendaraan mana yang sudah waktunya servis berkala?',
  'Berapa total piutang semua perusahaan?',
  'Bagaimana cara memindahkan kendaraan ke PT lain?',
  'Apa beda "Di rak" dan "Tersedia"?',
  'Kenapa status pekerjaan tidak berubah jadi Sudah datang?',
]

const MODEL_NAME = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

export default function TanyaSettings({ id }) {
  const { t, lang } = useT()
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const { timezone } = useShop()
  const [month, setMonth] = useState(null) // first day, YYYY-MM-DD; null = this month
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [openRow, setOpenRow] = useState(null)
  const [detail, setDetail] = useState(null) // the open row's answer, lookups and tokens (read when opened)
  const [cq, setCq] = useState('')
  const [cmp, setCmp] = useState([]) // [{ q, results }]
  const [cmpBusy, setCmpBusy] = useState(null) // { i, n }

  async function load(m = month) {
    const { data: d, error } = await supabase.rpc('tanya_overview', m ? { p_month: m } : {})
    if (error) return setLoadError(errorText(error, t))
    setLoadError(null)
    setData(d)
    setForm((f) => f || toForm(d.settings))
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const locale = lang === 'id' ? 'id-ID' : 'en-GB'
  const whenText = new Intl.DateTimeFormat(locale, { timeZone: timezone || 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format
  const monthText = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format
  const monthName = (d) => monthText(new Date(d + 'T00:00:00Z'))
  function shiftMonth(by) {
    const d = new Date((data?.month || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z')
    d.setUTCMonth(d.getUTCMonth() + by)
    const m = d.toISOString().slice(0, 8) + '01'
    setMonth(m); setOpenRow(null); load(m)
  }

  async function save() {
    const daily = parseInt(form.daily_limit, 10), cap = Number(String(form.monthly_cap_idr).replace(/\D/g, '')), rate = Number(String(form.idr_per_usd).replace(/\D/g, ''))
    setSaving(true)
    const { error } = await supabase.rpc('tanya_save_settings', { p_enabled: form.enabled, p_daily_limit: daily, p_monthly_cap_idr: cap, p_idr_per_usd: rate, p_model_mode: form.model_mode })
    setSaving(false)
    if (error) return toast(errorText(error, t), 'err')
    toast(t('tcs.saved'))
    window.dispatchEvent(new Event(TANYA_STATUS_EVENT))
    setForm(null)
    load()
  }

  async function compare(questions) {
    const list = questions.map((q) => q.trim()).filter(Boolean)
    if (!list.length) return
    for (let i = 0; i < list.length; i++) {
      setCmpBusy({ i: i + 1, n: list.length })
      const { data: d, error } = await askClaude({ question: list[i], mode: 'compare', lang })
      setCmp((c) => [{ q: list[i], results: d?.results || [], error: d ? null : error || t('tc.error') }, ...c])
    }
    setCmpBusy(null)
    load()
  }
  async function compareAll() {
    const ok = await confirm({ title: t('tcs.compareAll', { n: COMPARE_QUESTIONS.length }), text: t('tcs.compareHint') })
    if (ok) compare(COMPARE_QUESTIONS)
  }

  const rate = Number(data?.settings?.idr_per_usd || 16500)
  const idr = (usd) => rp(Number(usd || 0) * rate)
  async function toggleRow(rowId) {
    if (openRow === rowId) { setOpenRow(null); return }
    setOpenRow(rowId); setDetail(null)
    const { data: d } = await supabase.from('tanya_log').select('id, answer, tools, error, escalation_reason, input_tokens, output_tokens, cache_read_tokens, cost_usd').eq('id', rowId).maybeSingle()
    setDetail(d || { id: rowId })
  }
  const dirty = form && data && JSON.stringify(form) !== JSON.stringify(toForm(data.settings))

  return (
    <Card title={t('settings.nav.tanya')} id={id}>
      {confirmEl}
      <div className="hint" style={{ marginTop: 0, marginBottom: 12 }}>{t('tcs.sub')}</div>
      {loadError && <Notice kind="error">{loadError}</Notice>}
      {!data && !loadError && <Spinner />}
      {data && form && (
        <>
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <button className="iconbtn-plain" aria-label={t('tcs.prevMonth')} title={t('tcs.prevMonth')} onClick={() => shiftMonth(-1)}><Icon name="chevronLeft" size={16} /></button>
            <b>{t('tcs.month')}: {monthName(data.month)}</b>
            <button className="iconbtn-plain" aria-label={t('tcs.nextMonth')} title={t('tcs.nextMonth')} onClick={() => shiftMonth(1)}><Icon name="chevronRight" size={16} /></button>
          </div>
          <div className="tcs-stats">
            <div className="tcs-stat">
              <div className="k">{t('tcs.questions')}</div>
              <div className="v">{num(data.questions)}</div>
              <div className="s">{data.by_person.slice(0, 4).map((p) => `${(p.name || '').split(' ')[0]}${p.role === 'Fleet manager' ? ' (Fleet)' : ''} ${p.n}`).join(' · ') || '—'}</div>
            </div>
            <div className="tcs-stat">
              <div className="k">{t('tcs.cost')}</div>
              <div className="v">± {idr(data.cost_usd)}</div>
              <div className="s">{t('tcs.capOf', { cap: rp(data.settings.monthly_cap_idr) })}</div>
            </div>
            <div className="tcs-stat">
              <div className="k">{t('tcs.careful')}</div>
              <div className="v">{num(data.sonnet_auto + data.sonnet_staff)}</div>
              <div className="s">{t('tcs.carefulSplit', { a: data.sonnet_auto, s: data.sonnet_staff })}</div>
            </div>
            <div className={`tcs-stat${data.thumbs_down > 0 ? ' warn' : ''}`}>
              <div className="k">{t('tcs.down')}</div>
              <div className="v">{num(data.thumbs_down)}</div>
              <div className="s">{t('tcs.downHint')}</div>
            </div>
          </div>

          <div className="grid2">
            <div className="tcs-form">
              <div className="field"><Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t('tcs.on')} /></div>
              <Select label={t('tcs.model')} value={form.model_mode} onChange={(e) => setForm({ ...form, model_mode: e.target.value })}
                options={['auto', 'sonnet', 'opus'].map((m) => ({ value: m, label: t(`tcs.model.${m}`) }))} />
              <Input label={t('tcs.daily')} type="number" min={0} max={500} value={form.daily_limit} hint={t('tcs.dailyHint')}
                onChange={(e) => setForm({ ...form, daily_limit: e.target.value })} />
              <Input label={t('tcs.cap')} inputMode="numeric" value={form.monthly_cap_idr} hint={t('tcs.capHint')}
                onChange={(e) => setForm({ ...form, monthly_cap_idr: e.target.value.replace(/[^\d.]/g, '') })} />
              <Input label={t('tcs.rate')} inputMode="numeric" value={form.idr_per_usd}
                onChange={(e) => setForm({ ...form, idr_per_usd: e.target.value.replace(/[^\d.]/g, '') })} />
              <div className="field">
                <div className="fieldlabel">{t('tcs.who')}</div>
                <b>{t('tcs.whoAll')}</b>
                <div className="hint">{t('tcs.whoHint')}</div>
              </div>
              <div><Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>{t('tcs.save')}</Button></div>
            </div>
            <div>
              <div className="sectionlabel" style={{ marginTop: 0 }}>{t('tcs.compare')}</div>
              <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{t('tcs.compareHint')}</div>
              <textarea className="textarea" rows={2} value={cq} maxLength={2000} placeholder={t('tc.placeholder')} aria-label={t('tcs.compare')} onChange={(e) => setCq(e.target.value)} />
              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => compare([cq])} disabled={!!cmpBusy || !cq.trim()}>{t('tcs.compareRun')}</Button>
                <Button variant="ghost" onClick={compareAll} disabled={!!cmpBusy}>{t('tcs.compareAll', { n: COMPARE_QUESTIONS.length })}</Button>
                {cmpBusy && <span className="muted"><Spinner size={12} /> {t('tcs.compareBusy', cmpBusy)}</span>}
              </div>
            </div>
          </div>

          {cmp.map((c, i) => (
            <div key={cmp.length - i} className="tcs-detail" style={{ marginTop: 12 }}>
              <b>{c.q}</b>
              {c.error && <Notice kind="error">{c.error}</Notice>}
              <div className="tcs-cmp">
                {c.results.map((r) => (
                  <div key={r.model}>
                    <h4>{MODEL_NAME[r.model]}{r.ms != null && <span className="muted"> · {t('tcs.secs', { s: num(r.ms / 1000, 1) })} · {idr(r.cost_usd)}</span>}</h4>
                    <div className="tc-ai">{r.error ? r.error : <AnswerText text={r.answer} />}</div>
                    {r.lookups?.length > 0 && <div className="hint">{t('tc.from', { list: r.lookups.join(', ') })}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="sectionlabel">{t('tcs.log')}</div>
          {!data.log.length ? <div className="muted">{t('tcs.logEmpty')}</div> : (
            <>
              <div className="table tcs-log">
                <table>
                  <thead><tr><th>{t('tcs.col.when')}</th><th>{t('tcs.col.who')}</th><th>{t('tcs.col.page')}</th><th>{t('tcs.col.q')}</th><th>{t('tcs.col.model')}</th><th /></tr></thead>
                  <tbody>
                    {data.log.map((l) => (
                      <React.Fragment key={l.id}>
                        <tr className="clickable" tabIndex={0} onClick={() => toggleRow(l.id)} aria-expanded={openRow === l.id}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(l.id) } }}>
                          <td style={{ whiteSpace: 'nowrap' }}>{whenText(new Date(l.asked_at))}</td>
                          <td>{l.name}{l.role === 'Fleet manager' && <div className="muted small">Fleet{l.companies ? ` · ${l.companies}` : ''}</div>}</td>
                          <td className="muted">{l.page_label || l.page || '—'}</td>
                          <td className="q">{l.question}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {l.status === 'failed' ? <span className="badge b-red">{t('tcs.failed')}</span>
                              : <>{MODEL_NAME[l.model] || l.model || '—'}
                                {l.escalated && <span className="badge b-blue" style={{ marginLeft: 6 }}>{t(l.escalated === 'auto' ? 'tcs.auto' : 'tcs.staff')}</span>}
                                {l.mode === 'compare' && <span className="badge b-gray" style={{ marginLeft: 6 }}>{t('tcs.compareTag')}</span>}</>}
                          </td>
                          <td>{l.rating === -1 ? <span role="img" aria-label={t('tc.bad')} title={t('tc.bad')}>👎</span> : l.rating === 1 ? <span role="img" aria-label={t('tc.good')} title={t('tc.good')}>👍</span> : ''}</td>
                        </tr>
                        {openRow === l.id && (
                          <tr><td colSpan={6}>
                            {detail?.id !== l.id ? <Spinner size={16} /> : (
                              <div className="tcs-detail">
                                <div className="fieldlabel">{t('tcs.answer')}</div>
                                {l.question.length >= 300 && <div className="muted small">{t('tcs.col.q')}: {l.question}…</div>}
                                <div className="tc-ai">{detail.answer ? <AnswerText text={detail.answer} /> : <span className="muted">{detail.error || '—'}</span>}</div>
                                {detail.tools?.length > 0 && <div className="hint">{t('tcs.lookups')}: {detail.tools.map((x) => x.label).join(', ')}</div>}
                                {detail.escalation_reason && <div className="hint">{t('tcs.reason')}: {reasonText(detail.escalation_reason, t)}</div>}
                                <div className="hint">{t('tcs.tokens', { in: num(detail.input_tokens), out: num(detail.output_tokens), cache: num(detail.cache_read_tokens), cost: idr(detail.cost_usd) })}</div>
                              </div>
                            )}
                          </td></tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="hint">{t('tcs.rowHint')}</div>
            </>
          )}
        </>
      )}
    </Card>
  )
}

function toForm(s) {
  return { enabled: !!s.enabled, model_mode: s.model_mode || 'auto', daily_limit: String(s.daily_limit ?? 30),
    monthly_cap_idr: String(Math.round(Number(s.monthly_cap_idr ?? 300000))), idr_per_usd: String(Math.round(Number(s.idr_per_usd ?? 16500))) }
}
function reasonText(r, t) {
  if (r === 'data_conflict' || r === 'many_lookups') return t(`tcs.reason.${r}`)
  return r
}
