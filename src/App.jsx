import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import SetPassword from './pages/SetPassword'
import Dashboard from './pages/Dashboard'
import Vehicles from './pages/Vehicles'
import Maintenance from './pages/Maintenance'
import WorkOrders from './pages/WorkOrders'
import Parts from './pages/Parts'
import Drivers from './pages/Drivers'
import FleetGroups from './pages/FleetGroups'
import Technicians from './pages/Technicians'
import Alerts from './pages/Alerts'
import Settings from './pages/Settings'
import { colors } from './lib/theme'

function ProtectedRoute({ children }) {
  const { session, loading, needsPasswordSetup } = useAuth()
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.bg, color: colors.muted, fontSize: 14 }}>
        Loading…
      </div>
    )
  }
  if (!session) return <Navigate to="/login" replace />
  // Arrived via an invite or password-reset link — Supabase already signed
  // them in to verify the link, but they must set a password before they
  // can use the rest of the app (or sign in again later).
  if (needsPasswordSetup) return <Navigate to="/set-password" replace />
  return children
}

function SetPasswordRoute() {
  const { session, loading } = useAuth()
  if (loading) return null
  // Supabase signs the visitor in as part of verifying the invite/reset
  // link, so a session is expected to already exist here.
  if (!session) return <Navigate to="/login" replace />
  return <SetPassword />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/set-password" element={<SetPasswordRoute />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="vehicles" element={<Vehicles />} />
            <Route path="maintenance" element={<Maintenance />} />
            <Route path="work-orders" element={<WorkOrders />} />
            <Route path="parts" element={<Parts />} />
            <Route path="drivers" element={<Drivers />} />
            <Route path="fleet-groups" element={<FleetGroups />} />
            <Route path="technicians" element={<Technicians />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
