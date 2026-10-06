import React, { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import Icon from './Icon'
import NotificationBell from './NotificationBell'
import ProfileModal from './ProfileModal'
import { usePopover } from './ui'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useT } from '../lib/i18n'
import { initials } from '../lib/format'

export const NAV = [
  { to: '/', key: 'nav.dashboard', icon: 'layout-dashboard', end: true },
  { to: '/board', key: 'nav.board', icon: 'layout-kanban' },
  { to: '/calendar', key: 'nav.calendar', icon: 'calendar' },
  { to: '/customers', key: 'nav.customers', icon: 'users' },
  { to: '/catalog', key: 'nav.catalog', icon: 'book' },
  { to: '/inventory', key: 'nav.inventory', icon: 'packages' },
  { to: '/reports', key: 'nav.reports', icon: 'chart-bar' },
]

// The "+" quick-create menu. Each entry switches on as its screen is built.
const CREATE = [
  { key: 'create.job', icon: 'wrench', to: '/jobs/new', perm: 'edit_jobs' },
  { key: 'create.customer', icon: 'users', to: '/customers?new=1', perm: 'edit_customers' },
  { key: 'create.vehicle', icon: 'car', to: '/customers/vehicles?new=1', perm: 'edit_customers' },
  { key: 'create.part', icon: 'book', to: '/catalog/parts/new', perm: 'edit_catalog' },
  { key: 'create.appointment', icon: 'calendar' },
  { key: 'create.po', icon: 'packages' },
]

function Brand() {
  const { shopName, logoUrl } = useShop()
  return (
    <Link to="/" className="brand" title={shopName}>
      <span className="brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : initials(shopName)}</span>
      <span className="brand-name">{shopName}</span>
    </Link>
  )
}

function SearchBox() {
  const { t } = useT()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  return (
    <form className="topsearch" role="search" onSubmit={(e) => { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(q.trim())}`) }}>
      <Icon name="search" size={14} color="var(--muted)" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('nav.search')} aria-label={t('nav.search')} />
    </form>
  )
}

function CreateMenu() {
  const { t } = useT()
  const { can } = useAuth()
  const navigate = useNavigate()
  const pop = usePopover()
  return (
    <div className="popwrap" ref={pop.ref}>
      <button className="plusbtn" onClick={pop.toggle} aria-label={t('create.title')} title={t('create.title')}>
        <Icon name="plus" size={16} stroke={2.6} />
      </button>
      {pop.open && (
        <div className="popover">
          <div className="menuhead small muted" style={{ fontWeight: 700 }}>{t('create.title')}</div>
          {CREATE.map((c) => {
            const ready = Boolean(c.to)
            const allowed = ready && can(c.perm)
            return (
              <button key={c.key} className="menuitem" disabled={!allowed}
                onClick={() => { pop.setOpen(false); navigate(c.to) }}
                title={ready && !allowed ? t('err.permission') : undefined}>
                <Icon name={c.icon} size={16} />
                {t(c.key)}
                {!ready && <span className="soon">{t('common.soon')}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function LangToggle() {
  const { lang, setLang, t } = useT()
  return (
    <div className="langtoggle" role="group" aria-label={t('nav.language')}>
      <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
      <button className={lang === 'id' ? 'on' : ''} onClick={() => setLang('id')}>ID</button>
    </div>
  )
}

function UserMenu() {
  const { t } = useT()
  const { profile, roleName, signOut } = useAuth()
  const pop = usePopover()
  const [editing, setEditing] = useState(false)
  return (
    <div className="popwrap" ref={pop.ref}>
      <button className="avatarbtn" onClick={pop.toggle} aria-label={t('nav.account')} title={profile?.name}>
        {initials(profile?.name)}
      </button>
      {pop.open && (
        <div className="popover">
          <div className="menuhead">
            <div style={{ fontWeight: 800 }}>{profile?.name}</div>
            <div className="muted small">@{profile?.username || '—'} · {roleName ? t(`role.${roleName}`) : ''}</div>
          </div>
          <button className="menuitem" onClick={() => { pop.setOpen(false); setEditing(true) }}>
            <Icon name="user" size={16} />{t('profile.title')}
          </button>
          <div className="menusep" />
          <button className="menuitem" onClick={() => signOut()}>
            <Icon name="logout" size={16} />{t('auth.signOut')}
          </button>
        </div>
      )}
      <ProfileModal open={editing} onClose={() => setEditing(false)} />
    </div>
  )
}

export default function Layout() {
  const { t } = useT()
  return (
    <div className="app">
      <header className="topnav">
        <Brand />
        <nav className="mainnav" aria-label={t('nav.main')}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
              <Icon name={n.icon} size={19} color="#fff" stroke={1.9} />
              {t(n.key)}
            </NavLink>
          ))}
        </nav>
        <div className="topright">
          <SearchBox />
          <NavLink to="/search" className="iconbtn mobile-only" aria-label={t('nav.search')} title={t('nav.search')}>
            <Icon name="search" size={20} color="#fff" />
          </NavLink>
          <CreateMenu />
          <NavLink to="/settings" className="iconbtn" aria-label={t('nav.settings')} title={t('nav.settings')}>
            <Icon name="gear" size={20} color="#fff" />
          </NavLink>
          <NotificationBell />
          <LangToggle />
          <UserMenu />
        </div>
      </header>
      <Outlet />
    </div>
  )
}

// Standard page body with padding; pages with sub-tabs render the tabs above it.
export function Page({ children, tabs }) {
  return (
    <>
      {tabs}
      <main className="content">{children}</main>
    </>
  )
}
