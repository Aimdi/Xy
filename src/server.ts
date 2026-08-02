/**
 * Tiny local HTTP API for Raspberry Pi / Coolify / always-on hosts.
 *
 *   npx tsx src/server.ts
 *   curl http://127.0.0.1:8787/health
 *   curl -H "Authorization: Bearer $XY_API_TOKEN" http://127.0.0.1:8787/profile/zuck
 */
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ThreadsAPI } from './client.js';
import { WEB_PROFILE_HOSTS, WEB_IG_APP_ID } from './constants.js';
import { curlRequest } from './curl-transport.js';
import {
  httpStatusForThreadsError,
  ThreadsAPIError,
} from './errors.js';
import { postIdFromThreadId, postIdFromUrl, threadIdFromPostId } from './utils.js';

const HOST = process.env.XY_HOST ?? '0.0.0.0';
const PORT = Number(process.env.XY_PORT ?? process.env.PORT ?? 8787);
const API_TOKEN = process.env.XY_API_TOKEN;

const api = new ThreadsAPI({
  verbose: process.env.XY_VERBOSE === '1',
  docIdCachePath: process.env.XY_DOC_ID_CACHE ?? '.xy-doc-ids.json',
  username: process.env.THREADS_USERNAME,
  password: process.env.THREADS_PASSWORD,
  token: process.env.THREADS_TOKEN,
  deviceId: process.env.THREADS_DEVICE_ID,
  userId: process.env.THREADS_USER_ID,
  transport: (process.env.XY_TRANSPORT as 'curl' | 'fetch' | 'auto' | undefined) ?? 'curl',
});

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

function authorized(req: IncomingMessage): boolean {
  if (!API_TOKEN) return true;
  const header = req.headers['authorization'] ?? '';
  const sent = header.replace(/^Bearer\s+/i, '');
  return sent === API_TOKEN;
}

function notFound(res: ServerResponse): void {
  send(res, 404, {
    error: 'not_found',
    endpoints: [
      'GET /health',
      'GET /debug/ping',
      'GET /debug/upstream?username=zuck',
      'GET /debug/refresh-doc-ids',
      'GET /profile/:username',
      'GET /user-id/:username',
      'GET /post-id/:shortcodeOrUrl',
      'GET /thread-id/:postId',
    ],
  });
}

function sendError(res: ServerResponse, err: unknown): void {
  // Duck-type: instanceof can fail across bundled module copies.
  if (
    err instanceof ThreadsAPIError ||
    (err &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'ThreadsAPIError' &&
      typeof (err as { toJSON?: unknown }).toJSON === 'function')
  ) {
    const e = err as ThreadsAPIError;
    send(res, httpStatusForThreadsError(e), {
      ...e.toJSON(),
      transport: e.transport ?? api.getDiagnostics().last_transport,
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  send(res, 500, {
    error: 'internal_error',
    message,
    transport: api.getDiagnostics().last_transport,
    hint:
      /curl|HTTP\/2|nghttp|spawn/i.test(message)
        ? 'Container is missing curl with HTTP/2, or Meta blocked this IP. Redeploy with the repo Dockerfile and/or set XY_PROXY to a residential proxy.'
        : undefined,
  });
}

function curlRuntimeInfo(): {
  curl_on_path: boolean;
  curl_version?: string;
  http2: boolean;
  proxy_configured: boolean;
} {
  const which = spawnSync('curl', ['-V'], { encoding: 'utf8' });
  const out = `${which.stdout ?? ''}${which.stderr ?? ''}`;
  return {
    curl_on_path: which.status === 0,
    curl_version: which.status === 0 ? out.split('\n')[0] : undefined,
    http2: /HTTP2|nghttp2/i.test(out),
    proxy_configured: Boolean(
      process.env.XY_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.ALL_PROXY,
    ),
  };
}

function diagnosticsPayload() {
  const d = api.getDiagnostics();
  return {
    transport: d.transport,
    last_transport: d.last_transport,
    lsd: {
      present: d.lsd_present,
      is_default: d.lsd_is_default,
    },
    has_cookies: d.has_cookies,
    authenticated: d.authenticated,
    runtime: curlRuntimeInfo(),
  };
}

function extractUpstreamJsonMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const message =
    typeof obj.message === 'string' && obj.message.trim()
      ? obj.message.trim()
      : typeof obj.error_message === 'string' && obj.error_message.trim()
        ? obj.error_message.trim()
        : undefined;
  const errorType =
    typeof obj.error_type === 'string' && obj.error_type.trim()
      ? obj.error_type.trim()
      : undefined;
  if (errorType && message) {
    return message.includes(errorType) ? message : `${errorType}: ${message}`;
  }
  if (message) return message;
  if (errorType) return errorType;
  if (Array.isArray(obj.errors) && obj.errors[0]) {
    const first = obj.errors[0] as Record<string, unknown>;
    if (typeof first.message === 'string' && first.message.trim()) return first.message;
  }
  return undefined;
}

function adviceForUpstreamResults(
  results: Array<Record<string, unknown>>,
  runtime: ReturnType<typeof curlRuntimeInfo>,
  anyOk: boolean,
): string {
  if (anyOk) return 'Upstream works from this host.';
  if (runtime.curl_on_path === false) {
    return 'curl is missing in this container. Redeploy using the repo Dockerfile (apt installs curl).';
  }
  if (runtime.http2 === false) {
    return 'curl has no HTTP/2. Meta returns empty 429 on HTTP/1.1. Install curl with nghttp2.';
  }

  const httpResults = results.filter((r) => typeof r.status === 'number');
  const jsonClientErrors = httpResults.filter((r) => {
    if (r.status !== 400 && r.status !== 404) return false;
    if (typeof r.upstream_message === 'string' && String(r.upstream_message).trim()) {
      return true;
    }
    const preview = String(r.body_preview ?? '').trimStart();
    const bodyLen = Number(r.body_len ?? 0);
    return bodyLen > 0 && (preview.startsWith('{') || preview.startsWith('['));
  });
  if (jsonClientErrors.length > 0) {
    const first = jsonClientErrors[0];
    const msg =
      typeof first.upstream_message === 'string' && String(first.upstream_message).trim()
        ? String(first.upstream_message)
        : String(first.body_preview ?? 'JSON error body').trim();
    return (
      `Upstream returned HTTP ${first.status} with a JSON error ` +
      `(${msg}). This usually means a stale identifier (doc_id / fbtype mismatch), ` +
      `not an IP block. Try GET /debug/refresh-doc-ids, then retry.`
    );
  }

  // Only suggest proxy / IP block for empty bodies or HTTP 429.
  const looksBlocked = httpResults.some((r) => {
    const status = r.status as number;
    const bodyLen = Number(r.body_len ?? 0);
    return status === 429 || bodyLen === 0;
  });
  if (looksBlocked) {
    return (
      'Meta is likely blocking this server IP (common on Coolify/VPS/datacenter ASNs). ' +
      'Set XY_PROXY to a residential HTTP proxy, or run Xy on a home Raspberry Pi.'
    );
  }

  const previews = httpResults
    .map((r) => String(r.body_preview ?? '').trim())
    .filter(Boolean);
  if (previews.length > 0) {
    return (
      `Upstream failed with non-empty responses (not empty/429). ` +
      `Inspect results[].body_preview; if you see NodeInvalidTypeException / fbtype mismatch, ` +
      `refresh doc ids via GET /debug/refresh-doc-ids rather than changing proxy.`
    );
  }

  return 'Upstream checks failed. Inspect results[] for status, body_preview, and errors.';
}

async function debugUpstream(username: string) {
  const runtime = curlRuntimeInfo();
  const results: Array<Record<string, unknown>> = [];

  for (const host of WEB_PROFILE_HOSTS) {
    const url = `${host}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    try {
      const res = await curlRequest(url, {
        headers: {
          accept: '*/*',
          'x-ig-app-id': WEB_IG_APP_ID,
          referer: `${host}/`,
        },
        timeoutSec: 15,
        proxy:
          process.env.XY_PROXY ||
          process.env.HTTPS_PROXY ||
          process.env.HTTP_PROXY ||
          process.env.ALL_PROXY,
      });
      let parsed: unknown = null;
      let userId: string | undefined;
      let upstreamMessage: string | undefined;
      try {
        parsed = JSON.parse(res.body);
        userId = (parsed as { data?: { user?: { id?: string } } })?.data?.user?.id;
        upstreamMessage = extractUpstreamJsonMessage(parsed);
      } catch {
        // ignore
      }
      results.push({
        host,
        status: res.status,
        http_version: res.httpVersion,
        body_len: res.body.length,
        user_id: userId,
        upstream_message: upstreamMessage,
        hint: res.headers['x-xy-curl-hint'],
        body_preview: res.body.slice(0, 160),
      });
    } catch (err) {
      results.push({
        host,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const anyOk = results.some((r) => r.user_id);
  return {
    ok: anyOk,
    username,
    runtime,
    results,
    advice: adviceForUpstreamResults(results, runtime, Boolean(anyOk)),
  };
}

async function readUrl(req: IncomingMessage): Promise<URL> {
  return new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const url = await readUrl(req);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'health')) {
      send(res, 200, {
        ok: true,
        service: 'xy-threads',
        host: HOST,
        port: PORT,
        time: new Date().toISOString(),
        ...diagnosticsPayload(),
      });
      return;
    }

    if (parts[0] === 'debug' && parts[1] === 'ping' && parts.length === 2) {
      send(res, 200, {
        ok: true,
        ping: 'pong',
        time: new Date().toISOString(),
        ...diagnosticsPayload(),
      });
      return;
    }

    if (!authorized(req)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (parts[0] === 'debug' && parts[1] === 'upstream' && parts.length === 2) {
      const username = url.searchParams.get('username') || 'zuck';
      send(res, 200, await debugUpstream(username));
      return;
    }

    if (parts[0] === 'debug' && parts[1] === 'refresh-doc-ids' && parts.length === 2) {
      const docIds = await api.refreshDocIds(true);
      send(res, 200, {
        ok: true,
        count: Object.keys(docIds).length,
        doc_ids: docIds,
      });
      return;
    }

    if (parts[0] === 'profile' && parts[1]) {
      const profile = await api.getUserProfile(parts[1]);
      send(res, 200, profile);
      return;
    }
    if (parts[0] === 'user-id' && parts[1]) {
      const id = await api.getUserIdFromUsername(parts[1]);
      send(res, 200, { username: parts[1], user_id: id });
      return;
    }
    if (parts[0] === 'post-id' && parts[1]) {
      const raw = decodeURIComponent(parts.slice(1).join('/'));
      const id = raw.includes('/') ? postIdFromUrl(raw) : postIdFromThreadId(raw);
      send(res, 200, { input: raw, post_id: id });
      return;
    }
    if (parts[0] === 'thread-id' && parts[1]) {
      const shortcode = threadIdFromPostId(parts[1]);
      send(res, 200, { post_id: parts[1], thread_id: shortcode });
      return;
    }
    notFound(res);
  } catch (err) {
    console.error('[xy-threads] request error', err);
    try {
      sendError(res, err);
    } catch (sendErr) {
      console.error('[xy-threads] failed to send error', sendErr);
      res.statusCode = 500;
      res.end('{"error":"internal_error"}');
    }
  }
});

server.listen(PORT, HOST, () => {
  const runtime = curlRuntimeInfo();
  console.log(`[xy-threads] listening on http://${HOST}:${PORT}`);
  console.log(`[xy-threads] curl_on_path=${runtime.curl_on_path} http2=${runtime.http2}`);
  console.log(`[xy-threads] curl: ${runtime.curl_version ?? 'NOT FOUND'}`);
  if (!runtime.curl_on_path || !runtime.http2) {
    console.warn(
      '[xy-threads] WARNING: curl with HTTP/2 is required. Redeploy with the repo Dockerfile.',
    );
  }
  if (!runtime.proxy_configured) {
    console.warn(
      '[xy-threads] NOTE: no XY_PROXY set. Datacenter IPs (Coolify/VPS) are often blocked by Meta.',
    );
  }
});

function shutdown(signal: string) {
  console.log(`[xy-threads] ${signal} — shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[xy-threads] uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[xy-threads] unhandledRejection', err);
});
