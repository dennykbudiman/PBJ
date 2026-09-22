import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors } from '../lib/theme'

// Shown when someone arrives via an invite email or a "reset password" link.
// Supabase logs them in automatically just to verify the link is real, but
// they don't have a password yet (invite) or want a new one (reset) — this
// is the one place in the app that lets them set it.
export default function SetPassword() {
  const { completePasswordSetup, profile } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    completePasswordSetup()
    navigate('/', { replace: true })
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.bg }}>
      <form
        onSubmit={handleSubmit}
        style={{ width: 360, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 32, boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px 0' }}>Set your password</h1>
        <p style={{ fontSize: 13, color: colors.muted, margin: '0 0 20px 0' }}>
          {profile?.name ? `Welcome, ${profile.name}. ` : ''}Choose a password to finish setting up your account.
        </p>

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }} htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          required
          autoFocus
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={inputStyle}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, margin: '16px 0 6px 0' }} htmlFor="confirm-password">
          Confirm password
        </label>
        <input
          id="confirm-password"
          type="password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          style={inputStyle}
        />

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, color: colors.danger, background: colors.dangerBg, borderRadius: 8, padding: '8px 12px' }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            marginTop: 20, width: '100%', background: colors.accent, color: colors.white, border: 'none',
            borderRadius: 8, padding: '11px 16px', fontSize: 14, fontWeight: 700,
            cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Saving…' : 'Save password and continue'}
        </button>
      </form>
    </div>
  )
}

const inputStyle = {
  width: '100%', border: '1px solid rgba(28,30,34,0.14)', borderRadius: 8,
  padding: '10px 12px', fontSize: 14, fontFamily: 'inherit', outline: 'none',
}
