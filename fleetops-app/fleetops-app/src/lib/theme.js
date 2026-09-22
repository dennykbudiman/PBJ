// Shared design tokens, ported 1:1 from the FleetOps/Axle prototype
// (.dc.html files) so every page looks like the same app.

export const colors = {
  bg: '#F7F6F2',
  ink: '#1C1E22',
  border: 'rgba(28,30,34,0.08)',
  borderStrong: 'rgba(28,30,34,0.14)',
  white: '#FFFFFF',
  muted: '#6B7078',
  mutedLight: '#9A9FA6',
  text2: '#3D4148',
  text3: '#4B505A',
  accent: '#146B69',
  accentBg: '#E3F1EF',
  danger: '#C0392B',
  dangerBg: '#FBE7E4',
  warn: '#9A5B10',
  warnBg: '#FCF0DC',
  neutral: '#55606B',
  neutralBg: '#EEF0F2',
  good: '#2F8F4E',
}

export const fontMono = "'IBM Plex Mono', monospace"

// Maps a severity/status word to the {bg, color} pill pair used throughout
// the app (alerts, work orders, maintenance priority, part stock status...).
export function severityPalette(sev) {
  switch (sev) {
    case 'critical':
    case 'overdue':
    case 'out':
    case 'urgent':
      return { bg: colors.dangerBg, color: colors.danger }
    case 'warning':
    case 'due_soon':
    case 'low':
    case 'high':
      return { bg: colors.warnBg, color: colors.warn }
    default:
      return { bg: colors.neutralBg, color: colors.neutral }
  }
}

export function formatRupiah(n) {
  if (n === null || n === undefined) return '—'
  return 'Rp' + Number(n).toLocaleString('id-ID')
}

// e.g. 68500000 -> "68,5jt" (short "juta" form used in the dashboard chart)
export function formatJuta(n) {
  const juta = n / 1_000_000
  const rounded = Math.round(juta * 10) / 10
  const str = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',')
  return str + 'jt'
}

export function formatDate(d) {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  if (isNaN(date)) return '—'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''
  const diffMs = Date.now() - then
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

export const LICENSE_CLASSES = [
  'SIM A', 'SIM B1', 'SIM B2', 'SIM C', 'SIM D',
  'SIM A Umum', 'SIM B1 Umum', 'SIM B2 Umum',
]

export const PERMISSIONS = [
  { key: 'delete_drivers', label: 'Delete drivers' },
  { key: 'delete_parts', label: 'Delete parts' },
  { key: 'delete_work_orders', label: 'Delete work orders' },
  { key: 'delete_vehicles', label: 'Delete vehicles' },
  { key: 'manage_users', label: 'Manage users' },
  { key: 'edit_settings', label: 'Edit settings' },
]
