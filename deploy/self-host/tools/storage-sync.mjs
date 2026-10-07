// Copies uploaded files (shop logo, attachments) between a Supabase Storage API and a folder.
// Used by axle.sh for backups, restores and moving from supabase.co. No packages needed (Node 18+).
//
//   SB_URL=https://xyz.supabase.co SB_KEY=<service_role key> node storage-sync.mjs download <folder>
//   SB_URL=http://127.0.0.1:8000   SB_KEY=<service_role key> node storage-sync.mjs upload   <folder>
//
// The folder holds buckets.json, objects.json and files/<bucket>/<path>.

import fs from 'node:fs'
import path from 'node:path'

const [mode, dirArg] = process.argv.slice(2)
const URL_BASE = (process.env.SB_URL || '').replace(/\/+$/, '')
const KEY = process.env.SB_KEY || ''
if (!['download', 'upload'].includes(mode) || !dirArg || !URL_BASE || !KEY) {
  console.error('usage: SB_URL=... SB_KEY=... node storage-sync.mjs download|upload <folder>')
  process.exit(2)
}
const dir = path.resolve(dirArg)
const filesDir = path.join(dir, 'files')
const API = `${URL_BASE}/storage/v1`
const AUTH = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const enc = (p) => p.split('/').map(encodeURIComponent).join('/')

// Object names come from the other side; never let one point outside the folder.
function localPath(bucket, name) {
  const parts = [bucket, ...name.split('/')]
  if (parts.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
    throw new Error(`unsafe object name: ${bucket}/${name}`)
  }
  const p = path.join(filesDir, ...parts)
  if (!p.startsWith(filesDir + path.sep)) throw new Error(`unsafe object name: ${bucket}/${name}`)
  return p
}

async function call(method, url, { json, body, headers = {}, ok = [] } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { ...AUTH, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: json !== undefined ? JSON.stringify(json) : body,
      })
    } catch (e) {
      if (attempt < 4) { await new Promise((r) => setTimeout(r, 1000 * attempt)); continue }
      throw new Error(`${method} ${url}: ${e.message}`)
    }
    if (res.ok || ok.includes(res.status)) return res
    if (res.status >= 500 && attempt < 4) { await new Promise((r) => setTimeout(r, 1000 * attempt)); continue }
    throw new Error(`${method} ${url} → ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}

async function listAll(bucket, prefix = '') {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const res = await call('POST', `${API}/object/list/${encodeURIComponent(bucket)}`, {
      json: { prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } },
    })
    const items = await res.json()
    for (const it of items) {
      const name = prefix ? `${prefix}/${it.name}` : it.name
      if (it.id === null || it.id === undefined) out.push(...(await listAll(bucket, name))) // a folder
      else out.push({ bucket, name, contentType: it.metadata?.mimetype || 'application/octet-stream', size: it.metadata?.size ?? null })
    }
    if (items.length < 1000) return out
  }
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it) }
  }))
}

async function download() {
  fs.mkdirSync(filesDir, { recursive: true })
  const buckets = (await (await call('GET', `${API}/bucket`)).json())
    .map((b) => ({ id: b.id, name: b.name, public: !!b.public, file_size_limit: b.file_size_limit ?? null, allowed_mime_types: b.allowed_mime_types ?? null }))
  const objects = []
  for (const b of buckets) objects.push(...(await listAll(b.id)))
  let bytes = 0
  await pool(objects, 4, async (o) => {
    const res = await call('GET', `${API}/object/${encodeURIComponent(o.bucket)}/${enc(o.name)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const p = localPath(o.bucket, o.name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, buf)
    bytes += buf.length
  })
  fs.writeFileSync(path.join(dir, 'buckets.json'), JSON.stringify(buckets, null, 2))
  fs.writeFileSync(path.join(dir, 'objects.json'), JSON.stringify(objects, null, 2))
  console.log(`files: ${objects.length} from ${buckets.length} bucket(s), ${(bytes / 1048576).toFixed(1)} MB`)
}

async function upload() {
  const buckets = JSON.parse(fs.readFileSync(path.join(dir, 'buckets.json'), 'utf8'))
  const objects = JSON.parse(fs.readFileSync(path.join(dir, 'objects.json'), 'utf8'))
  for (const b of buckets) {
    const res = await call('GET', `${API}/bucket/${encodeURIComponent(b.id)}`, { ok: [400, 404] })
    if (!res.ok) {
      await call('POST', `${API}/bucket`, { json: { id: b.id, name: b.name, public: b.public, file_size_limit: b.file_size_limit, allowed_mime_types: b.allowed_mime_types } })
      console.log(`created bucket ${b.id}`)
    }
  }
  await pool(objects, 4, async (o) => {
    const body = fs.readFileSync(localPath(o.bucket, o.name))
    await call('POST', `${API}/object/${encodeURIComponent(o.bucket)}/${enc(o.name)}`, {
      body, headers: { 'Content-Type': o.contentType || 'application/octet-stream', 'x-upsert': 'true' },
    })
  })
  console.log(`files: ${objects.length} uploaded`)
}

try {
  await (mode === 'download' ? download() : upload())
} catch (e) {
  console.error(`storage ${mode} failed: ${e.message}`)
  process.exit(1)
}
