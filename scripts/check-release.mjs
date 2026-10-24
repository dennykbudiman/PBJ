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
if (url.includes(V1)) fail(`VITE_SUPABASE_URL points at the old v1 database (${V1}). Axle v2 needs its own database: set the production Supabase project's address and anon key.`)
if (context === 'production' && url.includes(STAGING) && process.env.AXLE_ALLOW_STAGING !== '1') {
  fail(`this is a production build${site ? ` of ${site}` : ''}, but VITE_SUPABASE_URL is the staging database (${STAGING}). Set the production Supabase project's address and anon key, or set AXLE_ALLOW_STAGING=1 for a deliberate test.`)
}
console.log(`✔ Axle release check: ${context} build${site ? ` of ${site}` : ''} uses ${url.replace(/^https?:\/\//, '')}`)
