// Release check, run by Netlify before every build (netlify.toml). Stops a build that would point Axle v2 at the
// wrong database:
//   - no database address or key set;
//   - the old v1 database (the live app before Axle v2), which doesn't have Axle v2's tables and rules;
//   - the staging database for the live site's production build (staging holds test data).
// Preview and branch builds use staging on purpose (pinned in netlify.toml).
const V1 = 'aifdaaztxathcumgvosb'
const STAGING = 'wuwabhwvnzhlcctxwpda'
const url = process.env.VITE_SUPABASE_URL || ''
const key = process.env.VITE_SUPABASE_ANON_KEY || ''
const context = process.env.CONTEXT || 'local'
const site = process.env.SITE_NAME || ''
const fail = (msg) => { console.error(`\n✖ Axle release check: ${msg}\n`); process.exit(1) }

if (!url || !key) fail('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (Netlify → Site configuration → Environment variables).')
if (url.includes(V1)) fail(`VITE_SUPABASE_URL points at the old v1 database (${V1}). Axle v2 needs its own database: set the production Supabase project's address and publishable key.`)
if (context === 'production' && url.includes(STAGING) && process.env.AXLE_ALLOW_STAGING !== '1') {
  fail(`this is a production build${site ? ` of ${site}` : ''}, but VITE_SUPABASE_URL is the staging database (${STAGING}). Set the production Supabase project's address and publishable key, or set AXLE_ALLOW_STAGING=1 for a deliberate test.`)
}
// The key: a secret key must never be built into the app. A legacy JWT key must belong to the same project as the
// address (a key from another project makes every request fail); Supabase retires those keys by the end of 2026, so
// production should use the publishable key (sb_publishable_…).
if (key.startsWith('sb_secret_')) fail('VITE_SUPABASE_ANON_KEY is a SECRET key. Use the project\'s publishable key (sb_publishable_…) and rotate the secret key, since it may have been exposed.')
if (key.startsWith('eyJ')) {
  let claims = {}
  try { claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()) } catch { fail('VITE_SUPABASE_ANON_KEY is not a valid key.') }
  if (claims.role && claims.role !== 'anon') fail(`VITE_SUPABASE_ANON_KEY is a "${claims.role}" key. Use the project's publishable key (sb_publishable_…).`)
  const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1]
  if (ref && claims.ref && claims.ref !== ref) fail(`VITE_SUPABASE_ANON_KEY belongs to project ${claims.ref}, but VITE_SUPABASE_URL is project ${ref}.`)
  if (context === 'production') console.warn('⚠ Axle release check: this build uses a legacy anon key; Supabase retires these by the end of 2026. Switch to the publishable key (sb_publishable_…).')
} else if (!key.startsWith('sb_publishable_')) {
  fail('VITE_SUPABASE_ANON_KEY should be the project\'s publishable key (sb_publishable_…).')
}
console.log(`✔ Axle release check: ${context} build${site ? ` of ${site}` : ''} uses ${url.replace(/^https?:\/\//, '')}`)
