# Deploy Xy on Coolify (xy.txne.org)

## Why `/profile/zuck` was failing

Two separate issues hit Coolify deploys:

1. **Missing `curl` in the Node image** — Xy shells out to system curl with HTTP/2. Plain Nixpacks / `node:slim` images often have no curl → profile fetches die.
2. **Datacenter IP blocks** — Meta frequently empty-429s AWS/Hetzner/OVH/etc. Even with curl+HTTP/2, Coolify VPS IPs can be blocked. Home Pi / residential proxy works much more often.

## Fix: redeploy with the repo Dockerfile

In Coolify:

1. **Build Pack:** Dockerfile  
2. **Ports Exposes:** `8787` (or your `PORT`)  
3. **Start Command:** leave empty (`CMD` is `node dist/server.js`)  
4. **Healthcheck path:** `/health`  
5. Force a **Rebuild** (not just restart) so apt installs curl

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `XY_HOST` | no | Default `0.0.0.0` |
| `PORT` / `XY_PORT` | no | Default `8787` |
| `XY_API_TOKEN` | recommended | Bearer token for `/profile` etc. (`/health` stays public) |
| `XY_TRANSPORT` | no | Keep `curl` |
| `XY_PROXY` | **if VPS blocked** | Residential HTTP proxy, e.g. `http://user:pass@host:port` |
| `XY_VERBOSE` | no | `1` for logs |

## Verify after deploy

```bash
curl -sS http://xy.txne.org/health
# Expect: runtime.curl_on_path=true, runtime.http2=true

curl -sS -H "Authorization: Bearer YOUR_TOKEN" \
  "http://xy.txne.org/debug/upstream?username=zuck"
# Expect: ok=true and a user_id like 314216
# If ok=false, read "advice" in the JSON

curl -sS -H "Authorization: Bearer YOUR_TOKEN" \
  http://xy.txne.org/profile/zuck
```

## If upstream still blocked

Set a **residential** proxy (not another datacenter proxy):

```env
XY_PROXY=http://USER:PASS@PROXY_HOST:PORT
```

Then restart/redeploy and re-check `/debug/upstream`.

Or run Xy on a **home Raspberry Pi** instead of Coolify — consumer ISP IPs are far less blocked.

## Nixpacks alternative

`nixpacks.toml` adds curl and starts `node dist/server.js`, but **Dockerfile is preferred**.
