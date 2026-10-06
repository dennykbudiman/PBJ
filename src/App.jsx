import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { FullPageSpinner } from './components/ui'
import { useAuth } from './context/AuthContext'
import Login from './pages/Login'
import SetPassword from './pages/SetPassword'
import AccountPending from './pages/AccountPending'
import ComingSoon, { Dashboard, NotFound, SearchPage } from './pages/ComingSoon'
import Settings from './pages/settings/Settings'

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
        <Route path="customers/*" element={<ComingSoon titleKey="nav.customers" stage="customers" icon="users" />} />
        <Route path="vehicles/*" element={<ComingSoon titleKey="nav.vehicles" stage="customers" icon="car" />} />
        <Route path="catalog/*" element={<ComingSoon titleKey="nav.catalog" stage="catalog" icon="book" />} />
        <Route path="jobs/*" element={<ComingSoon titleKey="nav.jobs" stage="jobs" icon="wrench" />} />
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
