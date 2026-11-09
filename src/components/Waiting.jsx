import React from 'react'
import { Link } from 'react-router-dom'
import { useShop } from '../context/ShopContext'
import { useT } from '../lib/i18n'
import { addDays, clock, dayLabel, shopParts } from '../lib/calendar'
import { shopToday } from '../lib/customers'

// What an open job is waiting for (migration 139, jobs_waiting): one short coloured line that answers
// "why hasn't this truck left yet". Used on the Work board list and on Hari ini.
export const WAIT_COLOR = {
  pickup: 'blue', not_arrived: 'gray', approval: 'amber', part: 'amber', po_draft: 'amber', no_work: 'red',
  no_tech: 'red', work: 'purple', zero_price: 'amber', ready: 'green',
}

// "08.46" today, "Besok 09.00", otherwise "Kam 5 Nov 09.00", on the shop clock.
export function shortWhen(ts, tz, lang, t, { timeToday = false } = {}) {
  if (!ts) return ''
  const p = shopParts(ts, tz)
  const today = shopToday(tz)
  const time = clock(p.minutes, lang)
  if (p.date === today) return timeToday ? t('wait.at', { time }) : t('board.todayAt', { time })
  if (p.date === addDays(today, 1)) return t('board.tomorrowAt', { time })
  return `${dayLabel(p.date, lang)} ${time}`
}

export function waitingText(kind, info, { t, lang, tz }) {
  const i = info || {}
  switch (kind) {
    case 'pickup': return t('wait.pickup')
    case 'not_arrived': return i.appt ? t('wait.notArrivedAppt', { when: shortWhen(i.appt, tz, lang, t) }) : t('wait.notArrived')
    case 'approval': return t('wait.approval', { n: i.pending || 0 })
    case 'part':
      if (!i.part) return t('wait.partNoPo')
      // outside work on a PO (141) reads "Sublet: …"
      return t(i.sublet ? 'wait.sublet' : 'wait.part', {
        part: i.parts > 1 ? t('wait.partMore', { part: i.part, n: i.parts - 1 }) : i.part,
        po: i.po_number || '—', supplier: i.supplier || '—', when: i.ordered_at ? shortWhen(i.ordered_at, tz, lang, t, { timeToday: true }) : '—',
      })
    case 'po_draft': return t('wait.poDraft', { po: i.draft_number || '—' })
    case 'no_work': return t('wait.noWork')
    case 'no_tech': return t('wait.noTech', { n: i.no_tech || 0 })
    case 'work': return i.tech ? t('wait.work', { tech: i.tech, n: i.open || 0, name: i.open_name || '' }) : t('wait.workNoTech', { n: i.open || 0, name: i.open_name || '' })
    case 'zero_price': return t('wait.zero', { n: i.zero || 0 })
    case 'ready': return t('wait.ready')
    default: return ''
  }
}

// The chip. A waiting part links to its PO (and a draft PO to the draft) when the viewer may open purchase orders.
export function WaitingTag({ kind, info, linkPo = true }) {
  const { t, lang } = useT()
  const { timezone } = useShop()
  if (!kind) return <span className="muted">—</span>
  const text = waitingText(kind, info, { t, lang, tz: timezone })
  const po = kind === 'part' ? info?.po_id : kind === 'po_draft' ? info?.draft_id : null
  const chip = <span className={`chip waitchip c-${WAIT_COLOR[kind] || 'gray'}`} title={text}>{text}</span>
  return linkPo && po
    ? <Link to={`/inventory/purchase-orders/${po}`} className="waitlink" onClick={(e) => e.stopPropagation()}>{chip}</Link>
    : chip
}
