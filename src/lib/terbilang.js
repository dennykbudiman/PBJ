// A rupiah amount in Indonesian words, e.g. 225000 → "dua ratus dua puluh lima ribu rupiah" (145: drum-oil
// statements and the driver's reimbursement slip).
const ONE = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas']
function words(n) {
  if (n < 12) return ONE[n]
  if (n < 20) return `${ONE[n - 10]} belas`
  if (n < 100) return `${ONE[Math.floor(n / 10)]} puluh ${words(n % 10)}`.trim()
  if (n < 200) return `seratus ${words(n - 100)}`.trim()
  if (n < 1000) return `${ONE[Math.floor(n / 100)]} ratus ${words(n % 100)}`.trim()
  if (n < 2000) return `seribu ${words(n - 1000)}`.trim()
  if (n < 1e6) return `${words(Math.floor(n / 1000))} ribu ${words(n % 1000)}`.trim()
  if (n < 1e9) return `${words(Math.floor(n / 1e6))} juta ${words(n % 1e6)}`.trim()
  if (n < 1e12) return `${words(Math.floor(n / 1e9))} miliar ${words(n % 1e9)}`.trim()
  return `${words(Math.floor(n / 1e12))} triliun ${words(n % 1e12)}`.trim()
}
export function terbilang(amount) {
  const n = Math.round(Math.abs(Number(amount) || 0))
  return n === 0 ? 'nol rupiah' : `${words(n).replace(/\s+/g, ' ')} rupiah`
}
