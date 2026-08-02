/**
 * Discover current Threads GraphQL doc_ids from live JS bundles.
 *
 *   npm run discover-doc-ids
 */
import { writeFileSync } from 'node:fs';
import { DocIdRegistry } from '../src/doc-id-discovery.js';

async function main() {
  const registry = new DocIdRegistry({
    verbose: true,
    cachePath: '.xy-doc-ids.json',
  });
  const map = await registry.refresh();
  writeFileSync('discovered-doc-ids.latest.json', JSON.stringify(map, null, 2));
  console.log(`Wrote ${Object.keys(map).length} operations → discovered-doc-ids.latest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
