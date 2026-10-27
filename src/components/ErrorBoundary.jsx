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

export default function ErrorBoundary({ children }) {
  const { pathname } = useLocation()
  return <Boundary key={pathname}>{children}</Boundary>
}
