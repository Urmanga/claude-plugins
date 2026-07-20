// Code change acceptance. Analogous to accept.mjs, but for mutation, not exploration.
//
// KEY POINT: this is a FRAUD FILTER, not a correctness oracle. Exploration has a
// killer gate "link ⊆ tool log" — claimed evidence is checked against observed
// action. Code has NO such analogue: "correct behavior" is not observable the way
// "the page was opened" is. Gates catch FRAUD (empty diff, touched test, stub,
// suppressed error) and do NOT catch INCORRECTNESS (fitting a weak test, regression
// in an uncovered path). The verdict is not "done" but "not caught cheating + passed
// available tests". Lying green is forbidden (same rule as with "6/6").
//
// Checks run strictly in order; any red = full failure (fail-fast: cheap fraud
// checks first, expensive test run last).
//
// Gates run FOREIGN commands (tsc/eslint/test) and read THEIR exit codes and
// diff from DISK. The agent's own exit code is not used — in Cursor it is
// undocumented. Disk (git) is truth; agent stream-json is a hint.

import { spawn } from 'node:child_process'

// ── run command with timeout ───────────────────────────────────────────────

function run(cmd, args, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, shell: false })
    let out = ''
    let err = ''
    let done = false
    const finish = (code, extra = {}) => {
      if (done) return
      done = true
      resolve({ code, out, err, ...extra })
    }
    p.stdout?.setEncoding('utf8')
    p.stderr?.setEncoding('utf8')
    p.stdout?.on('data', (s) => (out += s))
    p.stderr?.on('data', (s) => (err += s))
    p.on('error', (e) => finish(-1, { spawnError: e.message }))
    p.on('close', (code) => finish(code ?? -1))
    const t = setTimeout(() => finish(-2, { timedOut: true }), timeoutMs)
    p.on('close', () => clearTimeout(t))
  })
}

const git = (wt, args, opts = {}) => run('git', ['-C', wt, ...args], { cwd: wt, ...opts })

// ── configuration defaults (TypeScript) ────────────────────────────────────────

export const DEFAULT_CFG = {
  testGlobs: [/\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//],
  ownerAllow: [/^src\//], // empty → any path outside tests
  stubMarkers: [
    /\bNotImplementedError\b/,
    /\bnot[_ ]implemented\b/i,
    /\bTODO\b/,
    /\bFIXME\b/,
    /\braise NotImplementedError/,
    /^\s*pass\s*$/,
    /throw new Error\(['"`](not implemented|unimplemented|todo)/i,
  ],
  typeSuppressors: [/@ts-ignore/, /@ts-expect-error/, /\bas\s+any\b/, /:\s*any\b/],
  lintSuppressors: [/eslint-disable/, /\/\/\s*eslint-disable-next-line/, /#\s*noqa/],
  typecheck: ['npx', 'tsc', '--noEmit'],
  lint: null,
  failToPass: null,
  passToPass: null,
  timeoutMs: 300_000,
}

// ── stack presets ────────────────────────────────────────────────────────
// Gate logic is the same; markers and commands differ. Merge into acceptCode as opts.

// C++ differs from TS in three ways, each hitting a specific gate:
//  • Gate 3 (typecheck): C++ has NO separate cheap typecheck — type checking IS
//    COMPILATION itself, and it is slow (minutes, not seconds). So cheap gates must
//    filter junk BEFORE compilation. `-Werror` is the analogue of strict tsc.
//  • Stubs differ: C++ has no NotImplementedError/pass.
//  • Suppressors differ: not @ts-ignore/any, but pragmas, NOLINT, -Wno-, C casts.
export const CPP_CFG = {
  testGlobs: [/_test\.(cpp|cc|cxx|hpp|h)$/i, /test_.*\.(cpp|cc|cxx)$/i, /Test\.(cpp|cc|cxx)$/, /(^|\/)(tests?|Tests?)\//],
  ownerAllow: [],
  stubMarkers: [
    /\bTODO\b/, /\bFIXME\b/,
    /throw\s+std::(logic_error|runtime_error)\s*\(\s*["'`](not implemented|unimplemented|todo|stub)/i,
    /\bassert\s*\(\s*(false|0)\s*\)/,
    /\babort\s*\(\s*\)/,
    /#\s*error\b/,
    /static_assert\s*\(\s*false/,
    /\/\/\s*\.\.\.\s*(existing|rest|unchanged|\u043e\u0441\u0442\u0430\u043b\u044c\u043d\u043e\u0435)/i, // ellipsis "…rest of file"
  ],
  typeSuppressors: [
    /#\s*pragma\s+warning\s*\(\s*disable/i,
    /#\s*pragma\s+GCC\s+diagnostic\s+ignored/i,
    /#\s*pragma\s+clang\s+diagnostic\s+ignored/i,
    /\bNOLINT\b/,
    /-Wno-/,
  ],
  lintSuppressors: [/\bNOLINT(NEXTLINE|BEGIN)?\b/, /clang-format\s+off/],
  typecheck: null, // = the build itself; repo-specific and SLOW. e.g. ['cmake','--build','build']
  lint: null,
  failToPass: null,
  passToPass: null,
  timeoutMs: 900_000,
}

// Unreal Engine 5 — C++ on top of UnrealBuildTool, more rules:
//  • Build via UBT (Build.bat/RunUAT), not cmake. Minutes per incremental build. Budget
//    for repair-loop and stuck-detector is critical here.
//  • UHT macros (UCLASS/UPROPERTY/UFUNCTION/GENERATED_BODY) + paired .generated.h.
//    Broken macro → cryptic UHT error; pass its text to repair as-is.
//  • Blueprint (.uasset) is binary, not diffable. Gate 0 MUST forbid writing
//    *.uasset — text acceptance cannot verify them (our conclusion: UE code is edited in C++).
//  • Tests — Automation Spec, via commandlet (slow).
export const UE_CFG = {
  ...CPP_CFG,
  testGlobs: [...CPP_CFG.testGlobs, /Spec\.cpp$/, /\.uasset$/, /\.umap$/, /\.generated\.h$/],
  timeoutMs: 1_800_000, // up to 30 min for build — UE reality
}

// ── diff added lines ─────────────────────────────────────────────────

function addedLines(diff) {
  const out = []
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1))
  }
  return out
}

const matchAny = (globs, p) => globs.some((g) => (g instanceof RegExp ? g.test(p) : p.includes(g)))

// ── acceptance ──────────────────────────────────────────────────────────────────

export async function acceptCode(worktree, opts = {}) {
  const cfg = { ...DEFAULT_CFG, ...opts }
  const warnings = []

  // ── Gate 0: disk effect + ownership boundaries ──
  const status = await git(worktree, ['status', '--porcelain'])
  if (status.code !== 0) {
    return { accepted: false, gate: 0, reason: `git status failed: ${status.err.trim() || status.code}`, kind: 'infra' }
  }
  // --porcelain format: 2 status chars + space + path. Cannot trim —
  // trim eats the leading space and slice(3) grabs the first letter of the path.
  const changed = status.out
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => {
      let p = l.slice(3)
      const arrow = p.indexOf(' -> ')
      if (arrow >= 0) p = p.slice(arrow + 4)
      return p.trim().replace(/^"|"$/g, '')
    })
  if (changed.length === 0) {
    return { accepted: false, gate: 0, reason: 'nothing changed on disk — agent claimed success without doing the work', kind: 'fabrication' }
  }
  const outside = changed.filter((p) => cfg.ownerAllow.length && !matchAny(cfg.ownerAllow, p))
  if (outside.length) {
    return { accepted: false, gate: 0, reason: `touched paths outside allowed set: ${outside.slice(0, 5).join(', ')}`, kind: 'fabrication', changed }
  }

  // ── Gate 1: tests not touched (anti-fabrication #1) ──
  if (!cfg.mayEditTests) {
    const touchedTests = changed.filter((p) => matchAny(cfg.testGlobs, p))
    if (touchedTests.length) {
      return { accepted: false, gate: 1, reason: `test files modified: ${touchedTests.join(', ')}`, kind: 'fabrication', changed }
    }
  }

  const diffRes = await git(worktree, ['diff', '--unified=0'])
  if (diffRes.code !== 0) {
    return { accepted: false, gate: 2, reason: `git diff failed: ${diffRes.err.trim() || diffRes.code}`, kind: 'infra', changed }
  }
  const added = addedLines(diffRes.out)

  // ── Gate 2: stub detector in added lines ──
  for (const line of added) {
    const hit = cfg.stubMarkers.find((re) => re.test(line))
    if (hit) {
      return { accepted: false, gate: 2, reason: `stub in added code: "${line.trim().slice(0, 80)}"`, kind: 'stub', changed }
    }
  }

  // ── Gate 3: typecheck + no new suppressors ──
  const supHit = added.find((l) => cfg.typeSuppressors.some((re) => re.test(l)))
  if (supHit) {
    return { accepted: false, gate: 3, reason: `new type suppression instead of a fix: "${supHit.trim().slice(0, 80)}"`, kind: 'suppression', changed }
  }
  if (cfg.typecheck) {
    const tc = await run(cfg.typecheck[0], cfg.typecheck.slice(1), { cwd: worktree, timeoutMs: cfg.timeoutMs })
    if (tc.timedOut) return { accepted: false, gate: 3, reason: `typecheck timed out (${cfg.timeoutMs}ms)`, kind: 'infra', changed }
    if (tc.code !== 0) {
      const first = (tc.out + tc.err).split(/\r?\n/).filter((l) => /error/i.test(l))[0] || `exit ${tc.code}`
      return { accepted: false, gate: 3, reason: `typecheck failed: ${first.trim().slice(0, 120)}`, kind: 'typecheck', changed }
    }
  } else {
    warnings.push('gate 3 skipped: typecheck command not configured')
  }

  // ── Gate 4: lint + no new disable ──
  const lintSupHit = added.find((l) => cfg.lintSuppressors.some((re) => re.test(l)))
  if (lintSupHit) {
    return { accepted: false, gate: 4, reason: `new lint suppression: "${lintSupHit.trim().slice(0, 80)}"`, kind: 'suppression', changed }
  }
  if (cfg.lint) {
    const lt = await run(cfg.lint[0], cfg.lint.slice(1), { cwd: worktree, timeoutMs: cfg.timeoutMs })
    if (lt.timedOut) return { accepted: false, gate: 4, reason: `lint timed out`, kind: 'infra', changed }
    if (lt.code !== 0) {
      const first = (lt.out + lt.err).split(/\r?\n/).filter(Boolean)[0] || `exit ${lt.code}`
      return { accepted: false, gate: 4, reason: `lint failed: ${first.trim().slice(0, 120)}`, kind: 'lint', changed }
    }
  } else {
    warnings.push('gate 4 skipped: lint command not configured')
  }

  // ── Gate 5: tests as oracle — both halves ──
  if (cfg.failToPass) {
    const f = await run(cfg.failToPass[0], cfg.failToPass.slice(1), { cwd: worktree, timeoutMs: cfg.timeoutMs })
    if (f.timedOut) return { accepted: false, gate: 5, reason: `FAIL_TO_PASS timed out`, kind: 'infra', changed }
    if (f.code !== 0) {
      const last = (f.out + f.err).split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exit ${f.code}`
      return { accepted: false, gate: 5, reason: `target test (FAIL_TO_PASS) not green: ${last.trim().slice(0, 120)}`, kind: 'test', changed }
    }
  } else {
    warnings.push('NO FAIL_TO_PASS: fix correctness not verified — only absence of fraud was checked')
  }
  if (cfg.passToPass) {
    const pt = await run(cfg.passToPass[0], cfg.passToPass.slice(1), { cwd: worktree, timeoutMs: cfg.timeoutMs })
    if (pt.timedOut) return { accepted: false, gate: 5, reason: `PASS_TO_PASS timed out`, kind: 'infra', changed }
    if (pt.code !== 0) {
      const last = (pt.out + pt.err).split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exit ${pt.code}`
      return { accepted: false, gate: 5, reason: `regression: previously green tests (PASS_TO_PASS) broken: ${last.trim().slice(0, 120)}`, kind: 'regression', changed }
    }
  } else {
    warnings.push('NO PASS_TO_PASS: regression in uncovered code will not be caught')
  }

  return {
    accepted: true,
    reason: cfg.failToPass ? 'passed gates and target test' : 'passed gates; no test oracle — correctness NOT guaranteed',
    coverageBacked: Boolean(cfg.failToPass),
    warnings,
    changed,
  }
}
