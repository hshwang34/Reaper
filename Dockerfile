# Control-plane image (Fly.io). Build context = the repo root: the server runs
# @rh/core and @rh/shared from source via tsx, and serves the web build.
#
#   fly deploy            (from the repo root; fly.toml points here)
#
# SQLite, uploads, the CSAM quarantine and backups all live on the Fly volume
# mounted at /data — the container's own disk is wiped on every deploy.

FROM node:22-slim

# better-sqlite3 ships linux prebuilds; the toolchain is only the fallback
# if a prebuild is ever missing for this Node version.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only the workspaces the image runs: server, its two source deps,
# and web (whose portal bundle the server serves). Not sidecar or app — the
# latter would pull Electron and electron-builder. No --omit=dev: tsx (the
# runtime) and vite (the portal build) are devDependencies. Manifests first
# for layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY core/package.json core/
COPY sidecar/package.json sidecar/
COPY web/package.json web/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --no-audit --no-fund --workspace server --workspace @rh/core --workspace @rh/shared --workspace @rh/web --include-workspace-root

# Only what the image runs. (The workspaces' tsconfigs extend the root one.)
COPY tsconfig.base.json ./
COPY shared shared
COPY core core
COPY web web
COPY server server
RUN npm run build

ENV RH_ENV=production \
    RH_SERVER_PORT=8790 \
    RH_DATABASE_PATH=/data/data.sqlite \
    RH_UPLOADS_DIR=/data/uploads \
    RH_QUARANTINE_DIR=/data/safety/quarantine \
    RH_BACKUP_DIR=/data/backups
EXPOSE 8790

# Run node directly (not via npm) so SIGTERM from a deploy reaches the
# process; from the server dir so tsx applies its tsconfig paths.
WORKDIR /app/server
CMD ["node", "--import", "tsx", "src/index.ts"]
