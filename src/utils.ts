import { createHmac, randomUUID } from 'node:crypto';
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
