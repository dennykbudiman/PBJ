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
