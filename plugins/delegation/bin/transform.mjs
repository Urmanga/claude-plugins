#!/usr/bin/env node
// Bulk mechanical transform: one rule applied to many INDEPENDENT files by a
// pool of Cursor composers running in parallel.
//
// This is a THIRD mode, distinct from research (read-only) and implement
// (one writer, test oracle):
//  • Units are independent (file != file), so parallelism is real, not cargo
//    cult — unlike implement, where a shared contract makes it harmful.
//  • Each composer works in an ISOLATED temp copy of a SINGLE file. No races
//    in a shared tree, and no cross-file context — which is precisely why this
//    mode only fits changes that need none (translate, rename by pattern,
//    reformat). If the change needs to see other files, use implement.
//  • Per-file acceptance is NOT "tests pass": syntax intact + goal reached +
//    only its own file touched.
//  • The behavioural oracle runs LAST, on the merged result: apply everything,
//    run the suites, and revert wholesale if they go red. That catches
//    "syntax fine, behaviour changed".
//  • A partial result is a failure. Nothing is applied unless EVERY file
//    passed — otherwise half the codebase ends up transformed and half not.
//
// Usage:
//   node transform.mjs <task.json>
//
// task.json:
// {
//   "root": "I:/path/to/repo",           // files are resolved against this
//   "files": ["bin/a.mjs", "bin/b.mjs"], // explicit list; each is one unit
//   "task": "instruction for the composer; {{file}} -> the file's name",
//   "accept": {
//     "syntax": ["node", "--check", "{{abs}}"],  // optional per-file gate
//     "mustNotMatch": "[Ѐ-ӿ]",         // optional regex on content
//     "mustMatch": "..."                          // optional regex on content
//   },
//   "oracle": [["node", "bin/some.test.mjs"]],   // optional, run in root
//   "concurrency": 4,
//   "maxAttempts": 3,
//   "model": "composer-2.5-fast"
// }

import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { makeCursorWriter, installWriterPermissions } from './writer-cursor.mjs'

const t0 = Date.now()
const emit = (t, extra = {}) => process.stdout.write(JSON.stringify({ t, ms: Date.now() - t0, ...extra }) + '\n')
const fatal = (msg) => { emit('transform.fatal', { error: msg }); process.exit(2) }

const argv = process.argv.slice(2)
if (!argv[0]) { console.error('usage: node transform.mjs <task.json>'); process.exit(2) }

let cfg
try { cfg = JSON.parse(await readFile(argv[0], 'utf8')) } catch (e) { fatal(`cannot read manifest: ${e.message}`) }

const root = cfg.root && path.resolve(cfg.root)
if (!root || !existsSync(root)) fatal(`root not found: ${cfg.root}`)
if (!Array.isArray(cfg.files) || cfg.files.length === 0) fatal('files must be a non-empty array')
if (typeof cfg.task !== 'string' || !cfg.task.trim()) fatal('task must be a non-empty instruction')

const missing = cfg.files.filter((f) => !existsSync(path.join(root, f)))
if (missing.length) fatal(`files not found under root: ${missing.join(', ')}`)

const CONCURRENCY = cfg.concurrency || 4
const MAX_ATTEMPTS = cfg.maxAttempts || 3
const MODEL = cfg.model || 'composer-2.5-fast'

const mustNot = cfg.accept?.mustNotMatch ? new RegExp(cfg.accept.mustNotMatch, 'u') : null
const mustHave = cfg.accept?.mustMatch ? new RegExp(cfg.accept.mustMatch, 'u') : null

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')

// Per-file acceptance, run against the temp copy. Deliberately NOT the project
// test suite: a single file in isolation can't be behaviourally tested, so we
// check what IS checkable here and defer behaviour to the merged-result oracle.
function acceptFile(dir, file) {
  const abs = path.join(dir, path.basename(file))
  let content
  try { content = readFileSync(abs, 'utf8') } catch (e) { return { ok: false, reason: `file missing: ${e.message}` } }

  if (cfg.accept?.syntax) {
    const [cmd, ...rest] = cfg.accept.syntax.map((a) => fill(a, { abs, file: path.basename(file) }))
    const chk = spawnSync(cmd, rest, { encoding: 'utf8' })
    if (chk.status !== 0) {
      // Report the actual diagnostic, not the first stderr line: `node --check`
      // leads with "<path>:<line>", which says nothing about what broke.
      const out = `${chk.stderr || ''}\n${chk.stdout || ''}`
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
      const diag = lines.find((l) => /(Error|error|warning)\b/.test(l)) || lines[0] || 'no output'
      return { ok: false, reason: `syntax gate failed: ${diag.slice(0, 200)}` }
    }
  }
  if (mustNot && mustNot.test(content)) {
    const line = content.split('\n').find((l) => mustNot.test(l)) || ''
    return { ok: false, reason: `forbidden pattern still present: "${line.trim().slice(0, 60)}"` }
  }
  if (mustHave && !mustHave.test(content)) {
    return { ok: false, reason: 'required pattern not found in result' }
  }
  return { ok: true, content }
}

async function transformOne(file) {
  const base = path.basename(file)
  const src = path.join(root, file)
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-'))
  copyFileSync(src, path.join(dir, base))

  // Writer may touch ONLY its own file. testGlob is neutralised because the
  // unit here may itself be a test file being reformatted.
  await installWriterPermissions(dir, { writeGlobs: [`Write(${base})`], testGlob: 'Write(__none__)' })
  const runWriter = makeCursorWriter({
    worktree: dir,
    model: MODEL,
    hardMs: cfg.hardMs || 240_000,
    idleMs: cfg.idleMs || 90_000,
  })

  const prompt = fill(cfg.task, { file: base })
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Restore the original before each retry so every attempt starts clean —
    // otherwise attempt N compounds attempt N-1's damage.
    if (attempt > 1) copyFileSync(src, path.join(dir, base))
    emit('file.attempt', { file, attempt })

    const w = await runWriter(
      attempt === 1 ? prompt : `${prompt}\n\nThe previous attempt failed acceptance. Redo it, fully satisfying the requirements.`,
    )
    if (!w.ok) { emit('file.writer_dead', { file, attempt, reason: w.reason }); continue }

    const v = acceptFile(dir, file)
    if (v.ok) { emit('file.accepted', { file, attempt }); return { file, ok: true, content: v.content } }
    emit('file.rejected', { file, attempt, reason: v.reason })
  }
  return { file, ok: false }
}

async function pool(items, limit, fn) {
  const res = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      if (i > 0) await new Promise((r) => setTimeout(r, 400)) // stagger process starts
      res[i] = await fn(items[i])
    }
  }))
  return res
}

emit('transform.start', { root, files: cfg.files.length, concurrency: CONCURRENCY, model: MODEL })

const results = await pool(cfg.files, CONCURRENCY, transformOne)
const good = results.filter((r) => r?.ok)
const bad = cfg.files.filter((f, i) => !results[i]?.ok)

// All-or-nothing: a partial sweep is worse than none.
if (bad.length) {
  emit('transform.incomplete', { accepted: good.length, failed: bad })
  process.exit(1)
}

// Back up originals, apply, then run the behavioural oracle on the merged
// result. Red suites mean the transform changed behaviour — revert everything.
const backup = new Map()
for (const r of good) backup.set(r.file, readFileSync(path.join(root, r.file), 'utf8'))
for (const r of good) writeFileSync(path.join(root, r.file), r.content, 'utf8')
emit('transform.applied', { files: good.length })

let broke = null
for (const suite of cfg.oracle || []) {
  const [cmd, ...rest] = suite
  const run = spawnSync(cmd, rest, { encoding: 'utf8', cwd: root, timeout: cfg.oracleTimeoutMs || 300_000, shell: process.platform === 'win32' })
  emit('oracle.suite', { suite: suite.join(' '), code: run.status })
  if (run.status !== 0) { broke = suite.join(' '); break }
}

if (broke) {
  for (const [f, c] of backup) writeFileSync(path.join(root, f), c, 'utf8')
  emit('transform.reverted', { reason: `behavioural oracle went red after transform: ${broke}` })
  process.exit(1)
}

emit('transform.done', { files: good.length, oracleBacked: Boolean(cfg.oracle?.length) })
process.exit(0)
