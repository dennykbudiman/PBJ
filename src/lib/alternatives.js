// Alternative parts (Nov 3, Denny; migration 136). Each catalog part is one part number from one brand, with its own
// stock and price. Parts that share a part number are alternatives for each other: a part's numbers are its code plus
// its "alternative part numbers" (free text, separated by commas, e.g. "Sakura C-1007, ME215002"). Words without a
// digit ("Sakura") are brand names, not numbers, and are ignored; spaces, dashes and dots don't count ("C-1007" =
// "C1007"). Fitment ("fits") is free text in the vehicle list's words, e.g. "Colt FE71 Euro 4 (2022+)".

const MIN_LEN = 4 // shorter tokens ("No 10", "SAE") would match too much

// Within one entry (between commas), a short letter prefix written with a space belongs to the number after it
// ("ME 013307" = "ME013307", "C 1007" = "C1007"); a longer word without digits is a brand ("Sakura") and is dropped;
// several numbers in one entry separated by spaces stay separate ("ME013307 ME215002").
export function numberTokens(text) {
  const out = []
  for (const entry of String(text || '').split(/[,;\n/]+/)) {
    let prefix = ''
    for (const word of entry.toUpperCase().split(/\s+/)) {
      const w = word.replace(/[^A-Z0-9]/g, '')
      if (!w) continue
      if (!/\d/.test(w)) { prefix = w.length <= 3 ? prefix + w : ''; continue }
      const tok = prefix + w
      prefix = ''
      if (w.length >= 3 && tok.length >= MIN_LEN) out.push(tok) // "No 10" is not a part number
    }
  }
  return out
}

// The brands written on a part's alternate rows (145), for searching.
export const altBrands = (item) => (item?.alt_parts || []).map((r) => r.brand).filter(Boolean).join(' ')

// Other parts (active or not) that already carry one of the numbers in this text, as their own number or an
// alternate row (145): "Nomor ini sudah ada di …".
export function numberOwners(items, text, selfId) {
  const toks = numberTokens(text)
  if (!toks.length) return []
  return (items || []).filter((x) => x.item_type === 'part' && x.id !== selfId && toks.some((tk) => partNumbers(x).has(tk)))
}

export function partNumbers(item) {
  return new Set([...numberTokens(item?.code), ...numberTokens(item?.alt_numbers)])
}

// For each part, the other active parts that share one of its numbers. Returns Map(id → [items]).
export function alternativesIndex(items) {
  const parts = (items || []).filter((x) => x.item_type === 'part')
  const byToken = new Map()
  const numbers = new Map()
  for (const p of parts) {
    const toks = partNumbers(p)
    numbers.set(p.id, toks)
    for (const tk of toks) {
      if (!byToken.has(tk)) byToken.set(tk, [])
      byToken.get(tk).push(p)
    }
  }
  const out = new Map()
  for (const p of parts) {
    const seen = new Map()
    for (const tk of numbers.get(p.id)) {
      for (const o of byToken.get(tk) || []) if (o.id !== p.id && o.active) seen.set(o.id, o)
    }
    if (seen.size) out.set(p.id, [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)))
  }
  return out
}

// Does a part fit this vehicle? Its "fits" or its name mentions the vehicle's model ("Colt FE71"), ignoring case and
// spaces. Only a hint for ordering the part list: Euro 2 / Euro 4 and years are for the person to judge.
export function fitsVehicle(item, vehicle) {
  const model = String(vehicle?.model || '').toLowerCase().replace(/\s+/g, '')
  if (model.length < 3) return false
  const text = `${item?.fits || ''} ${item?.name || ''}`.toLowerCase().replace(/\s+/g, '')
  return text.includes(model)
}

// Catalog parts that look like what someone is typing on a PO or job line (145, item 39): the same part number
// (dashes, dots, spaces and alternate rows count), else the name's words in any order with small typos allowed.
// Parts that fit the vehicle come first. Returns [{ item, why: 'number' | 'name' }], best first.
const STOP = new Set(['dan', 'untuk', 'utk', 'the', 'and', 'for', 'set', 'pcs'])
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  .filter((w) => w.length >= 3 && !STOP.has(w))
function near(a, b) {
  if (a === b) return true
  if (a.length >= 4 && (b.startsWith(a) || a.startsWith(b))) return true
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false
  // one letter off (added, missing or different): "mitshubishi" ~ "mitsubishi"
  let i = 0, j = 0, miss = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++miss > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else { i++; j++ }
  }
  return miss + (a.length - i) + (b.length - j) <= 1
}
export function catalogMatches(items, { name, number, vehicle, selfId, limit = 3 } = {}) {
  const toks = [...numberTokens(number), ...numberTokens(name)]
  const want = words(name).filter((w) => !/\d/.test(w) || w.length >= 4)
  const out = []
  for (const x of items || []) {
    if (x.item_type !== 'part' || !x.active || x.id === selfId) continue
    let score = 0, why = null
    if (toks.length && toks.some((tk) => partNumbers(x).has(tk))) { score = 100; why = 'number' }
    else if (want.length) {
      const have = words(`${x.name} ${x.brand || ''} ${x.code || ''} ${altBrands(x)}`)
      const hit = want.filter((w) => have.some((h) => near(w, h))).length
      // most of the typed words, and at least two (or the only one) of them
      if (hit >= Math.min(2, want.length) && hit / want.length >= 0.6) { score = 50 * hit / want.length; why = 'name' }
    }
    if (!why) continue
    if (fitsVehicle(x, vehicle)) score += 5
    out.push({ item: x, why, score })
  }
  return out.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, limit)
}
