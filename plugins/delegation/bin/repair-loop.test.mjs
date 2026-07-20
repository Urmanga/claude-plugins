// Repair-loop fixtures. Acceptance is mocked with a scripted verdict; the writer is
// fake. But repairLoop actually calls git (revert/diff/ls-files), so each case gets
// a REAL temporary git repo.
//
// ⚠️ NEVER pass process.cwd() or a live folder here: revertWorktree deletes
// untracked files that appeared after startup. An early version of this test pointed
// at bin/ and `git clean -fd` wiped neighboring files. Now — mkdtemp only, plus a
// separate case proving: a foreign untracked file survives revert.
//
//   node repair-loop.test.mjs

import { repairLoop } from './repair-loop.mjs'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

let pass = 0
let fail = 0

const git = (wt, ...a) => spawnSync('git', ['-C', wt, ...a], { encoding: 'utf8' })

function tmpRepo() {
  const wt = mkdtempSync(path.join(tmpdir(), 'repair-'))
  writeFileSync(path.join(wt, 'f.txt'), 'base\n', 'utf8')
  git(wt, 'init', '-q'); git(wt, 'config', 'user.email', 't@t'); git(wt, 'config', 'user.name', 't')
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'base')
  return wt
}

function check(name, got, want) {
  const ok = got.stopReason === want.stopReason && got.accepted === want.accepted &&
    (want.attempts === undefined || got.attempts === want.attempts)
  if (ok) { pass++; console.log(`  ok   ${name}  → ${got.stopReason}, attempts ${got.attempts}`) }
  else {
    fail++
    console.log(`  FAIL ${name}`)
    console.log(`       expected stop=${want.stopReason} accepted=${want.accepted}${want.attempts !== undefined ? ` attempts=${want.attempts}` : ''}`)
    console.log(`       got      stop=${got.stopReason} accepted=${got.accepted} attempts=${got.attempts}`)
  }
}

function scriptedAccept(seq) {
  let i = 0
  return async () => seq[Math.min(i++, seq.length - 1)]
}
const REJECT = (gate, kind, reason) => ({ accepted: false, gate, kind, reason })
const ACCEPT = { accepted: true, coverageBacked: true, reason: 'ok' }
const liveWriter = async () => ({ ok: true, raw: '{}' })

async function withRepo(fn) {
  const wt = tmpRepo()
  try { return await fn(wt) } finally { try { rmSync(wt, { recursive: true, force: true }) } catch {} }
}

console.log('\nrepair loop:')

check('success on first attempt',
  await withRepo((wt) => repairLoop({ worktree: wt, task: 't', runWriter: liveWriter, acceptFn: scriptedAccept([ACCEPT]), maxAttempts: 3 })),
  { accepted: true, stopReason: 'accepted', attempts: 1 })

check('converges in 3 (different errors)',
  await withRepo((wt) => repairLoop({ worktree: wt, task: 't', runWriter: liveWriter,
    acceptFn: scriptedAccept([REJECT(5, 'test', 'expected 4 got 5'), REJECT(3, 'typecheck', 'TS2322 at foo.ts:10:5'), ACCEPT]), maxAttempts: 3 })),
  { accepted: true, stopReason: 'accepted', attempts: 3 })

check('stuck loop: same error twice',
  await withRepo((wt) => repairLoop({ worktree: wt, task: 't', runWriter: liveWriter,
    acceptFn: scriptedAccept([REJECT(3, 'typecheck', 'TS2322 at foo.ts:10:5'), REJECT(3, 'typecheck', 'TS2322 at foo.ts:14:9')]), maxAttempts: 5, stuck: 2 })),
  { accepted: false, stopReason: 'stuck', attempts: 2 })

check('hits max-attempts (new errors)',
  await withRepo((wt) => repairLoop({ worktree: wt, task: 't', runWriter: liveWriter,
    acceptFn: scriptedAccept([REJECT(5, 'test', 'expected 4 got 5'), REJECT(3, 'typecheck', 'TS2322 foo'), REJECT(2, 'stub', 'stub')]), maxAttempts: 3, stuck: 2 })),
  { accepted: false, stopReason: 'max-attempts', attempts: 3 })

check('writer dead twice',
  await withRepo((wt) => repairLoop({ worktree: wt, task: 't', runWriter: async () => ({ ok: false, reason: 'timeout' }), acceptFn: scriptedAccept([ACCEPT]), maxAttempts: 5, stuck: 2 })),
  { accepted: false, stopReason: 'writer-dead', attempts: 2 })

await (async () => {
  let call = 0
  const flaky = async () => (++call === 1 ? { ok: false, reason: 'blip' } : { ok: true, raw: '{}' })
  check('writer recovered after failure',
    await withRepo((wt) => repairLoop({ worktree: wt, task: 't', runWriter: flaky, acceptFn: scriptedAccept([ACCEPT]), maxAttempts: 3, stuck: 2 })),
    { accepted: true, stopReason: 'accepted' })
})()

await (async () => {
  let clock = 1000
  const tick = () => (clock += 5000)
  check('time budget exhausted',
    await withRepo((wt) => repairLoop({ worktree: wt, task: 't', runWriter: liveWriter, acceptFn: scriptedAccept([REJECT(5, 'test', 'nope'), ACCEPT]), maxAttempts: 5, maxWallMs: 3000, now: tick })),
    { accepted: false, stopReason: 'budget' })
})()

console.log('\nrevert safety:')

// On attempt 1 the writer creates ITS file; a FOREIGN untracked file is already in
// the tree. After revert on attempt 2: foreign survives, writer's file is removed.
await (async () => {
  const wt = tmpRepo()
  try {
    writeFileSync(path.join(wt, 'foreign-untracked.txt'), 'DO NOT TOUCH\n', 'utf8') // foreign, before writer
    let n = 0
    const writer = async (_p, w) => {
      n++
      if (n === 1) writeFileSync(path.join(w, 'writer-made.txt'), 'writer junk\n', 'utf8')
      return { ok: true, raw: '{}' }
    }
    const r = await repairLoop({ worktree: wt, task: 't', runWriter: writer,
      acceptFn: scriptedAccept([REJECT(2, 'stub', 'stub'), ACCEPT]), maxAttempts: 3 })
    const foreignAlive = existsSync(path.join(wt, 'foreign-untracked.txt'))
    const writerGone = !existsSync(path.join(wt, 'writer-made.txt'))
    if (r.accepted && foreignAlive && writerGone) { pass++; console.log('  ok   surgical revert: foreign file alive, writer file removed') }
    else { fail++; console.log(`  FAIL revert: accepted=${r.accepted} foreignAlive=${foreignAlive} writerGone=${writerGone}`) }
  } finally { try { rmSync(wt, { recursive: true, force: true }) } catch {} }
})()

console.log(`\nsummary: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
