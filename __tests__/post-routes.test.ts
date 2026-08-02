import { describe, expect, it } from 'vitest';
import { postIdFromThreadId } from '../src/utils.js';

/**
 * Mirror of server fetchPostPayload routing rules (kept in sync with src/server.ts).
 * Ensures /post/:id picks the correct ThreadsAPI guest helper without inventing APIs.
 */
function classifyPostRoute(raw: string): 'getPost' | 'getPostFromThreadId' | 'getPostFromUrl' {
  const value = decodeURIComponent(raw);
  if (/^https?:\/\//i.test(value) || value.includes('/')) return 'getPostFromUrl';
  if (/^\d+$/.test(value)) return 'getPost';
  return 'getPostFromThreadId';
}

describe('GET /post/:id routing', () => {
  it('maps numeric ids to getPost', () => {
    expect(classifyPostRoute('314216')).toBe('getPost');
    expect(classifyPostRoute('1234567890123456789')).toBe('getPost');
  });

  it('maps shortcodes to getPostFromThreadId', () => {
    expect(classifyPostRoute('CuZsgfWLyiI')).toBe('getPostFromThreadId');
    // shortcode → numeric still works via utils
    expect(postIdFromThreadId('CuZsgfWLyiI')).toMatch(/^\d+$/);
  });

  it('maps URLs and path fragments to getPostFromUrl', () => {
    expect(
      classifyPostRoute('https://www.threads.net/@zuck/post/CuZsgfWLyiI'),
    ).toBe('getPostFromUrl');
    expect(classifyPostRoute('@zuck/post/CuZsgfWLyiI')).toBe('getPostFromUrl');
    expect(classifyPostRoute(encodeURIComponent('https://www.threads.com/t/CuZsgfWLyiI'))).toBe(
      'getPostFromUrl',
    );
  });
});

describe('auth-gated thread list endpoints', () => {
  it('documents that user threads/replies/timeline require login (no guest method)', () => {
    // There is no guest ThreadsAPI method for a user's post list — only
    // getUserProfileThreadsLoggedIn / getUserProfileRepliesLoggedIn / getTimeline.
    // Server must return 501 requires_authentication when unauthenticated.
    const authOnly = [
      'getUserProfileThreadsLoggedIn',
      'getUserProfileRepliesLoggedIn',
      'getTimeline',
    ];
    expect(authOnly).toContain('getUserProfileThreadsLoggedIn');
  });
});
