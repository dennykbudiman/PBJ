import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase, signInThroughServer, signInMemory } from '../lib/supabase'

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
// so reloading the page halfway can't skip the step. A login made or reset with a
// temporary password (migration 134) is known to the server (my_temp_password) until
// the password changes.
function mustSetPassword(user) {
  return Boolean(user?.invited_at && !user?.user_metadata?.password_set)
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = still loading
  const [loaded, setLoaded] = useState({ userId: undefined, profile: null, permissions: [], staff: false, fleet: false, fleetCompanies: [], tempPassword: false })
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
      if (event === 'SIGNED_OUT') { setRecovery(false); signInMemory.password = null }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const userId = session?.user?.id

  const loadProfile = useCallback(async (refresh = false) => {
    if (!userId) {
      setLoaded({ userId: null, profile: null, permissions: [], staff: false, fleet: false, fleetCompanies: [], tempPassword: false })
      return
    }
    const [{ data: p, error }, { data: staff }, { data: fleet }, { data: temp }] = await Promise.all([
      supabase.from('profiles').select('id, name, username, phone, status, language, role_id, roles(name)').eq('id', userId).maybeSingle(),
      // The database's own answer to "may this person use the app?" (active and not a Fleet manager).
      supabase.rpc('is_staff'),
      // A customer's fleet manager: sees only the companies linked to the login (migration 133).
      supabase.rpc('is_fleet'),
      // Signed in with a temporary password the Owner or Admin set (migration 134): choose your own first.
      supabase.rpc('my_temp_password'),
    ])
    if (error) console.error('profile load failed', error)
    if (refresh && (error || !p || typeof staff !== 'boolean')) return // a failed background refresh keeps what we had
    let fleetCompanies = []
    if (fleet === true && !staff) {
      const { data: links, error: linkErr } = await supabase.from('fleet_manager_companies').select('customer_id').eq('user_id', userId)
      if (refresh && linkErr) return
      fleetCompanies = (links ?? []).map((r) => r.customer_id).sort()
    }
    let permissions = []
    if (p?.role_id && staff) {
      const { data: perms, error: permErr } = await supabase.from('role_permissions').select('permission_key').eq('role_id', p.role_id)
      if (refresh && permErr) return // keep the permissions we had
      permissions = (perms ?? []).map((r) => r.permission_key).sort()
    }
    // The sign-in password is kept in memory only for the "choose your own password" step after a temporary one.
    if (temp !== true) signInMemory.password = null
    // Nothing changed: keep the same objects, so open forms (e.g. the profile dialog) aren't reset by a background check.
    setLoaded((old) => {
      const next = { userId, profile: p ?? null, permissions, staff: staff === true, fleet: fleet === true && staff !== true, fleetCompanies, tempPassword: temp === true }
      return JSON.stringify(old) === JSON.stringify(next) ? old : next
    })
  }, [userId])

  useEffect(() => {
    if (session === undefined) return
    loadProfile()
  }, [session === undefined, loadProfile]) // eslint-disable-line react-hooks/exhaustive-deps

  // A role or permission change (or a person being disabled) reaches open tabs when the window is used again, at most
  // once a minute, and every 5 minutes while the tab is shown (a counter PC that stays in front all day).
  useEffect(() => {
    if (!userId) return
    let last = Date.now()
    const refresh = () => { last = Date.now(); loadProfile(true) }
    const onFocus = () => { if (Date.now() - last > 60000) refresh() }
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - last > 290000) refresh() }, 60000)
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus); clearInterval(timer) }
  }, [userId, loadProfile])

  const value = useMemo(() => {
    const profile = loaded.userId === (userId ?? null) ? loaded.profile : undefined
    const isStaff = loaded.userId === userId && loaded.staff
    const permissions = isStaff ? loaded.permissions : []
    const isFleet = loaded.userId === userId && loaded.fleet
    return {
      session,
      user: session?.user ?? null,
      profile,
      roleName: profile?.roles?.name ?? null,
      permissions,
      isStaff,
      // Fleet manager: read-only view of the linked companies, plus approving waiting work (fleet_decide).
      isFleet,
      fleetCompanies: isFleet ? loaded.fleetCompanies : [],
      can: (key) => isStaff && permissions.includes(key),
      // Still loading until the profile we hold belongs to the person signed in.
      loading: session === undefined || (Boolean(session) && loaded.userId !== userId),
      needsPasswordSetup: Boolean(session) && (recovery || mustSetPassword(session?.user) || (loaded.userId === userId && loaded.tempPassword)),
      // Signed in with a temporary password the Owner or Admin set (migration 134).
      tempPassword: loaded.userId === userId && loaded.tempPassword,
      // Signed in from an invite or "Forgot password" email link (Supabase doesn't ask for the current password then).
      fromLink: recovery,
      linkError,
      clearLinkError: () => setLinkError(null),
      completePasswordSetup: () => setRecovery(false),
      refreshProfile: loadProfile,
      // People sign in with a username (or their email) through the server function `login`, which keeps emails
      // private and answers every wrong username or password the same way. The session it returns is kept as usual.
      signIn: async (identifier, password) => {
        const { session: s, error } = await signInThroughServer(identifier.trim(), password)
        if (error) return { error }
        signInMemory.password = password
        return supabase.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token })
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
