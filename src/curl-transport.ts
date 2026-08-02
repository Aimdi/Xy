import { spawn } from 'node:child_process';

export interface CurlResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Browser-like requests via system curl.
 *
 * Meta rate-limits Node/undici TLS fingerprints aggressively (HTTP 429 with empty
 * body) while accepting curl. QuaX avoids this by speaking from a real mobile
 * TLS stack; in Node we optionally fall back to curl for guest calls.
 */
export async function curlRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    userAgent?: string;
    cookie?: string;
    timeoutSec?: number;
  } = {},
): Promise<CurlResponse> {
  const method = options.method ?? (options.body ? 'POST' : 'GET');
  const args = [
    '-sL',
    '-X',
    method,
    '-A',
    options.userAgent ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '-D',
    '-', // dump headers to stdout before body
    '-o',
    '-', // body to stdout after headers... actually -D - mixes; use separate
  ];

  // Use a cleaner approach: write headers to fd3 via -w / -D tempfile is easier
  // We'll use -w for status and -D for headers file via stdout split with --raw
  return curlRequestViaFiles(url, { ...options, method });
}

async function curlRequestViaFiles(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    userAgent?: string;
    cookie?: string;
    timeoutSec?: number;
  },
): Promise<CurlResponse> {
  const { writeFileSync, readFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'xy-curl-'));
  const headerFile = join(dir, 'headers.txt');
  const bodyFile = join(dir, 'body.txt');

  const args = [
    '-sL',
    '--max-time',
    String(options.timeoutSec ?? 30),
    '-X',
    options.method ?? 'GET',
    '-A',
    options.userAgent ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '-D',
    headerFile,
    '-o',
    bodyFile,
  ];

  if (options.cookie) {
    args.push('-H', `Cookie: ${options.cookie}`);
  }
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    if (k.toLowerCase() === 'user-agent') continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (options.body != null) {
    args.push('--data-binary', options.body);
  }
  args.push(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl exited ${code}: ${stderr}`));
    });
  });

  const rawHeaders = readFileSync(headerFile, 'utf8');
  const body = readFileSync(bodyFile, 'utf8');
  try {
    unlinkSync(headerFile);
    unlinkSync(bodyFile);
  } catch {
    // ignore
  }

  // Last status line in redirected responses
  const statusMatches = [...rawHeaders.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d+)/g)];
  const status = statusMatches.length
    ? Number(statusMatches[statusMatches.length - 1][1])
    : 0;

  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const line of rawHeaders.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'set-cookie') setCookies.push(value);
    else headers[key] = value;
  }
  if (setCookies.length) headers['set-cookie'] = setCookies.join('\n');

  return { status, headers, body };
}

/** Minimal fetch-compatible wrapper around system curl (for DocIdRegistry etc.). */
export function createCurlFetch(userAgent?: string): typeof fetch {
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
      userAgent: userAgent ?? headers.get('user-agent') ?? undefined,
    });
    const safeHeaders: Record<string, string> = { ...res.headers };
    delete safeHeaders['set-cookie'];
    return new Response(res.body, { status: res.status, headers: safeHeaders });
  }) as typeof fetch;
  return impl;
}
