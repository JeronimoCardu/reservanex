# syntax=docker/dockerfile:1
#
# ReservaNex worker — production image (MVP PROD-A1).
#
# Build context: the REPO ROOT (the worker lives in a pnpm workspace).
#   docker build -f apps/worker/Dockerfile -t reservanex-worker .
#
# Strategy: run the TypeScript sources with tsx as a Node loader — the same
# transpiler `pnpm dev` / `pnpm start` use today — instead of adding a JS
# build. Single process (`node --import tsx`, no tsx CLI wrapper), so
# SIGTERM reaches the worker's own handlers directly.
#
# No secrets here: configuration comes from the platform's runtime
# environment (Render env vars). Render also hands env vars to the build as
# build args; this Dockerfile declares no ARG, so none reaches an image
# layer. .dockerignore keeps every .env* file out of the context.

FROM node:22-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# 1) Manifests + lockfile only, so the dependency layer is reused while they
#    don't change. Every workspace manifest is copied so the frozen lockfile
#    matches the workspace exactly; only the worker's graph is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json         apps/worker/
COPY apps/web/package.json            apps/web/
COPY apps/marketing/package.json      apps/marketing/
COPY packages/config/package.json     packages/config/
COPY packages/supabase/package.json   packages/supabase/
COPY packages/types/package.json      packages/types/
COPY packages/validators/package.json packages/validators/

# NODE_ENV is NOT production yet: tsx is a devDependency and is the runtime
# loader, so devDependencies must be installed.
RUN pnpm install --frozen-lockfile --filter "@orderflow/worker..."

# 2) Sources. Runtime only imports types from @orderflow/types (erased at
#    transpile time); its sources are copied so the workspace link resolves.
COPY packages/types  packages/types
COPY apps/worker     apps/worker

ENV NODE_ENV=production
USER node
WORKDIR /app/apps/worker

# WORKER_INTERNAL_PORT default (internal-server.ts) = PORT in render.yaml.
EXPOSE 8788

CMD ["node", "--import", "tsx", "src/index.ts"]
