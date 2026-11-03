import React, { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { translate } from '../lib/i18n'
import { fmtDateTime } from '../lib/format'

// "Dicetak oleh Budi · 3 Nov 2026 23.47" at the bottom of every printout (Nov 3, Denny), in the document's language.
// The time is when it is printed (or saved as PDF), not when the page was opened.
export default function PrintedBy({ lang, timezone }) {
  const { profile } = useAuth()
  const [when, setWhen] = useState(() => new Date())
  useEffect(() => {
    // The browser takes its picture of the page right after this event, so the new time must be drawn at once.
    const now = () => flushSync(() => setWhen(new Date()))
    window.addEventListener('beforeprint', now)
    return () => window.removeEventListener('beforeprint', now)
  }, [])
  const name = profile?.name || profile?.username
  if (!name) return null
  return <div className="doc-printedby">{translate(lang, 'pr.printedBy', { name, when: fmtDateTime(when, lang, timezone) })}</div>
}
