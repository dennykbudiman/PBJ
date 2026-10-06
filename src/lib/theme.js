// Colour themes. The shop picks one in Settings → Appearance (Owner / Admin only).
// Each theme is one accent colour; the darker, lighter and link shades are worked out from it.

export const PRESETS = [
  { id: 'teal', accent: '#0E9F7E' },
  { id: 'ocean', accent: '#0B6FB8' },
  { id: 'indigo', accent: '#4F46E5' },
  { id: 'purple', accent: '#7C3AED' },
  { id: 'crimson', accent: '#C0263D' },
  { id: 'orange', accent: '#C2410C' },
  { id: 'forest', accent: '#2F7D32' },
  { id: 'graphite', accent: '#334155' },
]

export const DEFAULT_THEME = { preset: 'teal' }
const STORE_KEY = 'axle.theme'

const hexRe = /^#[0-9a-f]{6}$/i
export const isHex = (v) => hexRe.test(String(v || ''))

function toRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function toHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('').toUpperCase()
}
// Moves a colour towards black (amount > 0) or white (amount < 0).
function shade(hex, amount) {
  const target = amount > 0 ? 0 : 255
  const a = Math.abs(amount)
  return toHex(toRgb(hex).map((c) => c + (target - c) * a))
}
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
// WCAG contrast ratio between two colours (1 to 21).
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

export function accentOf(theme) {
  if (theme?.preset === 'custom' && isHex(theme.accent)) return theme.accent.toUpperCase()
  return (PRESETS.find((p) => p.id === theme?.preset) || PRESETS[0]).accent
}

// The full set of shades the stylesheet uses, from one accent colour.
export function palette(accent) {
  let link = shade(accent, 0.12)
  for (let i = 0; i < 6 && contrast(link, '#FFFFFF') < 4.5; i++) link = shade(link, 0.15)
  const [r, g, b] = toRgb(accent)
  return {
    '--accent': accent,
    '--accent-dark': shade(accent, 0.18),
    '--accent-soft': shade(accent, -0.88),
    '--accent-ring': `rgba(${r}, ${g}, ${b}, 0.18)`,
    '--link': link,
    '--link-hover': shade(link, 0.2),
  }
}

export function applyTheme(theme) {
  const vars = palette(accentOf(theme))
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', vars['--accent'])
}

// The sign-in page can't read shop settings, so the last theme seen is kept in this browser.
export function rememberTheme(theme) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(theme || DEFAULT_THEME)) } catch { /* storage unavailable */ }
}
export function storedTheme() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || DEFAULT_THEME } catch { return DEFAULT_THEME }
}

// The same theme always in the same shape ({ preset } or { preset: 'custom', accent }),
// so a saved theme read back from the database compares equal to the one on screen.
export function normTheme(theme) {
  if (!theme || typeof theme !== 'object' || !theme.preset) return { ...DEFAULT_THEME }
  return theme.preset === 'custom' ? { preset: 'custom', accent: theme.accent ?? '' } : { preset: theme.preset }
}
