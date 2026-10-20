# Control-plane image. Runs the server via tsx (matches the sidecar's
# runtime — no separate build step). SQLite lives on a Fly volume mounted at
# /data; uploads too. Single machine, single region (plan: in-memory
# per-channel engines → no sticky routing at alpha scale).
#
# Built from the REPO ROOT (the server imports shared/ and core/ as source,
# and serves web/'s build):
#   fly deploy --config server/fly.toml --dockerfile server/Dockerfile .
# docs/DISTRIBUTION.md has the full deploy runbook.

FROM node:22-slim

# better-sqlite3 needs a toolchain to build its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only the workspaces the image runs: server, its two source deps,
# and web (whose portal bundle the server serves). Not sidecar or app — the
# latter would download Electron. No --omit=dev: tsx (the runtime) and vite
# (the portal build) are devDependencies. Manifests first for layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY core/package.json core/
COPY sidecar/package.json sidecar/
COPY web/package.json web/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --workspace server --workspace @rh/core --workspace @rh/shared --workspace @rh/web --include-workspace-root

# The workspaces' tsconfigs extend the root one.
COPY tsconfig.base.json ./
COPY shared shared
COPY core core
COPY web web
COPY server server

# Build the hosted portal bundle the server serves from web/dist.
RUN npm run build

ENV RH_DATABASE_PATH=/data/data.sqlite
ENV RH_UPLOADS_DIR=/data/uploads
ENV RH_QUARANTINE_DIR=/data/quarantine
ENV RH_SERVER_PORT=8790
EXPOSE 8790

CMD ["npm", "run", "start", "--workspace", "server"]
