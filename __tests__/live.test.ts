import { describe, expect, it } from 'vitest';
import { ThreadsAPI } from '../src/index.js';

const LIVE = process.env.XY_LIVE_TESTS === '1';

describe.runIf(LIVE)('live Threads guest API', () => {
  it('fetches @zuck web profile', async () => {
    const api = new ThreadsAPI({ verbose: true });
    const profile = await api.getUserProfile('zuck');
    expect(profile.username).toBe('zuck');
    expect(String(profile.pk || profile.id)).toBe('314216');
    expect(profile.follower_count).toBeGreaterThan(1_000_000);
  });

  it('resolves user id', async () => {
    const api = new ThreadsAPI();
    const id = await api.getUserIdFromUsername('zuck');
    expect(id).toBe('314216');
  });

  it('discovers doc ids from JS bundles', async () => {
    const api = new ThreadsAPI({ verbose: true, docIdCachePath: '.xy-doc-ids.test.json' });
    const map = await api.refreshDocIds(true);
    expect(Object.keys(map).length).toBeGreaterThan(10);
  });
});

describe('ThreadsAPI unit', () => {
  it('constructs with defaults', () => {
    const api = new ThreadsAPI();
    expect(api.deviceId.startsWith('android-')).toBe(true);
    expect(api.docIds.get('BarcelonaPostPageDirectQuery')).toBeTruthy();
  });
});
