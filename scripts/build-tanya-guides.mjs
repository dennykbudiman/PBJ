// Turns the Tanya Claude app guides (supabase/functions/ask-claude/guide_*.md) into guides.ts, so the server function
// carries them in its code. Run after editing a guide:  node scripts/build-tanya-guides.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'functions', 'ask-claude')
const read = (f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()
// one string per line, so the file stays readable and diffs stay small
const lines = (text) => '[\n' + text.split('\n').map((l) => '  ' + JSON.stringify(l) + ',').join('\n') + "\n].join('\\n')"
const out = `// Made by scripts/build-tanya-guides.mjs from guide_staff.md and guide_fleet.md. Edit those, then run the script.
export const GUIDE_STAFF = ${lines(read('guide_staff.md'))}
export const GUIDE_FLEET = ${lines(read('guide_fleet.md'))}
`
writeFileSync(join(dir, 'guides.ts'), out)
console.log(`guides.ts: staff ${read('guide_staff.md').length} chars, fleet ${read('guide_fleet.md').length} chars`)
