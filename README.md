# urmanga plugins

A small Claude Code marketplace with two plugins.

## Install

```
/plugin marketplace add Urmanga/claude-plugins
/plugin install delegation@urmanga
/plugin install gamesmm@urmanga
```

## delegation

Phased research that runs on Cursor CLI instead of burning Claude limits. You slice a topic into facets; the script picks the least-similar questions, launches a batch of scouts, and accepts their work deterministically — every cited URL is checked against the tool log, so an agent that quotes a page it never opened gets rejected and retried.

Built on three lessons that cost real quota:

- A fan-out doesn't learn. Four agents with one question bring back one answer.
- Agents lie about their sources. Verification beats trust.
- A partial result is a failure. The counter only counts what passed acceptance.

Hard limits: 6 scouts per round, 3 rounds. Model is always pinned.

## gamesmm

Social posts for games, written in your own voice. First run captures a **style passport** from your real posts — sentence rhythm, punctuation habits, emoji placement, and a forbidden list of phrasing you never use. After that, any piece of news becomes a set of posts, one per platform, adapted to each platform's limits and habits without changing your voice.

Includes platform references (X, Threads, Reddit, Telegram, Instagram, YouTube, TikTok), an anti-AI-slop pass, and a quality check before anything is shown.

Your style profile and post history live in `~/.claude/gamesmm/` — outside this repo, never committed.
