import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase, publicFileUrl, LOGO_BUCKET } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { applyTheme, rememberTheme } from '../lib/theme'
import { setBranding, useBranding } from '../lib/branding'

const ShopContext = createContext(null)

// shop_settings columns everyone signed in may read (default_markup_pct is cost information: shop_markup())
export const SHOP_COLS = 'id,shop_name,logo_path,legal_name,npwp,address,phone,email,bank_details,pkp_status,timezone,default_app_language,default_print_language,terms_id,terms_en,tax_name,tax_rate,new_items_taxable,shop_supplies_enabled,shop_supplies_type,shop_supplies_rate,shop_supplies_base,shop_supplies_min,shop_supplies_max,shop_supplies_taxable,default_payment_terms_days,due_soon_days,due_soon_km,updated_at,theme,opening_hours,auto_approve,staff_hours_limit,auto_concern_services,auto_workflow,statement_drum_mode'

// Shop-wide settings (single row). Loaded once a staff member or a customer's fleet manager is signed in;
// everyone else just sees the defaults.
export function ShopProvider({ children }) {
  const { isStaff, isFleet, user } = useAuth()
  const [settings, setSettingsRaw] = useState(null)
  // a saved row comes back without the markup (not readable by every login): keep the one loaded
  const setSettings = useCallback((d) => setSettingsRaw((prev) => (d ? { ...d, default_markup_pct: d.default_markup_pct ?? prev?.default_markup_pct ?? null } : d)), [])
  const brand = useBranding()

  const refresh = useCallback(async () => {
    if (!isStaff && !isFleet) {
      setSettingsRaw(null)
      return
    }
    // every column but the default parts markup, which only logins that see costs read (151, review 39)
    const { data, error } = await supabase.from('shop_settings').select(SHOP_COLS).maybeSingle()
    if (error) console.error('shop settings load failed', error)
    let markup = null
    if (data && isStaff) {
      const m = await supabase.rpc('shop_markup')
      if (!m.error) markup = m.data
    }
    setSettingsRaw(data ? { ...data, default_markup_pct: markup } : null)
  }, [isStaff, isFleet, user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh()
  }, [refresh])

  // The shop's name and logo: top bar, sign-in page, tab title and icon (kept for the next visit too).
  useEffect(() => {
    if (settings) setBranding({ name: settings.shop_name, logoPath: settings.logo_path })
  }, [settings?.shop_name, settings?.logo_path]) // eslint-disable-line react-hooks/exhaustive-deps

  // The shop's colour theme applies to everyone once settings load.
  useEffect(() => {
    if (!settings?.theme) return
    applyTheme(settings.theme)
    rememberTheme(settings.theme)
  }, [settings?.theme])

  const value = useMemo(
    () => ({
      settings,
      shopName: settings?.shop_name || brand.name,
      logoUrl: settings ? (settings.logo_path ? `${publicFileUrl(LOGO_BUCKET, settings.logo_path)}` : null) : brand.logoUrl,
      timezone: settings?.timezone || 'Asia/Jakarta',
      refresh,
      setSettings,
    }),
    [settings, refresh, brand],
  )

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>
}

export function useShop() {
  const ctx = useContext(ShopContext)
  if (!ctx) throw new Error('useShop must be used inside <ShopProvider>')
  return ctx
}
