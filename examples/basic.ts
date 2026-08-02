/**
 * Basic guest usage — no Instagram login required.
 *
 *   npx tsx examples/basic.ts
 */
import { ThreadsAPI } from '../src/index.js';

async function main() {
  const api = new ThreadsAPI({
    verbose: true,
    docIdCachePath: '.xy-doc-ids.json',
  });

  // One ensureLsd via getUserProfile — avoid double HTML fetches (rate limits).
  console.log('— public profile (@zuck) —');
  const profile = await api.getUserProfile('zuck');
  console.log({
    id: profile.id,
    username: profile.username,
    full_name: profile.full_name,
    followers: profile.follower_count,
    bio: profile.biography,
  });

  console.log('— resolve user id —');
  const userId = await api.getUserIdFromUsername('zuck');
  console.log({ userId });

  console.log('— discover GraphQL doc_ids (QuaX-style) —');
  const docIds = await api.refreshDocIds(true);
  const interesting = Object.fromEntries(
    Object.entries(docIds)
      .filter(([k]) => /Profile|Post|Feed|Search|User|Follow|Like/i.test(k))
      .slice(0, 40),
  );
  console.log(interesting);

  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
