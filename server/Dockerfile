# Control-plane image. Runs the whole monorepo via tsx (matches the sidecar's
# runtime — no separate build step). SQLite lives on a Fly volume mounted at
# /data; uploads too. Single machine, single region (plan: in-memory
# per-channel engines → no sticky routing at alpha scale).

FROM node:22-slim

# better-sqlite3 needs a toolchain to build its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install workspace deps (root + all packages). Copy manifests first for layer
# caching, then sources.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY core/package.json core/
COPY sidecar/package.json sidecar/
COPY web/package.json web/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --omit=dev --workspace server --workspace @rh/core --workspace @rh/shared --include-workspace-root || npm ci

COPY . .

# Build the hosted portal bundle the server serves from web/dist.
RUN npm run build

ENV RH_DATABASE_PATH=/data/data.sqlite
ENV RH_UPLOADS_DIR=/data/uploads
ENV RH_SERVER_PORT=8790
EXPOSE 8790

CMD ["npm", "run", "start", "--workspace", "server"]
