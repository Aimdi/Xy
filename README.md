# Xy — Reverse-Engineered Threads API

Unofficial Node.js / TypeScript client for Meta's [Threads](https://www.threads.net), inspired by how [QuaX](https://github.com/Teskann/QuaX) reaches X: use the same undocumented GraphQL / private APIs the official clients use, and **self-heal when identifiers rotate**.

This project is an updated continuation of the archived [`junhoyeo/threads-api`](https://github.com/junhoyeo/threads-api) (halted Sep 2023), reverse-engineered against the live Threads web + Barcelona (Android) surfaces in 2026.

> **Educational / research use only.** Using unofficial Meta APIs may violate Terms of Service. You are responsible for how you use this code.

## Why Xy (vs the 2023 library)

| Problem | QuaX (for X) | Xy (for Threads) |
|---|---|---|
| Rotating operation IDs | Scrapes `queryId` from X JS bundles; retries on 404 | Scrapes GraphQL `doc_id` from Threads `*_threadsRelayOperation` modules; refreshes on stale errors |
| Browser fingerprinting | Mimics web client + `x-client-transaction-id` | Mimics threads.net headers (`x-ig-app-id`, `x-fb-lsd`, cookies) |
| Auth reality | Needs an X account for most calls | Guest reads via `web_profile_info` + GraphQL; writes / timeline need Instagram login |
| Hardcoded constants | Goes stale | Seed map + runtime discovery + 24h cache |

## Install

```bash
npm install
npm run build
```

```ts
import { ThreadsAPI } from 'xy-threads-api';

const api = new ThreadsAPI({
  verbose: true,
  docIdCachePath: '.xy-doc-ids.json', // persistent QuaX-style cache
  // transport: 'curl' is the default — Meta often 429s Node/undici TLS fingerprints
});

// Guest — no login
const profile = await api.getUserProfile('zuck');
console.log(profile.username, profile.follower_count);

const userId = await api.getUserIdFromUsername('zuck');

// Optional: refresh GraphQL doc_ids from live JS bundles
await api.refreshDocIds(true);
```

> **Transport note:** By default Xy uses system `curl` for HTTP. Meta’s edge frequently returns empty HTTP 429 to Node’s undici TLS fingerprint while accepting curl / real browsers (QuaX speaks from a mobile TLS stack and avoids this). Pass `transport: 'fetch'` to force native fetch.

## CLI

```bash
npx tsx src/cli.ts profile zuck
npx tsx src/cli.ts user-id zuck
npx tsx src/cli.ts discover-doc-ids
npx tsx src/cli.ts post-id CuZsgfWLyiI
npx tsx src/cli.ts thread-id 314216
```

## API surface

### Guest / public

- `getWebProfile(username)` — stable `GET /api/v1/users/web_profile_info/`
- `getUserProfile(username)` — normalized profile
- `getUserIdFromUsername(username)`
- `refreshLsd()` / `ensureLsd()` — CSRF `lsd` token from HTML
- `refreshDocIds()` — scrape & cache GraphQL doc_ids
- `graphql(operationName, variables)` — low-level Threads GraphQL
- `searchUsers(query)`
- `getPost(postId)` / `getPostFromUrl(url)` / `getPostFromThreadId(shortcode)`

### Authenticated (Barcelona / `i.instagram.com`)

Set `username` + `password`, or a saved `token` (`Bearer IGT:2:…`) + `deviceId`:

- `login()`
- `getUserProfileThreadsLoggedIn(userId)`
- `getUserProfileRepliesLoggedIn(userId)`
- `getTimeline()`
- `publish({ text })`
- `like` / `unlike` / `follow` / `unfollow`

> Persist `deviceId` across sessions. Interactive 2FA / challenges may still require manual intervention — same class of problem QuaX solves by letting you paste account sessions.

## Reverse engineering notes

See [docs/REVERSE_ENGINEERING.md](./docs/REVERSE_ENGINEERING.md).

Short version:

1. **Web GraphQL** — `POST https://www.threads.net/api/graphql` with `doc_id` + `lsd` + `x-ig-app-id: 238260118697367`
2. **Doc IDs** — live in JS as `BarcelonaXxxQuery_threadsRelayOperation → "digits"`
3. **Guest REST** — `web_profile_info` remains the most reliable unauthenticated profile read
4. **Mobile** — `i.instagram.com/api/v1/text_feed/...` (Barcelona UA) for timelines, publish, social actions

## Raspberry Pi (auto-start on boot)

```bash
curl -fsSL https://raw.githubusercontent.com/Aimdi/Xy/main/deploy/install-pi.sh | bash
curl http://127.0.0.1:8787/profile/zuck
```

Full guide: [docs/RASPBERRY_PI.md](./docs/RASPBERRY_PI.md)

## Scripts

```bash
npm run build
npm test                 # unit tests
XY_LIVE_TESTS=1 npm test # also hit live Threads (rate limits apply)
npm run example:basic
npm run discover-doc-ids
```

## Credits

- Architecture inspiration: [Teskann/QuaX](https://github.com/Teskann/QuaX) (esp. v4.13.0) — unofficial X GraphQL client with runtime header / query-id healing
- Original Threads client: [junhoyeo/threads-api](https://github.com/junhoyeo/threads-api) (archived)
- Early RE notes: [m1guelpf/threads-re](https://github.com/m1guelpf/threads-re)

## License

MIT
