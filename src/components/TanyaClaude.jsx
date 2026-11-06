import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Icon from './Icon'
import { Spinner } from './ui'
import { supabase, errorText } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { currentPageTitle, usePageTitleText } from '../lib/branding'

// "Tanya Claude" (migration 140): the icon in the top bar opens a side panel where anyone signed in can ask about
// the app or the shop's data. The server function (ask-claude) answers with read-only lookups made as this person.
// The conversation stays while the panel is used on other pages, and is gone after a reload.

export const TANYA_STATUS_EVENT = 'tanya:status'

const LINK_PATH = {
  job: (id) => `/jobs/${id}`,
  po: (id) => `/inventory/purchase-orders/${id}`,
  part: (id) => `/inventory/stock/${id}`,
  company: (id) => `/customers/${id}`,
  vehicle: (id) => `/customers/vehicles/${id}`,
}

// The answer's small formatting: paragraphs, numbered and bulleted lists, **bold**. Built as elements, never as HTML.
function inline(text, key) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={`${key}-${i}`}>{part.slice(2, -2)}</b> : <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>)
}
export function AnswerText({ text }) {
  const blocks = []
  let list = null
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  lines.forEach((raw, n) => {
    const line = raw.trim()
    const num = line.match(/^(\d+)[.)]\s+(.*)$/)
    const bullet = line.match(/^[-*•]\s+(.*)$/)
    if (num || bullet) {
      const kind = num ? 'ol' : 'ul'
      if (!list || list.kind !== kind) { list = { kind, items: [], key: n }; blocks.push(list) }
      list.items.push(num ? num[2] : bullet[1])
      return
    }
    list = null
    if (!line) return
    const last = blocks[blocks.length - 1]
    if (last && last.kind === 'p' && lines[n - 1]?.trim()) last.text += '\n' + line
    else blocks.push({ kind: 'p', text: line, key: n })
  })
  return blocks.map((b) => b.kind === 'p'
    ? <p key={b.key}>{b.text.split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{inline(l, `${b.key}-${i}`)}</React.Fragment>)}</p>
    : React.createElement(b.kind, { key: b.key }, b.items.map((it, i) => <li key={i}>{inline(it, `${b.key}-${i}`)}</li>)))
}

export async function askClaude(body) {
  const { data, error } = await supabase.functions.invoke('ask-claude', { body })
  if (!error) return { data }
  let message = null
  try { message = (await error.context?.json())?.error } catch { /* not JSON */ }
  return { error: message || null, raw: error }
}

let nextKey = 1

// The panel's state lives outside React's tree: every page change remounts the app (ErrorBoundary is keyed by page),
// and the conversation, an open panel and an answer still on its way must survive that.
let state = { userId: null, enabled: false, open: false, items: [], text: '' }
const subs = new Set()
function update(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  subs.forEach((fn) => fn())
}
const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn) }
const snapshot = () => state

export default function TanyaClaude() {
  const { t, lang } = useT()
  const { profile, isFleet } = useAuth()
  const location = useLocation()
  // items: { key, q, a, id, model, escalated, links, lookups, rating, error, pending, retryOf }
  const { enabled, open, items, text, userId } = useSyncExternalStore(subscribe, snapshot)
  const setOpen = (v) => update((s) => ({ open: typeof v === 'function' ? v(s.open) : v }))
  const setItems = (fn) => update((s) => ({ items: typeof fn === 'function' ? fn(s.items) : fn }))
  const setText = (v) => update({ text: v })
  const busy = items.some((m) => m.pending)
  // another person signed in on this browser: start empty
  useEffect(() => {
    if (profile?.id && userId !== profile.id) update({ userId: profile.id, enabled: false, open: false, items: [], text: '' })
  }, [profile?.id, userId])
  const box = useRef(null)
  const scroller = useRef(null)
  const iconRef = useRef(null)
  const pageLabel = usePageTitleText()
  const close = () => { setOpen(false); setTimeout(() => iconRef.current?.focus(), 0) }

  const check = useCallback(async () => {
    const { data } = await supabase.rpc('tanya_status')
    update({ enabled: !!data?.enabled })
  }, [])
  useEffect(() => {
    check()
    const on = () => check()
    window.addEventListener(TANYA_STATUS_EVENT, on)
    return () => window.removeEventListener(TANYA_STATUS_EVENT, on)
  }, [check, profile?.id])
  useEffect(() => {
    if (!open) return undefined
    // Escape closes the panel, unless a dialog is open on top of the page
    const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.overlay')) close() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [items, open])

  if (!enabled) return null

  async function send(question, retryOf = null) {
    const q = String(question || '').trim()
    if (!q || busy) return
    const key = nextKey++
    // earlier answers in this conversation (the server reads them back from the person's own log); a retried pair is
    // left out, so the careful answer isn't steered by the first one
    const historyIds = items.filter((m) => m.id && m.a && !m.error && m.id !== retryOf).slice(-6).map((m) => m.id)
    setItems((list) => [...list.map((m) => (retryOf && m.id === retryOf ? { ...m, retried: true } : m)), { key, q, pending: true, retryOf }])
    if (!retryOf) setText('')
    const { data, error, raw } = await askClaude({
      question: q, page: location.pathname + location.search, pageLabel: currentPageTitle(), historyIds, retryOf, lang,
    })
    setItems((list) => list.map((m) => (m.key !== key ? m : data
      ? { ...m, pending: false, id: data.id, a: data.answer, model: data.model, escalated: data.escalated, links: data.links || [], lookups: data.lookups || [] }
      : { ...m, pending: false, error: error || (raw ? errorText(raw, t) : t('tc.error')) })))
  }
  async function rate(m, rating) {
    const value = m.rating === rating ? null : rating
    setItems((list) => list.map((x) => (x.key === m.key ? { ...x, rating: value } : x)))
    await supabase.rpc('tanya_rate', { p_id: m.id, p_rating: value })
  }
  const examples = isFleet ? ['tc.exF1', 'tc.exF2', 'tc.exF3'] : ['tc.ex1', 'tc.ex2', 'tc.ex3', 'tc.ex4', 'tc.ex5']
  const name = (profile?.name || '').split(' ')[0]

  return (
    <>
      <button ref={iconRef} className={`iconbtn tc-icon${open ? ' on' : ''}`} aria-label={t('tc.button')} title={t('tc.button')} aria-expanded={open}
        onClick={() => { const opening = !open; setOpen(opening); if (opening) setTimeout(() => box.current?.focus(), 50) }}>
        <Icon name="ask" size={21} color="#fff" stroke={1.9} />
      </button>
      {open && (
        <aside className="tc-drawer" role="dialog" aria-label={t('tc.title')}>
          <div className="tc-head">
            <div className="tc-title">
              <span className="tc-spark" aria-hidden="true">C</span>
              <span>{t('tc.title')}</span>
              <span style={{ flex: 1 }} />
              {items.length > 0 && <button className="tc-textbtn" onClick={() => setItems([])} disabled={busy}>{t('tc.clear')}</button>}
              <button className="iconbtn-plain" aria-label={t('tc.close')} title={t('tc.close')} onClick={close}><Icon name="x" size={18} /></button>
            </div>
            <div className="tc-ro">{t('tc.readOnly')}</div>
            {pageLabel && <div className="tc-ctx">{t('tc.onPage', { page: pageLabel })}</div>}
          </div>

          <div className="tc-body" ref={scroller} aria-live="polite">
            {!items.length && (
              <>
                <div className="tc-ai">{t(isFleet ? 'tc.helloFleet' : 'tc.hello', { name: name || '' })}</div>
                <div className="tc-sughead">{t('tc.examples')}</div>
                <div className="tc-sug">
                  {examples.map((k) => <button key={k} onClick={() => send(t(k))}>{t(k)}</button>)}
                </div>
              </>
            )}
            {items.map((m) => (
              <div key={m.key} className="tc-pair">
                {!m.retryOf && <div className="tc-me">{m.q}</div>}
                <div className="tc-who">{t('tc.claude')}{m.escalated && <span className="tc-careful"> · {t('tc.careful')}</span>}</div>
                {m.pending
                  ? <div className="tc-ai tc-wait"><Spinner size={14} /> {t('tc.thinking')}</div>
                  : m.error
                    ? <div className="tc-ai tc-err">{m.error}</div>
                    : (
                      <div className="tc-ai">
                        <AnswerText text={m.a} />
                        {m.links?.length > 0 && (
                          <div className="tc-links">
                            {m.links.filter((l) => LINK_PATH[l.kind] && !(isFleet && (l.kind === 'po' || l.kind === 'part'))).map((l) => (
                              <Link key={l.kind + l.id} className="tc-link" to={LINK_PATH[l.kind](l.id)}
                                onClick={() => { if (window.innerWidth < 700) setOpen(false) }}>{l.label} →</Link>
                            ))}
                          </div>
                        )}
                        <div className="tc-src">
                          <span>{m.lookups?.length ? t('tc.from', { list: m.lookups.join(', ') }) : t('tc.fromNone')}</span>
                          <span style={{ flex: 1 }} />
                          <button className={`tc-rate${m.rating === 1 ? ' on' : ''}`} aria-pressed={m.rating === 1} title={t('tc.good')} aria-label={t('tc.good')} onClick={() => rate(m, 1)}><Icon name="thumbUp" size={14} /></button>
                          <button className={`tc-rate${m.rating === -1 ? ' on' : ''}`} aria-pressed={m.rating === -1} title={t('tc.bad')} aria-label={t('tc.bad')} onClick={() => rate(m, -1)}><Icon name="thumbDown" size={14} /></button>
                        </div>
                      </div>
                    )}
                {!m.pending && !m.error && !m.escalated && !m.retried && m.model === 'haiku' && (
                  <button className="tc-more" disabled={busy} onClick={() => send(m.q, m.id)}>{t('tc.more')}</button>
                )}
              </div>
            ))}
          </div>

          <div className="tc-foot">
            <div className="tc-input">
              <textarea ref={box} rows={2} value={text} maxLength={2000} placeholder={t('tc.placeholder')} aria-label={t('tc.placeholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) } }} />
              <button className="btn primary sm" disabled={busy || !text.trim()} onClick={() => send(text)}>{t('tc.send')}</button>
            </div>
            <div className="tc-log">{t('tc.logged')}</div>
          </div>
        </aside>
      )}
    </>
  )
}
