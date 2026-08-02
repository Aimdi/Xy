import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { SIGNATURE_KEY } from './constants.js';

export function generateDeviceId(): string {
  return `android-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Instagram-style signed body: `signed_body=SIGNATURE.PAYLOAD`. */
export function signPayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const sig = createHmac('sha256', SIGNATURE_KEY).update(json).digest('hex');
  return `signed_body=${sig}.${encodeURIComponent(json)}`;
}

/** Convert a Threads shortcode (e.g. CuZsgfWLyiI) to a numeric media PK. */
export function postIdFromThreadId(threadId: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = BigInt(0);
  for (const char of threadId) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Threads shortcode character: ${char}`);
    }
    id = id * BigInt(64) + BigInt(index);
  }
  return id.toString();
}

/** Convert a numeric media PK to a Threads shortcode. */
export function threadIdFromPostId(postId: string | number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = BigInt(postId);
  if (id === BigInt(0)) return alphabet[0];
  let out = '';
  while (id > 0) {
    const rem = Number(id % BigInt(64));
    id = id / BigInt(64);
    out = alphabet[rem] + out;
  }
  return out;
}

export function postIdFromUrl(url: string): string {
  const match = url.match(/\/(?:t|post)\/([A-Za-z0-9_-]+)/);
  if (!match) {
    throw new Error(`Could not extract thread shortcode from URL: ${url}`);
  }
  return postIdFromThreadId(match[1]);
}

export function extractLsdToken(html: string): string | undefined {
  const match = html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/);
  return match?.[1];
}

export function extractUserIdFromHtml(html: string): string | undefined {
  const patterns = [/"user_id":"(\d+)"/, /"userID":"(\d+)"/, /"props":\{"user_id":"(\d+)"\}/];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function parseSetCookie(setCookie: string[] | null): string {
  if (!setCookie?.length) return '';
  return setCookie
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

export function mergeCookies(existing: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const chunk of `${existing};${incoming}`.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Cookie name → value from a Netscape-format curl cookie jar. */
export function parseNetscapeCookieJar(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // domain \t flag \t path \t secure \t expires \t name \t value
    const parts = rawLine.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5]?.trim();
    const value = parts.slice(6).join('\t').trim();
    if (name) map.set(name, value);
  }
  return map;
}

export function cookieHeaderFromJarMap(map: Map<string, string>): string {
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function getCookieValueFromHeader(cookieHeader: string, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const chunk of cookieHeader.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

/**
 * Read a curl Netscape jar from disk (best-effort). Returns empty map if missing.
 * Does not throw for missing files — callers treat that as "cold jar".
 */
export function readCookieJarFile(jarPath: string): Map<string, string> {
  try {
    if (!existsSync(jarPath)) return new Map();
    return parseNetscapeCookieJar(readFileSync(jarPath, 'utf8'));
  } catch {
    return new Map();
  }
}

export interface CookieJarDiagnostics {
  path: string;
  exists: boolean;
  size: number;
  mtime?: string;
  has_csrftoken: boolean;
  has_mid: boolean;
  has_ig_did: boolean;
  cookie_names: string[];
}

/** Safe (no values) diagnostics for a cookie jar file. */
export function cookieJarDiagnostics(jarPath: string): CookieJarDiagnostics {
  const empty: CookieJarDiagnostics = {
    path: jarPath,
    exists: false,
    size: 0,
    has_csrftoken: false,
    has_mid: false,
    has_ig_did: false,
    cookie_names: [],
  };
  try {
    if (!existsSync(jarPath)) return empty;
    const st = statSync(jarPath);
    const map = parseNetscapeCookieJar(readFileSync(jarPath, 'utf8'));
    const names = [...map.keys()].sort();
    return {
      path: jarPath,
      exists: true,
      size: st.size,
      mtime: st.mtime.toISOString(),
      has_csrftoken: map.has('csrftoken'),
      has_mid: map.has('mid'),
      has_ig_did: map.has('ig_did'),
      cookie_names: names,
    };
  } catch {
    return empty;
  }
}
