# gamesmm — research reference (3 rounds, Cursor CLI, July 2026)

Everything below has been checked: every quote is backed by a page that was actually opened (the review process rejected agents that quoted things they hadn't actually opened). `[primary]` — primary source, `[secondary]` — secondary source. The user's stack: **text — X, Threads, Reddit, Telegram; video (occasional) — Instagram, YouTube; TikTok — planning from zero.**

---

## 1. How to reproduce the author's style (the core of setup)

**Research findings, not opinion:**
- Few-shot with 3–5 real examples is the most reliable approach without fine-tuning. `[primary]` Anthropic: "Include 3–5 examples for best results." Having a live example in the prompt makes text sound more human than generating "on a topic" (arxiv 2506.09975).
- **A static style guide without examples is often WORSE than plain few-shot.** `[primary]` "most LLMs exhibit reduced performance while transitioning from simple to directed prompting" (aclanthology 2024.personalize-1.6). → Takeaway for gamesmm: **examples matter more than the passport; the passport supplements, it doesn't replace.**
- More than 5–10 examples barely improve style alignment (arxiv 2509.14543). → 3–7 samples are enough; no need to chase quantity.
- The ceiling for prompting alone is ~2/3 the quality of imitation vs. the original (aclanthology 2024.personalize-1.6). Honest limit: the skill gets close to the voice, it doesn't clone it 100%.

**What to extract from examples (existing open-source procedures — the approach can be copied):**
- `claude-voice-analyzer` (aplaceforallmystuff): 3–5 samples of 500–2,000 words → a VOICE.md file + **a list of forbidden phrases** (the author's anti-patterns) + test prompts for verification. `[primary]`
- `ghost-writer` (OneSpiral): 24 dimensions, including "Punctuation Personality" — em-dash lovers read as urgent, semicolon users read as measured. `[primary]`
- `ghostwriter` (angelarose210): measures **burstiness** — AI clusters around 15–20 words/sentence, humans swing from 3 to 40. `[primary]`
- `voice-extractor` (BrianRWagner): a minimum of 3 samples OR 500 words, plus a mandatory **validator**: generate version A (per the profile) and B (deliberately someone else's voice), then ask "does A really sound like you when you're not overdoing it?" `[primary]`
- Prompting practice (PromptsDaily, aiprompthackers): "don't describe tone with adjectives; name patterns and quote actual phrases from the text; if an observation could apply to any author, cut it." `[primary/secondary]`

**Direct upgrade for gamesmm's style passport:** add (a) the author's forbidden phrase list, (b) a check on sentence-length variance, (c) a final A/B test — "does this sound like you?"

---

## 2. Anti-AI (so it doesn't smell like a neural net)

Markers readers and detectors use to spot AI — the skill must actively avoid these:

**English** `[primary]` (Wikipedia:Signs of AI writing, crypdick/unslop):
- Vocabulary: delve, tapestry, landscape, pivotal, robust, leverage, underscore, showcase, testament, meticulous. A cluster of 3+ is a tell.
- "It's not X, it's Y" / "Not just X, but Y" — almost a diagnostic sign (5–10x more frequent than in human writing). Replace with a direct statement.
- Swapping plain "is/has" for "serves as / boasts / stands as."
- Em dashes for every occasion — the "ChatGPT dash."

**Russian** `[secondary]` (gramota.ru, vc.ru, bisa.ru) — markers for Russian-language text:
- «Не просто X, а Y» — GPT's signature construction, shows up in 80%+ of its texts. → State it directly instead: «Это партнёр».
- Cliché intro phrases: «Следует отметить», «Важно подчеркнуть», «Стоит сказать», «В заключение».
- AI sentence length runs an even 12–20 words; humans run 3–40+. Bureaucratic phrasing, nouns substituted for verbs.
- "Hand-written"-style AI text has NO filler words, interjections, or repetitions — their absence is itself a tell.

---

## 3. Your platforms

### X / Twitter (text) `[primary/secondary]`
- 280 characters (Premium — 25,000). Any link = 23 characters. Fully visible, no "more" truncation.
- **Optimum for engagement is 71–100 characters** (Buddy Media: posts <100 chars get +17% engagement). Sprout cites the opposite too (240–259) — so test it, but short usually wins.
- The algorithm throttles links: CTR runs 0.25–3% of followers. **Put the link in a reply, not the main tweet** (howtomarketagame, 2026).

### Threads (text) `[primary]` about.fb.com + developers.facebook.com
- 500 character text limit (attachments up to 10,000 since Sept 2025). Up to 5 links, first = preview. **1 topic tag per post** (up to 50 characters); tagged posts get more views (internal data, Meta).
- **Replies account for almost half of all views on Threads.** Post 2–5 times/week. Edits only within 15 minutes.
- The For You feed is AI-ranked by interest; Following is chronological. Eligible posts get recommended on Instagram and Facebook.
- Meta does NOT claim an official link penalty (like on X) — don't carry that habit over from X blindly.

### Reddit (text) `[primary/secondary]`
- There is NO official "10% rule" in Reddit Help; but `[primary]` the spam policy says if your posts are mostly links to your own business, "be thoughtful about the frequency." Practitioner norm: **9 helpful actions per 1 promo post.**
- r/gamedev: **a link-only post = ban.** Links only when contextual (post-mortem, analytics, discussion). Not for showcasing — they'll point you to r/indiegames, r/playmygame. Min. 100 karma / 30 days.
- r/indiegames: promo ≤2×/week, gameplay media required in the post, **no store/social links**, "show, don't sell" (a wishlist CTA in the title → ban).
- r/IndieDev — more tolerant of dev content. Cross-posting the same thing to multiple subs within an hour → bans.
- The one marketing-friendly slot on r/gamedev is Screenshot Saturday.

### Telegram (text) `[primary]` telegram.org
- Up to 4096 characters, HTML formatting. Reactions, polls, comments (via a discussion group), Stories (via boosts).
- 2025–2026 growth features: global hashtag search, Public Post Search (needs relevant keywords at the start of the post), Suggested Posts, Direct Messages, Communities (linked channels), shareable folders. Stats available from 500 subscribers.
- Telegram does NOT publish an official "optimal length/frequency" — only mechanics. Practitioners: genuine comments on 20–30 niche channels, co-op folders with 10–15 authors.

### Instagram (video, occasional) `[primary/secondary]`
- Caption limit 2,200 characters, **~125 visible before "more"** → put the key point in the first 125. **Max 5 hashtags** (Help Center; more and the post won't publish). Optimum caption: <30 words (Socialinsider, 9.1M posts) / 1–50 characters (Quintly).
- For indie games, Zukowski: "haven't seen meaningful visibility from Instagram." → low priority, but a short caption + media.

### YouTube (video, occasional) `[primary/secondary]`
- **Two-tier funnel:** Shorts (discovery, hook in 1–2 sec, Steam link in the description's first line + a spoken CTA → 3–5x more clicks) + long-form devlogs, 8–12 min, once every 1–2 weeks (cold open, the first 30 sec are critical).
- Title should be specific, not "Devlog #14": "I rebuilt my combat system" beats it on CTR by 3–5x. Thumbnail: a game shot + 3–5 words in large text, readable at 160×90 px. 90% of top videos have a custom thumbnail `[primary]`. Thumbnail A/B testing is built into YouTube, winner decided by watch time.
- The first lines of the description are visible before "Show more" — put keywords there. Shorts can't have a custom thumbnail uploaded (frame only).
- North star is wishlists, not views: 15K views + 50 wishlists = a failure. A devlog with 10K views converts 2–5% into wishlists.

### TikTok (aspirational, from zero) `[primary]` newsroom.tiktok.com + Creator Academy
- **Follower count and past hits are NOT direct FYP factors.** Every video ranks on its own; the main signal is **watch time** (completion). There's officially no "sandbox/shadowban for new accounts."
- **Posting frequency doesn't affect** FYP recommendations — "free to experiment." #FYP/#ForYou give no boost.
- Hook in the first 3 seconds. Narrow niche, not "general." 30%+ watch with sound off → captions are mandatory. Vertical, >5 sec. Quality over quantity. TikTok Studio can schedule posts up to 30 days out. There's an Account Check to see if the account is restricted.
- Indie case studies: one viral video → thousands of wishlists (571K views → 2,900 wishlists). But "don't build your castle on someone else's land" — funnel people to Steam/Discord.

**The general indie funnel (Zukowski, GDC 2025):** social media isn't a sales channel, it's a funnel to Steam wishlists. **Without a demo, posts barely move visibility** (Parcel Simulator: 7K wishlists over 2 years → +17K in one week after the demo). The threshold is ~7,000 wishlists for Popular Upcoming. Reddit and TikTok produce spikes; X is a channel to press/streamers, not buyers; Discord is for superfans (one server per studio).

---

## 4. Existing solutions (what to reuse)

- **coreyhaines31/marketingskills** (67 skills, 3.6M installs) — the most mature one. Pattern: `product-marketing.md` as shared context (Brand Voice: Tone/Style/Personality + Customer Language + words to avoid), which the `social` skill reads FIRST before asking questions. Reference files `platforms.md`, `platform-limits.md`. **A direct blueprint for gamesmm's architecture.** `[primary]`
- **anthropics/skills PR #890** (brand-voice) — a 7-question survey, but WITHOUT analyzing a corpus of posts. `[primary]`
- **anthropics/knowledge-work-plugins** — `brand-voice/agents/document-analysis.md` (extracts voice attributes with confidence scoring) + `draft-content` (platform rules). `[primary]`
- Full post prompt templates with placeholders: Tracia, BrandGhost (platform limits baked in), Prompt Optimizer (LinkedIn), `post-templates.md` in marketingskills, telegrams.site (Telegram). `[secondary]`

---

## 5. Hook formulas (first line) `[primary]`

- **Justin Welsh** — a 3-line trailer: `{Villain} = {negative}` / `{Hero} = {strong positive}` / `And I {fuel}. {teaser question}?`. The third line is the last one before "…more" and has to hook.
- **Ship 30 for 30** — 6 types of first line: strong statement / provocative question / controversial opinion / a moment in time / a vulnerable admission / a strange insight. Plus the story lead-in: "here's the end of the story (the crazy result) → here's the start (the modest one) → read to find out the middle."
- **Nicolas Cole** — specificity: not "how to grow an audience" but "how I grew a list from 0 to 5,281 in 87 days with 250-word posts."
- Classics (Buffer): AIDA (hook = attention), PAS (hook = naming the pain), BAB (hook = the "before" state).

---

## 6. Pre-delivery post scoring rubric `[secondary]`

Existing scoring systems to assemble gamesmm's internal check from:
- **TeamBench** (social media): Hook 30% + Brand Voice 30% + Clarity 20% + Engagement 20%, publish threshold 65/100. Hook rule: "the first line stops the scroll, without 'In today's...'".
- **Acrid** (social AI, 5×20=100): Voice Match / Hook / Value / Originality / Platform Fit. **Minimum 70 to post; below 50, change the topic.**
- Readability: Flesch ≥60 (Grammarly), ~8th-grade level (Hemingway). TextScore by platform: X 70–90, LinkedIn 55–70, Discord 75–90.

**For gamesmm:** silently run each post through 5 criteria before delivering (voice / hook / value / platform / no AI markers); rewrite anything below the bar, don't show it raw.

---

## 7. Content strategy (small business / personal blog) `[primary]`

- 3–5 content pillars (HubSpot/Buffer/Sprout all agree; more than that dilutes the brand).
- Mix with promo as the minority: 70/20/10 (value/others'/promo), 50/30/20, Rule of Thirds (⅓ promo / ⅓ personal / ⅓ expert). Promo is always the smallest share.
- For small business — 5 pillars: Work, Expertise, People, Proof, Offer (promo ~15–20%).
- Solo creator cadence: monthly planning + weekly review, 60–80% capacity.
