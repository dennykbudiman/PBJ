import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from './Icon'
import { usePopover } from './ui'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { fmtDate, invoiceNo, km, rp, timeAgo } from '../lib/format'

// Broadcast notifications (no user_id) can't be marked read in the database,
// so a viewer's "seen" list for those is kept in this browser only.
const SEEN_KEY = 'axle.seenBroadcasts'
function readSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) } catch { return new Set() }
}
function writeSeen(set) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-300))) } catch { /* storage unavailable */ }
}

const SEVERITY_DOT = { info: '#1D4ED8', warning: '#D97706', urgent: '#E5484D' }

// Where a notification opens, by the record it points at. Routes for later stages
// fall through to their placeholder pages until those screens are built.
function linkFor(n) {
  switch (n.entity_type) {
    case 'repair_order': return n.entity_id ? `/jobs/${n.entity_id}` : null
    case 'vehicle': return n.entity_id ? `/vehicles/${n.entity_id}` : null
    case 'customer': return n.entity_id ? `/customers/${n.entity_id}` : null
    case 'purchase_order': return n.entity_id ? `/inventory/po/${n.entity_id}` : null
    default: return null
  }
}

// Reminders written by the database carry their facts in `data`, so they read in the viewer's language.
function textOf(n, t, lang) {
  const d = n.data
  if (n.type === 'service_due' && d) {
    return {
      title: t(d.status === 'overdue' ? 'rem.serviceOverdue' : 'rem.serviceSoon', { plate: d.plate, name: d.name }),
      body: [d.company, d.next_due_km != null ? t('rem.dueAtKm', { km: km(d.next_due_km) }) : null, d.next_due_date ? t('rem.dueOn', { date: fmtDate(d.next_due_date, lang) }) : null].filter(Boolean).join(' · '),
    }
  }
  if (n.type === 'invoice_overdue' && d) {
    return {
      title: t('rem.invoiceOverdue', { no: invoiceNo(d.invoice_number) }),
      body: [d.company, rp(d.balance), d.due_date ? t('rem.wasDue', { date: fmtDate(d.due_date, lang) }) : null].filter(Boolean).join(' · '),
    }
  }
  return { title: n.title, body: n.body }
}

export default function NotificationBell() {
  const { user } = useAuth()
  const { t, lang } = useT()
  const pop = usePopover()
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [seen, setSeen] = useState(readSeen)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, severity, title, body, entity_type, entity_id, user_id, read_at, created_at, data')
      .order('created_at', { ascending: false })
      .order('id')
      .limit(50)
    if (!error) setItems(data ?? [])
  }, [])

  // Service-due and overdue-invoice reminders are worked out by the database; asking for them is cheap
  // (it runs at most once an hour for the whole shop), so every open app nudges it now and then.
  useEffect(() => {
    let live = true
    const refresh = () => supabase.rpc('refresh_reminders').then(() => { if (live) load() })
    refresh()
    const nudge = setInterval(refresh, 15 * 60000)
    const timer = setInterval(load, 60000)
    return () => { live = false; clearInterval(nudge); clearInterval(timer) }
  }, [load])

  useEffect(() => {
    if (pop.open) load()
  }, [pop.open, load])

  const isUnread = (n) => (n.user_id ? !n.read_at : !seen.has(n.id))
  const unread = items.filter(isUnread).length

  async function markRead(ids) {
    const own = items.filter((n) => ids.includes(n.id) && n.user_id === user?.id && !n.read_at).map((n) => n.id)
    const broadcast = items.filter((n) => ids.includes(n.id) && !n.user_id).map((n) => n.id)
    if (broadcast.length) {
      const next = new Set(seen)
      broadcast.forEach((id) => next.add(id))
      setSeen(next)
      writeSeen(next)
    }
    if (own.length) {
      const now = new Date().toISOString()
      setItems((xs) => xs.map((n) => (own.includes(n.id) ? { ...n, read_at: now } : n)))
      await supabase.from('notifications').update({ read_at: now }).in('id', own)
    }
  }

  function open(n) {
    markRead([n.id])
    const to = linkFor(n)
    if (to) {
      pop.setOpen(false)
      navigate(to)
    }
  }

  return (
    <div className="popwrap" ref={pop.ref}>
      <button className="iconbtn" onClick={pop.toggle} aria-label={t('nav.notifications')} title={t('nav.notifications')}>
        <Icon name="bell" size={20} color="#fff" />
        {unread > 0 && <span className="badge-count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {pop.open && (
        <div className="popover" style={{ width: 360 }}>
          <div className="menuhead row">
            <b style={{ fontSize: 14 }}>{t('notif.title')}</b>
            <div className="spacer" />
            {unread > 0 && (
              <button className="linkbtn small" onClick={() => markRead(items.filter(isUnread).map((n) => n.id))}>
                {t('notif.markAll')}
              </button>
            )}
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {items.length === 0 && <div className="muted small" style={{ padding: '28px 14px', textAlign: 'center' }}>{t('notif.empty')}</div>}
            {items.map((n) => (
              <button key={n.id} className="menuitem" style={{ alignItems: 'flex-start', fontWeight: 500, background: isUnread(n) ? 'var(--accent-soft)' : undefined }} onClick={() => open(n)}>
                <span style={{ width: 8, height: 8, borderRadius: 99, marginTop: 5, flexShrink: 0, background: isUnread(n) ? SEVERITY_DOT[n.severity] || SEVERITY_DOT.info : 'transparent' }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: isUnread(n) ? 800 : 600 }}>{textOf(n, t, lang).title}</span>
                  {textOf(n, t, lang).body && <span className="muted small" style={{ display: 'block', marginTop: 2, whiteSpace: 'normal' }}>{textOf(n, t, lang).body}</span>}
                  <span className="small" style={{ color: 'var(--faint)', display: 'block', marginTop: 3 }}>{timeAgo(n.created_at, lang)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
