/** Why an upstream Threads/Meta response was unusable. */
export type UpstreamHint =
  | 'rate_limited'
  | 'html_challenge'
  | 'empty_body'
  | 'non_json'
  | 'missing_user'
  | 'parse_error'
  | 'unknown';

export type TransportKind = 'fetch' | 'curl';

export interface ThreadsAPIErrorMeta {
  upstream?: UpstreamHint;
  transport?: TransportKind | string;
  /** Safe, redacted extras for API responses (no secrets). */
  details?: Record<string, unknown>;
}

/**
 * Classify an HTTP body from Threads/Meta into a diagnostic hint.
 * Prefer this over dumping raw HTML into clients.
 */
export function classifyUpstreamBody(status: number, text: string): UpstreamHint {
  if (status === 429) return 'rate_limited';
  if (text == null || !String(text).trim()) return 'empty_body';

  const trimmed = String(text).trimStart().toLowerCase();
  if (
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html') ||
    trimmed.includes('checkpoint') ||
    /<title[^>]*>\s*(sorry|error|login|challenge)/i.test(text)
  ) {
    return 'html_challenge';
  }

  const first = trimmed[0];
  if (first !== '{' && first !== '[') return 'non_json';
  return 'unknown';
}

/** Truncate body previews so error payloads stay small and secret-free. */
export function bodyPreview(text: string, max = 240): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export class ThreadsAPIError extends Error {
  readonly data?: unknown;
  readonly status?: number;
  readonly upstream?: UpstreamHint;
  readonly transport?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    data?: unknown,
    status?: number,
    meta?: ThreadsAPIErrorMeta,
  ) {
    super(message);
    this.name = 'ThreadsAPIError';
    this.data = data;
    this.status = status;
    this.upstream = meta?.upstream;
    this.transport = meta?.transport;
    this.details = meta?.details;
  }

  /** JSON-safe payload for HTTP APIs (no raw secrets / huge HTML dumps). */
  toJSON(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      error: 'threads_api_error',
      message: this.message,
    };
    if (this.status != null) payload.status = this.status;
    if (this.upstream) payload.upstream = this.upstream;
    if (this.transport) payload.transport = this.transport;
    if (this.details && Object.keys(this.details).length) payload.details = this.details;

    if (this.data != null && payload.details == null) {
      if (typeof this.data === 'string') {
        payload.data_preview = bodyPreview(this.data);
      } else if (typeof this.data === 'object') {
        payload.data = summarizeData(this.data);
      }
    }
    return payload;
  }
}

export class DocIdNotFoundError extends ThreadsAPIError {
  constructor(operation: string) {
    super(
      `No GraphQL doc_id found for operation "${operation}". Run discoverDocIds() or update seed-doc-ids.json.`,
    );
    this.name = 'DocIdNotFoundError';
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), error: 'doc_id_not_found' };
  }
}

function summarizeData(data: object): unknown {
  if (data instanceof Error) {
    return { name: data.name, message: data.message };
  }
  try {
    const json = JSON.stringify(data);
    if (json.length <= 400) return data;
    // Keep keys but truncate long string values
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = bodyPreview(v, 120);
      else out[k] = v;
    }
    return out;
  } catch {
    return { note: 'unserializable_data' };
  }
}

/** Map upstream HTTP status → status the local HTTP server should return. */
export function httpStatusForThreadsError(err: ThreadsAPIError): number {
  const s = err.status;
  if (s === 429) return 429;
  if (s === 401 || s === 403) return s;
  if (s === 404) return 404;
  if (s != null && s >= 500) return 502;
  if (err.upstream === 'rate_limited') return 429;
  if (err.upstream === 'html_challenge' || err.upstream === 'empty_body') return 502;
  if (err.name === 'DocIdNotFoundError') return 503;
  if (s != null && s >= 400) return 502;
  return 500;
}
