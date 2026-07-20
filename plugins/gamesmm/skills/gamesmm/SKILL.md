---
name: gamesmm
description: Writes SMM posts for games in the user's own voice. Use when the user wants to write a post, an announcement, a devlog post, or a batch of posts for social media — trigger phrases like "write a post", "announce this on socials", "devlog post", "spread this across platforms", or any mention of gamesmm. Also for setting up the writing profile — "set up my writing style", "update my style", "add a platform".
---

# gamesmm — posts in your voice

The skill lives in two modes. Personal data lives in `~/.claude/gamesmm/` (outside the repo, never goes to GitHub):

- `profile.md` — style passport, platforms, context, examples.
- `history.md` — log of delivered posts (tags, links, topics). The skill's memory.

Always read `profile.md` first.

- File doesn't exist → **setup mode**: capture style, platforms, and context, save the profile.
- File exists → **working mode**: write posts per profile. Don't return to setup unless the user explicitly asks to update the profile.

If the profile has a `## TODO` section, mention those open items **once** at the start of a session, in two or three lines — then get on with the actual request. It's a reminder, not a gate: never refuse to write posts because the profile is incomplete. For a platform the profile doesn't cover yet, say so plainly and write it from the closest platform's voice. When an item gets resolved, delete it from the TODO list.

## Setup mode (first run)

The goal isn't a questionnaire for its own sake — it's material you can actually write as this person from. Collect three things, in this order:

**1. Writing samples.** Ask the user to paste 3–7 real posts they wrote themselves (any platform, any language — the more variety, the better). If there aren't many posts, chat messages or devlogs work too. Don't analyze anything until the user is done pasting.

**2. Platforms.** The list of platforms to write for. For each one, ask only what you can't work out yourself: post language, how that platform's audience differs from the rest, any personal restrictions. Don't ask about platform norms (limits, truncation, hashtags, algorithm habits) — those live in [reference/platforms.md](../../reference/platforms.md); rely on that. One question-widget with a checklist, not an interrogation one item at a time.

**3. Extra context.** What game/studio, who the audience is, what can never be written (forbidden topics, words, promises), links and tags that always go in posts. Everything's optional — record whatever's given.

Then extract a **style passport** from the samples. This is the most important part of setup. Look for specifics, not generalities: sentence and paragraph length (and variance — does the author swing from choppy fragments to long sentences, or stay even?), how they address the reader (informal/formal/no direct address), emoji (which ones, how many, where they land), punctuation habits (dashes, parentheses, ellipses, caps), characteristic vocabulary and pet phrases, post structure (how it opens, how it ends, is there a CTA), what's *missing* from the samples (that's a style trait too). "Friendly and engaging" is not a passport, it's a placeholder; a passport reads "short paragraphs of 1–2 sentences, self-deprecating humor, zero exclamation points, emoji only at the end of the post."

Separately build a **forbidden list** — turns of phrase, words, and moves that don't appear anywhere in the author's samples but that an AI tends to insert anyway. This catches fakeness more reliably than a positive description does. Base list below (the "Anti-AI" section), plus whatever the samples themselves rule out: if the author never once wrote "excited to announce," ban it.

Show the passport and forbidden list to the user, let them correct it. After corrections, save the profile:

```markdown
# gamesmm Profile
Updated: <date>

## Style Passport
<passport after user corrections>

## Forbidden List
<turns of phrase/words/moves the author never uses — never write these>

## Platforms
### <platform>
- Language: …
- Restrictions: …
- Audience: …

## Context
<game, audience, restrictions, standing links/tags>

## Examples
<all submitted posts, verbatim, unedited>
```

Save examples verbatim — when writing, they work as few-shot samples; the passport alone is weaker.

## Working mode

The user brings a news hook: an update, a screenshot, a release, a thought. Read `profile.md` **and `history.md`**.

**Ask via checkboxes where to post.** One question-widget with a checklist of platforms from the profile, multi-select, pre-checked with whatever the user picks most often (visible from history). Don't ask if they already said so themselves ("just for Telegram," "spread this across platforms") — then just do it.

History exists so the skill remembers specifics: which tags and links the author already uses on each platform (use the same ones, for consistency), what's already been announced (don't repeat the same thing twice), what performed well. If `history.md` doesn't exist yet, just write — you'll start one after the first batch.

Writing rules:

- **Voice beats platform.** The post sounds like the author of the samples first, then gets adapted for the platform. Adaptation means length, format, hashtags, language; the voice doesn't change. Pull platform norms from [reference/platforms.md](../../reference/platforms.md) — it has limits, truncation points, and algorithm habits for each (e.g., on X the link goes in a reply, not the main post; on Threads the key point goes in the first lines plus a topic tag; on Reddit it's "show, don't sell"; on Telegram keywords go at the start).
- **Check against the examples, not just the passport.** Before delivering, reread a couple of examples from the profile and ask yourself: could the author of these have written this?
- **Restrictions from context are absolute.** No news hook overrides the "never write" section or the forbidden list.
- **Don't invent facts about the game.** Date, feature, price — only from the news hook or the profile's context. What you don't know, don't write, or ask.

**Anti-AI.** Before showing a post, strip out the tells of AI writing — they give away fakeness instantly even when the voice is right:
- RU markers (for Russian-language posts): «не просто X, а Y», «это не только…, но и…», intro phrases «стоит отметить / важно подчеркнуть / рады сообщить / встречайте», bureaucratic phrasing, sentences running an even 15–20 words in a row. Real writing varies in length.
- EN: delve, tapestry, robust, leverage, showcase, underscore; the "it's not X, it's Y" construction; "serves as / boasts" instead of plain "is / has"; dashes for every occasion.
- All of this goes into the profile's forbidden list if it isn't there already.

**Self-check before delivering** (silently, for each post): does it sound like the author? does the hook in line one land? is there value, not just "we shipped X"? is the format right for the platform? no AI markers? Rewrite whatever's weak — don't show it raw.

Deliver posts in blocks by platform, each one ready to copy-paste (with all hashtags and links from the profile). After the batch, don't explain anything — the user will either take it or ask for a fix.

Once the user takes the batch, add an entry to `history.md` — newest on top:

```markdown
## 2026-07-20 — Next Fest demo
- **X**: demo announcement, link in reply. Tags: #indiedev #screenshotsaturday
- **Telegram**: same news hook, longer, with a GIF. Steam link at the end.
- **Threads**: short, topic tag "indie games." Question at the end to invite replies.
```

Keep it short — this is memory, not a report. If the user later says "this post did well / this one flopped," add a note to the entry — that's worth more than anything else here.

If the user edits the output ("I don't write like that," "drop the emoji") — that's a signal about the profile, not just this one post. Fix the post **and suggest** updating the style passport too.

## Publishing to a platform

**Current mode is manual: the skill hands over the finished text, the user publishes it themselves.** Auto-posting via API hasn't been built yet — that's intentional; the setup guide for access lives in [reference/publishing.md](../../reference/publishing.md) for whenever we decide to turn it on.

The rules below take effect once auto-posting exists — they're not optional politeness, they're the condition without which it can't be turned on:

- **Never publish silently.** Publishing is an irreversible public action. Strict order: generate → show the exact final text → the user explicitly confirms **this** text for **this** platform → only then post. The "where to post" checkbox at the brief stage is intent, not permission to publish; permission is given for one specific finished text.
- Publish one platform at a time, with confirmation for each. "Post to X and Threads?" is fine as a question, but show exactly what goes out to each.
- API tokens/keys come from environment variables the user set themselves. Don't ask them to paste these into chat, and don't write them into the profile or history.
- After publishing, log it in `history.md` (noting it was posted via API, with a link to the post if the API returned one). Show publish errors as they are — don't dress up a failure as a success.

## Updating the profile

On request ("update my style," "add a platform," "new context"):

- New examples — append to the "Examples" section and rebuild the passport accounting for all examples.
- An edit to the output ("I don't write like that," "drop that word") goes into the passport or forbidden list — so the mistake doesn't repeat in future posts.
- Platforms and context — edit precisely, leave the rest alone.
- "Redo setup from scratch" — confirm the old profile gets wiped, then start setup fresh.

After any update, show exactly what changed in the profile.
