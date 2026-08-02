import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { curlRequest } from '../src/curl-transport.js';
import {
  cookieHeaderFromJarMap,
  cookieJarDiagnostics,
  getCookieValueFromHeader,
  parseNetscapeCookieJar,
  readCookieJarFile,
} from '../src/utils.js';

describe('Netscape cookie jar helpers', () => {
  it('parses Netscape jar lines into name/value map', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '# https://curl.se/docs/http-cookies.html',
      '.threads.net\tTRUE\t/\tTRUE\t1999999999\tcsrftoken\tabc',
      '.threads.net\tTRUE\t/\tTRUE\t1999999999\tmid\tMID123',
      '.instagram.com\tTRUE\t/\tTRUE\t0\tig_did\tDID-1',
    ].join('\n');
    const map = parseNetscapeCookieJar(text);
    expect(map.get('csrftoken')).toBe('abc');
    expect(map.get('mid')).toBe('MID123');
    expect(map.get('ig_did')).toBe('DID-1');
    expect(cookieHeaderFromJarMap(map)).toContain('csrftoken=abc');
  });

  it('reads jar files and reports safe diagnostics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xy-jar-'));
    const jar = join(dir, 'c.txt');
    expect(readCookieJarFile(jar).size).toBe(0);
    writeFileSync(
      jar,
      '.threads.net\tTRUE\t/\tTRUE\t0\tcsrftoken\tx\n.threads.net\tTRUE\t/\tTRUE\t0\tmid\ty\n',
    );
    const map = readCookieJarFile(jar);
    expect(map.get('csrftoken')).toBe('x');
    const diag = cookieJarDiagnostics(jar);
    expect(diag.exists).toBe(true);
    expect(diag.has_csrftoken).toBe(true);
    expect(diag.has_mid).toBe(true);
    expect(diag.cookie_names).toEqual(['csrftoken', 'mid']);
    expect(JSON.stringify(diag)).not.toMatch(/csrftoken=x/);
  });

  it('extracts cookie values from Cookie header strings', () => {
    expect(getCookieValueFromHeader('a=1; csrftoken=tok; mid=m', 'csrftoken')).toBe('tok');
    expect(getCookieValueFromHeader('a=1', 'csrftoken')).toBeUndefined();
  });
});

describe('curl cookie jar live warm', () => {
  it(
    'GET threads.net with --cookie-jar captures session cookies',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'xy-live-jar-'));
      const jar = join(dir, 'cookies.txt');
      const res = await curlRequest('https://www.threads.net/', {
        cookieJarPath: jar,
        headers: { accept: 'text/html,application/xhtml+xml' },
        timeoutSec: 25,
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(existsSync(jar)).toBe(true);
      const body = readFileSync(jar, 'utf8');
      // Meta typically sets at least one of these on the HTML bootstrap.
      const hasSession =
        /\t(csrftoken|mid|ig_did|datr|ig_nrcb)\t/.test(body) ||
        Boolean(res.headers['set-cookie']);
      expect(hasSession).toBe(true);

      // Reuse jar on web_profile_info — still works from this US VM.
      const csrf = readCookieJarFile(jar).get('csrftoken');
      const profile = await curlRequest(
        'https://www.threads.net/api/v1/users/web_profile_info/?username=zuck',
        {
          cookieJarPath: jar,
          headers: {
            accept: '*/*',
            'x-ig-app-id': '238260118697367',
            ...(csrf ? { 'x-csrftoken': csrf } : {}),
          },
          timeoutSec: 25,
        },
      );
      expect(profile.status).toBe(200);
      const json = JSON.parse(profile.body);
      expect(json?.data?.user?.id).toBe('314216');
      expect(String(profile.body)).not.toMatch(/NodeInvalidTypeException/);
    },
    60_000,
  );
});
