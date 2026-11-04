# Review counter

A Cloudflare Worker that adds up anonymous review counts from users who opted in, so the page's evidence section can show more than the maintainer's own projects.

Live at `https://bindwright-counter.starfoxcom.workers.dev`.

| Call | Takes | Returns |
|---|---|---|
| `POST /increment` | `{project, kind, checked, caught, deep, merged, from, to}` as JSON: `from` and `to` are the window of merges the counts cover, in epoch milliseconds | `{"ok": true}`; 409 with `coveredTo` when the window starts before the end of one already counted; or an error with 400, 413 or 429 |
| `GET /total` | nothing | the four sums, the project count, projects per country and the top 10 projects by `checked`, each as its kind and counts |

## What it keeps

One row per project: a random 32-character id the plugin makes once per repo, the kind picked at opt-in (`src/rules.js` lists them), the country Cloudflare derives from the last send, the four running counts, the time of the last send and the end of the last counted window. No repo names, usernames, code or IP addresses. `GET /total` never returns project ids.

## Limits

All in `src/rules.js`:

- Each count is a whole number from 0 to 1000 per send, and `caught` and `deep` never exceed `checked`.
- A project sends at most once every 20 hours, and a window that overlaps one already counted is refused, so a send whose answer was lost and is sent again never counts twice.
- At most 200 new projects a day across all senders.
- Five sends a minute per IP through Cloudflare's rate limiter (`wrangler.jsonc`); the Worker never stores the IP.
- Bodies over 1 KB are refused before parsing.

These keep casual inflation out, but an anonymous counter cannot prove a count is real, so the page shows these numbers apart from the maintainer's own.

## Deploy

From this folder, signed in with `npx wrangler login`:

```
npx wrangler d1 execute bindwright-counter --remote --file schema.sql   # first time only
npx wrangler deploy
```

Tests: `node --test engine/test/counter.test.js` from the repo root.
