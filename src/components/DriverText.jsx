import React from 'react'

// A driver as "Supriyanto · 0812-6234-7892", with the phone as a link that calls on a phone (migration 136).
export function DriverText({ name, phone }) {
  const tel = (phone || '').replace(/[^\d+]/g, '')
  return (
    <span>
      {name}
      {name && phone ? ' · ' : ''}
      {phone && (tel.length >= 6 ? <a className="plainlink" href={`tel:${tel}`}>{phone}</a> : phone)}
    </span>
  )
}
