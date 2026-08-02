# Production image for Coolify (xy.txne.org) / Docker.
#
# Critical: Xy defaults to transport:'curl'. Meta empty-429s Node/undici TLS
# fingerprints and HTTP/1.1 curl. Official node:*-slim images do NOT ship curl —
# without apt-installing curl (+ HTTP/2/nghttp2), createCurlFetch fails and
# /profile/* returns "Failed to fetch web profile".
#
# Persist EU consent cookies + doc_id cache across redeploys:
#   docker run -v xy-data:/data -e XY_COOKIE_JAR=/data/.xy-cookies.txt \
#     -e XY_DOC_ID_CACHE=/data/.xy-doc-ids.json ...
# Coolify: attach a volume at /data and set those two env vars.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Debian curl includes HTTP/2 (nghttp2). Fail the image build if it does not.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -V 2>&1 | grep -qiE 'HTTP2|nghttp2' \
  && mkdir -p /data

ENV NODE_ENV=production \
    XY_HOST=0.0.0.0 \
    PORT=8787 \
    XY_PORT=8787 \
    XY_TRANSPORT=curl \
    XY_COOKIE_JAR=/data/.xy-cookies.txt \
    XY_DOC_ID_CACHE=/data/.xy-doc-ids.json

VOLUME ["/data"]

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8787

# Shell form so Coolify-injected PORT is honored at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-${XY_PORT:-8787}}/health" || exit 1

CMD ["node", "dist/server.js"]
