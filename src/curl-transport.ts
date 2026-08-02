import { spawn } from 'node:child_process';

export interface CurlResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Last hop HTTP version from the dump-header status line (e.g. "2", "1.1"). */
  httpVersion?: string;
}

export interface CurlRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  userAgent?: string;
  /** Raw Cookie header (used when no jar, or as an extra override). */
  cookie?: string;
  /**
   * Netscape cookie jar path for curl `--cookie` / `--cookie-jar`.
   * Persists EU consent cookies (datr/mid/ig_did/csrftoken) across requests.
   */
  cookieJarPath?: string;
  timeoutSec?: number;
  /** HTTP(S) proxy URL, e.g. http://user:pass@host:port */
  proxy?: string;
}

export interface CurlFetchOptions {
  userAgent?: string;
  cookieJarPath?: string;
}

/**
 * Browser-like requests via system curl.
 *
 * Meta rate-limits Node/undici TLS fingerprints aggressively (HTTP 429 with empty
 * body) while accepting curl. QuaX avoids this by speaking from a real mobile
 * TLS stack; in Node we optionally fall back to curl for guest calls.
 *
 * Important: Meta's edge also empty-429s plain HTTP/1.1 curl. Prefer HTTP/2
 * (ALPN). Raspberry Pi builds of curl without nghttp2 will fail closed with a
 * clear error instead of looking like a random profile miss.
 *
 * EU hosts often need a warmed cookie jar: a real browser picks up Set-Cookie
 * from the first HTML load and sends those cookies on web_profile_info. Cold
 * calls without a jar are exactly what EU consent gating rejects.
 */
export async function curlRequest(
  url: string,
  options: CurlRequestOptions = {},
): Promise<CurlResponse> {
  return curlRequestViaFiles(url, {
    ...options,
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    proxy:
      options.proxy ||
      process.env.XY_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.ALL_PROXY,
  });
}

async function curlRequestViaFiles(
  url: string,
  options: CurlRequestOptions,
): Promise<CurlResponse> {
  const { readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'xy-curl-'));
  const headerFile = join(dir, 'headers.txt');
  const bodyFile = join(dir, 'body.txt');

  const method = (options.method ?? 'GET').toUpperCase();
  const baseArgs = [
    '-sL',
    '--max-time',
    String(options.timeoutSec ?? 20),
    '-A',
    options.userAgent ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '-D',
    headerFile,
    '-o',
    bodyFile,
  ];

  if (options.proxy) {
    baseArgs.push('-x', options.proxy);
  }

  // Avoid `-X` for GET/HEAD: with `-L`, `-X` forces the method on every hop.
  // `--data-binary` already selects POST, so skip `-X POST` when a body is set.
  const needsExplicitMethod =
    method !== 'GET' &&
    method !== 'HEAD' &&
    !(method === 'POST' && options.body != null);
  if (needsExplicitMethod) {
    baseArgs.push('-X', method);
  }

  // Native curl cookie engine — persists consent cookies across redirects/restarts.
  // When a jar is configured it is the sole cookie source (no extra Cookie header).
  if (options.cookieJarPath) {
    baseArgs.push('--cookie', options.cookieJarPath);
    baseArgs.push('--cookie-jar', options.cookieJarPath);
  } else if (options.cookie) {
    baseArgs.push('-H', `Cookie: ${options.cookie}`);
  }

  for (const [k, v] of Object.entries(options.headers ?? {})) {
    const key = k.toLowerCase();
    // `-A` already sets User-Agent; avoid duplicate Cookie when jar/cookie is set.
    if (key === 'user-agent') continue;
    if (key === 'cookie' && (options.cookieJarPath || options.cookie)) continue;
    baseArgs.push('-H', `${k}: ${v}`);
  }

  if (options.body != null) {
    baseArgs.push('--data-binary', options.body);
  }
  baseArgs.push(url);

  // Prefer HTTP/2: Meta empty-429s HTTP/1.1 for guest web_profile_info.
  // If this curl build rejects --http2, retry without (ALPN may still negotiate h2).
  const attempts = [['--http2', ...baseArgs], [...baseArgs]];

  try {
    let lastErr: Error | undefined;
    let rawHeaders = '';
    let body = '';
    let usedHttp2Flag = false;

    for (let i = 0; i < attempts.length; i++) {
      const args = attempts[i];
      usedHttp2Flag = args[0] === '--http2';
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (c) => (stderr += c));
          child.on('error', (err) => {
            reject(
              new Error(
                `Failed to spawn curl (${err.message}). Is curl installed and on PATH?`,
              ),
            );
          });
          child.on('close', (code) => {
            if (code === 0) {
              resolve();
              return;
            }
            const detail = stderr.trim() || `exit ${code}`;
            if (/http2|HTTP\/2|nghttp|option --http2/i.test(detail) && usedHttp2Flag) {
              reject(new Error(`http2_unsupported:${detail}`));
              return;
            }
            reject(new Error(`curl exited ${code}: ${detail}`));
          });
        });
        rawHeaders = readFileSync(headerFile, 'utf8');
        body = readFileSync(bodyFile, 'utf8');
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (usedHttp2Flag && lastErr.message.startsWith('http2_unsupported:')) {
          continue;
        }
        throw lastErr;
      }
    }

    if (lastErr) {
      throw new Error(
        `curl lacks usable HTTP/2 (${lastErr.message}). Meta returns empty HTTP 429 on HTTP/1.1. Install curl with nghttp2 (e.g. sudo apt-get install -y curl).`,
      );
    }

    // Last status line in redirected responses: "HTTP/2 200" / "HTTP/1.1 429"
    const statusMatches = [
      ...rawHeaders.matchAll(/HTTP\/(\d(?:\.\d)?)\s+(\d+)/g),
    ];
    const last = statusMatches.length
      ? statusMatches[statusMatches.length - 1]
      : undefined;
    const httpVersion = last?.[1];
    const status = last ? Number(last[2]) : 0;

    const headers: Record<string, string> = {};
    const setCookies: string[] = [];
    // Only apply header lines from the final hop (after the last status line).
    const hops = rawHeaders.split(/(?=^HTTP\/\d)/m).filter(Boolean);
    const finalHop = hops.length ? hops[hops.length - 1] : rawHeaders;
    for (const line of finalHop.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (!key) continue;
      if (key === 'set-cookie') setCookies.push(value);
      else headers[key] = value;
    }
    // Still collect Set-Cookie from earlier hops (redirect session cookies).
    if (hops.length > 1) {
      for (const hop of hops.slice(0, -1)) {
        for (const line of hop.split(/\r?\n/)) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          const key = line.slice(0, idx).trim().toLowerCase();
          if (key === 'set-cookie') setCookies.push(line.slice(idx + 1).trim());
        }
      }
    }
    if (setCookies.length) headers['set-cookie'] = setCookies.join('\n');

    // Actionable signal when a non-HTTP2 curl somehow still ran (or proxy downgraded).
    if (status === 429 && !body.trim() && httpVersion === '1.1') {
      headers['x-xy-curl-hint'] =
        'empty_429_over_http1_1; Meta requires HTTP/2 for this guest endpoint';
    }

    return { status, headers, body, httpVersion };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function responseFromCurl(res: CurlResponse): Response {
  const status =
    res.status >= 200 && res.status <= 599
      ? res.status
      : // curl dump missing/unparsed — avoid `new Response(..., { status: 0 })` throw
        502;
  const safeHeaders: Record<string, string> = { ...res.headers };
  delete safeHeaders['set-cookie'];
  if (res.httpVersion) safeHeaders['x-xy-http-version'] = res.httpVersion;
  return new Response(res.body, { status, headers: safeHeaders });
}

/** Minimal fetch-compatible wrapper around system curl (for DocIdRegistry etc.). */
export function createCurlFetch(
  userAgentOrOptions?: string | CurlFetchOptions,
  maybeOptions?: CurlFetchOptions,
): typeof fetch {
  const options: CurlFetchOptions =
    typeof userAgentOrOptions === 'string'
      ? { userAgent: userAgentOrOptions, ...(maybeOptions ?? {}) }
      : (userAgentOrOptions ?? {});

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const headerObj: Record<string, string> = {};
    headers.forEach((v, k) => {
      headerObj[k] = v;
    });
    let body: string | undefined;
    if (init?.body != null) {
      body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    }
    const res = await curlRequest(url, {
      method: init?.method,
      headers: headerObj,
      body,
      userAgent: options.userAgent ?? headers.get('user-agent') ?? undefined,
      cookieJarPath: options.cookieJarPath,
    });
    return responseFromCurl(res);
  }) as typeof fetch;
  return impl;
}
