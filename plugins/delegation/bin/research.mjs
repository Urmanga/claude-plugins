#!/usr/bin/env node
// Runner and acceptance gate for research via the Cursor CLI (composer).
//
// Principle: the runner NEVER asks the agent whether it succeeded.
// Success = an observed effect, verified deterministically.
//
// Usage:
//   node research.mjs <manifest.json> [--out DIR] [--concurrency N] [--tries N]
//
// Return codes: 0 — gate is complete; 1 — some workers were not accepted; 2 —
// the runner itself is broken (bad manifest, missing binary, a leaked process).

import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync, writeSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// Acceptance lives in its own module and is covered by fixtures (accept.test.mjs).
// It can't be duplicated here: then one logic gets tested and a different one runs.
import { accept } from './accept.mjs'

const AGENT_CMD =
  process.env.CURSOR_AGENT_CMD ||
  path.join(process.env.LOCALAPPDATA || '', 'cursor-agent', 'agent.cmd')

const IS_WIN = process.platform === 'win32'
const t0 = Date.now()

// ── progress: NDJSON on stdout, that's the whole UI ──────────────────────────

// Written synchronously: process.exit() cuts off unflushed async stdout, and
// losing the last progress line isn't an option — the caller judges the
// outcome by it.
const emit = (t, extra = {}) => {
  try {
    writeSync(1, JSON.stringify({ t, ms: Date.now() - t0, ...extra }) + '\n')
  } catch {}
}

function finish(code) {
  process.exitCode = code
}

// A configuration error is a broken runner (code 2), not a worker failure
// (code 1). Exiting via a thrown exception won't do: an unhandled exception
// forces code 1 and masks the distinction.
function fatal(msg) {
  emit('runner.fatal', { error: msg })
  process.exit(2)
}

// ── argument and manifest parsing ────────────────────────────────────────────

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('usage: node research.mjs <manifest.json> [--out DIR] [--concurrency N] [--tries N]')
  process.exit(2)
}
const manifestPath = argv[0]
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  return dflt
}

// A NaN silently turns the pool into zero workers and paints "0 of 12
// failed", even though nothing ran. Hence: fail hard, don't degrade.
const posInt = (name, v) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) fatal(`${name}: expected an integer ≥1, got "${v}"`)
  return n
}

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch (e) {
  fatal(`manifest is unreadable: ${e.message}`)
}

const workers = manifest.workers
if (!Array.isArray(workers) || workers.length === 0) {
  fatal('manifest does not contain a non-empty workers array')
}
const keys = workers.map((w) => w?.key)
if (keys.some((k) => typeof k !== 'string' || !/^[\w.-]{1,64}$/.test(k))) {
  fatal('each worker needs a key from [A-Za-z0-9_.-], up to 64 characters')
}
if (new Set(keys).size !== keys.length) {
  fatal('worker keys must be unique — otherwise the report silently loses results')
}
if (workers.some((w) => typeof w?.prompt !== 'string' || w.prompt.trim() === '')) {
  fatal('each worker needs a non-empty prompt')
}

const OUT = path.resolve(
  flag('out', path.join(path.dirname(manifestPath), `gate${manifest.gate ?? 1}-out`)),
)
const CONCURRENCY = posInt('concurrency', flag('concurrency', manifest.concurrency ?? 4))
const TRIES = posInt('tries', flag('tries', manifest.tries ?? 3))
const MODEL = manifest.model ?? 'composer-2.5-fast'
const HARD_MS = posInt('hardTimeoutMs', manifest.hardTimeoutMs ?? 420_000)
const IDLE_MS = posInt('idleTimeoutMs', manifest.idleTimeoutMs ?? 120_000)
const DRAIN_MS = posInt('drainMs', manifest.drainMs ?? 3_000)
const STAGGER_MS = Number(manifest.staggerMs ?? 400)
const REQUIRED = manifest.required ?? ['findings']
if (!Array.isArray(REQUIRED) || REQUIRED.length === 0) {
  fatal('required must be a non-empty list of fields — otherwise acceptance degenerates')
}
const CITATION = manifest.citationPolicy ?? 'fetched'
// How many consecutive failures with a network/server cause mean the
// provider is down, rather than the worker being at fault.
const BREAKER_AT = posInt('breakerAt', manifest.breakerAt ?? 4)

const WS = path.resolve(manifest.workspace ?? path.join(OUT, 'ws'))

// ── killing the process tree, with verification ──────────────────────────────
// taskkill /T walks the tree by ParentProcessId AT THE MOMENT IT RUNS. If the
// root cmd.exe has already died, the grandchild is orphaned and unreachable:
// taskkill returns 128 while the agent keeps burning paid quota. So: snapshot
// the subtree BEFORE killing, then verify survivors by the pair (pid, start
// time) — so we don't kill an unrelated process that reused the PID.

function psRun(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    p.stdout?.setEncoding('utf8')
    p.stderr?.setEncoding('utf8')
    p.stdout?.on('data', (s) => (out += s))
    p.stderr?.on('data', (s) => (err += s))
    p.on('exit', (code) => resolve({ code, out, err }))
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }))
    setTimeout(() => resolve({ code: -2, out, err: 'ps timeout' }), 20_000)
  })
}

const PS = ['-NoProfile', '-NonInteractive', '-Command']
const FMT = '{ "$($_.ProcessId) $([long]([datetime]$_.CreationDate).ToFileTimeUtc())" }'

async function snapshotTree(rootPid) {
  const r = await psRun('powershell', [
    ...PS,
    `$all = Get-CimInstance Win32_Process
     $want = New-Object 'System.Collections.Generic.HashSet[int]'
     [void]$want.Add(${rootPid})
     for ($i=0; $i -lt 16; $i++) {
       $n = $want.Count
       foreach ($p in $all) { if ($want.Contains([int]$p.ParentProcessId)) { [void]$want.Add([int]$p.ProcessId) } }
       if ($want.Count -eq $n) { break }
     }
     $all | Where-Object { $want.Contains([int]$_.ProcessId) } | ForEach-Object ${FMT}`,
  ])
  return r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [pid, born] = s.split(/\s+/)
      return { pid: Number(pid), born }
    })
    .filter((x) => Number.isInteger(x.pid))
}

async function stillAlive(snap) {
  if (!snap.length) return []
  const filter = snap.map((s) => `ProcessId=${s.pid}`).join(' OR ')
  const r = await psRun('powershell', [
    ...PS,
    `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ForEach-Object ${FMT}`,
  ])
  const now = new Map(
    r.out
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => l.trim().split(/\s+/))
      .map(([p, b]) => [Number(p), b]),
  )
  return snap.filter((s) => now.get(s.pid) === s.born)
}

// A snapshot taken at kill time is useless: if the root has already died, the
// child is orphaned and a parent-chain walk won't find it. So the tree gets
// re-snapshotted WHILE the process is alive, and the accumulated list is used
// at exit — however it exits, not only when killed.
function watchTree(rootPid, observed) {
  if (!IS_WIN || !rootPid) return () => {}
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    for (const p of await snapshotTree(rootPid)) observed.set(p.pid, p.born)
    if (!stopped) timer = setTimeout(tick, 15_000)
  }
  // First snapshot immediately: the agent's process tree comes up within a
  // fraction of a second, and there's nothing to wait for — the earlier
  // children are recorded, the smaller the chance of missing one.
  tick()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

// reapTree is called ALWAYS when a worker finishes. kill=false means "the
// process exited on its own" — but its children may still be around, and
// that's just as much a quota leak as an unkilled tree.
async function reapTree(rootPid, observed, { kill }) {
  if (!IS_WIN) {
    if (kill && rootPid) { try { process.kill(rootPid, 'SIGKILL') } catch {} }
    return { ok: true, survivors: [] }
  }
  const snap = [...observed.entries()].map(([pid, born]) => ({ pid, born }))
  if (rootPid && !observed.has(rootPid)) snap.push({ pid: rootPid, born: null })

  let tkCode = null
  if (kill && rootPid) {
    const tk = await psRun('taskkill', ['/PID', String(rootPid), '/T', '/F'])
    tkCode = tk.code
  }
  if (snap.length === 0) return { ok: true, survivors: [], taskkillCode: tkCode }

  const deadline = Date.now() + 15_000
  let alive = await stillAlive(snap.filter((s) => s.born !== null))
  while (alive.length && Date.now() < deadline) {
    for (const p of alive) await psRun('taskkill', ['/PID', String(p.pid), '/T', '/F'])
    await new Promise((r) => setTimeout(r, 300))
    alive = await stillAlive(snap.filter((s) => s.born !== null))
  }
  return { ok: alive.length === 0, taskkillCode: tkCode, survivors: alive.map((p) => p.pid) }
}

// Compatibility shim for the signal handler: the tree hasn't been observed yet there.
async function killTree(pid) {
  return reapTree(pid, new Map(), { kill: true })
}

// ── one agent run ─────────────────────────────────────────────────────────────

const LEAKED = []
const LIVE = new Set()

async function runAgent({ key, prompt, attempt, lastReason }) {
  const dir = path.join(OUT, key)
  await mkdir(dir, { recursive: true })

  // Prompt goes in via a stdin UTF-8 buffer: as an argument, Cyrillic breaks
  // on the .cmd shim. A retry gets the reason for the previous rejection —
  // otherwise the agent repeats the same mistake, and marking the attempt
  // also keeps it from handing back a cached answer.
  const marked =
    attempt > 1
      ? `${prompt}\n\n---\nATTEMPT ${attempt}. The previous one was rejected by acceptance, reason: ${lastReason}\nFix exactly that.\n`
      : prompt

  await writeFile(path.join(dir, `prompt.attempt${attempt}.txt`), marked, 'utf8')

  const args = ['-p', '--trust', '--force', '--output-format', 'stream-json', '--model', MODEL]

  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', AGENT_CMD, ...args], {
      cwd: WS,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    LIVE.add(child)

    const observed = new Map()
    const stopWatch = watchTree(child.pid, observed)

    let out = ''
    let err = ''
    let finished = false
    let idleTimer = null
    let hardTimer = null
    let drainTimer = null

    const settle = async (verdict) => {
      if (finished) return
      finished = true
      clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      clearTimeout(drainTimer)
      stopWatch()

      // Always check for survivors: a "clean" agent exit that leaves a
      // living child behind is just as much a paid-quota leak as an
      // unkilled tree.
      let leak = null
      const k = await reapTree(child.pid, observed, { kill: !!verdict.killed })
      if (!k.ok) {
        leak = k
        LEAKED.push({ key, attempt, survivors: k.survivors, taskkillCode: k.taskkillCode })
        emit('worker.leaked', { key, attempt, survivors: k.survivors, taskkillCode: k.taskkillCode })
      }
      LIVE.delete(child)

      await writeFile(path.join(dir, `raw.attempt${attempt}.jsonl`), out, 'utf8').catch(() => {})
      if (err.trim()) {
        await writeFile(path.join(dir, `stderr.attempt${attempt}.txt`), err, 'utf8').catch(() => {})
      }
      resolve({ ...verdict, raw: out, stderr: err, ms: Date.now() - started, leak })
    }

    const bumpIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => settle({ ok: false, reason: `no output for ${IDLE_MS}ms`, killed: true }),
        IDLE_MS,
      )
    }

    hardTimer = setTimeout(
      () => settle({ ok: false, reason: `hard timeout ${HARD_MS}ms`, killed: true }),
      HARD_MS,
    )
    bumpIdle()

    // setEncoding holds onto the tail of an incomplete UTF-8 sequence across
    // chunks. Without it, Cyrillic breaks into U+FFFD — and worse, the
    // corrupted JSON stays valid JSON and sails through acceptance.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (s) => { out += s; bumpIdle() })
    child.stderr.on('data', (s) => { err += s; bumpIdle() })

    child.on('error', (e) => settle({ ok: false, reason: `failed to start: ${e.message}`, killed: false }))

    // Wait for 'exit' (process death), not 'close' (all pipes closed): any
    // grandchild that inherited stdout holds 'close' open indefinitely — a
    // successful run would otherwise be rejected on a timeout.
    child.on('exit', (code) => {
      clearTimeout(hardTimer)
      clearTimeout(idleTimer)
      drainTimer = setTimeout(
        () => settle({ ok: true, exitCode: code, killed: true, note: `stdout did not close within ${DRAIN_MS}ms` }),
        DRAIN_MS,
      )
    })
    child.on('close', (code) => {
      clearTimeout(drainTimer)
      settle({ ok: true, exitCode: code, killed: false })
    })

    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(marked, 'utf8'))
  })
}

// ── pool ─────────────────────────────────────────────────────────────────────

let launched = 0
let breakerTripped = null
let consecutiveInfra = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      // Stagger is counted by actual launch order, not by index: otherwise
      // the first four start simultaneously and there's no stagger at all.
      const n = launched++
      if (n > 0) await sleep(STAGGER_MS)
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

// ── setup ────────────────────────────────────────────────────────────────────

async function prepareWorkspace() {
  await mkdir(path.join(WS, '.cursor'), { recursive: true })
  // allow is required even when empty, otherwise the config fails schema
  // validation. deny layers on top of --force: web stays available, shell
  // and write access get stripped.
  await writeFile(
    path.join(WS, '.cursor', 'cli.json'),
    JSON.stringify({ permissions: { allow: [], deny: ['Shell(*)', 'Write(*)'] } }, null, 2),
    'utf8',
  )
}

if (!existsSync(AGENT_CMD)) fatal(`agent not found: ${AGENT_CMD} (set CURSOR_AGENT_CMD)`)

await mkdir(OUT, { recursive: true })
await prepareWorkspace()

// Ctrl-C must not leave the agent process tree running.
let interrupted = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (interrupted) return
    interrupted = true
    emit('runner.interrupted', { signal: sig, live: LIVE.size })
    for (const c of LIVE) await killTree(c.pid)
    process.exitCode = 2
    process.exit(2)
  })
}

emit('gate.start', {
  gate: manifest.gate ?? 1,
  workers: workers.length,
  concurrency: CONCURRENCY,
  tries: TRIES,
  model: MODEL,
})

const outcomes = await pool(workers, CONCURRENCY, async (w) => {
  const attempts = []
  let lastReason = null

  for (let attempt = 1; attempt <= TRIES; attempt++) {
    if (breakerTripped) {
      return { key: w.key, accepted: false, reason: `skipped: ${breakerTripped}`, attempts }
    }
    if (attempt > 1) {
      // Backoff with jitter: otherwise a correlated failure on the API side
      // burns through every attempt of every worker within a few seconds.
      const back = Math.min(30_000, 2_000 * 2 ** (attempt - 2))
      await sleep(back + Math.floor(Math.random() * 1_000))
    }

    emit('worker.start', { key: w.key, attempt })
    const run = await runAgent({ key: w.key, prompt: w.prompt, attempt, lastReason })
    const verdict = accept(run, { required: REQUIRED, citationPolicy: CITATION })
    attempts.push({ attempt, ok: verdict.accepted, reason: verdict.reason ?? null, ms: run.ms })

    if (verdict.accepted) {
      consecutiveInfra = 0
      await writeFile(
        path.join(OUT, w.key, 'result.json'),
        JSON.stringify(verdict.payload, null, 2),
        'utf8',
      )
      emit('worker.accepted', { key: w.key, attempt, ...verdict.stats })
      return { key: w.key, accepted: true, payload: verdict.payload, attempts }
    }

    lastReason = verdict.reason
    emit('worker.rejected', { key: w.key, attempt, reason: verdict.reason, kind: verdict.kind, ms: run.ms })

    // "run"/"stream" rejections are infrastructure, not the worker. Many in a
    // row mean the provider is down, and hammering away further is pointless.
    if (verdict.kind === 'run' || verdict.kind === 'stream') {
      if (++consecutiveInfra >= BREAKER_AT && !breakerTripped) {
        breakerTripped = `breaker: ${consecutiveInfra} consecutive infrastructure failures`
        emit('gate.breaker', { reason: breakerTripped })
      }
    } else {
      consecutiveInfra = 0
    }
  }
  return { key: w.key, accepted: false, reason: lastReason, attempts }
})

const accepted = outcomes.filter((o) => o?.accepted)
const failed = outcomes
  .filter((o) => !o?.accepted)
  .map((o) => ({ key: o?.key ?? '(unknown)', reason: o?.reason ?? '(no reason)', attempts: o?.attempts ?? [] }))

const report = {
  gate: manifest.gate ?? 1,
  model: MODEL,
  // The counter only counts workers that passed acceptance. An empty worker
  // list is not a "complete gate" but a config error: completeness requires
  // that there was work to begin with.
  accepted: accepted.length,
  total: workers.length,
  complete: workers.length > 0 && accepted.length === workers.length && LEAKED.length === 0,
  failed,
  leaked: LEAKED,
  breaker: breakerTripped,
  retried: accepted.filter((o) => o.attempts.length > 1).map((o) => ({ key: o.key, attempts: o.attempts.length })),
  durationMs: Date.now() - t0,
  results: Object.fromEntries(accepted.map((o) => [o.key, o.payload])),
}
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

emit('gate.done', {
  accepted: accepted.length,
  total: workers.length,
  complete: report.complete,
  failed: failed.map((f) => f.key),
  leaked: LEAKED.length,
})

// A leaked process is also an incomplete gate: it burns quota invisibly.
finish(report.complete ? 0 : 1)
