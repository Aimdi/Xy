#!/usr/bin/env node
import { Command } from 'commander';
import { ThreadsAPI } from './client.js';
import { postIdFromThreadId, postIdFromUrl, threadIdFromPostId } from './utils.js';

const program = new Command();

program
  .name('xy-threads')
  .description('Unofficial reverse-engineered Threads API CLI (Xy)')
  .option('-v, --verbose', 'verbose logging', false);

program
  .command('profile')
  .argument('<username>', 'Threads username')
  .description('Fetch a public profile via web_profile_info')
  .action(async (username: string, _opts, cmd) => {
    const verbose = cmd.parent?.opts()?.verbose;
    const api = new ThreadsAPI({ verbose });
    const profile = await api.getUserProfile(username);
    console.log(JSON.stringify(profile, null, 2));
  });

program
  .command('user-id')
  .argument('<username>', 'Threads username')
  .description('Resolve username → user id')
  .action(async (username: string, _opts, cmd) => {
    const verbose = cmd.parent?.opts()?.verbose;
    const api = new ThreadsAPI({ verbose });
    const id = await api.getUserIdFromUsername(username);
    console.log(id);
  });

program
  .command('discover-doc-ids')
  .description('Scrape Threads JS bundles and print GraphQL doc_id map')
  .option('-c, --cache <path>', 'cache file path', '.xy-doc-ids.json')
  .action(async (opts, cmd) => {
    const verbose = cmd.parent?.opts()?.verbose ?? true;
    const api = new ThreadsAPI({ verbose, docIdCachePath: opts.cache });
    const map = await api.refreshDocIds(true);
    console.log(JSON.stringify(map, null, 2));
  });

program
  .command('post-id')
  .argument('<shortcode-or-url>', 'Thread shortcode or URL')
  .description('Convert thread shortcode/URL → numeric post id')
  .action((value: string) => {
    const id = value.includes('/') ? postIdFromUrl(value) : postIdFromThreadId(value);
    console.log(id);
  });

program
  .command('thread-id')
  .argument('<postId>', 'Numeric post id')
  .description('Convert numeric post id → thread shortcode')
  .action((postId: string) => {
    console.log(threadIdFromPostId(postId));
  });

program
  .command('search')
  .argument('<query>', 'Search query')
  .description('Search users via GraphQL (guest)')
  .action(async (query: string, _opts, cmd) => {
    const verbose = cmd.parent?.opts()?.verbose;
    const api = new ThreadsAPI({ verbose });
    const res = await api.searchUsers(query);
    console.log(JSON.stringify(res, null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
