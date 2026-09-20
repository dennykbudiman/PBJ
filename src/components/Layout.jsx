import React from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import { colors } from '../lib/theme'

export default function Layout() {
  return (
    <div style={{ width: '100%', minHeight: '100vh', background: colors.bg }}>
      <Sidebar />
      <div style={{ marginLeft: 264, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <Outlet />
      </div>
    </div>
  )
}
