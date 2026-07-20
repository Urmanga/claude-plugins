// Shared process-runtime: spawn a child process on Windows with two timers
// and kill the entire tree with survivor verification. Core logic for both
// the scout and the writer — the single source of truth for this logic.
//
// ⚠️ DEBT: research.mjs still holds ITS OWN copy of this runtime (it works and
// was battle-tested live by fake-agent; rewriting proven code from a long session
// is riskier than temporarily duplicating). Consolidating research.mjs onto
// this module is a separate task, not a v1 blocker.
//
// Verified facts (battle-tested on fake-agent stand: leak/drain/hang):
//  • taskkill /T walks the tree at launch time — it won't find an orphaned grandchild;
//    therefore the tree is watched WHILE the process is alive, cleaned up on ANY exit.
//  • wait for 'exit' (process death), not 'close' (pipe) — a grandchild holds the pipe forever.
//  • setEncoding('utf8') keeps the tail of an incomplete UTF-8 sequence.
//  • prompt — via stdin as a UTF-8 buffer; Cyrillic in args breaks on the .cmd shim.

import { spawn } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

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
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [pid, born] = s.split(/\s+/); return { pid: Number(pid), born } })
    .filter((x) => Number.isInteger(x.pid))
}

async function stillAlive(snap) {
  if (!snap.length) return []
  const filter = snap.map((s) => `ProcessId=${s.pid}`).join(' OR ')
  const r = await psRun('powershell', [
    ...PS,
    `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ForEach-Object ${FMT}`,
  ])
  const now = new Map(r.out.split(/\r?\n/).filter((l) => l.trim())
    .map((l) => l.trim().split(/\s+/)).map(([p, b]) => [Number(p), b]))
  return snap.filter((s) => now.get(s.pid) === s.born)
}

function watchTree(rootPid, observed) {
  if (!IS_WIN || !rootPid) return () => {}
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    for (const p of await snapshotTree(rootPid)) observed.set(p.pid, p.born)
    if (!stopped) timer = setTimeout(tick, 15_000)
  }
  tick()
  return () => { stopped = true; clearTimeout(timer) }
}

async function reapTree(rootPid, observed, { kill }) {
  if (!IS_WIN) {
    if (kill && rootPid) { try { process.kill(rootPid, 'SIGKILL') } catch {} }
    return { ok: true, survivors: [] }
  }
  const snap = [...observed.entries()].map(([pid, born]) => ({ pid, born }))
  if (rootPid && !observed.has(rootPid)) snap.push({ pid: rootPid, born: null })
  let tkCode = null
  if (kill && rootPid) tkCode = (await psRun('taskkill', ['/PID', String(rootPid), '/T', '/F'])).code
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

export async function killTreeByPid(pid) {
  return reapTree(pid, new Map(), { kill: true })
}

// runProcess — run a single command with two timers and tree cleanup.
// Returns { ok, raw, stderr, reason, killed, leaked, ms }.
//   ok=false  → process did not finish on its own (timeout/hang/crash).
//   leaked    → array of surviving pids if the tree could not be killed (quota leak).
export function runProcess(cmd, args, {
  cwd,
  stdin = null,
  hardMs = 420_000,
  idleMs = 120_000,
  drainMs = 3_000,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
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
      clearTimeout(idleTimer); clearTimeout(hardTimer); clearTimeout(drainTimer)
      stopWatch()
      const k = await reapTree(child.pid, observed, { kill: !!verdict.killed })
      resolve({ ...verdict, raw: out, stderr: err, ms: Date.now() - started, leaked: k.ok ? null : k.survivors })
    }

    const bumpIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => settle({ ok: false, reason: `no output for ${idleMs}ms`, killed: true }), idleMs)
    }
    hardTimer = setTimeout(() => settle({ ok: false, reason: `hard timeout ${hardMs}ms`, killed: true }), hardMs)
    bumpIdle()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (s) => { out += s; bumpIdle() })
    child.stderr.on('data', (s) => { err += s; bumpIdle() })
    child.on('error', (e) => settle({ ok: false, reason: `failed to start: ${e.message}`, killed: false }))
    child.on('exit', (code) => {
      clearTimeout(hardTimer); clearTimeout(idleTimer)
      drainTimer = setTimeout(() => settle({ ok: true, exitCode: code, killed: true, note: `stdout did not close within ${drainMs}ms` }), drainMs)
    })
    child.on('close', (code) => { clearTimeout(drainTimer); settle({ ok: true, exitCode: code, killed: false }) })

    child.stdin.on('error', () => {})
    child.stdin.end(stdin != null ? Buffer.from(stdin, 'utf8') : Buffer.alloc(0))
  })
}
