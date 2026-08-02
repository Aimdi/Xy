/** Web GraphQL app id used by threads.net (Instagram web). */
export const WEB_IG_APP_ID = '238260118697367';

/** Android / Barcelona private API app id used by the Threads mobile client. */
export const ANDROID_IG_APP_ID = '3419628305025917';

export const THREADS_BASE_URL = 'https://www.threads.net';
/** Canonical www host after Threads → Instagram migration redirects. */
export const THREADS_WWW_URL = 'https://www.threads.com';
export const THREADS_GRAPHQL_URL = `${THREADS_WWW_URL}/api/graphql`;
export const INSTAGRAM_API_URL = 'https://i.instagram.com';
export const INSTAGRAM_WWW_URL = 'https://www.instagram.com';

/**
 * Hosts that currently serve guest `web_profile_info` for Threads usernames.
 * Fail over across these when one edge returns 429 / challenge / empty body.
 */
export const WEB_PROFILE_HOSTS = [
  THREADS_BASE_URL,
  THREADS_WWW_URL,
  INSTAGRAM_WWW_URL,
  INSTAGRAM_API_URL,
] as const;

/** Fallback LSD token — always refresh from a live page when possible. */
export const DEFAULT_LSD_TOKEN = 'NjppQDEgONsU_1LCzrmp6q';

export const DEFAULT_ASBD_ID = '359341';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Barcelona (Threads Android) user-agent template. */
export const BARCELONA_USER_AGENT =
  'Barcelona 361.0.0.51.90 Android (33/13; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 689000000)';

export const BLOKS_VERSION =
  '5f56efad68e1edec7801f630b5c122704ec5378adbee6609a448f105f34a9c73';

/** Legacy Instagram request-signing key (still used by some private endpoints). */
export const SIGNATURE_KEY =
  '9193488027538fd3450b83b7d05286d4ca9599a0f7eeed90d8c85925698a05dc';

export const DOC_ID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
