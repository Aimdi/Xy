import { describe, expect, it } from 'vitest';
import {
  extractDocIdsFromJs,
  extractLsdToken,
  postIdFromThreadId,
  threadIdFromPostId,
  postIdFromUrl,
} from '../src/index.js';

describe('id conversion', () => {
  it('round-trips shortcode ↔ post id', () => {
    const shortcode = 'CuZsgfWLyiI';
    const postId = postIdFromThreadId(shortcode);
    expect(postId).toMatch(/^\d+$/);
    expect(threadIdFromPostId(postId)).toBe(shortcode);
  });

  it('extracts post id from URL', () => {
    const id = postIdFromUrl('https://www.threads.net/@zuck/post/CuZsgfWLyiI');
    // /t/ form
    const id2 = postIdFromUrl('https://www.threads.net/t/CuZsgfWLyiI');
    expect(id2).toBe(postIdFromThreadId('CuZsgfWLyiI'));
    // first URL may not match /t/ — ensure /t/ works
    expect(id2).toMatch(/^\d+$/);
    expect(id).toMatch(/^\d+$/);
  });
});

describe('extractLsdToken', () => {
  it('parses LSD from HTML bootstrap', () => {
    const html = `xyz["LSD",[],{"token":"AdTestToken123"},100]abc`;
    expect(extractLsdToken(html)).toBe('AdTestToken123');
  });
});

describe('extractDocIdsFromJs', () => {
  it('parses threadsRelayOperation exports', () => {
    const js = `__d("BarcelonaPostPageDirectQuery_threadsRelayOperation",[],(function(t,n,r,o,a,i){a.exports="27871919269164889"}),null);`;
    const map = extractDocIdsFromJs(js);
    expect(map.BarcelonaPostPageDirectQuery_threadsRelayOperation).toBe('27871919269164889');
    expect(map.BarcelonaPostPageDirectQuery).toBe('27871919269164889');
  });

  it('parses Relay params blocks', () => {
    const js = `var e={params:{id:"27156446060700407",metadata:{},name:"BarcelonaUserDialogByUsernameQuery",operationKind:"query",text:null}};`;
    const map = extractDocIdsFromJs(js);
    expect(map.BarcelonaUserDialogByUsernameQuery).toBe('27156446060700407');
  });
});
