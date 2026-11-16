// Naming check for part names (update 150, item 49): run while someone types a new part's name and number.
// Pure functions, no database: the caller passes the catalog items and the part-name dictionary (part_name_words).
import { numberTokens, numberOwners } from './alternatives.js'

const SERVICE_START = /^(ganti|bongkar|pasang|jasa|servis|service|perbaikan|perbaiki|setel|stel|las|bubut)\b/i
// a token that looks like a part number: letters and digits mixed, at least 5 long (ME013307, 16510-61J00)
const LOOKS_NUMBER = /^(?=.*\d)(?=.*[a-z])[a-z0-9-]{5,}$/i
const VEHICLE_WORDS = /^(colt|fe\d+|nmr\d*|elf|dyna|canter|fuso|l300|t120ss|hino|isuzu|mitsubishi|toyota|suzuki|ps|euro)$/i

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
export const normNumber = (s) => String(s || '').toUpperCase().replace(/[\s.\-/]/g, '')

function dist1(a, b) {
  // true when a and b differ by one letter (changed, added or left out)
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else { i++; j++ }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

// the catalog's words with how often each is used, and how each is usually written (capitals)
export function catalogVocabulary(items) {
  const count = new Map(), form = new Map()
  for (const x of items || []) {
    if (x.item_type !== 'part') continue
    for (const w of String(x.name || '').split(/\s+/)) {
      if (!/^[a-z]{3,}$/i.test(w)) continue
      const k = w.toLowerCase()
      count.set(k, (count.get(k) || 0) + 1)
      const f = form.get(k) || new Map()
      f.set(w, (f.get(w) || 0) + 1)
      form.set(k, f)
    }
  }
  const usual = new Map()
  for (const [k, f] of form) usual.set(k, [...f.entries()].sort((a, b) => b[1] - a[1])[0][0])
  return { count, usual }
}

// Suggestions for a part name. Each: { kind, text, fix } where fix (when given) is the whole corrected name.
// kinds: 'dict' (dictionary), 'spell' (close to a catalog word), 'caps', 'service', 'brand', 'number'
export function nameChecks(name, { words = [], vocab, brands = [], brand = '' } = {}) {
  const out = []
  const raw = String(name || '').replace(/\s+/g, ' ').trim()
  if (raw.length < 3) return out
  let fixed = raw
  // 1. dictionary phrases, longest first
  for (const w of [...words].sort((a, b) => b.wrong.length - a.wrong.length)) {
    const wrong = norm(w.wrong)
    if (!wrong) continue
    const re = new RegExp(`(^|[^a-z0-9])(${escapeRe(wrong).replace(/ /g, '\\s+')})(?=$|[^a-z0-9])`, 'i')
    const m = fixed.match(re)
    if (m && m[2] !== w.right_text) {
      fixed = fixed.replace(re, `$1${w.right_text}`)
      out.push({ kind: 'dict', from: m[2], to: w.right_text })
    }
  }
  // 2. words one letter away from a word the catalog uses at least twice
  if (vocab) {
    fixed = fixed.split(' ').map((tok) => {
      const k = tok.toLowerCase()
      if (!/^[a-z]{5,}$/i.test(tok) || vocab.count.has(k)) return tok
      let best = null
      for (const [w, n] of vocab.count) if (n >= 2 && dist1(k, w) && (!best || n > best.n)) best = { w, n }
      if (!best) return tok
      const to = vocab.usual.get(best.w) || best.w
      out.push({ kind: 'spell', from: tok, to })
      return to
    }).join(' ')
  }
  // 3. capitals: first letter capital; a name in all capitals → like the catalog
  const letters = fixed.replace(/[^a-z]/gi, '')
  if (letters.length >= 6 && letters === letters.toUpperCase()) {
    const to = fixed.split(' ').map((tok, i) => {
      if (/\d/.test(tok)) return tok
      const usual = vocab?.usual.get(tok.toLowerCase())
      if (usual) return i === 0 ? cap(usual) : usual
      if (VEHICLE_WORDS.test(tok)) return cap(tok.toLowerCase())
      return i === 0 ? cap(tok.toLowerCase()) : tok.toLowerCase()
    }).join(' ')
    if (to !== fixed) { out.push({ kind: 'caps', from: fixed, to }); fixed = to }
  } else if (/^[a-z]/.test(fixed)) {
    const to = cap(fixed)
    out.push({ kind: 'caps', from: fixed.split(' ')[0], to: to.split(' ')[0] })
    fixed = to
  }
  // 4. sounds like a service, not a part
  const sm = raw.match(SERVICE_START)
  if (sm) out.push({ kind: 'service', word: sm[1] })
  // 5. a brand in the name
  const bs = [...new Set([brand, ...brands].map((b) => String(b || '').trim()).filter((b) => b.length >= 2))]
  for (const b of bs) {
    const re = new RegExp(`(^|\\s)${escapeRe(b)}(?=\\s|$)`, 'i')
    if (re.test(raw) && !VEHICLE_WORDS.test(b)) { out.push({ kind: 'brand', word: b }); break }
  }
  // 6. a part number in the name
  const num = raw.split(' ').find((tok) => LOOKS_NUMBER.test(tok) && !VEHICLE_WORDS.test(tok) && !/^\d+(v|a|ps|l)$/i.test(tok))
  if (num) out.push({ kind: 'number', word: num })
  return out.map((x) => (x.to !== undefined ? { ...x, fix: fixed } : x))
}

// the number is already on another part (its number or one of its other numbers)
export function numberTaken(items, number, selfId) {
  const k = normNumber(number)
  if (k.length < 3) return []
  const out = []
  for (const x of items || []) {
    if (x.item_type !== 'part' || (selfId && x.id === selfId)) continue
    const all = [x.code, ...String(x.alt_numbers || '').split(','), ...(x.alt_parts || []).map((r) => r.number)]
    if (all.some((n) => normNumber(n) === k)) out.push(x)
  }
  if (out.length) return out
  // fall back to the shared number-token rule (145) for numbers written with extra text
  return numberTokens(number).length ? numberOwners(items, number, selfId) : []
}

// a number that is made-up words rather than a supplier's number (allowed, only noted): letters only, long
export const looksInvented = (number) => /^[a-z]{8,}\d*$/i.test(normNumber(number))

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
