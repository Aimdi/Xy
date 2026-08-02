import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_USER_AGENT,
  DOC_ID_CACHE_TTL_MS,
  THREADS_BASE_URL,
} from './constants.js';
import type { DocIdMap } from './types.js';
import seedDocIds from './seed-doc-ids.json';

function loadSeedDocIds(): DocIdMap {
  return { ...(seedDocIds as DocIdMap) };
}

export interface DocIdDiscoveryOptions {
  /** Profile path used to bootstrap HTML + JS bundle URLs. */
  bootstrapPath?: string;
  userAgent?: string;
  cachePath?: string;
  ttlMs?: number;
  verbose?: boolean;
  fetchImpl?: typeof fetch;
}

interface CacheFile {
  updatedAt: number;
  docIds: DocIdMap;
}

/**
 * QuaX-style runtime discovery for Threads GraphQL `doc_id`s.
 *
 * Meta embeds persisted Relay operations in JS bundles as:
 *   __d("BarcelonaFooQuery_threadsRelayOperation",[],(...=>{a.exports="123..."})
 *
 * When Meta rotates these IDs, clients that hardcode them break (same failure mode
 * as X query-id rotation that QuaX heals by scraping frontend bundles).
 */
export class DocIdRegistry {
  private docIds: DocIdMap;
  private readonly options: Required<
    Pick<DocIdDiscoveryOptions, 'bootstrapPath' | 'userAgent' | 'ttlMs' | 'verbose'>
  > &
    DocIdDiscoveryOptions;
  private lastRefresh = 0;

  constructor(options: DocIdDiscoveryOptions = {}) {
    this.options = {
      bootstrapPath: options.bootstrapPath ?? '/@zuck',
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      ttlMs: options.ttlMs ?? DOC_ID_CACHE_TTL_MS,
      verbose: options.verbose ?? false,
      cachePath: options.cachePath,
      fetchImpl: options.fetchImpl,
    };
    this.docIds = { ...loadSeedDocIds(), ...this.readCache()?.docIds };
  }

  get(operation: string): string | undefined {
    return this.docIds[operation];
  }

  getAll(): DocIdMap {
    return { ...this.docIds };
  }

  set(operation: string, docId: string): void {
    this.docIds[operation] = docId;
  }

  isStale(): boolean {
    if (!this.lastRefresh && !this.readCache()) return true;
    const updatedAt = this.lastRefresh || this.readCache()?.updatedAt || 0;
    return Date.now() - updatedAt > this.options.ttlMs;
  }

  async ensureFresh(force = false): Promise<DocIdMap> {
    if (!force && !this.isStale() && Object.keys(this.docIds).length > 0) {
      return this.getAll();
    }
    return this.refresh();
  }

  async refresh(): Promise<DocIdMap> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `${THREADS_BASE_URL}${this.options.bootstrapPath}`;
    if (this.options.verbose) console.debug('[doc-ids] bootstrapping', url);

    const htmlRes = await fetchImpl(url, {
      headers: {
        'user-agent': this.options.userAgent,
        accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = await htmlRes.text();
    const jsUrls = extractJsUrls(html);
    if (this.options.verbose) console.debug('[doc-ids] js bundles', jsUrls.length);

    const discovered: DocIdMap = {};
    // Cap concurrency to be polite
    const queue = [...jsUrls];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length) {
        const jsUrl = queue.shift();
        if (!jsUrl) break;
        try {
          const res = await fetchImpl(jsUrl, {
            headers: { 'user-agent': this.options.userAgent },
          });
          if (!res.ok) continue;
          const body = await res.text();
          Object.assign(discovered, extractDocIdsFromJs(body));
        } catch {
          // ignore individual bundle failures
        }
      }
    });
    await Promise.all(workers);

    // Prefer freshly discovered IDs, keep seeds/cache as fallbacks
    this.docIds = { ...this.docIds, ...discovered };
    this.lastRefresh = Date.now();
    this.writeCache({ updatedAt: this.lastRefresh, docIds: this.docIds });

    if (this.options.verbose) {
      console.debug('[doc-ids] discovered', Object.keys(discovered).length, 'total', Object.keys(this.docIds).length);
    }
    return this.getAll();
  }

  private readCache(): CacheFile | undefined {
    const path = this.options.cachePath;
    if (!path || !existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
    } catch {
      return undefined;
    }
  }

  private writeCache(cache: CacheFile): void {
    const path = this.options.cachePath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  }
}

export function extractJsUrls(html: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /src="(https:\/\/static\.cdninstagram\.com\/[^"]+)"/g,
    /"(https:\/\/static\.cdninstagram\.com\/rsrc\.php\/[^"]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = match[1];
      if (url.includes('rsrc.php') || url.endsWith('.js')) urls.add(url);
    }
  }

  // Also pull rsrcMap entries from Bootloader JSON blobs
  for (const match of html.matchAll(/"src":"(https:\\\/\\\/static\.cdninstagram\.com[^"]+)"/g)) {
    urls.add(match[1].replace(/\\\//g, '/'));
  }
  for (const match of html.matchAll(/"src":"(\/\/static\.cdninstagram\.com[^"]+)"/g)) {
    urls.add(`https:${match[1].replace(/\\\//g, '/')}`);
  }

  return [...urls];
}

/**
 * Extract operation → doc_id mappings from a Threads/Instagram JS bundle.
 */
export function extractDocIdsFromJs(js: string): DocIdMap {
  const out: DocIdMap = {};

  // Primary: __d("Name_threadsRelayOperation",[],(...=>{a.exports="DOCID"})
  const relayOp =
    /__d\("([^"]+_threadsRelayOperation)"[^)]*\)\{a\.exports="(\d+)"\}/g;
  for (const match of js.matchAll(relayOp)) {
    const full = match[1];
    const docId = match[2];
    out[full] = docId;
    const friendly = full.replace(/_threadsRelayOperation$/, '');
    out[friendly] = docId;
    // normalize useFoo → Foo when applicable
    if (friendly.startsWith('use')) {
      out[friendly.slice(3)] = docId;
    }
  }

  // Secondary: Relay params:{id:"...",metadata:{},name:"...",operationKind:"query"}
  const params =
    /\{id:"(\d{10,})",metadata:\{[^}]{0,200}\},name:"([^"]+)",operationKind:"(query|mutation|subscription)"/g;
  for (const match of js.matchAll(params)) {
    out[match[2]] = match[1];
  }

  return out;
}

export function resolveOperationDocId(
  registry: DocIdRegistry,
  operation: string,
  aliases: string[] = [],
): string | undefined {
  for (const name of [operation, ...aliases]) {
    const hit = registry.get(name) || registry.get(`${name}_threadsRelayOperation`);
    if (hit) return hit;
  }
  return undefined;
}
