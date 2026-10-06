import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase, publicFileUrl, LOGO_BUCKET } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { applyTheme, rememberTheme } from '../lib/theme'

const ShopContext = createContext(null)

// Shop-wide settings (single row). Loaded once a staff member is signed in;
// everyone else just sees the defaults.
export function ShopProvider({ children }) {
  const { isStaff, user } = useAuth()
  const [settings, setSettings] = useState(null)

  const refresh = useCallback(async () => {
    if (!isStaff) {
      setSettings(null)
      return
    }
    const { data, error } = await supabase.from('shop_settings').select('*').maybeSingle()
    if (error) console.error('shop settings load failed', error)
    setSettings(data ?? null)
  }, [isStaff, user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh()
  }, [refresh])

  // The shop's colour theme applies to everyone once settings load.
  useEffect(() => {
    if (!settings?.theme) return
    applyTheme(settings.theme)
    rememberTheme(settings.theme)
  }, [settings?.theme])

  const value = useMemo(
    () => ({
      settings,
      shopName: settings?.shop_name || 'Axle',
      logoUrl: settings?.logo_path ? `${publicFileUrl(LOGO_BUCKET, settings.logo_path)}` : null,
      timezone: settings?.timezone || 'Asia/Jakarta',
      refresh,
      setSettings,
    }),
    [settings, refresh],
  )

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>
}

export function useShop() {
  const ctx = useContext(ShopContext)
  if (!ctx) throw new Error('useShop must be used inside <ShopProvider>')
  return ctx
}
