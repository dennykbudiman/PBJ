import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import NewJob from './NewJob'
import JobPage from './JobPage'

// /jobs/new → new job, /jobs/<id> → the job; the lists live under Customers.
export default function JobsArea() {
  const parts = useLocation().pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
  if (!parts.length) return <Navigate to="/customers/repair-orders" replace />
  if (parts[0] === 'new') return <NewJob />
  return <JobPage key={parts[0]} id={parts[0]} />
}
