import React from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { colors } from '../lib/theme'

const NAV_ITEMS = [
  {
    to: '/', label: 'Dashboard', end: true,
    icon: (
      <>
        <rect x="3" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="3" width="8" height="5" rx="1.5" />
        <rect x="13" y="11" width="8" height="10" rx="1.5" />
        <rect x="3" y="14" width="8" height="7" rx="1.5" />
      </>
    ),
  },
  {
    to: '/vehicles', label: 'Vehicles',
    icon: (
      <>
        <path d="M3 16V7a1 1 0 0 1 1-1h9v10" />
        <path d="M13 10h4.5l3.5 3.5V16h-2" />
        <path d="M3 16h1" />
        <circle cx="7" cy="17.5" r="1.8" />
        <circle cx="17" cy="17.5" r="1.8" />
      </>
    ),
  },
  {
    to: '/calendar', label: 'Calendar',
    icon: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18" />
        <path d="M8 3v4M16 3v4" />
      </>
    ),
  },
  {
    to: '/work-orders', label: 'Work Orders',
    icon: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1H9z" />
        <path d="M8.5 13l2 2 4.5-4.5" />
      </>
    ),
  },
  {
    to: '/invoices', label: 'Invoices',
    icon: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
  },
  {
    to: '/parts', label: 'Parts',
    icon: (
      <>
        <path d="M21 8l-9-5-9 5 9 5 9-5z" />
        <path d="M3 8v8l9 5 9-5V8" />
        <path d="M12 13v8" />
      </>
    ),
  },
  {
    to: '/drivers', label: 'Drivers',
    icon: (
      <>
        <circle cx="9" cy="7.5" r="3.3" />
        <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
        <circle cx="18" cy="9" r="2.6" />
        <path d="M15.8 20a5 5 0 0 1 6.7-4.7" />
      </>
    ),
  },
  {
    to: '/fleet-groups', label: 'Fleet Groups',
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
  },
  {
    to: '/technicians', label: 'Technicians',
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20a8 8 0 0 1 16 0" />
        <path d="M9.5 8l1.7 1.7L14.5 6.5" />
      </>
    ),
  },
]

function NavIcon({ children }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {children}
    </svg>
  )
}

function linkStyle(isActive) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 12px',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: isActive ? 700 : 500,
    background: isActive ? colors.accentBg : 'transparent',
    color: isActive ? colors.accent : '#4B505A',
    position: 'relative',
  }
}

export default function Sidebar() {
  const { profile, signOut } = useAuth()
  const initials = (profile?.name || 'U')
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div
      style={{
        width: 264,
        height: '100vh',
        position: 'fixed',
        top: 0,
        left: 0,
        background: colors.white,
        borderRight: '1px solid rgba(28,30,34,0.10)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
      }}
    >
      <div style={{ padding: '24px 20px 20px 20px', display: 'flex', flexDirection: 'column', gap: 2, borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: colors.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17h1a2 2 0 1 0 4 0h8a2 2 0 1 0 4 0h1v-5l-3-5H7L3 12z" />
              <path d="M14 12V7" />
            </svg>
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' }}>Axle</div>
        </div>
        <div style={{ fontSize: 12, color: colors.mutedLight, paddingLeft: 42 }}>Fleet Maintenance</div>
      </div>

      <div style={{ margin: '14px 16px 4px 16px', padding: '9px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 9, fontSize: 13, fontWeight: 600 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Meridian Auto Group</span>
      </div>

      <nav aria-label="Primary" style={{ flex: '1 1 auto', padding: 12, overflowY: 'auto' }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} style={({ isActive }) => linkStyle(isActive)}>
                <NavIcon>{item.icon}</NavIcon>
                {item.label}
              </NavLink>
            </li>
          ))}
          <li style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
            <NavLink to="/settings" style={({ isActive }) => linkStyle(isActive)}>
              <NavIcon>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 1 1-2.9 2.9l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V20a2.05 2.05 0 1 1-4.1 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2.05 2.05 0 1 1-2.9-2.9l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H4a2.05 2.05 0 1 1 0-4.1h.09a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2.05 2.05 0 1 1 2.9-2.9l.06.06a1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1.03-1.56V4a2.05 2.05 0 1 1 4.1 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2.05 2.05 0 1 1 2.9 2.9l-.06.06a1.7 1.7 0 0 0-.34 1.87V10a1.7 1.7 0 0 0 1.56 1.03H20a2.05 2.05 0 1 1 0 4.1h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
              </NavIcon>
              Settings
            </NavLink>
          </li>
        </ul>
      </nav>

      <div style={{ padding: '14px 16px 18px 16px', borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: 999, background: colors.accentBg, color: colors.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
          {initials}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {profile?.name || 'Loading…'}
          </div>
          <button
            type="button"
            onClick={() => signOut()}
            style={{ fontSize: 12, color: colors.mutedLight, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
