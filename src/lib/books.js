// Books (pembukuan) inside a paying PT (143). A company's book is its "Pembukuan", else its own name; its PT is its
// "PT pembayar", else its own name. Spelling and spaces don't matter (as payer_key in the database).
export const nameKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
export const payerOf = (c) => (c?.payer_name?.trim() || c?.display_name || '').trim()
export const bookOf = (c) => (c?.book_name?.trim() || c?.display_name || '').trim().replace(/\s+/g, ' ')

// the books of one paying PT, from the companies that name it (sorted, each spelling once)
export function booksOfPayer(customers, payer) {
  const k = nameKey(payer)
  if (!k) return []
  const seen = new Map()
  for (const c of customers || []) {
    if (nameKey(payerOf(c)) !== k) continue
    const b = bookOf(c)
    if (b && !seen.has(nameKey(b))) seen.set(nameKey(b), b)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

// "PT. Pulau Indah Jaya · PIJ 1" (the book left out when it's just the PT's own name)
export function payerBookLabel(payer, book) {
  if (!payer) return book || ''
  if (!book || nameKey(book) === nameKey(payer)) return payer
  return `${payer} · ${book}`
}
