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

Phased research that runs on Cursor's quota instead of Claude's. You slice a topic into facets and hand them to a batch of scouts; a script decides deterministically who did the work and who faked it.

**The verification gate is the point.** Every URL a scout cites is checked against its own tool log. An agent that quotes a page it never opened gets rejected and retried — not trusted, not averaged in. Research counts only what passed.

Three rules that cost real quota to learn:

- **A fan-out doesn't learn.** Four agents given one question return one answer. The win comes from slicing the topic, not from adding agents.
- **Agents lie about their sources.** Twice in one evening, scouts cited pages they had never opened. Hence the log check.
- **A partial result is a failure.** "6 of 6" with two missing devalues everything above it. The counter only counts what passed acceptance.

Hard caps: **6 scouts per round, 3 rounds**, model always pinned. These don't move for any task, however important — ignoring them once burned a week of limits.

### How a round goes

```bash
# 1. You write candidates.json: facets, three phrasings each
node bin/partition.mjs candidates.json --select 6 --out gate1.json

# 2. Scouts run in parallel; the runner accepts or rejects each
node bin/research.mjs gate1.json --out ./gate1-out --concurrency 4

# 3. Read report.json, decide whether a second round is worth it
node bin/partition.mjs candidates2.json --select 4 --out gate2.json --known ./gate1-out/report.json
```

Exit codes: `0` round complete, `1` someone failed acceptance, `2` the runner itself broke. Rejections are typed — infrastructure, agent error, malformed output, or fabricated evidence — so you know whether to retry or rewrite the question.

Acceptance logic lives in its own module with 19 fixtures: `node bin/accept.test.mjs`.

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
    bin/                          partition, runner, acceptance + fixtures
    skills/research/SKILL.md      how to run a round
    test/fake/                    fake agent for failure injection
  gamesmm/
    skills/gamesmm/SKILL.md       setup and working mode
    reference/
      platforms.md                per-platform cheat sheet
      publishing.md               API access setup (not implemented yet)
      research-notes.md           sourced research behind the above
```
