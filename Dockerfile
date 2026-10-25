# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml* frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# The build reads the release version from the server package.json.
COPY package.json /app/package.json
COPY frontend/ ./
RUN pnpm build

# ── Stage 2: Build backend ─────────────────────────────────────────────────────
FROM node:22-alpine AS backend-builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle/ ./drizzle/
COPY src/ ./src/
RUN pnpm build:server

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Production dependencies only
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Compiled server
COPY --from=backend-builder /app/dist ./dist

# Built frontend
COPY --from=frontend-builder /app/frontend-dist ./frontend-dist

# Drizzle migrations (generated during build)
COPY --from=backend-builder /app/drizzle ./drizzle

# LiteLLM gateway config (config.yaml + custom_auth.py). The `llm` compose profile
# copies it into a shared volume, so a deployment needs no file next to the
# compose file and the gateway always matches this auth-service version.
COPY litellm ./litellm

# Built-in page + email templates. The resolvers fall back to this directory
# (/app/templates/default, relative to dist/services) when no override exists in
# TEMPLATES_DIR. It must live in the image, outside any volume an operator
# mounts on TEMPLATES_DIR, so a mounted volume never needs a `default/` copy.
COPY templates/default ./templates/default

EXPOSE 3001

ENV NODE_ENV=production

# Drop privileges: the runtime only needs to read code/config and open sockets.
USER node

CMD ["node", "dist/index.js"]
