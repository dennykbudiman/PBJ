import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still loading
  const [profile, setProfile] = useState(null)
  const [permissions, setPermissions] = useState([])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
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
        .select('id, name, phone, status, role_id, roles(name)')
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
    signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
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
