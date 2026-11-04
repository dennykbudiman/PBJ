import React from 'react'
import { useLocation } from 'react-router-dom'
import { useT } from '../lib/i18n'

// If a page fails while drawing (unexpected data, a bug), show a message with a way back instead of a blank white
// page. Going to another page clears it.
class Boundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error, info) {
    console.error('Axle page error', error, info?.componentStack)
  }
  componentDidUpdate(prev) {
    // Opening another record from the same list keeps the page, so clear a failure here too.
    if (this.state.failed && prev.pathname !== this.props.pathname) this.setState({ failed: false })
  }
  render() {
    return this.state.failed ? <Fallback /> : this.props.children
  }
}

function Fallback() {
  const { t } = useT()
  return (
    <div className="card" style={{ maxWidth: 520, margin: '60px auto', padding: 24 }} role="alert">
      <h2 style={{ marginTop: 0 }}>{t('err.pageTitle')}</h2>
      <p className="muted" style={{ lineHeight: 1.55 }}>{t('err.pageText')}</p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>{t('err.reload')}</button>
        <a className="btn" href="/">{t('err.home')}</a>
      </div>
    </div>
  )
}

// The pages are drawn fresh on every new address, except between a list and a record opened from it (Nov 4, Denny):
// /customers ↔ /customers/<id>, /customers/vehicles ↔ /customers/vehicles/<id>, /catalog/<tab> ↔ /catalog/<tab>/<id>.
// There the list keeps its search and filters (e.g. the company filter on Vehicles); the record's panel is keyed by
// its id, so it still starts fresh for each record.
const CUSTOMER_TABS = ['vehicles', 'service-due', 'repair-orders', 'invoices', 'payments', 'deferred']
export function pageKey(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'customers') {
    if (parts.length === 2 && !CUSTOMER_TABS.includes(parts[1])) return '/customers'
    if (parts[1] === 'vehicles') return '/customers/vehicles'
  }
  if (parts[0] === 'catalog') return `/catalog/${parts[1] || 'parts'}` // "/catalog" shows Parts
  return pathname
}

export default function ErrorBoundary({ children }) {
  const { pathname } = useLocation()
  return <Boundary key={pageKey(pathname)} pathname={pathname}>{children}</Boundary>
}
