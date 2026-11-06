// Supabase Edge Function: ask-claude (Axle v2, migration 140) — "Tanya Claude"
//
// A person asks a question in the app; Claude answers using a fixed list of read-only lookups (tools.ts) that run
// with that person's own sign-in, so it sees exactly what they may see. Nothing here can change shop data:
//   * the lookups are STABLE, SECURITY INVOKER database functions called over GET (a read-only transaction);
//   * the only writes are to the question log: tanya_start (as the person; checks the limits) and tanya_finish
//     (service role; stores the answer, model, lookups, tokens and cost).
//
// Models: Haiku first; Sonnet when Haiku hands the question over, needs too many lookups, or the data disagrees with
// itself (a lookup flags data_conflict), or when the person presses "Tanya lebih teliti". The Owner can pin a model
// in the settings, and compare Haiku, Sonnet and Opus side by side (mode "compare").
//
// Secrets: ANTHROPIC_API_KEY (set by the Owner in Supabase → Edge Functions → Secrets). Optional: TANYA_MODEL_HAIKU,
// TANYA_MODEL_SONNET, TANYA_MODEL_OPUS (model ids), ANTHROPIC_BASE_URL (local tests only).
// Deploy with the platform JWT check off (--no-verify-jwt), like the other functions: the sign-in is checked here.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { ESCALATE_TOOL, linkFrom, toolsFor, type ToolDef } from './tools.ts'
import { systemBlocks } from './prompt.ts'

// deno-lint-ignore no-explicit-any
type Json = any

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function apiKey(kind: 'public' | 'secret'): string {
  const [list, legacy] = kind === 'public' ? ['SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'] : ['SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY']
  try {
    const keys = JSON.parse(Deno.env.get(list) || '{}')
    if (typeof keys.default === 'string' && keys.default) return keys.default
  } catch { /* not set or not JSON: use the legacy key */ }
  return Deno.env.get(legacy)!
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// ---- Models and prices (USD per million tokens; platform.claude.com pricing, checked Nov 6, 2026) -----------------
type Tier = 'haiku' | 'sonnet' | 'opus'
const MODEL: Record<Tier, string> = {
  haiku: Deno.env.get('TANYA_MODEL_HAIKU') || 'claude-haiku-5-5',
  sonnet: Deno.env.get('TANYA_MODEL_SONNET') || 'claude-sonnet-5-5',
  opus: Deno.env.get('TANYA_MODEL_OPUS') || 'claude-opus-5-5',
}
const PRICE: Record<Tier, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  haiku: { in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  sonnet: { in: 2, out: 10, cacheRead: 0.10, cacheWrite: 2.5 },
  opus: { in: 4, out: 20, cacheRead: 0.20, cacheWrite: 5 },
}
const MAX_LOOKUPS: Record<Tier, number> = { haiku: 5, sonnet: 10, opus: 10 }
const MAX_TOKENS = 1500
const RESULT_CHARS = 10000 // one lookup's result as given to Claude

type Usage = { in: number; out: number; cacheRead: number; cacheWrite: number; usd: number }
const noUsage = (): Usage => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 })
function addUsage(u: Usage, tier: Tier, x: Json) {
  const p = PRICE[tier]
  const i = x?.input_tokens || 0, o = x?.output_tokens || 0, cr = x?.cache_read_input_tokens || 0, cw = x?.cache_creation_input_tokens || 0
  u.in += i; u.out += o; u.cacheRead += cr; u.cacheWrite += cw
  u.usd += (i * p.in + o * p.out + cr * p.cacheRead + cw * p.cacheWrite) / 1e6
}

async function callClaude(body: Json, timeoutMs = 60000): Promise<Json> {
  const base = Deno.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com'
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) throw new Error('NO_KEY')
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) return await res.json()
    const text = await res.text().catch(() => '')
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 1) {
      await new Promise((ok) => setTimeout(ok, 2500))
      continue
    }
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`)
  }
}

// ---- One run of the question on one model --------------------------------------------------------------------------
type Lookup = { tool: string; input: Json; label: string; ok: boolean }
type Link = { kind: string; id: string; label: string }
type Run = { answer: string; lookups: Lookup[]; links: Link[]; escalate: string | null }

// What one question may spend per model before it must answer with what it has (USD), and lookups per reply.
const BUDGET: Record<Tier, number> = { haiku: 0.02, sonnet: 0.15, opus: 0.30 }
const MAX_PER_TURN = 4

// Lookups' totals first, so a cut-off result still has them.
function serialize(result: Json): string {
  let content = JSON.stringify(result && typeof result === 'object' && !Array.isArray(result) && 'summary' in result
    ? { summary: result.summary, ...result } : result ?? null)
  if (content.length > RESULT_CHARS) content = content.slice(0, RESULT_CHARS) + ' …(cut: ask a narrower question or look up one record)'
  return content
}

// The newest message carries the cache mark, so each turn of lookups re-reads the earlier ones from the cache.
function withCacheMark(messages: Json[]): Json[] {
  return messages.map((m, i) => {
    if (i !== messages.length - 1) return m
    if (typeof m.content === 'string') return { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
    const c = [...m.content]
    c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } }
    return { ...m, content: c }
  })
}

// usage, lookups and links are filled in as the run goes, so they are kept even when it fails halfway.
async function run(tier: Tier, opts: {
  caller: SupabaseClient; ctx: Json; page: Page; messages: Json[]; canEscalate: boolean
  deadline: number // ms timestamp: the platform stops a function after ~150 s, so answer well before that
  usage: Usage; lookups: Lookup[]; links: Link[]
}): Promise<Run> {
  const fleet = !!opts.ctx.fleet
  const tools = toolsFor(fleet)
  const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]))
  const apiTools: Json[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  if (opts.canEscalate) apiTools.push(ESCALATE_TOOL)
  apiTools[apiTools.length - 1] = { ...apiTools[apiTools.length - 1], cache_control: { type: 'ephemeral' } }

  const system = systemBlocks(opts.ctx, opts.page)
  const messages = [...opts.messages]
  const { usage, links } = opts
  const lookups: Lookup[] = []
  const spentBefore = usage.usd
  let forceAnswer = false
  const done = (answer: string, escalate: string | null): Run => ({ answer, lookups, links, escalate })

  for (let turn = 0; turn < 14; turn++) {
    const left = opts.deadline - Date.now()
    if (left < 8000) throw new Error('TIMEOUT')
    if (left < 30000 || usage.usd - spentBefore > BUDGET[tier]) forceAnswer = true
    const reply = await callClaude({
      model: MODEL[tier], max_tokens: MAX_TOKENS, system, tools: apiTools, messages: withCacheMark(messages),
      ...(forceAnswer ? { tool_choice: { type: 'none' } } : {}),
    }, Math.min(60000, left - 3000))
    addUsage(usage, tier, reply.usage)
    const blocks: Json[] = reply.content || []
    const uses = blocks.filter((b) => b.type === 'tool_use')
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()

    const handOver = uses.find((u) => u.name === ESCALATE_TOOL.name)
    if (handOver && opts.canEscalate) return done('', `Haiku: ${String(handOver.input?.reason || '').slice(0, 200)}`)
    if (!uses.length || reply.stop_reason !== 'tool_use') return done(text, null)

    messages.push({ role: 'assistant', content: blocks })
    const results: Json[] = []
    let conflict = false
    for (const [n, u] of uses.entries()) {
      const tool = byName.get(u.name)
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Unknown tool.', is_error: true })
        continue
      }
      if (n >= MAX_PER_TURN) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: `Not run: at most ${MAX_PER_TURN} lookups at a time.`, is_error: true })
        continue
      }
      // GET: PostgREST runs it in a read-only transaction
      const { data, error } = await opts.caller.rpc(tool.fn, tool.args(u.input || {}), { get: true })
      const result = error ? { error: /permission denied|not allowed/i.test(error.message) ? 'Not available for this login' : 'Lookup failed' } : data
      const l = { tool: tool.name, input: u.input || {}, label: tool.label(u.input || {}, result), ok: !error && !result?.error }
      lookups.push(l); opts.lookups.push(l)
      const link = linkFrom(tool, result, fleet)
      if (link && !links.some((x) => x.kind === link.kind && x.id === link.id)) links.push(link)
      if (result?.data_conflict) conflict = true
      results.push({ type: 'tool_result', tool_use_id: u.id, content: serialize(result) })
    }
    messages.push({ role: 'user', content: results })

    if (opts.canEscalate && conflict) return done('', 'data_conflict')
    if (lookups.length > MAX_LOOKUPS[tier]) {
      if (opts.canEscalate) return done('', 'many_lookups')
      forceAnswer = true
    }
  }
  return done('', null)
}

// ---- Messages to friendly text ---------------------------------------------------------------------------------------
const MSG: Record<string, { id: string; en: string; status: number }> = {
  TANYA_OFF: { id: 'Tanya Claude sedang dimatikan oleh Pemilik.', en: 'Tanya Claude is switched off by the Owner.', status: 403 },
  TANYA_NOT_ALLOWED: { id: 'Login ini tidak bisa memakai Tanya Claude.', en: 'This login cannot use Tanya Claude.', status: 403 },
  TANYA_LIMIT_DAY: { id: 'Batas pertanyaan hari ini tercapai. Coba lagi besok, atau minta Pemilik menaikkan batasnya.', en: 'You have reached today\'s question limit. Try again tomorrow, or ask the Owner to raise it.', status: 429 },
  TANYA_LIMIT_MONTH: { id: 'Batas biaya Tanya Claude bulan ini tercapai. Tanya Claude aktif lagi bulan depan, atau Pemilik bisa menaikkan batasnya.', en: 'This month\'s Tanya Claude cost cap is reached. It comes back next month, or the Owner can raise the cap.', status: 429 },
  TANYA_EMPTY: { id: 'Tulis pertanyaannya dulu.', en: 'Type a question first.', status: 400 },
  TANYA_TOO_LONG: { id: 'Pertanyaannya terlalu panjang (maksimal 2.000 karakter).', en: 'The question is too long (2,000 characters at most).', status: 400 },
  FAILED: { id: 'Maaf, Claude tidak bisa menjawab sekarang. Coba lagi sebentar lagi.', en: 'Sorry, Claude can\'t answer right now. Try again in a moment.', status: 502 },
  NO_ANSWER: { id: 'Maaf, Claude tidak menemukan jawaban. Coba tanyakan dengan kata lain.', en: 'Sorry, Claude couldn\'t find an answer. Try asking another way.', status: 200 },
}
const say = (code: string, lang: string) => (lang === 'en' ? MSG[code].en : MSG[code].id)

// ---- The request ---------------------------------------------------------------------------------------------------
type Page = { path?: string; label?: string }
// The page comes from the app: only an app address and a short plain title are passed on.
function cleanPage(path: unknown, label: unknown): Page {
  const p = String(path ?? '').slice(0, 200)
  const l = String(label ?? '').replace(/[\u0000-\u001f\u007f"<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return { path: /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(p) ? p : undefined, label: l || undefined }
}
// Errors kept in the log: the kind only, never the API's own text.
const errorKind = (e: unknown) => {
  const m = String((e as Error)?.message || e)
  return m === 'NO_KEY' || m === 'TIMEOUT' ? m : (m.match(/^API \d{3}/)?.[0] || (/abort|timed? ?out/i.test(m) ? 'TIMEOUT' : 'ERROR'))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)
  let lang = 'id'
  try {
    const body = await req.json().catch(() => ({}))
    lang = body.lang === 'en' ? 'en' : 'id'
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Not signed in.' }, 401)

    const url = Deno.env.get('SUPABASE_URL')!
    const caller = createClient(url, apiKey('public'), { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } })
    const { data: who, error: whoErr } = await caller.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''))
    if (whoErr || !who?.user) return json({ error: 'Not signed in.' }, 401)
    const admin = createClient(url, apiKey('secret'), { auth: { persistSession: false } })

    const page = cleanPage(body.page, body.pageLabel)
    const mode = body.mode === 'compare' ? 'compare' : 'ask'
    const retryOf = typeof body.retryOf === 'string' && /^[0-9a-f-]{36}$/i.test(body.retryOf) ? body.retryOf : null

    // Earlier questions in the panel, so follow-ups work: read back from this person's own log, never from the app.
    const history: Json[] = []
    const ids = (Array.isArray(body.historyIds) ? body.historyIds : []).filter((x: unknown) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(-6)
    if (ids.length) {
      const { data: rows } = await admin.from('tanya_log').select('id, question, answer').in('id', ids)
        .eq('user_id', who.user.id).eq('status', 'answered').eq('mode', 'ask')
      for (const id of ids) {
        const h = rows?.find((r) => r.id === id)
        if (h?.question && h?.answer) history.push({ role: 'user', content: h.question.slice(0, 1500) }, { role: 'assistant', content: h.answer.slice(0, 2500) })
      }
    }

    async function start(): Promise<{ ctx?: Json; code?: string }> {
      const { data, error } = await caller.rpc('tanya_start', { p_question: String(body.question ?? ''), p_page: page.path ?? null, p_page_label: page.label ?? null, p_retry_of: retryOf, p_mode: mode })
      if (error) {
        const code = (error.message.match(/TANYA_[A-Z_]+/) || [])[0]
        return { code: code && MSG[code] ? code : 'FAILED' }
      }
      return { ctx: data }
    }
    async function finish(id: string, status: 'answered' | 'failed', r: { answer?: string; usage: Usage; lookups: Lookup[]; model: Tier; escalated?: string | null; reason?: string | null; error?: string }) {
      const u = r.usage
      const { error } = await admin.rpc('tanya_finish', {
        p_id: id, p_status: status, p_answer: r.answer ?? null, p_model: r.model, p_escalated: r.escalated ?? null,
        p_reason: r.reason ?? null, p_tools: r.lookups.map((l) => ({ tool: l.tool, input: l.input, label: l.label, ok: l.ok })),
        p_in: u.in, p_out: u.out, p_cache_read: u.cacheRead, p_cache_write: u.cacheWrite, p_cost: Number(u.usd.toFixed(6)), p_error: r.error ?? null,
      })
      if (error) console.error('tanya_finish failed', id, error.message)
    }
    const messagesFor = (ctx: Json) => [...history, { role: 'user', content: String(ctx.question) }]

    // ---- Owner/Admin: the same question on Haiku, Sonnet and Opus, side by side
    if (mode === 'compare') {
      const tiers: Tier[] = ['haiku', 'sonnet', 'opus']
      const results = await Promise.all(tiers.map(async (tier) => {
        const s = await start()
        if (s.code) return { model: tier, error: say(s.code, lang) }
        const t0 = Date.now()
        const acc = { usage: noUsage(), lookups: [] as Lookup[], links: [] as Link[] }
        try {
          const r = await run(tier, { caller, ctx: s.ctx, page, messages: messagesFor(s.ctx), canEscalate: false, deadline: t0 + 120000, ...acc })
          const answer = r.answer || say('NO_ANSWER', lang)
          await finish(s.ctx.id, 'answered', { answer, usage: acc.usage, lookups: acc.lookups, model: tier })
          return { id: s.ctx.id, model: tier, answer, links: acc.links.slice(0, 4), lookups: acc.lookups.map((l) => l.label), cost_usd: Number(acc.usage.usd.toFixed(6)), ms: Date.now() - t0 }
        } catch (e) {
          await finish(s.ctx.id, 'failed', { usage: acc.usage, lookups: acc.lookups, model: tier, error: errorKind(e) })
          return { model: tier, error: say('FAILED', lang) }
        }
      }))
      return json({ results })
    }

    // ---- A question from the panel
    const s = await start()
    if (s.code) return json({ error: say(s.code, lang), code: s.code }, MSG[s.code].status)
    const ctx = s.ctx
    const t0 = Date.now()
    const deadline = t0 + 120000
    const pinned: Tier | null = ctx.model_mode === 'sonnet' ? 'sonnet' : ctx.model_mode === 'opus' ? 'opus' : null
    let tier: Tier = pinned || (retryOf ? 'sonnet' : 'haiku')
    let escalated: string | null = retryOf ? 'staff' : null
    let reason: string | null = retryOf ? 'Tanya lebih teliti' : null
    const acc = { usage: noUsage(), lookups: [] as Lookup[], links: [] as Link[] }
    const messages = messagesFor(ctx)
    try {
      let r = await run(tier, { caller, ctx, page, messages, canEscalate: tier === 'haiku', deadline, ...acc })
      if (r.escalate) {
        reason = r.escalate
        escalated = 'auto'
        tier = 'sonnet'
        r = await run(tier, { caller, ctx, page, messages, canEscalate: false, deadline, ...acc })
      }
      const answer = r.answer || say('NO_ANSWER', lang)
      await finish(ctx.id, 'answered', { answer, usage: acc.usage, lookups: acc.lookups, model: tier, escalated, reason })
      // under the answer: the lookups of the model that answered
      return json({ id: ctx.id, model: tier, escalated, answer, links: acc.links.slice(0, 4), lookups: r.lookups.map((l) => l.label),
        cost_usd: Number(acc.usage.usd.toFixed(6)), ms: Date.now() - t0 })
    } catch (e) {
      const kind = errorKind(e)
      await finish(ctx.id, 'failed', { usage: acc.usage, lookups: acc.lookups, model: tier, escalated, reason, error: kind })
      return json({ error: say('FAILED', lang), code: kind === 'NO_KEY' ? 'NO_KEY' : 'FAILED' }, 502)
    }
  } catch (e) {
    console.error('ask-claude', (e as Error)?.message)
    return json({ error: say('FAILED', lang), code: 'FAILED' }, 500)
  }
})
