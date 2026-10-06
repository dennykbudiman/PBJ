import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

// Read invite / password-reset links once, when the app first loads. supabase-js
// signs the person in from the link by itself and then clears the address bar,
// so this has to happen before that.
const LINK = (() => {
  const params = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return {
    type: params.get('type') || hash.get('type'),
    error: params.get('error_description') || hash.get('error_description'),
  }
})()

// An invited person must choose a password before using the app. Their login has
// invited_at set; once they save a password we record password_set on the login,
// so reloading the page halfway can't skip the step.
function mustSetPassword(user) {
  return Boolean(user?.invited_at && !user?.user_metadata?.password_set)
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still loading
  const [loaded, setLoaded] = useState({ userId: undefined, profile: null, permissions: [], staff: false })
  const [recovery, setRecovery] = useState(LINK.type === 'recovery' || LINK.type === 'invite')
  const [linkError, setLinkError] = useState(LINK.error)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      if (!data.session) setRecovery(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      setSession(sess ?? null)
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'SIGNED_OUT') setRecovery(false)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const userId = session?.user?.id

  const loadProfile = useCallback(async () => {
    if (!userId) {
      setLoaded({ userId: null, profile: null, permissions: [], staff: false })
      return
    }
    const [{ data: p, error }, { data: staff }] = await Promise.all([
      supabase.from('profiles').select('id, name, username, phone, status, language, role_id, roles(name)').eq('id', userId).maybeSingle(),
      // The database's own answer to "may this person use the app?" (active and not a Fleet manager).
      supabase.rpc('is_staff'),
    ])
    if (error) console.error('profile load failed', error)
    let permissions = []
    if (p?.role_id && staff) {
      const { data: perms } = await supabase.from('role_permissions').select('permission_key').eq('role_id', p.role_id)
      permissions = (perms ?? []).map((r) => r.permission_key)
    }
    setLoaded({ userId, profile: p ?? null, permissions, staff: staff === true })
  }, [userId])

  useEffect(() => {
    if (session === undefined) return
    loadProfile()
  }, [session === undefined, loadProfile]) // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(() => {
    const profile = loaded.userId === (userId ?? null) ? loaded.profile : undefined
    const isStaff = loaded.userId === userId && loaded.staff
    const permissions = isStaff ? loaded.permissions : []
    return {
      session,
      user: session?.user ?? null,
      profile,
      roleName: profile?.roles?.name ?? null,
      permissions,
      isStaff,
      can: (key) => isStaff && permissions.includes(key),
      // Still loading until the profile we hold belongs to the person signed in.
      loading: session === undefined || (Boolean(session) && loaded.userId !== userId),
      needsPasswordSetup: Boolean(session) && (recovery || mustSetPassword(session?.user)),
      linkError,
      clearLinkError: () => setLinkError(null),
      completePasswordSetup: () => setRecovery(false),
      refreshProfile: loadProfile,
      // People sign in with a username (or their email). A username is resolved
      // to its email by the get_email_for_username database function.
      signIn: async (identifier, password) => {
        let email = identifier.trim()
        if (!email.includes('@')) {
          const { data, error } = await supabase.rpc('get_email_for_username', { p_username: email })
          if (error) return { error }
          if (!data) return { error: { code: 'no_user' } }
          email = data
        }
        return supabase.auth.signInWithPassword({ email, password })
      },
      sendPasswordReset: (email) =>
        supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/set-password` }),
      // Sign out of this browser only, not every device the person uses.
      signOut: () => supabase.auth.signOut({ scope: 'local' }),
    }
  }, [session, userId, loaded, recovery, linkError, loadProfile])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
