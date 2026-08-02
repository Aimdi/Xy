# Reverse-engineering Threads (2026)

Xy talks to Threads the same way [QuaX](https://github.com/Teskann/QuaX) talks to X: **reuse the unofficial APIs shipped to browsers / official apps**, then heal when Meta rotates opaque identifiers.

## Surfaces

### 1. Web GraphQL — `https://www.threads.net/api/graphql`

Used by the logged-in and logged-out www clients (Relay).

Required request shape:

```http
POST /api/graphql HTTP/1.1
Host: www.threads.net
Content-Type: application/x-www-form-urlencoded
X-IG-App-ID: 238260118697367
X-FB-LSD: <lsd>
X-ASBD-ID: 359341
X-FB-Friendly-Name: BarcelonaUserDialogByUsernameQuery
Origin: https://www.threads.net
Cookie: <csrftoken …>

lsd=<lsd>
&variables={"username":"zuck",...}
&doc_id=27156446060700407
&fb_api_req_friendly_name=BarcelonaUserDialogByUsernameQuery
&server_timestamps=true
```

`lsd` is a CSRF token embedded in HTML:

```js
["LSD",[],{"token":"Ad…"},…]
```

### 2. Doc ID rotation (QuaX analogue of X `queryId`)

Meta does **not** accept arbitrary GraphQL documents. Each operation is a persisted query addressed by numeric `doc_id`.

In frontend bundles these appear as:

```js
__d("BarcelonaPostPageDirectQuery_threadsRelayOperation",[],(function(t,n,r,o,a,i){
  a.exports="27871919269164889"
}),null);
```

Xy’s `DocIdRegistry`:

1. Loads `seed-doc-ids.json` (last known good map)
2. Scrapes `threads.net` HTML → Bootloader `rsrcMap` JS URLs
3. Downloads bundles and regex-extracts `*_threadsRelayOperation` exports
4. Caches to disk (default TTL 24h)
5. On GraphQL errors that look like stale IDs, force-refreshes and retries once

This mirrors QuaX’s runtime discovery of X GraphQL query IDs from frontend JS (and the earlier Python `XClientTransaction` era).

### 3. Guest REST — `web_profile_info`

```http
GET /api/v1/users/web_profile_info/?username=zuck
Host: www.threads.net
X-IG-App-ID: 238260118697367
```

As of the 2026 probe this remains the most reliable **unauthenticated** profile endpoint. It returns Instagram-shaped JSON including Threads user id (`314216` for `@zuck`), follower counts, bio, etc.

Many older GraphQL profile doc_ids (`23996318473300828`, …) still parse but return `userData: null` when logged out.

### 4. Barcelona private API — `https://i.instagram.com`

The Android Threads app (“Barcelona”) uses Instagram’s private API with a Barcelona user-agent, e.g.:

| Action | Path |
|---|---|
| Profile threads | `GET /api/v1/text_feed/{userId}/profile/` |
| Replies | `GET /api/v1/text_feed/{userId}/profile/replies/` |
| Timeline | `POST /api/v1/feed/text_post_app_timeline/` |
| Publish text | `POST /api/v1/media/configure_text_only_post/` |
| Like | `POST /api/v1/media/{postId}_{userId}/like/` |
| Follow | `POST /api/v1/friendships/create/{userId}/` |

Auth is an `Authorization: Bearer IGT:2:…` token obtained via Bloks CAA login (`com.bloks.www.bloks.caa.login.async.send_login_request`). Persist `deviceId` (`android-…`).

Unauthenticated calls return `login_required` / 403 — same evolution Twitter/X went through before QuaX required accounts.

## Operation map (seed, Aug 2026)

| Operation | doc_id | Notes |
|---|---|---|
| `BarcelonaUserDialogByUsernameQuery` | `27156446060700407` | `xdt_text_app_user_by_username` |
| `BarcelonaUsernameHovercardImplDirectQuery` | `28194833553463057` | hovercard by username |
| `BarcelonaUserHovercardImplQuery` | `27220712120957908` | hovercard by userID |
| `BarcelonaPostPageDirectQuery` | `27871919269164889` | permalink / replies connection |
| `BarcelonaPostPageContainerViewerDirectQuery` | `27524608677194577` | viewer extras |
| `BarcelonaFeedPaginationDirectQuery` | `37463620386586907` | feed pagination |
| `BarcelonaAccountSearchGraphQLDataSourceQuery` | `27962697876655098` | user search |
| `useTHLikeMutationLikeMutation` | `24753372994365040` | like |
| `useTHFollowMutationFollowMutation` | `26234294899535416` | follow |

Legacy 2023 IDs are kept under `*_legacy` keys for fallback experiments.

Refresh anytime:

```bash
npm run discover-doc-ids
```

## Rate limits & challenges

Aggressive scraping yields HTML challenge pages (HTTP 200/429 with `<!DOCTYPE html>`) instead of JSON. Xy treats HTML GraphQL responses as errors. Back off, rotate sessions, and prefer `web_profile_info` for simple profile reads.

### Node TLS fingerprinting

From this environment, **Node/undici `fetch` receives empty HTTP 429** for the same URLs that **system `curl` fetches successfully**. Xy defaults to a curl-backed transport (`transport: 'curl'`) for that reason. QuaX does not hit this class of problem because it runs inside a real Android TLS stack.


## Relationship to Meta’s official Threads API

Meta launched an official OAuth Threads API (`graph.threads.net`) in 2024. Xy deliberately targets the **unofficial** client APIs (QuaX model) for feature parity with the consumer apps — timelines, search, guest reads, etc. — not the restricted partner Graph API.
