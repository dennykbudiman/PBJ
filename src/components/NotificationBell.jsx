import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from './Icon'
import { usePopover } from './ui'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { timeAgo } from '../lib/format'

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
      .select('id, type, severity, title, body, entity_type, entity_id, user_id, read_at, created_at')
      .order('created_at', { ascending: false })
      .limit(30)
    if (!error) setItems(data ?? [])
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 60000)
    return () => clearInterval(timer)
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
              <button key={n.id} className="menuitem" style={{ alignItems: 'flex-start', fontWeight: 500, background: isUnread(n) ? '#F7FBFA' : undefined }} onClick={() => open(n)}>
                <span style={{ width: 8, height: 8, borderRadius: 99, marginTop: 5, flexShrink: 0, background: isUnread(n) ? SEVERITY_DOT[n.severity] || SEVERITY_DOT.info : 'transparent' }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: isUnread(n) ? 800 : 600 }}>{n.title}</span>
                  {n.body && <span className="muted small" style={{ display: 'block', marginTop: 2, whiteSpace: 'normal' }}>{n.body}</span>}
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
