# NEXUS OS — production image (bun + Next.js standalone + mini-services).
# Build/run ONLY on a real host (VM / HF Space). NEVER inside the z.ai sandbox.
# Build context = repo root:  docker build -f deploy/Dockerfile -t nexus-os .

FROM oven/bun:1.3-slim AS build
WORKDIR /app

# Prisma client generation needs the schema before deps install.
COPY prisma ./prisma
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Standalone Next.js build (next.config.ts: output "standalone") + static assets
# into the server tree (same steps as the repo's `bun run build` script).
RUN bunx prisma generate && bun run build

# kick-bridge has its own tiny lockfile (ws).
RUN cd mini-services/kick-bridge && bun install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

# Runtime tree: built app + repo (mini-services, scripts, prisma, public).
COPY --from=build /app /app
# db path + .env live on the mounted volume (see entrypoint.sh).
VOLUME ["/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/data/custom.db \
    DATA_DIR=/data

EXPOSE 3000 3010 3011 3012 3013

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
