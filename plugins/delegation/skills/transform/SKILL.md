---
name: transform
description: Apply one mechanical rule across many independent files using a pool of parallel Cursor composers, with per-file acceptance and a behavioural oracle on the merged result. Use for bulk unintelligent work — translating comments, renaming by pattern, reformatting, rewriting imports. Triggers — "across all files", "bulk rename", "translate the comments", "apply everywhere", "monkey work".
---

# Bulk Transform Through a Composer Pool

Many **independent** files, one rule, a pool of composers running in parallel. Each works in an isolated copy of a single file, each result is accepted on its own, and nothing lands unless everything passes.

**This is where parallelism is real and not cargo cult.** In `implement` it's harmful — files share contracts. Here the units genuinely don't touch each other, so headcount converts straight into wall-clock.

## Step 0. Is this actually the right mode?

Two questions, both must be yes:

1. **Is the work bulk but unintelligent?** Translating comments, renaming by pattern, reformatting, mechanical import rewrites. If it needs design judgement, it isn't this.
2. **Is each file independent?** The composer sees **only its own file, in a temp directory** — no repo, no imports, no neighbours. That isolation is exactly what makes parallelism safe, and it's also the hard constraint: if the change needs to see other files, this mode cannot do it. Use `implement`.

Rule of thumb: if you'd feel bad spending your own limits typing it, and file N doesn't care what happened to file M — it belongs here.

## Step 1. Write the manifest

```json
{
  "root": "I:/path/to/repo",
  "files": ["src/a.ts", "src/b.ts", "src/c.ts"],
  "task": "instruction for the composer; {{file}} is replaced with the file's name",
  "accept": {
    "syntax": ["node", "--check", "{{abs}}"],
    "mustNotMatch": "[Ѐ-ӿ]",
    "mustMatch": "..."
  },
  "oracle": [["npx", "vitest", "run"]],
  "concurrency": 4,
  "maxAttempts": 3,
  "model": "composer-2.5-fast"
}
```

- `files` — paths relative to `root`. Each is one unit of work. The runner refuses to start if any is missing.
- `{{file}}` in `task` becomes the basename; `{{abs}}` in `accept.syntax` becomes the temp copy's absolute path.
- `accept` fields are all optional, but **supply at least one** — with none, acceptance degenerates into "the file still exists".
- `oracle` — commands run in `root` **after** everything is applied. Optional but strongly recommended: it's the only thing that catches "syntax fine, behaviour changed".
- `concurrency` 4–6. More just queues.

Write the task like a specification, not a wish. State what must NOT change (logic, control flow, identifiers, exports, regexes, numbers), what must be preserved verbatim (template placeholders), that the result must remain a valid module, and "edit in place, don't create files, don't commit".

## Step 2. Run it

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/transform.mjs task.json
```

Exit codes: `0` — everything applied and the oracle stayed green, `1` — not applied (or applied and reverted), `2` — the manifest or the runner is broken.

## Step 3. Read what happened

| Event | Meaning |
|---|---|
| `file.accepted` / `file.rejected` | per-file verdict, with the reason on rejection |
| `file.writer_dead` | the composer process died — timeout, hang, leak. The attempt is spent, not the file |
| `transform.incomplete` | at least one file never passed → **nothing was applied** |
| `transform.applied` | all files written to disk, oracle about to run |
| `transform.reverted` | the oracle went red → **everything rolled back** |
| `transform.done` | applied and oracle-backed |

`oracleBacked: false` on `transform.done` means you supplied no oracle: syntax and goal were checked, behaviour was not.

## Why it's built this way

Four properties, each verified by execution rather than assertion:

- **Isolation per file.** A temp copy plus writer permissions scoped to that one filename. No races in a shared tree.
- **Acceptance is not "tests pass".** A single file in isolation can't be behaviourally tested. So the per-file gate is: syntax intact + goal reached (`mustNotMatch` / `mustMatch`) + only its own file touched.
- **All-or-nothing.** A partial sweep is worse than none — half the codebase transformed and half not is a state nobody wants. Tested live: two files accepted, one rejected by the syntax gate, and the accepted two were left byte-identical on disk.
- **Behavioural oracle last, on the merged result.** Tested live: with acceptance green and the oracle exiting non-zero, the runner restored every original byte-for-byte.

First real use: 7 files of Russian comments translated to English by 4 composers in 75.9 s, every file accepted first try, unit suites green afterwards.

## Hard limits

- **The model is always pinned** — `composer-2.5-fast`. Never Auto.
- **A partial result is a failure.** Don't add a flag to apply what passed.
- **No cross-file changes.** The composer physically cannot see other files; a task that needs to is a task for `implement`.
- **Supply an oracle whenever one exists.** Without it the run is honestly labelled unverified, and you must pass that on.

## If the scheme itself lied to you

Reported applied but the files are unchanged; a correct file rejected; a red oracle that didn't revert — **stop and fix the runner**, then redo the batch. Everything downstream of a broken acceptance is worthless.

## Paths

`${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code when the plugin is installed. Running from a repo clone instead, substitute the path to `plugins/delegation` by hand.
