// Acceptance check for a scout's result. Split out from the runner so it can
// be tested against fixtures: rejection logic is more dangerous than success
// logic, because it runs rarely and so gets exercised poorly.
//
// The only export that matters: accept(run, opts) -> verdict.
// The runner must treat ONLY { accepted: true } as accepted.

export const DEFAULT_OPTS = {
  required: ['findings'],
  citationPolicy: 'fetched', // fetched | seen | off
}

// ── stream parsing ───────────────────────────────────────────────────────────

export function parseStream(raw) {
  const events = []
  let dropped = 0
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      events.push(JSON.parse(s))
    } catch {
      dropped++
    }
  }
  const results = events.filter((e) => e?.type === 'result')

  const fetched = new Set()
  const seen = new Set()
  for (const e of events) {
    if (e?.type !== 'tool_call') continue
    const tc = e.tool_call ?? {}
    if (tc.webFetchToolCall) {
      const url = tc.webFetchToolCall?.args?.url
      if (url) fetched.add(normUrl(url))
      for (const u of harvestUrls(tc.webFetchToolCall)) seen.add(u)
    }
    if (tc.webSearchToolCall) for (const u of harvestUrls(tc.webSearchToolCall)) seen.add(u)
  }
  for (const u of fetched) seen.add(u)
  return { events, results, fetched, seen, dropped }
}

function harvestUrls(obj) {
  const s = JSON.stringify(obj ?? {})
  const out = []
  for (const m of s.matchAll(/https?:\/\/[^\s"'\\<>)\]]+/g)) out.push(normUrl(m[0]))
  return out
}

// Case matters in the path and query on most servers: we drop only the scheme
// and host, otherwise a fabricated /docs/a would collapse onto a genuinely
// open /Docs/A.
export function normUrl(u) {
  const raw = String(u ?? '').trim().replace(/[.,;:'"`)\]]+$/, '')
  try {
    const x = new URL(raw.includes('://') ? raw : 'https://' + raw)
    x.hash = ''
    const host = x.host.toLowerCase().replace(/^www\./, '')
    let rest = x.pathname + x.search
    if (rest.endsWith('/')) rest = rest.slice(0, -1)
    return host + rest
  } catch {
    return raw.toLowerCase()
  }
}

// ── substantive checks ───────────────────────────────────────────────────────

const PLACEHOLDER = /^(n\/a|na|тбд|todo|tbd|—|--?|\.{2,}|<[^>]*>|null|none|нет данных|не найдено)$/i

export function isFilled(v) {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') {
    const s = v.trim()
    return s !== '' && !PLACEHOLDER.test(s)
  }
  if (Array.isArray(v)) return v.length > 0 && v.some(isFilled)
  if (typeof v === 'object') return Object.values(v).some(isFilled)
  if (typeof v === 'number') return true
  if (typeof v === 'boolean') return v === true
  return false
}

// The model often tacks a sample block onto the end of a real answer ("or
// like this"). Taking the last parseable block is wrong — the sample would
// crowd out the actual result.
export function extractJson(text, required = DEFAULT_OPTS.required) {
  if (!text) return { payload: null, ambiguous: false }
  const cands = []
  for (const m of String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    try { cands.push(JSON.parse(m[1])) } catch {}
  }
  if (cands.length === 0) {
    const first = String(text).indexOf('{')
    const last = String(text).lastIndexOf('}')
    if (first >= 0 && last > first) {
      try { cands.push(JSON.parse(String(text).slice(first, last + 1))) } catch {}
    }
  }
  if (cands.length === 0) return { payload: null, ambiguous: false }

  const score = (p) => required.reduce((acc, k) => acc + (isFilled(p?.[k]) ? 1 : 0), 0)
  let best = cands[0]
  let bestScore = score(best)
  for (const c of cands.slice(1)) {
    const s = score(c)
    if (s > bestScore) { best = c; bestScore = s }
  }
  // A tie at a nonzero score means it's unclear which candidate is the real
  // answer. A tie at zero doesn't matter — it fails on empty required fields
  // regardless.
  const ties = cands.filter((c) => score(c) === bestScore).length
  return { payload: best, ambiguous: ties > 1 && bestScore > 0 }
}

// A link with no scheme is just as much a citation, but it's invisible to the
// https:// regex, so a fabrication sails through unnoticed. We also catch
// bare domains in "link-like" fields.
const URL_KEY = /url|link|href|source|источник|ссылк/i
const BARE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?$/i

export function collectCitedUrls(payload) {
  const urls = new Set()
  const walk = (v, key = '') => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/https?:\/\/[^\s"'\\<>)\]]+/g)) urls.add(normUrl(m[0]))
      const s = v.trim()
      if (URL_KEY.test(key) && !s.includes('://') && BARE.test(s)) urls.add(normUrl(s))
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  walk(payload)
  return urls
}

// ── verdict ───────────────────────────────────────────────────────────────────
// kind tells who's at fault: run/stream is infrastructure (handled by retry
// and counted by the breaker), agent/shape/evidence is the worker itself.

export function accept(run, opts = {}) {
  const { required, citationPolicy } = { ...DEFAULT_OPTS, ...opts }

  if (!run?.ok) return { accepted: false, reason: run?.reason ?? 'run failed', kind: 'run' }

  const { results, fetched, seen, dropped } = parseStream(run.raw)

  if (dropped > 0) {
    return { accepted: false, reason: `stream corrupted: ${dropped} unparseable lines`, kind: 'stream' }
  }
  if (results.length === 0) return { accepted: false, reason: 'no result event', kind: 'stream' }

  const result = results[results.length - 1]
  if (result.subtype !== 'success') {
    return { accepted: false, reason: `subtype=${result.subtype}`, kind: 'agent' }
  }
  const errFlag = result.is_error ?? result.isError
  if (errFlag === true || errFlag === 'true') {
    return { accepted: false, reason: 'is_error', kind: 'agent' }
  }

  const { payload, ambiguous } = extractJson(result.result ?? '', required)
  if (!payload) return { accepted: false, reason: 'no parseable JSON in the response', kind: 'shape' }
  if (ambiguous) {
    return { accepted: false, reason: 'multiple equally-scored JSON blocks — unclear which one is the answer', kind: 'shape' }
  }

  const missing = required.filter((k) => !isFilled(payload[k]))
  if (missing.length) {
    return { accepted: false, reason: `empty or placeholder fields: ${missing.join(', ')}`, kind: 'shape' }
  }

  if (citationPolicy !== 'off') {
    // A scout that never made a single web request answered from memory.
    // Without this check, anti-fabrication degenerates into "no links, no
    // complaints" — i.e. acceptance starts rewarding sourceless answers.
    if (fetched.size === 0) {
      return { accepted: false, reason: 'not a single page was opened — answer came from memory', kind: 'evidence' }
    }
    const allowed = citationPolicy === 'seen' ? seen : fetched
    const fabricated = [...collectCitedUrls(payload)].filter((u) => !allowed.has(u))
    if (fabricated.length) {
      return {
        accepted: false,
        reason: `links outside the tool-call log (${fabricated.length}): ${fabricated.slice(0, 3).join(' ')}`,
        kind: 'evidence',
        fabricated,
      }
    }
  }

  return { accepted: true, payload, stats: { fetched: fetched.size, seen: seen.size, ms: run.ms } }
}
