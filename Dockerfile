# syntax=docker/dockerfile:1.7
#
# Recall server image: multi-stage build on node:22-slim.
#
#   docker build -t recall-server .
#   docker run -p 8000:8000 -v recall-data:/data recall-server        # embedded Postgres, offline
#   docker run -p 8000:8000 -e RECALL_DATABASE_URL=postgres://... recall-server
#
# Build args: NODE_IMAGE (e.g. a mirror or an image with your corporate CA), PNPM_VERSION.

ARG NODE_IMAGE=node:22-slim

# ---- base: Node + the pinned pnpm -------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=10.33.0
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install --global --no-audit --no-fund pnpm@${PNPM_VERSION}
WORKDIR /repo

# ---- fetch: download every package in the lockfile; cached until the lockfile changes ----------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# ---- build: install the server's workspace, compile TypeScript, collect production deps --------
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @recall-memory/server...
# `build` compiles src/ to dist/ and copies the SQL migrations next to the compiled code.
RUN pnpm --filter @recall-memory/server build \
 && ls packages/server/dist/db/migrations/*.sql >/dev/null
# Only the production dependency closure (no tsx, vitest, drizzle-kit, ...). The server has no
# workspace dependencies, so the legacy deploy mode is exactly what we want.
RUN pnpm --filter @recall-memory/server deploy --legacy --prod /out \
 && rm -rf /out/dist && cp -r packages/server/dist /out/dist

# ---- runtime ----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    RECALL_HOST=0.0.0.0 \
    RECALL_PORT=8000 \
    RECALL_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
# The bins from package.json (`recall-server`, and `recall` when the CLI is built).
RUN chmod +x dist/main.js \
 && ln -s /app/dist/main.js /usr/local/bin/recall-server \
 && if [ -f dist/cli.js ]; then chmod +x dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/recall; fi \
 && mkdir -p /data && chown node:node /data

# Run as the unprivileged `node` user that ships with the image.
USER node
# Embedded mode (no RECALL_DATABASE_URL) keeps its Postgres files here.
VOLUME ["/data"]
EXPOSE 8000

# Embedded Postgres needs a few seconds to boot and migrate, hence the start period.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.RECALL_PORT||8000)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["recall-server"]
