# crewswarm runtime image
# Builds the frontend and packages all core services into a single image.
# ~/.crewswarm is always mounted as a volume — never baked in.
#
# Build:  docker build -t crewswarm .
# Run:    docker compose up   (see docker-compose.yml)

# ── Stage 1: build Vite dashboard ────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app/apps/dashboard
COPY apps/dashboard/package*.json ./
RUN npm ci
COPY apps/dashboard/ ./
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# System deps (git for crew-github, curl for health checks)
RUN apk add --no-cache git curl bash

WORKDIR /app

# Install root deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Drop the local dashboard dist if any — use the clean build from stage 1
RUN rm -rf apps/dashboard/dist
COPY --from=frontend-builder /app/apps/dashboard/dist ./apps/dashboard/dist

# Build and install crew-cli (makes `crew` command globally available)
WORKDIR /app/crew-cli
RUN npm ci && npm run build && npm link

# Return to app root
WORKDIR /app

# ~/.crewswarm is always a mounted volume — the image never contains secrets.
# On first start the app bootstraps the directory if it doesn't exist.
VOLUME ["/root/.crewswarm"]

# Exposed ports
# 4319 — dashboard
# 5010 — crew-lead
# 18889 — RT message bus
# 4096 — code engine
# 5020 — MCP server (optional)
EXPOSE 4319 5010 18889 4096 5020

# Start all core services via the existing restart script
CMD ["bash", "scripts/restart-all-from-repo.sh"]
