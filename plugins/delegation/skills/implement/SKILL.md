---
name: implement
description: Delegate a coding task to a Cursor composer on an isolated branch, with deterministic acceptance gates and a repair loop. Use when a concrete change has to be written into a repo — fix a failing test, add a feature, refactor a module — and you want the writing done outside your own limits. Triggers — "implement", "delegate this", "let the composer do it", "write this code", "fix this bug".
---

# Delegated Coding Through Gates

One coding task: isolated branch → Cursor composer writes → deterministic acceptance on every attempt → repair loop on rejection → **the orchestrator commits, never the agent**. Green means committed on its own branch; red after the ceiling means rollback and an honest report.

**Spend comes out of the Cursor pool, not your Claude limits.** Your job is to slice the task, write the manifest, supply the oracle, and judge the result. The composer does the typing.

## The one thing you must never forget

**Acceptance is a FRAUD FILTER, not a correctness oracle.**

There is no code analogue of research's citation cross-check. `if (x === 42) return 1764` passes every gate. The gates prove the agent didn't cheat, didn't touch tests, didn't stub things out, and didn't break what already worked. They do **not** prove the change is right.

So the runner reports `coverageBacked: false` and `correctness: NOT CONFIRMED` whenever there was no failing test to go green. **Pass that through to the user verbatim.** Never round "gates passed" up to "it works". A tool that fakes green is worse than no tool.

## Step 0. Is this even the right mode?

| Situation | Mode |
|---|---|
| One change, files share contracts, needs cross-file context | **implement** (this skill) |
| Many independent files, one mechanical rule, no shared context | `transform` — parallel composers |
| Nothing gets written, you're gathering information | `research` |

Do not parallelise implement. Files in one change share contracts; two composers editing against the same moving interface produce work that has to be thrown away.

## Step 1. Get a green baseline first

The gates run the project's own commands. **If the repo is already red, every run fails for reasons the composer didn't cause.**

Before writing a manifest, run the project's typecheck, lint and tests yourself. Tested live: a repo with one pre-existing `no-explicit-any` error failed the lint gate on every attempt, and the composer's own code was clean. Fix the baseline (yours to fix, not the composer's) and only then delegate.

The runner also refuses to start if the working tree is dirty — it cannot tell writer edits from your unsaved work, so acceptance and rollback would both lie.

## Step 2. Supply the oracle you can supply

The composer is **denied write access to test files**. That's deliberate: a writer that can edit tests will fit the tests to its code. It also means every test in the repo is a real constraint on it.

So: **you write the tests, before the run.** Two kinds, and both are worth it:

- **Invariant guards** — "this must not break". Cheap, high value, and they turn acceptance from a fraud filter into a real oracle for that specific property. Proven live: a test asserting a hidden triple-click login still opened its dialog rode along as PASS_TO_PASS through three delegated steps and would have rejected any refactor that killed it.
- **Contract tests for new work** — if you can pin the interface before the composer writes it, write the test against that interface and put the contract in the prompt. Then a green run means something.

For a genuine fix-with-a-failing-test, put it in `failToPass` and the verdict becomes `coverageBacked: true`.

## Step 3. Write the manifest

```json
{
  "repo": "I:/path/to/repo",
  "task": "self-contained spec for the writer — see below",
  "branch": "impl/fix-foo",
  "stack": "ts",
  "accept": {
    "typecheck": ["npx", "tsc", "--noEmit"],
    "lint": ["npx", "eslint", "."],
    "failToPass": ["npx", "vitest", "run", "src/foo.test.ts"],
    "passToPass": ["npx", "vitest", "run"],
    "ownerAllow": ["^src/"]
  },
  "writer": {
    "writeGlobs": ["Write(src/**)"],
    "extraDeny": ["Write(src/features/contract/**)"],
    "model": "composer-2.5-fast"
  },
  "maxAttempts": 3,
  "hardMs": 600000,
  "idleMs": 180000
}
```

- `stack` picks a preset: `ts` (default), `cpp`, `ue`. Anything in `accept` overrides the preset.
- `ownerAllow` and `testGlobs` are **regex strings** — JSON can't hold a RegExp, the runner compiles them.
- `branch` must not already exist. The runner refuses rather than overwrite someone's work.
- `extraDeny` hard-locks paths the composer must not touch. Use it for any contract or fixture you pre-wrote — a prompt alone is a request, `extraDeny` is a wall.

**The `task` string is the whole spec.** The composer has no conversation context. Name the exact files to create, the components and hooks to reuse, the conventions (comment language, UI copy language), what must NOT be touched, and "do not commit". Vague prompts are where delegated work actually fails.

## Step 4. Run it

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/implement.mjs task.json
```

Exit codes: `0` — accepted **and** committed, `1` — not accepted, or accepted but the commit was refused, `2` — the runner itself is broken. NDJSON streams to stdout; show the user attempts and rejections as they land, don't go quiet.

## Step 5. Read the verdict honestly

`impl.done` carries the truth:

| Field | Meaning |
|---|---|
| `committed` | the runner made the commit; the result is on its branch |
| `coverageBacked` | **false = no test oracle ran. Correctness NOT confirmed.** |
| `stopReason` | **failure runs only** — see below. Absent on success; there you read `ok` and `committed`. |
| `warnings` | carries the "absence of fraud was checked" caveat |

| `stopReason` | What it means | What to do |
|---|---|---|
| `stuck` | the same error class came back twice — the composer is circling | re-slice the task; raising the ceiling only burns time |
| `max-attempts` / `budget` | ceiling hit with errors still changing | look at `history`; maybe one more run, maybe a smaller task |
| `writer-dead` | the composer process died twice — timeout, hang, leak | infrastructure; check the logs under `.impl-logs/` |
| `infra` | a gate command could not start or timed out | **ours, not the composer's** — fix the command and rerun |
| `commit-failed` | gates passed but `git commit` was refused (hook, signing) | the work is accepted and left **uncommitted on the branch**, and you stay on it — commit it yourself |
| `orchestrator-crash` | the runner itself threw | fix the runner |

On failure the runner reverts the tree, deletes the branch and puts you back where you started. On success it leaves the branch and returns you to your previous one — **merging is a human decision.**

The one deliberate exception is `commit-failed`: rolling back would destroy work that passed every gate, so the runner keeps the branch, keeps the changes, and leaves you standing on them. Switching branches there would drag uncommitted work onto your start branch.

## Step 6. Chain multi-step work

A large feature does not fit one composer pass. Slice it into steps that each fit one, and chain them: run step 1, `git checkout` its result branch, run step 2 from there. Each step gets its own branch and commit, so a failure at step 3 leaves steps 1–2 intact.

Proven live: an admin panel built as shell → feature → content editor, three runs, each accepted first try, each on top of the last.

Between steps is also where **you** commit the things the composer isn't allowed to write — tests, contracts, migrations.

## Hard limits

- **The model is always pinned** — `composer-2.5-fast`. Never Auto: it can't be reproduced and won't show up in the report.
- **The composer never commits.** Composition stays under the orchestrator's control. `Shell(git commit*)`, `push`, `reset` are denied.
- **Tests are never writable by the writer.** The moment that slips, every green becomes meaningless.
- **No parallel composers on one change.** See step 0.
- **Never report a red run as "almost worked".** Failure is failure, with a reason.

## If the scheme itself lied to you

Accepted but the tree is empty; a correct fix rejected; the counter not adding up — **drop the task and fix the runner.** A defect in the thing that catches everyone else's failures is caught by nothing.

This is not hypothetical: an early acceptance bug ate the first character of every changed path (`rc/rate.ts`), and a test that pointed the revert logic at a live folder deleted uncommitted source. Both were found by fixtures. Run them:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/accept-code.test.mjs   # 13 cases, 2 deliberately accept-but-wrong
node ${CLAUDE_PLUGIN_ROOT}/bin/repair-loop.test.mjs   # 9 cases, incl. surgical-revert safety
```

Two fixtures in the acceptance suite are there to prove the fraud filter's limits: a test-fitted `if (x === 2) return 4` and a regression in an uncovered path both **pass**. That is the honest boundary of this tool, encoded as a test.

## Paths

`${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code when the plugin is installed. Running from a repo clone instead, substitute the path to `plugins/delegation` by hand.
