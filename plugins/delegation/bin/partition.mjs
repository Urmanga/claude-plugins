#!/usr/bin/env node
// Slices questions for the research gate.
//
// The division of labor here is the whole point: a model is good at COMING UP
// WITH candidates and bad at judging how dissimilar they are — "pick the six
// most different ones" is something it does by eye. Dissimilarity can be
// computed deterministically, so the script computes it. The model produces
// ~20 sub-questions, the script picks the N least similar and assembles the
// manifest for research.mjs.
//
// Why bother at all: four parallel agents given the same question bring back
// the same answer. The payoff comes from slicing, not from headcount (arXiv
// 2602.03794: two heterogeneous agents match sixteen homogeneous ones).
//
// Usage:
//   node partition.mjs candidates.json --select 6 --out gate1.json [--known prev-report.json]
//
// candidates.json:
// {
//   "gate": 1,
//   "question": "overall gate question",
//   "workspace": "C:/path/to/scratch-ws",
//   "model": "composer-2.5",
//   "brief": "optional shared context, inserted into every prompt",
//   "candidates": [ { "key": "mcp-landscape", "question": "..." }, ... ]
// }

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { writeSync } from 'node:fs'

const emit = (t, extra = {}) => {
  try { writeSync(1, JSON.stringify({ t, ...extra }) + '\n') } catch {}
}
const fatal = (msg) => { emit('partition.fatal', { error: msg }); process.exit(2) }

// ── text similarity ──────────────────────────────────────────────────────────
// Cosine over TF-IDF. No embeddings, no network: the slicing has to be
// reproducible and free, otherwise it can't be trusted as the arbiter.

const STOP = new Set(`
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по
только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли
если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя
ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без
будто чего раз тоже себе под будет ж кто этот того потому этого какой совсем им
здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда
можно при наконец два об другой хоть после над больше тот через эти нас про них
какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть
том нельзя такой им более всегда конечно всю между
the a an and or of to in for on with is are was were be been being it its this
that these those as at by from has have had how what which who whom why when
where can could should would may might must do does did not no yes if then than
also into about over under more most some any all each other such via using use
`.trim().split(/\s+/))

// Rough stemmer: truncate a word form down to its stem. Good enough for
// Russian morphology to treat "разрешения" and "разрешений" as the same word.
const stem = (w) => (w.length > 6 ? w.slice(0, 6) : w)

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem)
}

function tf(text) {
  const m = new Map()
  for (const t of tokens(text)) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

function tfidfVectors(docs) {
  const tfs = docs.map(tf)
  const df = new Map()
  for (const m of tfs) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const N = docs.length
  return tfs.map((m) => {
    const v = new Map()
    let norm = 0
    for (const [t, c] of m) {
      const idf = Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1
      const w = c * idf
      v.set(t, w)
      norm += w * w
    }
    norm = Math.sqrt(norm) || 1
    for (const [t, w] of v) v.set(t, w / norm)
    return v
  })
}

function cosine(a, b) {
  let s = 0
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  for (const [t, w] of small) {
    const u = big.get(t)
    if (u) s += w * u
  }
  return s
}

// ── selection: coverage of the question's facets, not just dissimilarity ─────
// Pure MMR maximizes dissimilarity of candidates FROM EACH OTHER — and so
// drops topics named directly in the question if they're lexically sparse.
// Verified: on a question containing the word "cost", it discarded the one
// candidate about pricing tiers. So the primary criterion is how many
// NOT-YET-COVERED terms of the question a candidate brings; dissimilarity
// works as a penalty and tiebreaker only.
//
// must: true on a candidate forces inclusion: the planner sometimes knows
// something that isn't in the question's vocabulary.

// facets — facets tagged by the model when generating candidates. This is the
// one place where lexical matching is powerless: "cost" in the question and
// "billed per seat" in a candidate share no word, and a Russian question next
// to an English "permissions" candidate even less so. Only the model knows
// the semantics, so it's the one that tags them; the script just guarantees
// each facet is represented exactly once before filling the remaining slots
// by dissimilarity.
function selectByCoverage(vectors, queryVec, k, mustIdx = [], facets = [], penalty = 0.45) {
  const n = vectors.length
  const rel = vectors.map((v) => cosine(v, queryVec))
  const picked = []
  const remaining = new Set(vectors.map((_, i) => i))

  const uncovered = new Map(queryVec) // term → idf weight, struck off as it gets covered
  const usedFacets = new Set()
  const take = (i) => {
    picked.push(i)
    remaining.delete(i)
    if (facets[i]) usedFacets.add(facets[i])
    for (const t of vectors[i].keys()) uncovered.delete(t)
  }

  for (const i of mustIdx) if (remaining.has(i) && picked.length < k) take(i)

  // Two modes, and which one applies is decided by a single condition — do
  // the facets fit into the slots.
  //
  // Facets NO MORE THAN slots: cover each one once, taking its most relevant
  // representative. This guarantees no tagged topic is ever lost — exactly
  // what facets were introduced for (lexical matching can't connect "cost"
  // to "billed per seat").
  //
  // Facets MORE THAN slots: covering everything is impossible anyway, and
  // walking "one facet per file order" degenerates into picking by line
  // order. Verified: 17 facets over 18 candidates produced two nearly
  // identical questions about manifests. So here a facet only acts as a
  // BAN on repeats — which topics get taken is decided by dissimilarity.
  const distinct = new Set(facets.filter(Boolean)).size
  if (distinct && distinct <= k) {
    const order = []
    for (const f of facets) if (f && !usedFacets.has(f) && !order.includes(f)) order.push(f)
    for (const f of order) {
      if (picked.length >= k) break
      let best = -1
      let bestRel = -Infinity
      for (const i of remaining) {
        if (facets[i] !== f) continue
        if (rel[i] > bestRel + 1e-12) { bestRel = rel[i]; best = i }
      }
      if (best >= 0) take(best)
    }
  }

  while (picked.length < Math.min(k, n) && remaining.size) {
    let best = -1
    let bestScore = -Infinity
    for (const i of remaining) {
      if (facets[i] && usedFacets.has(facets[i])) continue
      let gain = 0
      for (const [t, w] of vectors[i]) {
        const q = uncovered.get(t)
        if (q) gain += w * q
      }
      let maxSim = 0
      for (const j of picked) {
        const s = cosine(vectors[i], vectors[j])
        if (s > maxSim) maxSim = s
      }
      // Once the question's facets run out, gain is zero for everyone — and
      // the criterion naturally degenerates into "take what's dissimilar and relevant."
      const score = gain + 0.25 * rel[i] - penalty * maxSim
      if (score > bestScore + 1e-12) { bestScore = score; best = i }
    }
    if (best < 0) {
      // Every remaining candidate belongs to an already-occupied facet.
      // Slots are worth more than the constraint: fill with the best ones,
      // ignoring the facet repeat.
      let alt = -1
      let altScore = -Infinity
      for (const i of remaining) {
        let maxSim = 0
        for (const j of picked) {
          const s2 = cosine(vectors[i], vectors[j])
          if (s2 > maxSim) maxSim = s2
        }
        const sc = 0.25 * rel[i] - penalty * maxSim
        if (sc > altScore + 1e-12) { altScore = sc; alt = i }
      }
      if (alt < 0) break
      take(alt)
      continue
    }
    take(best)
  }

  const dropped = []

  // For dropped candidates, record exactly who they overlapped with —
  // otherwise it's unclear whether a duplicate was dropped or a topic was lost.
  for (const i of remaining) {
    let maxSim = 0
    let rival = null
    for (const j of picked) {
      const s = cosine(vectors[i], vectors[j])
      if (s > maxSim) { maxSim = s; rival = j }
    }
    dropped.push({ index: i, similarity: Number(maxSim.toFixed(3)), closestTo: rival })
  }
  dropped.sort((a, b) => b.similarity - a.similarity)
  return { picked, dropped, rel }
}

// ── prompt assembly ──────────────────────────────────────────────────────────

const SCHEMA_BLOCK = `\`\`\`json
{
  "summary": "2-4 sentences: exactly what was found",
  "findings": [
    {
      "claim": "a claim, self-contained without extra context",
      "quote": "a verbatim quote from a page you opened",
      "url": "https://...",
      "source_type": "primary|secondary",
      "confidence": "high|medium|low"
    }
  ],
  "urls_opened": ["all URLs you actually opened"],
  "not_found": ["what you searched for and didn't find — with the query wording"]
}
\`\`\``

function buildPrompt({ question, brief, known }) {
  const parts = []
  if (brief) parts.push(`CONTEXT (don't research this, use it as framing):\n${brief}`)
  if (known) {
    // Injecting what's already known is the only defense against re-opening
    // the same ground twice. Duplicates within a single round are
    // unavoidable: agents can't see each other.
    parts.push(
      `ALREADY KNOWN — don't re-verify, build on and extend this:\n${known}`,
    )
  }
  parts.push(`QUESTION: ${question}`)
  parts.push(
    `HOW TO WORK:
1. First check LOCAL primary sources if they exist: installed SDKs, engine and library source code, local repositories, config files on this machine. They're more accurate than documentation and almost always get ignored.
2. Then search the web. Open pages and read them — don't answer from memory.
3. Prioritize primary sources: official documentation, repositories, changelogs, specs. Mark blogs and aggregators as secondary.
4. Every fact needs a VERBATIM quote from a page you actually opened, plus its URL. A quote that isn't on the opened page will be rejected automatically.
5. Whatever you didn't find, write into not_found with the query wording. Don't guess or fill gaps with something plausible-sounding.`,
  )
  parts.push(`RESPONSE FORMAT — end with a mandatory JSON block in triple backticks:\n${SCHEMA_BLOCK}`)
  return parts.join('\n\n')
}

// Summary of the previous round: claims only, no quotes — otherwise the block bloats.
function knownFromReport(report) {
  const lines = []
  for (const [key, payload] of Object.entries(report?.results ?? {})) {
    const claims = (payload?.findings ?? [])
      .map((f) => f?.claim)
      .filter((c) => typeof c === 'string' && c.trim())
    if (claims.length) lines.push(`[${key}]\n` + claims.map((c) => `- ${c}`).join('\n'))
  }
  const open = Object.values(report?.results ?? {})
    .flatMap((p) => p?.not_found ?? [])
    .filter(Boolean)
  if (open.length) lines.push('STILL OPEN FROM THE PREVIOUS ROUND:\n' + open.map((c) => `- ${c}`).join('\n'))
  return lines.join('\n\n')
}

// ── main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
if (!argv[0]) {
  console.error('usage: node partition.mjs <candidates.json> --select N --out manifest.json [--known report.json]')
  process.exit(2)
}
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : dflt
}

let src
try {
  src = JSON.parse(await readFile(argv[0], 'utf8'))
} catch (e) {
  fatal(`candidates file is unreadable: ${e.message}`)
}

const cands = src.candidates
if (!Array.isArray(cands) || cands.length === 0) fatal('need a non-empty candidates array')
if (typeof src.question !== 'string' || !src.question.trim()) fatal('need a non-empty question')

const keys = cands.map((c) => c?.key)
if (keys.some((k) => typeof k !== 'string' || !/^[\w.-]{1,64}$/.test(k))) {
  fatal('each candidate needs a key from [A-Za-z0-9_.-], up to 64 characters')
}
if (new Set(keys).size !== keys.length) fatal('candidate keys must be unique')
if (cands.some((c) => typeof c?.question !== 'string' || !c.question.trim())) {
  fatal('each candidate needs a non-empty question')
}

const SELECT = Number(flag('select', src.select ?? 6))
if (!Number.isInteger(SELECT) || SELECT < 1) fatal(`select: expected an integer ≥1, got "${flag('select')}"`)
// Nothing to select from means there was no partitioning, just a list.
if (cands.length < SELECT * 2) {
  emit('partition.warn', {
    message: `${cands.length} candidates for ${SELECT} slots — selection is nearly degenerate, provide at least ${SELECT * 3}`,
  })
}

const OUT = flag('out', path.join(path.dirname(argv[0]), `gate${src.gate ?? 1}.json`))

let known = null
const knownPath = flag('known', null)
if (knownPath) {
  try {
    known = knownFromReport(JSON.parse(await readFile(knownPath, 'utf8')))
  } catch (e) {
    fatal(`previous round's report is unreadable: ${e.message}`)
  }
  if (!known) emit('partition.warn', { message: "previous round's report is empty — the KNOWN block wasn't assembled" })
}

const texts = cands.map((c) => `${c.key} ${c.question}`)
const vectors = tfidfVectors([...texts, src.question])
const queryVec = vectors.pop()
const mustIdx = cands.map((c, i) => (c?.must ? i : -1)).filter((i) => i >= 0)
if (mustIdx.length > SELECT) fatal(`mandatory candidates (must) ${mustIdx.length}, but only ${SELECT} slots`)
const facets = cands.map((c) => (typeof c?.facet === 'string' ? c.facet.trim().toLowerCase() : ''))
const nFacets = new Set(facets.filter(Boolean)).size
if (nFacets && nFacets > SELECT) {
  emit('partition.warn', { message: `${nFacets} facets but ${SELECT} slots — some facets will be left without a scout` })
}
if (!nFacets) {
  emit('partition.warn', { message: "candidates have no facet — selection runs on lexical similarity only, topics outside the question's vocabulary may get dropped" })
}
const { picked, dropped } = selectByCoverage(vectors, queryVec, SELECT, mustIdx, facets)

const workers = picked.map((i) => ({
  key: cands[i].key,
  prompt: buildPrompt({ question: cands[i].question, brief: src.brief, known }),
}))

const manifest = {
  gate: src.gate ?? 1,
  question: src.question,
  workspace: src.workspace,
  model: src.model ?? 'composer-2.5-fast',
  concurrency: src.concurrency ?? Math.min(4, workers.length),
  tries: src.tries ?? 3,
  hardTimeoutMs: src.hardTimeoutMs ?? 420_000,
  idleTimeoutMs: src.idleTimeoutMs ?? 120_000,
  required: src.required ?? ['summary', 'findings', 'urls_opened'],
  citationPolicy: src.citationPolicy ?? 'fetched',
  workers,
}
await writeFile(OUT, JSON.stringify(manifest, null, 2), 'utf8')

emit('partition.done', {
  from: cands.length,
  selected: picked.map((i) => ({ key: cands[i].key, facet: facets[i] || null })),
  dropped: dropped.slice(0, 10).map((d) => ({
    key: cands[d.index].key,
    similarity: d.similarity,
    closestTo: d.closestTo === null ? null : cands[d.closestTo].key,
  })),
  known: Boolean(known),
  out: OUT,
})
