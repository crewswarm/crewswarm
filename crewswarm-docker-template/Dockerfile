# CrewSwarm Template Runtime
# Minimal Docker image for deploying CrewSwarm agents

# ── Stage 1: Build dependencies ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# System dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    python3 \
    py3-pip

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create data directory for knowledge agent
RUN mkdir -p /app/data/docs

# Persistent config volume
VOLUME ["/root/.crewswarm"]

# Exposed ports
EXPOSE 4319 5010 18889 4096 5020

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:4319/api/health || exit 1

# Start services
CMD ["bash", "scripts/start.sh"]
