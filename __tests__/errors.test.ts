import { describe, expect, it } from 'vitest';
import {
  bodyPreview,
  classifyUpstreamBody,
  httpStatusForThreadsError,
  looksLikeStaleIdentifier,
  ThreadsAPIError,
} from '../src/errors.js';

describe('classifyUpstreamBody', () => {
  it('detects rate limits', () => {
    expect(classifyUpstreamBody(429, '')).toBe('rate_limited');
    expect(classifyUpstreamBody(429, '{}')).toBe('rate_limited');
  });

  it('detects empty bodies', () => {
    expect(classifyUpstreamBody(200, '')).toBe('empty_body');
    expect(classifyUpstreamBody(200, '   ')).toBe('empty_body');
  });

  it('detects HTML challenges', () => {
    expect(classifyUpstreamBody(200, '<!DOCTYPE html><html>')).toBe('html_challenge');
    expect(classifyUpstreamBody(200, '<html><title>Sorry</title></html>')).toBe(
      'html_challenge',
    );
  });

  it('detects non-JSON text', () => {
    expect(classifyUpstreamBody(200, 'not json at all')).toBe('non_json');
  });

  it('returns unknown for JSON-looking bodies', () => {
    expect(classifyUpstreamBody(200, '{"data":null}')).toBe('unknown');
  });

  it('detects NodeInvalidTypeException / fbtype mismatch as stale_identifier', () => {
    const msg =
      'NodeInvalidTypeException: Node backed by fbid 123 has wrong fbtype 6057, expected fbtype 64043';
    expect(classifyUpstreamBody(400, JSON.stringify({ message: msg }))).toBe(
      'stale_identifier',
    );
    expect(classifyUpstreamBody(400, msg)).toBe('stale_identifier');
    expect(
      classifyUpstreamBody(
        200,
        JSON.stringify({ errors: [{ message: 'NodeInvalidType: wrong fbtype' }] }),
      ),
    ).toBe('stale_identifier');
    expect(looksLikeStaleIdentifier(msg)).toBe(true);
    expect(looksLikeStaleIdentifier('{"data":null}')).toBe(false);
  });
});

describe('ThreadsAPIError', () => {
  it('serializes status, upstream, and transport without secrets', () => {
    const err = new ThreadsAPIError(
      'web_profile_info failed for @zuck (HTTP 429, rate_limited)',
      '<html>challenge cookie=SECRET</html>',
      429,
      {
        upstream: 'rate_limited',
        transport: 'curl',
        details: { username: 'zuck', attempt: 2 },
      },
    );

    const json = err.toJSON();
    expect(json.error).toBe('threads_api_error');
    expect(json.status).toBe(429);
    expect(json.upstream).toBe('rate_limited');
    expect(json.transport).toBe('curl');
    expect(json.details).toEqual({ username: 'zuck', attempt: 2 });
    // details present → raw HTML data is omitted from the payload
    expect(json.data_preview).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('SECRET');
    expect(httpStatusForThreadsError(err)).toBe(429);
  });

  it('includes a truncated preview when no details bag is set', () => {
    const err = new ThreadsAPIError('boom', `<html>${'x'.repeat(400)}</html>`, 502, {
      upstream: 'html_challenge',
      transport: 'curl',
    });
    const json = err.toJSON();
    expect(String(json.data_preview).startsWith('<html>')).toBe(true);
    expect(String(json.data_preview).length).toBeLessThan(300);
  });

  it('maps html_challenge to 502 for the local server', () => {
    const err = new ThreadsAPIError('blocked', undefined, 200, {
      upstream: 'html_challenge',
      transport: 'fetch',
    });
    expect(httpStatusForThreadsError(err)).toBe(502);
  });

  it('maps stale_identifier to 502 (not an IP-block 429)', () => {
    const err = new ThreadsAPIError('stale doc', undefined, 400, {
      upstream: 'stale_identifier',
      transport: 'curl',
    });
    expect(httpStatusForThreadsError(err)).toBe(502);
  });
});

describe('bodyPreview', () => {
  it('truncates long text', () => {
    const preview = bodyPreview('a'.repeat(500), 40);
    expect(preview.length).toBeLessThanOrEqual(41);
    expect(preview.endsWith('…')).toBe(true);
  });
});
