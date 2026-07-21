# Publishing via API — access setup

> **Status: not implemented.** Publishing scripts haven't been written yet — this is a guide for the future.
> Right now the skill works in manual mode: it prepares the text, the user publishes it themselves.
> When we decide to turn on auto-posting — this document sets up the access, then the scripts get written.

Publishing directly from the skill requires a one-time access setup. **Keys and tokens are set by the user themselves** (in environment variables or a local config outside the repo); the skill reads them from the environment and never stores them in the profile, history, or git.

Publishing always follows the rule: show the exact text → get an explicit "yes" for that text → post it. Never publish silently.

## X / Twitter

The user has paid X API access — posting tweets (`POST /2/tweets`) is available.

1. In the project at [developer.x.com](https://developer.x.com), enable **User authentication** (OAuth 1.0a User Context or OAuth 2.0 with `tweet.write` scope).
2. Obtain: API Key, API Secret, Access Token, Access Token Secret (OAuth 1.0a) — these are tied to the account posting is done as.
3. Set in the environment (example names, the skill looks for these):
   ```
   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
   ```
4. Limits: a link in the tweet body counts as 23 characters; for indies, put the link in a separate reply instead (the algorithm throttles links in the main post).

## Threads

Meta's API is **free**, but requires app setup — "paid" doesn't come into it here.

1. At [developers.facebook.com](https://developers.facebook.com), create an app, connect the **Threads API**, and link the Threads account.
2. Go through OAuth, get a long-lived user access token (`threads_content_publish` scope).
3. Publishing is two steps: create a media container (`POST /me/threads`) → publish it (`POST /me/threads_publish`).
4. Set in the environment:
   ```
   THREADS_USER_ID, THREADS_ACCESS_TOKEN
   ```
5. Limits: 500 characters, ≤5 links (first = preview), 1 topic tag, ≤250 posts per 24h.

## Other platforms

- **Telegram** — publishing to a channel is the simplest: a bot via `sendMessage` (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHANNEL_ID`), the bot needs to be a channel admin. Supports HTML formatting.
- **Reddit** — the API exists (`praw`/OAuth), but bot posting is risky: subreddits ban for auto-promo, rules require genuine participation. Keep Reddit manual — auto-publishing here does more harm than good.
- **Instagram / YouTube / TikTok** — these are video platforms; the text (caption/description) is prepared by the skill, but media upload happens manually or via separate pipelines. Auto-publishing text without the video makes no sense.

## What the skill does when publishing

1. Checks which tokens exist in the environment — offers auto-posting only for configured platforms, hands the rest over for copy-paste.
2. Shows the final text of each post.
3. Asks for confirmation for each platform separately.
4. Posts what's confirmed, writes the result (success + link, or the error as-is) to `history.md`.
