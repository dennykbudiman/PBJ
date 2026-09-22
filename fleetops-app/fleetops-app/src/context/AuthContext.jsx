import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still loading
  const [profile, setProfile] = useState(null)
  const [permissions, setPermissions] = useState([])
  // True right after someone lands here via an invite or password-reset
  // link — Supabase logs them in automatically so it can verify the link,
  // but they haven't actually set a password yet. Until they do, force them
  // to the "set password" screen instead of the rest of the app.
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false)

  useEffect(() => {
    // Supabase invite/reset links come in one of two shapes depending on
    // project settings: a hash fragment (#access_token=...&type=invite),
    // which supabase-js's `detectSessionInUrl` (on by default) picks up
    // automatically, or a query-string PKCE code (?code=...), which needs
    // an explicit exchange. Handle both so this works regardless of which
    // flow this Supabase project uses.
    const params = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const linkType = params.get('type') || hash.get('type') // 'invite' | 'recovery' | ...
    const code = params.get('code')

    async function init() {
      if (code) {
        const { data, error } = await supabase.auth.exchangeCodeForSession(window.location.href)
        if (!error && data.session) {
          setSession(data.session)
          // Clean the ?code=... out of the URL bar without a reload.
          window.history.replaceState({}, '', window.location.pathname)
        }
      } else {
        const { data } = await supabase.auth.getSession()
        setSession(data.session)
      }
      if (linkType === 'invite' || linkType === 'recovery') {
        setNeedsPasswordSetup(true)
      }
    }
    init()

    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      setSession(sess)
      if (event === 'PASSWORD_RECOVERY') setNeedsPasswordSetup(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      setPermissions([])
      return
    }
    let cancelled = false
    async function loadProfile() {
      const { data: p } = await supabase
        .from('profiles')
        .select('id, name, username, phone, status, role_id, roles(name)')
        .eq('id', session.user.id)
        .single()
      if (cancelled) return
      setProfile(p ?? null)

      if (p?.role_id) {
        const { data: perms } = await supabase
          .from('role_permissions')
          .select('permission_key')
          .eq('role_id', p.role_id)
        if (!cancelled) setPermissions((perms ?? []).map((r) => r.permission_key))
      } else {
        setPermissions([])
      }
    }
    loadProfile()
    return () => {
      cancelled = true
    }
  }, [session])

  const hasPermission = (key) => permissions.includes(key)

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    permissions,
    hasPermission,
    loading: session === undefined,
    needsPasswordSetup,
    completePasswordSetup: () => setNeedsPasswordSetup(false),
    signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
    // The app only ever shows a "username" field to the person — this
    // resolves it to the matching email server-side (via the
    // get_email_for_username RPC from 004_username_login.sql) and signs in
    // with that, so Supabase's actual email-based auth stays invisible.
    signInWithUsername: async (username, password) => {
      const { data: email, error: lookupError } = await supabase.rpc('get_email_for_username', {
        p_username: username,
      })
      if (lookupError) return { error: lookupError }
      if (!email) return { error: { message: 'No account found with that username.' } }
      return supabase.auth.signInWithPassword({ email, password })
    },
    signUp: (email, password, name) =>
      supabase.auth.signUp({ email, password, options: { data: { name } } }),
    signOut: () => supabase.auth.signOut(),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
