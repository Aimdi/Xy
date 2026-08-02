# Deploy Xy on Coolify (xy.txne.org)

## Why `/profile/zuck` fails on EU hosts

Two separate issues hit Coolify deploys:

1. **Missing `curl` in the Node image** — Xy shells out to system curl with HTTP/2. Plain Nixpacks / `node:*-slim` images often have no curl → profile fetches die.
2. **EU consent gating (geo)** — US egress works cold; German/EU hosts often get HTTP 400 `NodeInvalidTypeException` / fbtype mismatch on `web_profile_info` when called **without** browser session cookies. This is **not** a datacenter IP block and **not** a stale doc_id. Xy warms a curl cookie jar (`XY_COOKIE_JAR`) from **Instagram + Threads** HTML so the jar accumulates `mid` / `ig_did` / `ig_nrcb` / `csrftoken` (Threads alone only sets csrftoken).

A US VPS proxy (`XY_PROXY`) remains the reliable fallback if EU still rejects after a full warm (`consent_ready: true` in `/health`).

## Fix: redeploy with the repo Dockerfile

In Coolify:

1. **Build Pack:** Dockerfile  
2. **Ports Exposes:** `8787` (or your `PORT`)  
3. **Start Command:** leave empty (`CMD` is `node dist/server.js`)  
4. **Healthcheck path:** `/health`  
5. Force a **Rebuild** (not just restart) so apt installs curl
6. **Persistent storage (recommended):** mount a volume at `/data` so doc_ids + cookies survive redeploys

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `XY_HOST` | no | Default `0.0.0.0` |
| `PORT` / `XY_PORT` | no | Default `8787` |
| `XY_API_TOKEN` | recommended | Bearer token for `/profile` etc. (`/health` stays public) |
| `XY_TRANSPORT` | no | Keep `curl` |
| `XY_COOKIE_JAR` | **yes on Coolify** | e.g. `/data/.xy-cookies.txt` (EU consent cookies) |
| `XY_DOC_ID_CACHE` | **yes on Coolify** | e.g. `/data/.xy-doc-ids.json` (avoid re-scraping ~300 bundles) |
| `XY_PROXY` | if jar insufficient | US egress HTTP proxy, e.g. `http://user:pass@host:port` |
| `XY_VERBOSE` | no | `1` for logs |

### Persistent volume (Coolify)

Attach a volume so these files are not wiped on every deploy:

```env
XY_COOKIE_JAR=/data/.xy-cookies.txt
XY_DOC_ID_CACHE=/data/.xy-doc-ids.json
```

Mount the volume at `/data` (or change the paths to match your mount).

## Verify after deploy

```bash
curl -sS http://xy.txne.org/health
# Expect: runtime.curl_on_path=true, runtime.http2=true
# Expect: cookie_jar.exists / has_csrftoken after first warm

curl -sS -H "Authorization: Bearer YOUR_TOKEN" \
  http://xy.txne.org/debug/refresh-cookies

curl -sS -H "Authorization: Bearer YOUR_TOKEN" \
  "http://xy.txne.org/debug/upstream?username=zuck"
# Expect: ok=true and a user_id like 314216
# If ok=false, read "advice" in the JSON

curl -sS -H "Authorization: Bearer YOUR_TOKEN" \
  http://xy.txne.org/profile/zuck
```

## If upstream still returns NodeInvalidTypeException

1. `GET /debug/refresh-cookies` then retry `/profile/zuck`
2. If still failing from Germany: set **`XY_PROXY`** to a **US** VPS/proxy (Oracle always-free / Fly.io is enough — this is regional gating, not residential-required)
3. Last resort: paid residential proxy

## Nixpacks alternative

`nixpacks.toml` adds curl and starts `node dist/server.js`, but **Dockerfile is preferred**.
