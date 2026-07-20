---
name: research
description: Phased reconnaissance through Cursor CLI with deterministic acceptance gating. Use when you need to research a topic, gather best practices, find out the state of a tool, or check whether the problem's already been solved. Triggers — "research this", "dig into", "look into", "what's the state of", "gather info on", "is there an existing solution".
---

# Recon Through Gates

A round of several Cursor agents gathers material, a script deterministically accepts or rejects each one, you consolidate the results and decide whether another round is needed.

**Spend comes out of the Cursor pool, not your Claude limits.** Your job is to slice up the questions, sift the results, and decide on the next round. The agents do the collecting.

## Why it works this way

Three things have been proven on this machine and are not up for debate again:

- **A fan-out doesn't learn.** Four agents given the same question came back with the same answer. The win comes from slicing the question, not from headcount.
- **Agents lie about their sources.** Twice in one evening they cited a page they'd never opened. That's why acceptance checks every URL against the tool log instead of trusting the report.
- **A partial result is a failure.** "6 of 6" with two missing devalues everything above it. The counter only counts agents that passed acceptance.

## Step 0. Ask about depth

One widget, before any work starts:

1. **Recon:** none / quick (1 round, 3 agents) / phased (up to 3 rounds of ≤6)
2. **Autonomy:** run to completion / stop after the first round

If the user already stated the depth in words ("just a quick look", "dig in properly") — don't ask, just do it.

## Step 1. Slice up the questions

First pick the number of slots — that's the number of scouts in the round:

| Answer from step 0 | `select` |
|---|---|
| quick | **3** |
| phased | **up to 6** — as many as the topic genuinely splits into |

Six is a ceiling, not a target. If the topic honestly breaks into four non-overlapping aspects, take four: a facet stretched artificially thin gives you a scout who duplicates his neighbor.

What follows is the single most important thing in this skill, and it happens in this order:

**Facets first, candidates second.** Name exactly `select` **facets** — non-overlapping aspects of the topic. Then for each facet write **three different phrasings of the question**: different angle, different keywords. Three, not two — otherwise there's almost nothing to choose between. Six facets gives you 18 candidates.

Why this order and not the reverse. The script runs in two modes, and the correct one only kicks in when `facets ≤ slots`: then it covers every facet by taking the best phrasing among its candidates, and no tagged topic gets lost. If facets outnumber slots, the script falls back to a worse mode — it covers what it can and lets raw lexical distance decide the rest. **Tested: 17 facets against 18 candidates produced two nearly identical questions about manifests** — meaning "one facet per candidate" tagging makes facets pointless.

So: **several candidates per facet is the norm and the goal**, not a mistake. That's exactly what the script is for — picking the best one out of them.

Every candidate must have:

- `key` — a short identifier from `[A-Za-z0-9_.-]`
- `question` — a self-contained phrasing, understandable to the agent with no conversation context
- `facet` — **the topic's facet**. The script can compute lexical dissimilarity, but it has no idea that "cost" and "pricing" mean the same thing, or that a question asked in Russian and the English word `permissions` are about the same thing. You tag the semantics — you, and only you.

Set `must: true` on **no more than 1–2 candidates** — it's an emergency lever for a topic that's critical but lexically thin. Every `must` eats a slot without going through selection.

Write the candidates file:

```json
{
  "gate": 1,
  "question": "the round's overall question, covering every facet",
  "workspace": "<absolute path to an empty working folder for the agents>",
  "brief": "framing: what we're building and why we need this",
  "select": 6,
  "candidates": [
    { "key": "permissions", "question": "...", "facet": "permissions" },
    { "key": "pricing", "question": "...", "facet": "cost", "must": true }
  ]
}
```

## Step 2. Select

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/partition.mjs candidates.json --select 6 --out gate1.json
```

The script covers every facet with one representative and spreads the rest by dissimilarity. **Read its output.** If it warns "more facets than slots" — you broke step 1: merge facets and regenerate. Silently dropping tagged topics is not allowed. If it warns "candidates have no facet" — the tagging got lost, and selection is running blind.

## Step 3. Run the round

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/research.mjs gate1.json --out ./gate1-out --concurrency 4
```

Concurrency **4–6, no more**. Exit codes: `0` — the round is complete, `1` — someone didn't get accepted, `2` — the runner itself is broken.

While it runs, NDJSON streams to stdout — that's progress for the user. Show them accepted and rejected agents as they come in, don't go silent until the end.

## Step 4. Sort out the rejections

Not all rejections are equal — check the `kind`:

| kind | What it means | What to do |
|---|---|---|
| `run`, `stream` | infrastructure: timeout, empty stream, malformed lines | the runner already retried it; if the circuit breaker tripped — the provider is down, stop the round |
| `agent` | the agent reported an error itself | check `stderr.attemptN.txt` in the worker's folder |
| `shape` | no JSON, empty fields, placeholder text | the question was phrased unclearly — rephrase it |
| `evidence` | **cited something it never opened**, or answered from memory | the question needs sources that don't exist on the web; narrow it or rephrase |

If someone's still dead after every attempt — **say so plainly and name which facet was left without a scout**. Don't round up.

## Step 5. Sift

Read `gate1-out/report.json` — `results` is keyed there. Your job as the sifter:

- throw out secondary sources wherever primary ones exist (`source_type`)
- reconcile contradictions between agents: two different answers to the same fact is a finding, not noise
- note what's still unresolved — agents honestly write this into `not_found`
- **decide whether another round is needed** and for which exact gaps

Stop when a round stops bringing back anything new. Three rounds is the ceiling, and it doesn't go up "because the topic matters."

## Step 6. The next round

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/partition.mjs candidates2.json --select 4 --out gate2.json --known ./gate1-out/report.json
```

`--known` inserts an "already known, don't re-verify" block into every prompt. This is the **only** defense against rediscovering the same ground twice: within a single round the agents can't see each other, so duplicates there are unavoidable.

The second round is narrow questions targeting specific gaps. A broad prompt misses what a targeted one finds.

## What to put in candidate prompts

`partition.mjs` assembles the prompt template itself — no need to touch it. It already contains:

- **local primary sources first** — installed SDKs, engine source, configs on this machine. In an actual run, an agent figured out on its own to dig into the UE source, and that turned out to be the best source in the whole research pass; you can't rely on agents guessing that, so now it's baked into the template
- priority for primary sources, flagging for secondary ones
- a requirement for a verbatim quote from a page that was actually opened
- a ban on making things up: didn't find it — write it into `not_found`

Your job is phrasing the `question` and tagging the `facet`.

## Paths

`${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code when the plugin is installed. If the skill is running from a repo clone rather than an installed plugin, substitute the path to `plugins/delegation` by hand.

## Hard limits

- **≤6 agents per round, ≤3 rounds.** Doesn't move for any task, no matter how important — ignoring it is exactly what burned a week's worth of limits once.
- **Exactly as many facets as slots.** More, and the script stops guaranteeing topic coverage. Fewer, and you lose ground.
- **Three candidates per facet.** One phrasing per facet means nothing to select from, and facets become pointless.
- **The model is always pinned** — `composer-2.5-fast` by default. Never Auto: it can't be pinned, can't be reproduced, and doesn't show up in the report.
- **No Claude subagents doing the collecting.** Recon runs through Cursor — otherwise the whole point is gone.
- **At least twice as many candidates as slots.**
- **Every candidate is tagged with a `facet`.** Without tagging, selection runs blind on lexical distance and drops topics.

## If the scheme itself lied to you

The runner said "accepted" but the result is empty; the counter doesn't add up; an obviously good answer got rejected — **drop what you're doing and fix the runner**. A defect in the thing that's supposed to catch everyone else's failures isn't caught by anything, and it devalues everything built on top of it.

Acceptance fixtures: `node ${CLAUDE_PLUGIN_ROOT}/bin/accept.test.mjs` — 19 cases, all must pass.
Failure-injection rig: `${CLAUDE_PLUGIN_ROOT}/test/fake/` — a fake agent with modes `leak`, `drain`, `fail`, `hold`.
