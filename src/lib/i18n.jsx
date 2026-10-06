import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { dict } from './strings'

const LangContext = createContext(null)
const STORE_KEY = 'axle.lang'

function stored() {
  try { return localStorage.getItem(STORE_KEY) } catch { return null }
}
function store(lang) {
  try {
    if (lang) localStorage.setItem(STORE_KEY, lang)
    else localStorage.removeItem(STORE_KEY)
  } catch { /* storage unavailable */ }
}

export function translate(lang, key, vars) {
  let s = dict[lang]?.[key] ?? dict.en[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

// Language order: what the person just picked → their profile → this browser's last
// pick (e.g. on the sign-in screen) → the shop default → English.
export function LangProvider({ children }) {
  const { profile, isStaff, user, refreshProfile } = useAuth()
  const { settings } = useShop()
  const [override, setOverride] = useState(null)

  useEffect(() => setOverride(null), [user?.id])

  const lang = override || profile?.language || stored() || settings?.default_app_language || 'en'

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // next = 'en' | 'id', or null for "follow the shop default".
  const setLang = useCallback(async (next, { persist = true } = {}) => {
    setOverride(next || null)
    store(next || null)
    if (persist && next && isStaff && profile?.id && profile.language !== next) {
      const { error } = await supabase.from('profiles').update({ language: next }).eq('id', profile.id)
      if (!error) refreshProfile()
    }
  }, [isStaff, profile?.id, profile?.language, refreshProfile])

  const value = useMemo(() => ({
    lang,
    setLang,
    t: (key, vars) => translate(lang, key, vars),
  }), [lang, setLang])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useT() {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useT must be used inside <LangProvider>')
  return ctx
}
