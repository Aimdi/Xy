import {
  ANDROID_IG_APP_ID,
  BARCELONA_USER_AGENT,
  BLOKS_VERSION,
  DEFAULT_ASBD_ID,
  DEFAULT_LSD_TOKEN,
  DEFAULT_USER_AGENT,
  INSTAGRAM_API_URL,
  THREADS_BASE_URL,
  THREADS_GRAPHQL_URL,
  THREADS_WWW_URL,
  WEB_IG_APP_ID,
  WEB_PROFILE_HOSTS,
} from './constants.js';
import {
  bodyPreview,
  classifyUpstreamBody,
  DocIdNotFoundError,
  looksLikeStaleIdentifier,
  ThreadsAPIError,
  type TransportKind,
} from './errors.js';
import {
  DocIdRegistry,
  resolveOperationDocId,
  type DocIdDiscoveryOptions,
} from './doc-id-discovery.js';
import { createCurlFetch, curlRequest } from './curl-transport.js';
import type {
  DocIdMap,
  GraphQLResponse,
  Thread,
  ThreadsUser,
  WebProfileUser,
} from './types.js';
import {
  extractLsdToken,
  generateDeviceId,
  mergeCookies,
  parseSetCookie,
  postIdFromThreadId,
  postIdFromUrl,
  signPayload,
  threadIdFromPostId,
} from './utils.js';

export type HttpTransport = 'fetch' | 'curl' | 'auto';

export interface ThreadsAPIOptions {
  /** Instagram/Threads username for authenticated calls. */
  username?: string;
  /** Instagram/Threads password for authenticated calls. */
  password?: string;
  /** Existing authorization token (`Bearer IGT:2:...`). */
  token?: string;
  /** Device id (`android-...`). Persist this across sessions. */
  deviceId?: string;
  /** Pre-set user id. */
  userId?: string;
  /** Override LSD token (otherwise fetched automatically). */
  fbLsdToken?: string;
  /** Whether to auto-update LSD from HTML responses. */
  noUpdateLsd?: boolean;
  verbose?: boolean;
  userAgent?: string;
  locale?: string;
  /** Path for persistent doc_id cache (QuaX-style). */
  docIdCachePath?: string;
  /** Seed/override doc ids. */
  docIds?: DocIdMap;
  fetchImpl?: typeof fetch;
  /**
   * HTTP transport.
   * - `curl` (default): system curl — Meta often 429s Node/undici TLS fingerprints
   * - `fetch`: native fetch / undici
   * - `auto`: try fetch, fall back to curl on empty 429
   */
  transport?: HttpTransport;
}

export class ThreadsAPI {
  username?: string;
  password?: string;
  token?: string;
  deviceId: string;
  userId?: string;
  fbLsdToken: string;
  noUpdateLsd: boolean;
  verbose: boolean;
  userAgent: string;
  locale: string;
  cookie = '';

  readonly docIds: DocIdRegistry;
  private readonly fetchImpl: typeof fetch;
  /** Configured transport mode (`curl` | `fetch` | `auto`). */
  readonly transport: HttpTransport;
  /** Last concrete transport that actually ran a request. */
  private lastTransportUsed: TransportKind;

  constructor(options: ThreadsAPIOptions = {}) {
    this.username = options.username ?? process.env.THREADS_USERNAME;
    this.password = options.password ?? process.env.THREADS_PASSWORD;
    this.token = options.token ?? process.env.THREADS_TOKEN;
    this.deviceId =
      options.deviceId ?? process.env.THREADS_DEVICE_ID ?? generateDeviceId();
    this.userId = options.userId ?? process.env.THREADS_USER_ID;
    this.fbLsdToken = options.fbLsdToken ?? DEFAULT_LSD_TOKEN;
    this.noUpdateLsd = options.noUpdateLsd ?? false;
    this.verbose = options.verbose ?? false;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.locale = options.locale ?? 'en-US';
    this.transport = options.transport ?? 'curl';
    this.lastTransportUsed = this.transport === 'fetch' ? 'fetch' : 'curl';
    this.fetchImpl =
      options.fetchImpl ??
      (this.transport === 'fetch' ? fetch : createCurlFetch(this.userAgent));

    const discoveryOptions: DocIdDiscoveryOptions = {
      verbose: this.verbose,
      userAgent: this.userAgent,
      cachePath: options.docIdCachePath,
      fetchImpl: this.fetchImpl,
    };
    this.docIds = new DocIdRegistry(discoveryOptions);
    if (options.docIds) {
      for (const [k, v] of Object.entries(options.docIds)) this.docIds.set(k, v);
    }
  }

  /**
   * Safe runtime diagnostics for /health and /debug/ping.
   * Never includes LSD token, cookies, passwords, or auth headers.
   */
  getDiagnostics(): {
    transport: HttpTransport;
    last_transport: TransportKind;
    lsd_present: boolean;
    lsd_is_default: boolean;
    has_cookies: boolean;
    authenticated: boolean;
  } {
    const lsdIsDefault = !this.fbLsdToken || this.fbLsdToken === DEFAULT_LSD_TOKEN;
    return {
      transport: this.transport,
      last_transport: this.lastTransportUsed,
      lsd_present: Boolean(this.fbLsdToken),
      lsd_is_default: lsdIsDefault,
      has_cookies: Boolean(this.cookie && this.cookie.length > 0),
      authenticated: Boolean(this.token),
    };
  }

  // ---------------------------------------------------------------------------
  // Low-level HTTP
  // ---------------------------------------------------------------------------

  private async rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', this.userAgent);
    if (this.cookie && !headers.has('cookie')) headers.set('cookie', this.cookie);

    if (this.transport === 'curl') {
      return this.rawCurl(url, init, headers);
    }

    this.lastTransportUsed = 'fetch';
    const res = await this.fetchImpl(url, { ...init, headers });
    this.captureCookiesFromFetch(res);

    if (this.transport === 'auto' && res.status === 429) {
      const peek = await res.clone().text();
      if (!peek) {
        if (this.verbose) console.debug('[http] fetch 429 — falling back to curl');
        return this.rawCurl(url, init, headers);
      }
    }

    return res;
  }

  private async rawCurl(url: string, init: RequestInit, headers: Headers): Promise<Response> {
    this.lastTransportUsed = 'curl';
    const headerObj: Record<string, string> = {};
    headers.forEach((v, k) => {
      headerObj[k] = v;
    });
    // Prefer a single Cookie header via curlRequest's `cookie` option (avoids duplicates).
    const cookie = this.cookie || headerObj.cookie || undefined;
    delete headerObj.cookie;

    const method = (init.method ?? 'GET').toUpperCase();
    let body: string | undefined;
    if (init.body != null) {
      body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    }
    const curlRes = await curlRequest(url, {
      method,
      headers: headerObj,
      body,
      userAgent: this.userAgent,
      cookie,
    });
    if (curlRes.headers['set-cookie']) {
      const parts = curlRes.headers['set-cookie'].split('\n').filter(Boolean);
      this.cookie = mergeCookies(this.cookie, parseSetCookie(parts));
    }
    // Response headers cannot contain raw Set-Cookie multi-values with newlines;
    // status 0 would throw in `new Response` — clamp to a valid gateway error.
    const status =
      curlRes.status >= 200 && curlRes.status <= 599 ? curlRes.status : 502;
    const safeHeaders: Record<string, string> = { ...curlRes.headers };
    delete safeHeaders['set-cookie'];
    if (curlRes.httpVersion) safeHeaders['x-xy-http-version'] = curlRes.httpVersion;
    return new Response(curlRes.body, {
      status,
      headers: safeHeaders,
    });
  }

  private captureCookiesFromFetch(res: Response): void {
    const setCookie =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')!]
          : [];
    if (setCookie.length) {
      this.cookie = mergeCookies(this.cookie, parseSetCookie(setCookie));
    }
  }

  private webHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: '*/*',
      'accept-language': `${this.locale},${this.locale.split('-')[0]};q=0.9`,
      'content-type': 'application/x-www-form-urlencoded',
      origin: THREADS_WWW_URL,
      referer: `${THREADS_WWW_URL}/`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'x-asbd-id': DEFAULT_ASBD_ID,
      'x-fb-lsd': this.fbLsdToken,
      'x-ig-app-id': WEB_IG_APP_ID,
      ...extra,
    };
  }

  private androidHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'user-agent': BARCELONA_USER_AGENT,
      'x-ig-app-id': ANDROID_IG_APP_ID,
      'x-ig-device-id': this.deviceId,
      'x-ig-android-id': this.deviceId,
      'x-bloks-version-id': BLOKS_VERSION,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(this.token ? { authorization: this.token } : {}),
      ...extra,
    };
  }

  // ---------------------------------------------------------------------------
  // Session / tokens
  // ---------------------------------------------------------------------------

  /** Fetch a fresh LSD token (and cookies) from threads.com. */
  async refreshLsd(username = 'zuck'): Promise<string> {
    const res = await this.rawFetch(`${THREADS_WWW_URL}/@${username}`, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': this.userAgent,
      },
    });
    const html = await res.text();
    const token = extractLsdToken(html);
    if (!token) {
      const upstream = classifyUpstreamBody(res.status, html);
      throw new ThreadsAPIError(
        'Failed to extract LSD token from Threads HTML',
        bodyPreview(html, 500),
        res.status,
        {
          upstream: upstream === 'unknown' ? 'html_challenge' : upstream,
          transport: this.lastTransportUsed,
          details: { endpoint: 'threads_html' },
        },
      );
    }
    if (!this.noUpdateLsd) this.fbLsdToken = token;
    if (this.verbose) console.debug('[lsd] refreshed');
    return token;
  }

  async ensureLsd(): Promise<string> {
    if (this.fbLsdToken && this.fbLsdToken !== DEFAULT_LSD_TOKEN && this.cookie) {
      return this.fbLsdToken;
    }
    return this.refreshLsd();
  }

  /** Refresh GraphQL doc_ids by scraping Threads JS bundles (QuaX-style). */
  async refreshDocIds(force = false): Promise<DocIdMap> {
    return this.docIds.ensureFresh(force);
  }

  // ---------------------------------------------------------------------------
  // GraphQL
  // ---------------------------------------------------------------------------

  async graphql<T = unknown>(
    operationName: string,
    variables: Record<string, unknown>,
    options: { docId?: string; aliases?: string[]; retryOnStaleDocId?: boolean } = {},
  ): Promise<GraphQLResponse<T>> {
    await this.ensureLsd();
    await this.refreshDocIds();

    const docId =
      options.docId ??
      resolveOperationDocId(this.docIds, operationName, options.aliases ?? []);
    if (!docId) throw new DocIdNotFoundError(operationName);

    const body = new URLSearchParams({
      lsd: this.fbLsdToken,
      variables: JSON.stringify(variables),
      doc_id: docId,
      fb_api_req_friendly_name: operationName,
      server_timestamps: 'true',
    });

    const res = await this.rawFetch(THREADS_GRAPHQL_URL, {
      method: 'POST',
      headers: this.webHeaders({
        'x-fb-friendly-name': operationName,
      }),
      body,
    });

    const text = await res.text();
    if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
      throw new ThreadsAPIError(
        `GraphQL returned HTML (likely rate-limited or challenged). HTTP ${res.status}`,
        bodyPreview(text, 300),
        res.status,
        {
          upstream: classifyUpstreamBody(res.status, text),
          transport: this.lastTransportUsed,
          details: { operation: operationName },
        },
      );
    }

    let json: GraphQLResponse<T>;
    try {
      json = JSON.parse(text) as GraphQLResponse<T>;
    } catch {
      const upstream = classifyUpstreamBody(res.status, text);
      // HTTP 400 NodeInvalidTypeException bodies are usually JSON, but still
      // self-heal if the raw text matches before giving up on parse.
      if (options.retryOnStaleDocId !== false && upstream === 'stale_identifier') {
        if (this.verbose) {
          console.debug('[graphql] stale identifier in non-JSON body, refreshing doc_ids…');
        }
        await this.refreshDocIds(true);
        return this.graphql(operationName, variables, {
          ...options,
          retryOnStaleDocId: false,
        });
      }
      throw new ThreadsAPIError(
        `Failed to parse GraphQL JSON (HTTP ${res.status})`,
        bodyPreview(text, 300),
        res.status,
        {
          upstream: upstream === 'unknown' ? 'parse_error' : upstream,
          transport: this.lastTransportUsed,
          details: { operation: operationName },
        },
      );
    }

    // Self-heal: Meta rotated doc_id, or NodeInvalidTypeException / fbtype mismatch
    // (stale persisted operation / wrong node type — not an IP block).
    const upstreamHint = classifyUpstreamBody(res.status, text);
    const errorMessages = (json.errors ?? []).map((e) => e.message ?? '').join('\n');
    const jsonMessage =
      typeof (json as { message?: unknown }).message === 'string'
        ? ((json as { message: string }).message)
        : '';
    const staleIdentifier =
      upstreamHint === 'stale_identifier' ||
      looksLikeStaleIdentifier(text) ||
      looksLikeStaleIdentifier(errorMessages) ||
      looksLikeStaleIdentifier(jsonMessage);
    const staleDocId = json.errors?.some((e) =>
      /not found|unknown|doc_id|persisted/i.test(e.message ?? ''),
    );
    const shouldRefreshDocIds =
      options.retryOnStaleDocId !== false && (staleIdentifier || Boolean(staleDocId));

    if (shouldRefreshDocIds) {
      if (this.verbose) {
        console.debug(
          staleIdentifier
            ? '[graphql] stale identifier / fbtype mismatch, refreshing doc_ids…'
            : '[graphql] stale doc_id, refreshing…',
        );
      }
      await this.refreshDocIds(true);
      return this.graphql(operationName, variables, {
        ...options,
        retryOnStaleDocId: false,
      });
    }

    return json;
  }

  // ---------------------------------------------------------------------------
  // Public / guest helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a username → Instagram/web_profile user id (e.g. zuck → 314216).
   * Uses multi-host web_profile_info. HTML no longer embeds user_id for guests.
   */
  async getUserIdFromUsername(username: string): Promise<string> {
    const profile = await this.getWebProfile(username);
    return String(profile.id);
  }

  /**
   * Public Instagram/Threads web profile info (REST-only guest path).
   *
   * ONLY calls `GET {host}/api/v1/users/web_profile_info/?username=` with
   * `x-ig-app-id: 238260118697367`. Never POSTs to `/api/graphql` and never
   * uses a GraphQL `doc_id` — guest profile reads stay on this REST endpoint.
   *
   * Tries multiple hosts — Meta edge often 429s one host while others still work.
   * Requires HTTP/2 curl transport on many networks (HTTP/1.1 → empty 429).
   */
  async getWebProfile(username: string): Promise<WebProfileUser> {
    let lastError: ThreadsAPIError | undefined;
    /** One forced refreshDocIds + retry when Meta returns NodeInvalidType / fbtype mismatch. */
    let didStaleRefresh = false;
    /** Skip backoff once after a stale-identifier heal (immediate retry). */
    let skipBackoffOnce = false;

    for (const host of WEB_PROFILE_HOSTS) {
      const url = `${host}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
      const origin = host.includes('instagram.com') && !host.startsWith('https://i.')
        ? host
        : host.startsWith('https://i.')
          ? INSTAGRAM_API_URL
          : host.includes('threads.com')
            ? THREADS_WWW_URL
            : THREADS_BASE_URL;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          if (skipBackoffOnce) {
            skipBackoffOnce = false;
          } else {
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }

        let res: Response;
        try {
          res = await this.rawFetch(url, {
            headers: {
              accept: '*/*',
              'user-agent': this.userAgent,
              'x-ig-app-id': WEB_IG_APP_ID,
              'x-asbd-id': DEFAULT_ASBD_ID,
              referer: `${origin}/`,
              origin,
            },
          });
        } catch (err) {
          lastError = new ThreadsAPIError(
            err instanceof Error ? err.message : String(err),
            undefined,
            undefined,
            {
              upstream: 'unknown',
              transport: this.lastTransportUsed,
              details: { username, host, attempt: attempt + 1 },
            },
          );
          // curl missing HTTP/2 — don't keep hammering
          if (/HTTP\/2|nghttp2/i.test(lastError.message)) break;
          continue;
        }

        const text = await res.text();
        const transport = this.lastTransportUsed;
        const upstream = classifyUpstreamBody(res.status, text);
        const curlHint = res.headers.get('x-xy-curl-hint') ?? undefined;
        const httpVersion = res.headers.get('x-xy-http-version') ?? undefined;
        const retryable =
          res.status === 429 ||
          upstream === 'rate_limited' ||
          upstream === 'empty_body' ||
          upstream === 'html_challenge' ||
          upstream === 'non_json';

        if (retryable) {
          lastError = new ThreadsAPIError(
            curlHint
              ? `web_profile_info failed for @${username} on ${host} (HTTP ${res.status}, ${upstream}): ${curlHint}`
              : `web_profile_info failed for @${username} on ${host} (HTTP ${res.status}, ${upstream})`,
            bodyPreview(text, 300),
            res.status,
            {
              upstream,
              transport,
              details: {
                username,
                host,
                attempt: attempt + 1,
                body_len: text.length,
                http_version: httpVersion,
                curl_hint: curlHint,
              },
            },
          );
          // Empty HTTP/1.1 429 won't recover on same host/transport
          if (curlHint) break;
          continue;
        }

        let json: {
          data?: { user?: WebProfileUser };
          message?: string;
          status?: string;
        };
        try {
          json = JSON.parse(text);
        } catch {
          lastError = new ThreadsAPIError(
            `web_profile_info returned unparseable body for @${username} on ${host}`,
            bodyPreview(text, 300),
            res.status,
            {
              upstream: 'parse_error',
              transport,
              details: { username, host, attempt: attempt + 1, body_len: text.length },
            },
          );
          continue;
        }

        if (!json?.data?.user) {
          const upstreamMessage = json?.message;
          const headerMismatch = /useragent mismatch/i.test(String(upstreamMessage ?? ''));
          // Prefer body classification so NodeInvalidType / fbtype mismatch is not
          // reported as missing_user or (later) as an IP block.
          const classified =
            upstream === 'stale_identifier' || looksLikeStaleIdentifier(text)
              ? 'stale_identifier'
              : looksLikeStaleIdentifier(String(upstreamMessage ?? ''))
                ? 'stale_identifier'
                : 'missing_user';
          lastError = new ThreadsAPIError(
            headerMismatch
              ? `web_profile_info rejected headers for @${username} on ${host}: ${upstreamMessage}`
              : classified === 'stale_identifier'
                ? `web_profile_info returned stale identifier for @${username} on ${host}`
                : `Failed to fetch web profile for @${username} on ${host}`,
            {
              message: upstreamMessage,
              status: json?.status,
              has_data: Boolean(json?.data),
            },
            res.status || 404,
            {
              upstream: classified,
              transport,
              details: {
                username,
                host,
                attempt: attempt + 1,
                upstream_message: upstreamMessage,
                http_version: httpVersion,
              },
            },
          );
          // Self-heal once: refresh cached doc_ids, then retry this host (and keep
          // going if still stale). GraphQL paths also refresh on the same pattern.
          if (classified === 'stale_identifier' && !didStaleRefresh) {
            didStaleRefresh = true;
            if (this.verbose) {
              console.debug(
                '[web_profile] stale identifier / fbtype mismatch, refreshing doc_ids…',
              );
            }
            try {
              await this.refreshDocIds(true);
            } catch {
              // Discovery failure should not hide the original upstream error.
            }
            // Exactly one immediate retry on this host after heal.
            skipBackoffOnce = true;
            attempt = 0;
            continue;
          }
          if (headerMismatch || classified === 'stale_identifier' || res.status === 400 || res.status === 404) break;
          continue;
        }

        if (this.verbose) {
          console.debug('[web_profile] ok', username, 'via', host, 'id=', json.data.user.id);
        }
        return json.data.user;
      }
    }

    if (lastError) {
      // Never reclassify NodeInvalidTypeException / fbtype mismatch (stale_identifier)
      // as an IP block — HTTP 400 with that body is not rate-limiting.
      const blocked =
        lastError.upstream !== 'stale_identifier' &&
        (lastError.upstream === 'rate_limited' ||
          lastError.upstream === 'empty_body' ||
          lastError.status === 429);
      if (blocked) {
        throw new ThreadsAPIError(
          `Failed to fetch web profile for @${username}: Meta blocked upstream requests from this server IP (common on Coolify/VPS). Set XY_PROXY to a residential proxy, or host on a home network/Raspberry Pi.`,
          lastError.data,
          lastError.status,
          {
            upstream: lastError.upstream ?? 'rate_limited',
            transport: lastError.transport ?? this.lastTransportUsed,
            details: {
              ...(lastError.details ?? {}),
              username,
              hosts_tried: [...WEB_PROFILE_HOSTS],
              hint: 'XY_PROXY / HTTPS_PROXY residential proxy, or run on Pi',
            },
          },
        );
      }
      throw lastError;
    }

    throw new ThreadsAPIError(`Failed to fetch web profile for @${username}`, undefined, undefined, {
      upstream: 'unknown',
      transport: this.lastTransportUsed,
      details: { username, hosts_tried: [...WEB_PROFILE_HOSTS] },
    });
  }

  /**
   * Guest profile lookup → REST-only via `getWebProfile` (`web_profile_info`).
   * Server `GET /profile/:username` uses this path; it does not call GraphQL.
   */
  async getUserProfile(usernameOrId: string): Promise<ThreadsUser> {
    const isNumeric = /^\d+$/.test(usernameOrId);
    const web = isNumeric
      ? await this.getWebProfile(await this.usernameFromIdFallback(usernameOrId))
      : await this.getWebProfile(usernameOrId);

    return {
      pk: web.id,
      id: web.id,
      username: web.username,
      full_name: web.full_name,
      is_verified: web.is_verified,
      is_private: web.is_private,
      profile_pic_url: web.profile_pic_url_hd || web.profile_pic_url,
      biography: web.biography,
      follower_count: web.edge_followed_by?.count,
      following_count: web.edge_follow?.count,
      media_count: web.edge_owner_to_timeline_media?.count,
      external_url: web.external_url,
    };
  }

  private async usernameFromIdFallback(userId: string): Promise<string> {
    // Without auth we can't reverse id→username via private API; caller should pass username.
    if (this.username && this.userId === userId) return this.username;
    throw new ThreadsAPIError(
      `Pass a username instead of numeric id "${userId}" for guest profile lookups`,
    );
  }

  /**
   * Explicit GraphQL profile query (`BarcelonaUserDialogByUsernameQuery`).
   * Not used by the guest server path — prefer `getUserProfile` / `getWebProfile`
   * (REST `web_profile_info`) for unauthenticated profile reads.
   */
  async getUserProfileGraphQL(username: string): Promise<unknown> {
    const res = await this.graphql('BarcelonaUserDialogByUsernameQuery', {
      username,
      __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
      __relay_internal__pv__BarcelonaShouldShowFediverseM1Featuresrelayprovider: false,
    });
    if (res.data) return res.data;
    throw new ThreadsAPIError('GraphQL user profile returned no data', res);
  }

  /**
   * Search users via GraphQL.
   */
  async searchUsers(query: string, first = 10): Promise<unknown> {
    return this.graphql('BarcelonaAccountSearchGraphQLDataSourceQuery', {
      query,
      first,
      should_fetch_ig_inactive_on_text_app: false,
      __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
      __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
      __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
    }, {
      aliases: ['useBarcelonaAccountSearchGraphQLDataSourceQuery'],
    });
  }

  /**
   * Fetch a thread / replies by numeric post id via GraphQL.
   */
  async getPost(postId: string): Promise<unknown> {
    return this.graphql(
      'BarcelonaPostPageDirectQuery',
      {
        mediaID: postId,
        postID: postId,
        __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
        __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
      },
      { aliases: ['BarcelonaPostPageQuery_legacy'] },
    );
  }

  async getPostFromUrl(url: string): Promise<unknown> {
    return this.getPost(postIdFromUrl(url));
  }

  async getPostFromThreadId(threadId: string): Promise<unknown> {
    return this.getPost(postIdFromThreadId(threadId));
  }

  // ---------------------------------------------------------------------------
  // Authenticated (Instagram private / Barcelona) API
  // ---------------------------------------------------------------------------

  private assertAuth(): void {
    if (!this.token) {
      throw new ThreadsAPIError(
        'Authentication required. Set token or call login() with username/password.',
      );
    }
  }

  /**
   * Login via Instagram Bloks CAA (same path as the original threads-api).
   * Returns `{ token, userId }`. Persist `deviceId` across runs.
   */
  async login(): Promise<{ token: string; userId: string }> {
    if (!this.username || !this.password) {
      throw new ThreadsAPIError('username and password are required for login()');
    }

    // sync experiments (best-effort)
    try {
      await this.rawFetch(`${INSTAGRAM_API_URL}/api/v1/qe/sync/`, {
        method: 'POST',
        headers: this.androidHeaders(),
        body: signPayload({
          id: this.deviceId,
          experiments: 'ig_android_fci_onboarding_friend_search',
        }),
      });
    } catch {
      // non-fatal
    }

    const params = new URLSearchParams({
      params: JSON.stringify({
        client_input_params: {
          password: `#PWD_INSTAGRAM:0:${Math.floor(Date.now() / 1000)}:${this.password}`,
          contact_point: this.username,
          device_id: this.deviceId,
        },
        server_params: {
          credential_type: 'password',
          device_id: this.deviceId,
        },
      }),
      bk_client_context: JSON.stringify({
        bloks_version: BLOKS_VERSION,
        styles_id: 'instagram',
      }),
      bloks_versioning_id: BLOKS_VERSION,
    });

    const res = await this.rawFetch(
      `${INSTAGRAM_API_URL}/api/v1/bloks/apps/com.bloks.www.bloks.caa.login.async.send_login_request/`,
      {
        method: 'POST',
        headers: this.androidHeaders(),
        body: params,
      },
    );

    const text = await res.text();
    // Token appears as IGT:2:… inside Bloks payload / headers
    const headerAuth =
      res.headers.get('ig-set-authorization') ||
      res.headers.get('IG-Set-Authorization') ||
      undefined;
    const bodyAuth = text.match(/(Bearer\s+IGT:2:[A-Za-z0-9+/=]+)/)?.[1];
    const token = headerAuth || bodyAuth;
    const userId =
      res.headers.get('ig-set-ig-u-ds-user-id') ||
      text.match(/"ds_user_id"\s*:\s*"?(\d+)"?/)?.[1] ||
      text.match(/"pk"\s*:\s*"?(\d+)"?/)?.[1];

    if (!token || !userId) {
      throw new ThreadsAPIError(
        'Login failed — check credentials / 2FA. Meta may require interactive challenge.',
        text.slice(0, 1000),
        res.status,
      );
    }

    this.token = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    this.userId = userId;
    if (this.verbose) console.debug('[login] ok userId=', this.userId);
    return { token: this.token, userId };
  }

  async getUserProfileThreadsLoggedIn(
    userId: string,
    maxId?: string,
  ): Promise<{ threads: Thread[]; next_max_id?: string; status: string }> {
    this.assertAuth();
    const path = `/api/v1/text_feed/${userId}/profile/${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''}`;
    const res = await this.rawFetch(`${INSTAGRAM_API_URL}${path}`, {
      headers: this.androidHeaders({ 'user-agent': BARCELONA_USER_AGENT }),
    });
    const json = (await res.json()) as {
      threads?: Thread[];
      next_max_id?: string;
      status?: string;
    };
    if (json.status && json.status !== 'ok') {
      throw new ThreadsAPIError('Failed to fetch user threads', json, res.status);
    }
    return {
      threads: json.threads ?? [],
      next_max_id: json.next_max_id,
      status: json.status ?? 'ok',
    };
  }

  async getUserProfileRepliesLoggedIn(
    userId: string,
    maxId?: string,
  ): Promise<{ threads: Thread[]; next_max_id?: string; status: string }> {
    this.assertAuth();
    const path = `/api/v1/text_feed/${userId}/profile/replies/${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''}`;
    const res = await this.rawFetch(`${INSTAGRAM_API_URL}${path}`, {
      headers: this.androidHeaders(),
    });
    const json = (await res.json()) as {
      threads?: Thread[];
      next_max_id?: string;
      status?: string;
    };
    return {
      threads: json.threads ?? [],
      next_max_id: json.next_max_id,
      status: json.status ?? 'ok',
    };
  }

  async getTimeline(maxId?: string): Promise<unknown> {
    this.assertAuth();
    const res = await this.rawFetch(`${INSTAGRAM_API_URL}/api/v1/feed/text_post_app_timeline/`, {
      method: 'POST',
      headers: this.androidHeaders(),
      body: new URLSearchParams(maxId ? { max_id: maxId } : {}),
    });
    return res.json();
  }

  async like(postId: string): Promise<unknown> {
    this.assertAuth();
    const userId = this.userId ?? (await this.getCurrentUserId());
    const res = await this.rawFetch(
      `${INSTAGRAM_API_URL}/api/v1/media/${postId}_${userId}/like/`,
      { method: 'POST', headers: this.androidHeaders(), body: '' },
    );
    return res.json();
  }

  async unlike(postId: string): Promise<unknown> {
    this.assertAuth();
    const userId = this.userId ?? (await this.getCurrentUserId());
    const res = await this.rawFetch(
      `${INSTAGRAM_API_URL}/api/v1/media/${postId}_${userId}/unlike/`,
      { method: 'POST', headers: this.androidHeaders(), body: '' },
    );
    return res.json();
  }

  async follow(userId: string): Promise<unknown> {
    this.assertAuth();
    const res = await this.rawFetch(`${INSTAGRAM_API_URL}/api/v1/friendships/create/${userId}/`, {
      method: 'POST',
      headers: this.androidHeaders(),
      body: '',
    });
    return res.json();
  }

  async unfollow(userId: string): Promise<unknown> {
    this.assertAuth();
    const res = await this.rawFetch(`${INSTAGRAM_API_URL}/api/v1/friendships/destroy/${userId}/`, {
      method: 'POST',
      headers: this.androidHeaders(),
      body: '',
    });
    return res.json();
  }

  async publish(options: {
    text: string;
    replyToPostId?: string;
    quotedPostId?: string;
    attachmentUrl?: string;
  }): Promise<unknown> {
    this.assertAuth();
    const userId = this.userId ?? (await this.getCurrentUserId());
    const payload: Record<string, unknown> = {
      publish_mode: 'text_post',
      text_post_app_info: {
        reply_control: 0,
      } as Record<string, unknown>,
      timezone_offset: '0',
      source_type: '4',
      _uid: userId,
      device_id: this.deviceId,
      caption: options.text,
    };

    if (options.attachmentUrl) {
      (payload.text_post_app_info as Record<string, unknown>).link_attachment_url =
        options.attachmentUrl;
    }
    if (options.replyToPostId) {
      (payload.text_post_app_info as Record<string, unknown>).reply_id =
        options.replyToPostId.replace(/_\d+$/, '');
    }
    if (options.quotedPostId) {
      (payload.text_post_app_info as Record<string, unknown>).quoted_post_id =
        options.quotedPostId.replace(/_\d+$/, '');
    }

    const res = await this.rawFetch(
      `${INSTAGRAM_API_URL}/api/v1/media/configure_text_only_post/`,
      {
        method: 'POST',
        headers: this.androidHeaders(),
        body: signPayload(payload),
      },
    );
    return res.json();
  }

  async getCurrentUserId(): Promise<string> {
    if (this.userId) return this.userId;
    if (!this.username) throw new ThreadsAPIError('username is not defined');
    this.userId = await this.getUserIdFromUsername(this.username);
    return this.userId;
  }

  // ---------------------------------------------------------------------------
  // ID helpers (re-exported on instance for convenience)
  // ---------------------------------------------------------------------------

  postIdFromThreadId = postIdFromThreadId;
  threadIdFromPostId = threadIdFromPostId;
  postIdFromUrl = postIdFromUrl;
}
