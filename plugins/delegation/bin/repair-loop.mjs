// Repair loop: writer → acceptance → if red, return reason+diff and retry.
//
// Unlike one-shot recon retry: there it's "failed → restart". Here —
// iterative convergence to green acceptance, where FEEDBACK QUALITY (diff
// of the last fix + error text) matters more than attempt count.
//
// Three rules from recon "how others fix":
//  1. Stop on BUDGET, not counter (SWE-agent): attempts + wall-clock.
//  2. STUCK detector separate from limit (OpenHands): same error class
//     in a row → stop immediately, don't count to the ceiling.
//  3. In the repair prompt — diff of the fix that caused the error (regression-repair: −1.8x).
//
// writer is injected: runWriter(prompt, worktree) -> { ok, raw?, reason? }.
//
// ⚠️ SURGICAL REVERT. Early version did `git clean -fd` — wiped ALL
// untracked files, and a test targeting a live folder erased neighboring
// files. Now we snapshot baseline untracked AT START and remove
// only what appeared AFTER (writer created). Tracked changes
// reverted via checkout. Pre-existing stuff (what was before the writer) is never touched —
// function is safe even in a shared worktree.

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

function untrackedSet(wt) {
  const r = spawnSync('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (r.status !== 0) return new Set()
  return new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
}

// Revert to baseline state: don't touch others' changes.
function revertWorktree(wt, baseline) {
  // 1. Tracked files — restore to HEAD (undoes writer edits in them).
  spawnSync('git', ['-C', wt, 'checkout', '--', '.'], { encoding: 'utf8' })
  // 2. Untracked — remove ONLY what appeared after baseline.
  const now = untrackedSet(wt)
  for (const rel of now) {
    if (!baseline.has(rel)) {
      try { rmSync(path.join(wt, rel), { force: true }) } catch {}
    }
  }
}

function currentDiff(wt) {
  const r = spawnSync('git', ['-C', wt, 'diff'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : ''
}

// ── error normalization for stuck detector ───────────────────────────
// "Same error" = same gate + message class, not byte-for-byte. Strip
// line/col numbers, addresses, paths, quotes — shape remains.

function errorSignature(verdict) {
  return `${verdict.gate}|${verdict.kind}|${verdict.reason || ''}`
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '0x')
    .replace(/:\d+:\d+/g, ':L:C')
    .replace(/\b\d+\b/g, 'N')
    .replace(/[«»"'`][^«»"'`]*[«»"'`]/g, 'Q')
    .replace(/[a-z]:[\\/][^\s]+/gi, 'PATH')
    .replace(/\/[^\s]+/g, 'PATH')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── repair prompt assembly ───────────────────────────────────────────────────

function buildRepairPrompt(task, attempt, lastFail) {
  if (attempt === 1 || !lastFail) return task
  const diffBlock = lastFail.diff
    ? `\n\nYour previous fix (it did NOT pass acceptance):\n\`\`\`diff\n${lastFail.diff.slice(0, 6000)}\n\`\`\``
    : ''
  return `${task}

---
ATTEMPT ${attempt}. Previous fix rejected by automated acceptance.
Reason (gate ${lastFail.gate}, ${lastFail.kind}): ${lastFail.reason}
${diffBlock}

Worktree already reverted to initial state — previous fix is not on disk, start fresh. Fix EXACTLY the reason above. Do not touch tests. Do not suppress the error (@ts-ignore, NOLINT, disable) — fix the root cause.`
}

// ── loop ────────────────────────────────────────────────────────────────────
// stopReason: 'accepted' | 'stuck' | 'budget' | 'max-attempts' | 'writer-dead'

export async function repairLoop({
  worktree,
  task,
  runWriter,
  acceptFn,
  acceptCfg = {},
  maxAttempts = 3,
  maxWallMs = 0,
  stuck = 2,
  log = () => {},
  now = () => Date.now(),
}) {
  const t0 = now()
  const baseline = untrackedSet(worktree) // snapshot of pre-existing untracked before writer
  const history = []
  let lastFail = null
  let sameSig = 0
  let prevSig = null
  let writerDeadStreak = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (maxWallMs && now() - t0 > maxWallMs) {
      log({ t: 'repair.budget', attempt, spentMs: now() - t0 })
      return { accepted: false, attempts: attempt - 1, stopReason: 'budget', verdict: lastFail, history }
    }

    if (attempt > 1) revertWorktree(worktree, baseline)

    const prompt = buildRepairPrompt(task, attempt, lastFail)
    log({ t: 'repair.attempt', attempt })

    const w = await runWriter(prompt, worktree)
    if (!w || !w.ok) {
      writerDeadStreak++
      log({ t: 'repair.writer_dead', attempt, reason: w?.reason || 'unknown', streak: writerDeadStreak })
      history.push({ attempt, writerDead: true, reason: w?.reason })
      if (writerDeadStreak >= stuck) {
        return { accepted: false, attempts: attempt, stopReason: 'writer-dead', verdict: null, history }
      }
      continue
    }
    writerDeadStreak = 0

    const verdict = await acceptFn(worktree, acceptCfg)
    if (verdict.accepted) {
      log({ t: 'repair.accepted', attempt, coverageBacked: verdict.coverageBacked })
      return { accepted: true, attempts: attempt, stopReason: 'accepted', verdict, history }
    }

    const diff = currentDiff(worktree)
    lastFail = { gate: verdict.gate, kind: verdict.kind, reason: verdict.reason, diff }
    history.push({ attempt, gate: verdict.gate, kind: verdict.kind, reason: verdict.reason })
    log({ t: 'repair.rejected', attempt, gate: verdict.gate, kind: verdict.kind, reason: verdict.reason })

    const sig = errorSignature(verdict)
    if (sig === prevSig) {
      sameSig++
      if (sameSig >= stuck) {
        log({ t: 'repair.stuck', attempt, signature: sig })
        return { accepted: false, attempts: attempt, stopReason: 'stuck', verdict: lastFail, history }
      }
    } else {
      sameSig = 1
      prevSig = sig
    }
  }

  return { accepted: false, attempts: maxAttempts, stopReason: 'max-attempts', verdict: lastFail, history }
}
