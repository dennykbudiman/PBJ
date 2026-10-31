// The shop's own name and logo everywhere: the top bar, the sign-in page, printouts, texts that name the app, the
// browser tab title and the tab icon (Settings → Shop profile). Signed-in pages get them from the shop settings
// (ShopContext); before signing in they come from shop_branding() (migration 135), which returns only the name, the
// logo and the colour theme. The last values are kept in this browser so the next visit shows them at once.
import { useSyncExternalStore } from 'react'
import { supabase, publicFileUrl, LOGO_BUCKET } from './supabase'
import { applyTheme, rememberTheme } from './theme'

const STORE_KEY = 'axle.brand'
const DEFAULT_ICON = '/favicon.svg'
let brand = (() => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || { name: '', logoUrl: null } } catch { return { name: '', logoUrl: null } }
})()
const listeners = new Set()

export function getBranding() { return brand }

// Used where a text names the app ({shop} in the strings) and no shop name is known yet.
export function brandName(lang) {
  return brand.name || (lang === 'id' ? 'aplikasi' : 'the app')
}

function applyToDocument() {
  if (brand.name) document.title = brand.name
  let link = document.querySelector('link[rel~="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  const href = brand.logoUrl || DEFAULT_ICON
  if (link.getAttribute('href') !== href) {
    link.removeAttribute('type') // the logo may be PNG, JPG or WebP, not the default SVG
    link.setAttribute('href', href)
  }
}

export function setBranding({ name, logoPath }) {
  const next = { name: name || '', logoUrl: logoPath ? publicFileUrl(LOGO_BUCKET, logoPath) : null }
  if (next.name === brand.name && next.logoUrl === brand.logoUrl) { applyToDocument(); return }
  brand = next
  try { localStorage.setItem(STORE_KEY, JSON.stringify(brand)) } catch { /* storage unavailable */ }
  applyToDocument()
  listeners.forEach((fn) => fn())
}

// On start: show what this browser saw last, then ask the server (works signed out too).
export async function loadBranding() {
  applyToDocument()
  const { data, error } = await supabase.rpc('shop_branding')
  if (error || !data) return // older database or offline: keep the last known name and logo
  setBranding({ name: data.name, logoPath: data.logo_path })
  if (data.theme) { applyTheme(data.theme); rememberTheme(data.theme) }
}

export function useBranding() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, getBranding)
}
