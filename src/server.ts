/**
 * Tiny local HTTP API for Raspberry Pi / always-on hosts.
 *
 *   npx tsx src/server.ts
 *   curl http://127.0.0.1:8787/health
 *   curl http://127.0.0.1:8787/profile/zuck
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ThreadsAPI } from './client.js';
import { postIdFromThreadId, postIdFromUrl, threadIdFromPostId } from './utils.js';

const HOST = process.env.XY_HOST ?? '0.0.0.0';
const PORT = Number(process.env.XY_PORT ?? 8787);
const API_TOKEN = process.env.XY_API_TOKEN;

const api = new ThreadsAPI({
  verbose: process.env.XY_VERBOSE === '1',
  docIdCachePath: process.env.XY_DOC_ID_CACHE ?? '.xy-doc-ids.json',
  username: process.env.THREADS_USERNAME,
  password: process.env.THREADS_PASSWORD,
  token: process.env.THREADS_TOKEN,
  deviceId: process.env.THREADS_DEVICE_ID,
  userId: process.env.THREADS_USER_ID,
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
  if (!API_TOKEN) return true; // no token set = open (dev)
  const header = req.headers['authorization'] ?? '';
  const sent = header.replace(/^Bearer\s+/i, '');
  return sent === API_TOKEN;
}

function notFound(res: ServerResponse): void {
  send(res, 404, {
    error: 'not_found',
    endpoints: [
      'GET /health',
      'GET /profile/:username',
      'GET /user-id/:username',
      'GET /post-id/:shortcodeOrUrl',
      'GET /thread-id/:postId',
    ],
  });
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

    // /health stays public so Coolify's healthcheck works without a token
    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'health')) {
      send(res, 200, {
        ok: true,
        service: 'xy-threads',
        host: HOST,
        port: PORT,
        time: new Date().toISOString(),
      });
      return;
    }

    // everything below requires the token
    if (!authorized(req)) {
      send(res, 401, { error: 'unauthorized' });
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
    const message = err instanceof Error ? err.message : String(err);
    send(res, 500, { error: 'internal_error', message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[xy-threads] listening on http://${HOST}:${PORT}`);
  console.log(`[xy-threads] try: curl http://${HOST}:${PORT}/profile/zuck`);
});

function shutdown(signal: string) {
  console.log(`[xy-threads] ${signal} — shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
