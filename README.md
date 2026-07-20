# urmanga plugins

A personal marketplace of Claude Code plugins — small, opinionated tools built for daily use rather than for demos.

## Install

```
/plugin marketplace add Urmanga/claude-plugins
```

Then install whichever plugins you want:

```
/plugin install delegation@urmanga
/plugin install gamesmm@urmanga
```

Requires Node 18+. Individual plugins may have their own requirements, noted below.

---

# Plugins

## delegation

*Requires [Cursor CLI](https://cursor.com/cli), installed and signed in.*

Work runs on Cursor's quota instead of Claude's, so your own limits go on thinking rather than typing. Three modes share one principle: **an agent's report about itself is never evidence.** Acceptance looks at observable effect — the tool log, the git diff, the gates — and a partial result counts as a failure.

### research — scouts behind an evidence gate

You slice a topic into facets and hand them to a batch of scouts; a script decides who did the work and who faked it. Every URL a scout cites is checked against its own tool log: quote a page you never opened and you're rejected and retried, not averaged in.

```bash
node bin/partition.mjs candidates.json --select 6 --out gate1.json
node bin/research.mjs gate1.json --out ./gate1-out --concurrency 4
node bin/partition.mjs candidates2.json --select 4 --out gate2.json --known ./gate1-out/report.json
```

Hard caps: **6 scouts per round, 3 rounds**, model always pinned. They don't move for any task, however important — ignoring them once burned a week of limits.

Three rules that cost real quota to learn:

- **A fan-out doesn't learn.** Four agents given one question return one answer. The win comes from slicing the topic, not from adding agents.
- **Agents lie about their sources.** Twice in one evening, scouts cited pages they had never opened. Hence the log check.
- **A partial result is a failure.** "6 of 6" with two missing devalues everything above it.

### implement — a code writer on an isolated branch

One task: isolated branch → composer writes → six gates on every attempt → repair loop → the orchestrator commits, never the agent. Green lands on its own branch; red after the ceiling rolls back and reports why.

```bash
node bin/implement.mjs task.json
```

The gates check disk effect and path ownership, that tests weren't touched, that nothing was stubbed out, typecheck, lint, and that the target test went green while the rest stayed green.

**Acceptance here is a fraud filter, not a correctness oracle.** There is no code analogue of the citation check — `if (x === 42) return 1764` passes everything. So without a failing test to go green, the runner reports `coverageBacked: false` and *correctness NOT confirmed*, and that wording is meant to reach the user unrounded. Two fixtures exist specifically to prove the limit: a test-fitted answer and a regression in an uncovered path both **pass**.

The writer cannot write test files, cannot commit, and cannot leave its allowed paths. That's what makes the tests you write beforehand a real constraint on it — an invariant guard rides along as PASS_TO_PASS and rejects any change that breaks it.

### transform — a parallel pool for bulk mechanical edits

Many independent files, one rule, composers in parallel. Each works in an isolated copy of a single file, so parallelism is safe here — unlike in `implement`, where files share contracts.

```bash
node bin/transform.mjs task.json
```

Per-file acceptance is syntax intact + goal reached + only its own file touched. The behavioural oracle runs last, on the merged result: if the suites go red, every file is restored byte-for-byte. Nothing is applied unless **every** file passed — half a codebase transformed is worse than none.

### Fixtures

The acceptance logic is what everything else rests on, so it has its own tests:

```bash
node bin/accept.test.mjs          # 19 cases — research acceptance
node bin/accept-code.test.mjs     # 13 cases — code gates, 2 deliberately accept-but-wrong
node bin/repair-loop.test.mjs     # 9 cases  — incl. surgical-revert safety
```

Failure injection lives in `test/fake/` — a fake agent with `leak`, `drain`, `fail`, and `hold` modes.

---

## gamesmm

Social posts for games, written in your voice rather than in the voice of a marketing department.

**Setup** captures a *style passport* from 3–7 of your real posts: sentence rhythm and variance, punctuation habits, emoji placement, how you address the reader, what your posts open and close with. Plus a **forbidden list** — the phrasings that never appear in your writing but that an AI reaches for anyway. The list catches fakeness more reliably than any positive description of tone.

**Working mode** takes a news hook and returns one post per platform, each adapted to that platform's limits and habits without changing the voice. Before anything is shown, every post goes through an anti-AI-slop pass and a silent quality check; whatever is weak gets rewritten rather than delivered raw.

The skill remembers. A local history log keeps the tags, links, and topics you've already used, so posts stay consistent and nothing gets announced twice.

### Platform coverage

Reference sheets ship with the plugin, built from three rounds of source-verified research: X, Threads, Reddit, Telegram, Instagram, YouTube, TikTok. Limits, truncation points, link placement, and the habits that actually move reach — for example, links belong in a reply on X, replies drive nearly half of all views on Threads, and Reddit bans "show, don't sell" violations faster than anything else.

For indie gamedev there's a frame over all of it: social media is a funnel to Steam wishlists, not a sales channel, and without a demo posts barely move visibility at all.

### Your data stays yours

The style profile and post history live in `~/.claude/gamesmm/` — outside this repo, never committed. `.gitignore` carries a safety net in case a copy ever lands inside the plugin tree.

---

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest
plugins/
  delegation/
    bin/                          partition, runners, acceptance + fixtures
    skills/research/SKILL.md      scouts behind an evidence gate
    skills/implement/SKILL.md     delegated coding behind acceptance gates
    skills/transform/SKILL.md     parallel pool for bulk mechanical edits
    test/fake/                    fake agent for failure injection
  gamesmm/
    skills/gamesmm/SKILL.md       setup and working mode
    reference/
      platforms.md                per-platform cheat sheet
      publishing.md               API access setup (not implemented yet)
      research-notes.md           sourced research behind the above
```
