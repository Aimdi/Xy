import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadsAPI } from '../src/client.js';
import { WEB_IG_APP_ID } from '../src/constants.js';
import { ThreadsAPIError } from '../src/errors.js';

const okUser = {
  id: '314216',
  username: 'zuck',
  full_name: 'Mark Zuckerberg',
  is_verified: true,
  is_private: false,
  profile_pic_url: 'https://example.com/pic.jpg',
  profile_pic_url_hd: 'https://example.com/pic-hd.jpg',
  biography: 'bio',
  external_url: null,
  edge_followed_by: { count: 1_000_001 },
  edge_follow: { count: 500 },
  edge_owner_to_timeline_media: { count: 10 },
};

function headerGet(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => String(k).toLowerCase() === name.toLowerCase());
    return hit?.[1] != null ? String(hit[1]) : null;
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? record[key] : null;
}

const warmHtml = '<html><script>"LSD",[],{"token":"TestLsdTokenFromWarm"}</script></html>';

describe('getWebProfile REST-only guest path', () => {
  it('calls only web_profile_info with x-ig-app-id (never GraphQL / doc_id)', async () => {
    const seen: Array<{ url: string; method: string; appId: string | null }> = [];

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      // Cookie-jar warm hits HTML first — allow those through.
      if (!url.includes('web_profile_info')) {
        return new Response(warmHtml, {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'set-cookie': 'csrftoken=testcsrf; Path=/',
          },
        });
      }

      seen.push({
        url,
        method,
        appId: headerGet(init?.headers, 'x-ig-app-id'),
      });

      expect(url).toMatch(/\/api\/v1\/users\/web_profile_info\/\?username=zuck$/);
      expect(url).not.toContain('/api/graphql');
      expect(url).not.toMatch(/doc_id/i);
      expect(method).toBe('GET');

      return new Response(JSON.stringify({ data: { user: okUser } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const api = new ThreadsAPI({
      transport: 'fetch',
      fetchImpl,
      disableCookieJar: true,
    });
    api.warmCookieJar = async () => {};
    const profile = await api.getUserProfile('zuck');

    expect(profile.username).toBe('zuck');
    expect(String(profile.pk)).toBe('314216');
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((s) => s.url.includes('web_profile_info'))).toBe(true);
    expect(seen.every((s) => s.appId === WEB_IG_APP_ID)).toBe(true);
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
    expect(seen.every((s) => !s.url.includes('graphql'))).toBe(true);
  });

  it('does not advise IP block for HTTP 400 NodeInvalidTypeException', async () => {
    const staleBody = JSON.stringify({
      message:
        'NodeInvalidTypeException: Node backed by fbid 123 has wrong fbtype 6057, expected fbtype 64043',
      status: 'fail',
    });

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('web_profile_info')) {
        return new Response(warmHtml, { status: 200 });
      }
      return new Response(staleBody, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const api = new ThreadsAPI({ transport: 'fetch', fetchImpl, disableCookieJar: true });
    // Avoid network during forced refreshDocIds(true) on stale heal.
    api.refreshDocIds = async () => ({});
    api.warmCookieJar = async () => {};

    await expect(api.getWebProfile('zuck')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ThreadsAPIError);
      const e = err as ThreadsAPIError;
      expect(e.upstream).toBe('stale_identifier');
      expect(e.status).toBe(400);
      expect(e.message).not.toMatch(/blocked|residential proxy|Coolify|Raspberry Pi/i);
      expect(e.message).toMatch(/stale identifier/i);
      return true;
    });
  });

  it('calls refreshDocIds(true) once then retries after NodeInvalidTypeException', async () => {
    const staleBody = JSON.stringify({
      message:
        'NodeInvalidTypeException: Node backed by fbid 123 has wrong fbtype 6057, expected fbtype 64043',
      status: 'fail',
    });
    let profileHits = 0;
    let refreshCalls = 0;

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('web_profile_info')) {
        return new Response(warmHtml, { status: 200 });
      }
      profileHits += 1;
      if (profileHits === 1) {
        return new Response(staleBody, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { user: okUser } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const api = new ThreadsAPI({ transport: 'fetch', fetchImpl, disableCookieJar: true });
    api.warmCookieJar = async () => {};
    api.refreshDocIds = async (force = false) => {
      expect(force).toBe(true);
      refreshCalls += 1;
      return { BarcelonaProfilePageQuery: '999' };
    };

    const user = await api.getWebProfile('zuck');
    expect(user.id).toBe('314216');
    expect(refreshCalls).toBe(1);
    expect(profileHits).toBeGreaterThanOrEqual(2);
  });

  it('sends x-csrftoken from memory cookies on web_profile_info', async () => {
    let seenCsrf: string | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('web_profile_info')) {
        return new Response(warmHtml, { status: 200 });
      }
      seenCsrf = headerGet(init?.headers, 'x-csrftoken');
      return new Response(JSON.stringify({ data: { user: okUser } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const api = new ThreadsAPI({ transport: 'fetch', fetchImpl, disableCookieJar: true });
    api.warmCookieJar = async () => {
      api.cookie = 'csrftoken=abc123; mid=midval';
    };

    await api.getWebProfile('zuck');
    expect(seenCsrf).toBe('abc123');
  });
});

describe('cookie jar path defaults', () => {
  it('defaults cookieJarPath to .xy-cookies.txt', () => {
    const prev = process.env.XY_COOKIE_JAR;
    delete process.env.XY_COOKIE_JAR;
    const api = new ThreadsAPI({ transport: 'fetch', fetchImpl: fetch, disableCookieJar: false });
    expect(api.cookieJarPath).toBe('.xy-cookies.txt');
    if (prev === undefined) delete process.env.XY_COOKIE_JAR;
    else process.env.XY_COOKIE_JAR = prev;
  });

  it('honors XY_COOKIE_JAR and disableCookieJar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xy-jar-'));
    const jar = join(dir, 'cookies.txt');
    const api = new ThreadsAPI({
      transport: 'fetch',
      fetchImpl: fetch,
      cookieJarPath: jar,
    });
    expect(api.cookieJarPath).toBe(jar);

    const disabled = new ThreadsAPI({
      transport: 'fetch',
      fetchImpl: fetch,
      disableCookieJar: true,
    });
    expect(disabled.cookieJarPath).toBe('');
  });

  it('seeds memory cookies from an existing Netscape jar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xy-jar-'));
    const jar = join(dir, 'cookies.txt');
    writeFileSync(
      jar,
      [
        '# Netscape HTTP Cookie File',
        '.threads.net\tTRUE\t/\tTRUE\t0\tcsrftoken\tseededcsrf',
        '.threads.net\tTRUE\t/\tTRUE\t0\tmid\tseededmid',
      ].join('\n'),
    );
    const api = new ThreadsAPI({
      transport: 'fetch',
      fetchImpl: fetch,
      cookieJarPath: jar,
    });
    expect(api.cookie).toMatch(/csrftoken=seededcsrf/);
    expect(api.cookie).toMatch(/mid=seededmid/);
    const diag = api.getDiagnostics();
    expect(diag.has_cookies).toBe(true);
    expect(diag.cookie_jar).toMatchObject({
      exists: true,
      has_csrftoken: true,
      has_mid: true,
    });
  });
});
