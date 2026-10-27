// Run by Netlify after the build (netlify.toml). Writes dist/_headers with the page's Content-Security-Policy, letting
// the page talk only to this build's own Supabase project (VITE_SUPABASE_URL), not to any *.supabase.co project.
// That also covers a Supabase custom domain. The self-hosted setup has its own policy in deploy/self-host/web/Caddyfile.
import fs from 'node:fs'

const url = process.env.VITE_SUPABASE_URL || ''
let host
try { host = new URL(url).host } catch { /* checked below */ }
if (!host) { console.error('✖ write-headers: VITE_SUPABASE_URL is missing or not a web address.'); process.exit(1) }

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: blob: https://${host}`,
  `connect-src 'self' https://${host} wss://${host}`,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

fs.writeFileSync('dist/_headers', `/*\n  Content-Security-Policy: ${csp}\n`)
console.log(`✔ write-headers: Content-Security-Policy allows ${host}`)
