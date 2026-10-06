import React from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import { FullPageSpinner } from './components/ui'
import { useAuth } from './context/AuthContext'
import Login from './pages/Login'
import SetPassword from './pages/SetPassword'
import AccountPending from './pages/AccountPending'
import ComingSoon, { Dashboard, NotFound } from './pages/ComingSoon'
import Settings from './pages/settings/Settings'
import CustomersArea from './pages/customers/CustomersArea'
import SearchPage from './pages/SearchPage'
import CatalogArea from './pages/catalog/CatalogArea'
import JobsArea from './pages/jobs/JobsArea'

// Old-style links (/vehicles/<id>, e.g. from notifications) open the vehicle under Customers.
function VehiclesRedirect() {
  const rest = useLocation().pathname.replace(/^\/vehicles/, '')
  return <Navigate to={`/customers/vehicles${rest}`} replace />
}

export default function App() {
  const { session, loading, needsPasswordSetup, isStaff } = useAuth()

  if (loading) return <FullPageSpinner />
  if (!session) return <Login />
  if (needsPasswordSetup) return <SetPassword />
  if (!isStaff) return <AccountPending />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="board" element={<ComingSoon titleKey="nav.board" stage="board" icon="layout-kanban" />} />
        <Route path="calendar" element={<ComingSoon titleKey="nav.calendar" stage="board" icon="calendar" />} />
        <Route path="customers/*" element={<CustomersArea />} />
        <Route path="vehicles/*" element={<VehiclesRedirect />} />
        <Route path="catalog/*" element={<CatalogArea />} />
        <Route path="jobs/*" element={<JobsArea />} />
        <Route path="inventory/*" element={<ComingSoon titleKey="nav.inventory" stage="inventory" icon="packages" />} />
        <Route path="reports/*" element={<ComingSoon titleKey="nav.reports" stage="reports" icon="chart-bar" />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="set-password" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
