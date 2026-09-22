import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { colors } from '../lib/theme'

export default function Login() {
  const { signInWithUsername } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signInWithUsername(username, password)
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      navigate('/', { replace: true })
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.bg }}>
      <form
        onSubmit={handleSubmit}
        style={{
          width: 360,
          background: colors.white,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 32,
          boxShadow: '0 1px 2px rgba(20,20,20,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: colors.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17h1a2 2 0 1 0 4 0h8a2 2 0 1 0 4 0h1v-5l-3-5H7L3 12z" />
              <path d="M14 12V7" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' }}>Axle</div>
            <div style={{ fontSize: 12, color: colors.mutedLight }}>Fleet Maintenance</div>
          </div>
        </div>

        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px 0' }}>Sign in</h1>

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }} htmlFor="login-username">
          Username
        </label>
        <input
          id="login-username"
          type="text"
          autoComplete="username"
          required
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={inputStyle}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, margin: '16px 0 6px 0' }} htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
            marginTop: 20,
            width: '100%',
            background: colors.accent,
            color: colors.white,
            border: 'none',
            borderRadius: 8,
            padding: '11px 16px',
            fontSize: 14,
            fontWeight: 700,
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        <p style={{ fontSize: 12, color: colors.mutedLight, marginTop: 16, textAlign: 'center' }}>
          Ask your fleet administrator for an invite if you don't have an account yet.
        </p>
      </form>
    </div>
  )
}

const inputStyle = {
  width: '100%',
  border: '1px solid rgba(28,30,34,0.14)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
}
