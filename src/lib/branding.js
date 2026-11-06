// The shop's own name and logo everywhere: the top bar, the sign-in page, printouts, texts that name the app, the
// browser tab title and the tab icon (Settings → Shop profile). Signed-in pages get them from the shop settings
// (ShopContext); before signing in they come from shop_branding() (migration 135), which returns only the name, the
// logo and the colour theme. The last values are kept in this browser so the next visit shows them at once.
import { useEffect, useSyncExternalStore } from 'react'
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

// The browser tab title (Nov 3, Denny: many open tabs must be told apart): the page's own title, then the shop name,
// e.g. "DA 8130 BN · #100001 — PBG Service Shop". The layout sets a title for each list page from the address
// (setRouteTitle); a page showing one record sets a more specific one while it is open (usePageTitle), which wins.
// Print pages use their title alone, because the browser suggests it as the PDF file name.
let routeTitle = ''
let pageTitle = null // { text, alone }
const titleListeners = new Set() // Tanya Claude's "open now" line

function applyToDocument() {
  const own = pageTitle?.text || routeTitle
  const title = own ? (pageTitle?.alone || !brand.name ? own : `${own} — ${brand.name}`) : brand.name
  const shown = title || 'Bengkel' // nothing known yet: the neutral name from index.html, not the previous page's title
  if (document.title !== shown) document.title = shown
  titleListeners.forEach((fn) => fn())
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

export function setRouteTitle(text) {
  routeTitle = text || ''
  applyToDocument()
}

// `alone`: without the shop name (print pages).
export function usePageTitle(text, { alone = false } = {}) {
  useEffect(() => {
    if (!text) return undefined
    const mine = { text, alone }
    pageTitle = mine
    applyToDocument()
    return () => { if (pageTitle === mine) { pageTitle = null; applyToDocument() } }
  }, [text, alone])
}

export function useBranding() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn) }, getBranding)
}

// The current page's own title without the shop name (e.g. "DA 8123 TAQ · #100005"), for Tanya Claude.
export function currentPageTitle() {
  return pageTitle?.text || routeTitle || ''
}
export function usePageTitleText() {
  return useSyncExternalStore((fn) => { titleListeners.add(fn); return () => titleListeners.delete(fn) }, currentPageTitle)
}
