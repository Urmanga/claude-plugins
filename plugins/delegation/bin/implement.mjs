#!/usr/bin/env node
// Single coding-task orchestrator (v1: sequential, single writer).
//
// Pipeline: isolated branch → writer (Cursor) in repair-loop → code acceptance on
// each attempt → green: we commit ourselves → red after ceiling: rollback + report.
//
// Invariants (same as across the whole system):
//  • Acceptance is NOT based on agent self-report, but on observed effect (git diff + gates).
//  • Acceptance is a fraud filter, NOT a correctness oracle: when there is no
//    test oracle we report "correctness NOT guaranteed", not green.
//  • The orchestrator commits, not the agent (composition under control).
//  • Failure = failure: not "almost worked", but an honest report with a reason.
//
// v1 — sequential, WITHOUT worktree/parallelism: works on a separate branch
// in the repo itself. Parallel worktrees — v2, when we prove we hit speed limits.
//
// Usage:
//   node implement.mjs <task.json>
//
// task.json:
// {
//   "repo": "I:/path/to/repo",              // git repo with already green tests
//   "task": "human-readable spec for the writer — what to fix",
//   "branch": "impl/fix-foo",               // optional; auto otherwise
//   "accept": {                             // accept-code config (stack-specific)
//     "typecheck": ["npx","tsc","--noEmit"],
//     "lint": ["npx","eslint","."],
//     "failToPass": ["npx","vitest","run","src/foo.test.ts"],
//     "passToPass": ["npx","vitest","run"],
//     "ownerAllow": ["^src/"]
//   },
//   "writer": { "writeGlobs": ["Write(src/**)"], "model": "composer-2.5-fast" },
//   "maxAttempts": 3,
//   "maxWallMs": 0
// }

import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { existsSync, writeSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { acceptCode, DEFAULT_CFG, CPP_CFG, UE_CFG } from './accept-code.mjs'
import { repairLoop } from './repair-loop.mjs'
import { makeCursorWriter, installWriterPermissions } from './writer-cursor.mjs'

const t0 = Date.now()
const emit = (t, extra = {}) => { try { writeSync(1, JSON.stringify({ t, ms: Date.now() - t0, ...extra }) + '\n') } catch {} }
const fatal = (msg) => { emit('impl.fatal', { error: msg }); process.exit(2) }

const PRESETS = { ts: DEFAULT_CFG, cpp: CPP_CFG, ue: UE_CFG }

const git = (repo, ...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })

// ── regexes from manifest strings ──────────────────────────────────────────────
// Can't put regexp in JSON — ownerAllow/testGlobs arrive as strings, we compile them.
function toRegexList(arr) {
  if (!Array.isArray(arr)) return undefined
  return arr.map((s) => (s instanceof RegExp ? s : new RegExp(s)))
}

const argv = process.argv.slice(2)
if (!argv[0]) { console.error('usage: node implement.mjs <task.json>'); process.exit(2) }

let task
try { task = JSON.parse(await readFile(argv[0], 'utf8')) } catch (e) { fatal(`cannot read manifest: ${e.message}`) }

const repo = task.repo && path.resolve(task.repo)
if (!repo || !existsSync(repo)) fatal(`repo not found: ${task.repo}`)
if (typeof task.task !== 'string' || !task.task.trim()) fatal('task field must be non-empty (spec for writer)')
if (git(repo, 'rev-parse', '--show-toplevel').status !== 0) fatal(`${repo} is not a git repository`)

// Require clean tree: otherwise we can't tell writer edits from unsaved
// user changes, and acceptance/rollback will lie.
const dirty = git(repo, 'status', '--porcelain').stdout.trim()
if (dirty) fatal(`working tree is dirty — commit or stash changes before running:\n${dirty.slice(0, 400)}`)

// Acceptance config: stack preset + manifest overrides.
const preset = PRESETS[task.stack || 'ts'] || DEFAULT_CFG
const acceptCfg = {
  ...preset,
  ...task.accept,
  ownerAllow: toRegexList(task.accept?.ownerAllow) ?? preset.ownerAllow,
  testGlobs: toRegexList(task.accept?.testGlobs) ?? preset.testGlobs,
}

const branch = task.branch || `impl/${Date.now().toString(36)}`
const startRef = git(repo, 'rev-parse', 'HEAD').stdout.trim()
// Remember the BRANCH the user was on: checking out the raw SHA on failure
// would leave them on a detached HEAD (live-run lesson).
const startBranchRaw = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()
const startBranch = startBranchRaw && startBranchRaw !== 'HEAD' ? startBranchRaw : startRef

emit('impl.start', { repo, branch, startRef: startRef.slice(0, 8), stack: task.stack || 'ts' })

// Isolated branch. If it exists — error, so we don't overwrite someone else's work.
if (git(repo, 'rev-parse', '--verify', branch).status === 0) fatal(`branch ${branch} already exists — choose another`)
if (git(repo, 'checkout', '-b', branch).status !== 0) fatal(`failed to create branch ${branch}`)

const logDir = path.join(repo, '.impl-logs', branch.replace(/[^\w.-]/g, '-'))
await mkdir(logDir, { recursive: true })

// Hide OUR service files from git via local exclude (not .gitignore —
// we'd have to commit that). Otherwise acceptance gate 0 sees .cursor/.impl-logs as
// "paths outside owner-set" and fails a fix the writer did correctly. Idempotent.
const excludePath = path.join(repo, '.git', 'info', 'exclude')
{
  let cur = ''
  try { cur = readFileSync(excludePath, 'utf8') } catch {}
  const need = ['.cursor/', '.impl-logs/'].filter((p) => !cur.includes(p))
  if (need.length) await appendFile(excludePath, '\n' + need.join('\n') + '\n').catch(() => {})
}

let report
try {
  await installWriterPermissions(repo, task.writer || {})

  const runWriter = makeCursorWriter({
    worktree: repo,
    logDir,
    model: task.writer?.model || 'composer-2.5-fast',
    hardMs: task.hardMs || 420_000,
    idleMs: task.idleMs || 120_000,
  })

  const result = await repairLoop({
    worktree: repo,
    task: task.task,
    runWriter,
    acceptFn: acceptCode,
    acceptCfg,
    maxAttempts: task.maxAttempts || 3,
    maxWallMs: task.maxWallMs || 0,
    log: (e) => emit(e.t, e),
  })

  if (result.accepted) {
    // We commit ourselves. Service files (our cli.json, logs) don't go in the commit: first
    // add -A, THEN remove service files from index — reverse order would bring them back.
    git(repo, 'add', '-A')
    git(repo, 'reset', '-q', '--', '.cursor/cli.json', '.impl-logs')
    const cov = result.verdict?.coverageBacked
    const msg = cov
      ? `impl: ${task.task.slice(0, 60)}`
      : `impl (UNVERIFIED, no test oracle): ${task.task.slice(0, 50)}`
    const c = git(repo, '-c', 'user.email=impl@local', '-c', 'user.name=implement', 'commit', '-q', '-m', msg)
    const committed = c.status === 0
    report = {
      ok: true,
      branch,
      attempts: result.attempts,
      coverageBacked: Boolean(cov),
      committed,
      // Honest boundary: accepted = not caught cheating + tests passed.
      // Without a test oracle correctness is NOT confirmed.
      correctness: cov ? 'passed tests (but tests are not a full guarantee)' : 'NOT CONFIRMED: no test oracle was present',
      warnings: result.verdict?.warnings || [],
    }
  } else {
    // Rollback: restore tree to start, delete branch, return to where we came from.
    git(repo, 'checkout', '-q', '--', '.')
    git(repo, 'clean', '-qfd', '--', 'src') // clean only src (writer owner zone)
    report = {
      ok: false,
      branch,
      attempts: result.attempts,
      stopReason: result.stopReason,
      lastReason: result.verdict?.reason || null,
      history: result.history,
    }
  }
} catch (e) {
  report = { ok: false, error: e.message, stopReason: 'orchestrator-crash', branch }
} finally {
  // Always return user to original commit/branch, so we don't leave them
  // on our working branch. Keep the branch with successful commit — that's the result.
  const prev = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()
  if (prev === branch && report && !report.ok) {
    git(repo, 'checkout', '-q', startBranch)
    git(repo, 'branch', '-qD', branch)
  } else if (prev === branch) {
    git(repo, 'checkout', '-q', startBranch) // return to start branch, keep result branch
  }
}

emit('impl.done', report)
process.exit(report.ok ? 0 : 1)
