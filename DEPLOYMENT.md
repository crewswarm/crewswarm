# crewswarm Deployment Guide

This guide provides step-by-step instructions for deploying crewswarm in production environments, including Docker containerization, environment configuration, and monitoring setup.

---

## Table of Contents

1. [Environment Setup](#1-environment-setup)
2. [Local Development and Production Builds](#2-local-development-and-production-builds)
3. [Docker Setup](#3-docker-setup)
4. [Production Deployment](#4-production-deployment)
5. [Monitoring and Logging](#5-monitoring-and-logging)

---

## 1. Environment Setup

### 1.1 Clone and Install Dependencies

```bash
git clone https://github.com/crewswarm/crewswarm
cd crewswarm
npm install
```

### 1.2 Environment Variables

Create a `.env` file in the project root. **Never commit this file to version control.**

```bash
# Required: At least one LLM provider API key
GROQ_API_KEY=gsk_your_groq_key_here
OPENAI_API_KEY=sk-your_openai_key_here
ANTHROPIC_API_KEY=sk-ant-your_anthropic_key_here

# RT Bus Configuration
RT_PORT=18889
RT_AUTH_TOKEN=your_secure_random_token_here

# Dashboard Configuration
VITE_RT_URL=http://localhost:18889
VITE_RT_AUTH_TOKEN=your_secure_random_token_here

# Optional: Output and workspace paths
CREWSWARM_OUTPUT_PATH=/path/to/output
CREWSWARM_WORKSPACE=/path/to/workspace

# Optional: Messaging bridges
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_ALLOWED_USERS=user1,user2
WHATSAPP_SESSION_PATH=/path/to/whatsapp/session

# Optional: Agent-specific configurations
CREW_PM_MODEL=perplexity/sonar-pro
CREW_CODER_MODEL=anthropic/claude-sonnet-4-20250514
CREW_QA_MODEL=groq/llama-3.3-70b-versatile
```

### 1.3 Generate Secure Tokens

For production deployments, generate cryptographically secure tokens:

```bash
# Generate RT_AUTH_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 1.4 Configuration Files

crewswarm stores additional configuration in `~/.crewswarm/config.json`. Review and update:

```json
{
  "providers": {
    "groq": { "apiKey": "gsk_..." },
    "openai": { "apiKey": "sk-..." },
    "anthropic": { "apiKey": "sk-ant-..." }
  },
  "agents": [
    { "id": "crew-pm", "model": "perplexity/sonar-pro" },
    { "id": "crew-coder", "model": "anthropic/claude-sonnet-4-20250514" },
    { "id": "crew-qa", "model": "groq/llama-3.3-70b-versatile" }
  ],
  "rtBus": {
    "port": 18889,
    "authToken": "your_secure_token"
  },
  "commandApproval": {
    "enabled": true,
    "allowlist": ["npm", "git", "node"]
  }
}
```

---

## 2. Local Development and Production Builds

### 2.1 Development Mode

Run crewswarm in development mode with hot reloading:

```bash
# Run preflight checks
npm run doctor

# Start all services
npm run restart-all

# Dashboard will be available at http://localhost:4319
```

### 2.2 Production Build

Build optimized production bundles:

```bash
# Build dashboard with Vite
cd apps/dashboard
npm run build
cd ../..

# Build crew-cli
cd crew-cli
npm run build
cd ..

# The built assets will be in:
# - apps/dashboard/dist/
# - crew-cli/dist/
```

### 2.3 Running Production Build Locally

Test the production build before deployment:

```bash
# Serve dashboard production build
cd apps/dashboard
npm run preview

# Or use a static file server
npx serve dist -l 4319
```

---

## 3. Docker Setup

### 3.1 Dockerfile Example (Dashboard)

Create `apps/dashboard/Dockerfile`:

```dockerfile
# Multi-stage build for minimal production image
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY apps/dashboard/package*.json ./apps/dashboard/

# Install dependencies
RUN npm ci --workspace=apps/dashboard

# Copy application source
COPY apps/dashboard ./apps/dashboard

# Build application
WORKDIR /app/apps/dashboard
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html

# Copy nginx configuration
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --quiet --tries=1 --spider http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
```

### 3.2 Dockerfile Example (RT Bus / Node Services)

Create `Dockerfile` in project root:

```dockerfile
# Multi-stage build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies
RUN npm ci --production=false

# Copy source
COPY . .

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy dependencies and built code
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/*.mjs ./
COPY --from=builder /app/crew-cli ./crew-cli
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/memory ./memory

# Environment variables
ENV NODE_ENV=production
ENV RT_PORT=18889

# Expose RT bus port
EXPOSE 18889

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('http').get('http://localhost:18889/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start RT bus and services
CMD ["node", "gateway-bridge.mjs"]
```

### 3.3 .dockerignore

Create `.dockerignore` to exclude unnecessary files:

```
# Dependencies
node_modules/
npm-debug.log*

# Build artifacts
dist/
build/
*.tsbuildinfo

# Environment and secrets
.env
.env.*
!.env.example

# Git
.git/
.gitignore
.gitattributes

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Testing
coverage/
.nyc_output/

# Logs
logs/
*.log

# Temp files
tmp/
temp/
*.tmp

# Documentation (optional, exclude if not needed in image)
docs/
*.md
!README.md
```

### 3.4 Docker Compose

Create `docker-compose.yml` for multi-service orchestration:

```yaml
version: '3.8'

services:
  rt-bus:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: crewswarm-rt-bus
    environment:
      - NODE_ENV=production
      - RT_PORT=18889
      - RT_AUTH_TOKEN=${RT_AUTH_TOKEN}
      - GROQ_API_KEY=${GROQ_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    ports:
      - "18889:18889"
    volumes:
      - ./memory:/app/memory
      - ./output:/app/output
    restart: unless-stopped
    networks:
      - crewswarm-network
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:18889/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  dashboard:
    build:
      context: .
      dockerfile: apps/dashboard/Dockerfile
    container_name: crewswarm-dashboard
    environment:
      - VITE_RT_URL=http://rt-bus:18889
      - VITE_RT_AUTH_TOKEN=${RT_AUTH_TOKEN}
    ports:
      - "8080:80"
    depends_on:
      - rt-bus
    restart: unless-stopped
    networks:
      - crewswarm-network

networks:
  crewswarm-network:
    driver: bridge
```

### 3.5 Build and Run with Docker

```bash
# Build images
docker-compose build

# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

---

## 4. Production Deployment

### 4.1 Process Management with PM2

For non-containerized deployments, use PM2 for process management:

```bash
# Install PM2 globally
npm install -g pm2

# Start RT bus
pm2 start gateway-bridge.mjs --name crewswarm-rt

# Start other bridges
pm2 start telegram-bridge.mjs --name crewswarm-telegram
pm2 start pm-loop.mjs --name crewswarm-pm-loop

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

Create `ecosystem.config.js` for PM2:

```javascript
module.exports = {
  apps: [
    {
      name: 'crewswarm-rt',
      script: './gateway-bridge.mjs',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        RT_PORT: 18889
      }
    },
    {
      name: 'crewswarm-telegram',
      script: './telegram-bridge.mjs',
      instances: 1,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
```

Start with ecosystem file:

```bash
pm2 start ecosystem.config.js
```

### 4.2 Reverse Proxy with Nginx

Configure nginx to proxy requests to the RT bus and dashboard:

```nginx
# /etc/nginx/sites-available/crewswarm
upstream rt_bus {
    server 127.0.0.1:18889;
}

server {
    listen 80;
    server_name crewswarm.example.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name crewswarm.example.com;

    # SSL certificates (use Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/crewswarm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crewswarm.example.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Dashboard static files
    location / {
        root /var/www/crewswarm/dashboard;
        try_files $uri $uri/ /index.html;
    }

    # RT Bus API
    location /api/ {
        proxy_pass http://rt_bus/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://rt_bus/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

Enable site and restart nginx:

```bash
sudo ln -s /etc/nginx/sites-available/crewswarm /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 4.3 Kubernetes Deployment

For Kubernetes orchestration, create deployment manifests:

**deployment.yaml:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: crewswarm-rt-bus
spec:
  replicas: 2
  selector:
    matchLabels:
      app: crewswarm-rt-bus
  template:
    metadata:
      labels:
        app: crewswarm-rt-bus
    spec:
      containers:
      - name: rt-bus
        image: crewswarm/rt-bus:latest
        ports:
        - containerPort: 18889
        env:
        - name: RT_AUTH_TOKEN
          valueFrom:
            secretKeyRef:
              name: crewswarm-secrets
              key: rt-auth-token
        - name: GROQ_API_KEY
          valueFrom:
            secretKeyRef:
              name: crewswarm-secrets
              key: groq-api-key
        livenessProbe:
          httpGet:
            path: /health
            port: 18889
          initialDelaySeconds: 30
          periodSeconds: 10
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

**service.yaml:**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: crewswarm-rt-bus
spec:
  selector:
    app: crewswarm-rt-bus
  ports:
  - protocol: TCP
    port: 18889
    targetPort: 18889
  type: LoadBalancer
```

Deploy to Kubernetes:

```bash
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
```

---

## 5. Monitoring and Logging

### 5.1 Prometheus Metrics

Expose metrics endpoint in your services. Add to `gateway-bridge.mjs`:

```javascript
import promClient from 'prom-client';

// Initialize Prometheus
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Custom metrics
const taskCounter = new promClient.Counter({
  name: 'crewswarm_tasks_total',
  help: 'Total number of tasks processed',
  labelNames: ['agent', 'status'],
  registers: [register]
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

Configure Prometheus to scrape metrics:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'crewswarm'
    static_configs:
      - targets: ['localhost:18889']
    scrape_interval: 15s
```

### 5.2 Structured Logging

Implement structured JSON logging for better log aggregation:

```javascript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'crewswarm-rt-bus' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

logger.info('RT bus started', { port: 18889 });
```

### 5.3 ELK Stack Integration

Ship logs to Elasticsearch using Filebeat:

**filebeat.yml:**

```yaml
filebeat.inputs:
  - type: log
    enabled: true
    paths:
      - /var/log/crewswarm/*.log
    json.keys_under_root: true
    json.add_error_key: true

output.elasticsearch:
  hosts: ["localhost:9200"]
  index: "crewswarm-%{+yyyy.MM.dd}"

setup.kibana:
  host: "localhost:5601"
```

### 5.4 Health Checks

Implement comprehensive health checks:

```javascript
// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    checks: {
      database: checkDatabase(),
      providers: checkProviders(),
      agents: checkAgents()
    }
  };

  const status = Object.values(health.checks).every(c => c.status === 'ok')
    ? 200
    : 503;

  res.status(status).json(health);
});
```

### 5.5 Alerting

Configure alerts in Prometheus Alertmanager:

```yaml
# alerts.yml
groups:
  - name: crewswarm
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(crewswarm_tasks_total{status="error"}[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }} errors/sec"

      - alert: ServiceDown
        expr: up{job="crewswarm"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "crewswarm service is down"
```

---

## Security Checklist

- [ ] All API keys stored in environment variables or secrets management
- [ ] `.env` files excluded from version control
- [ ] RT_AUTH_TOKEN generated with cryptographic randomness
- [ ] TLS/SSL configured for production domains
- [ ] Command approval gates enabled
- [ ] Firewall rules restrict access to RT bus port
- [ ] Regular security updates applied
- [ ] Monitoring and alerting configured
- [ ] Log rotation configured
- [ ] Backup strategy for memory and configuration files

---

## Troubleshooting

**Issue:** RT bus fails to start

```bash
# Check port availability
lsof -i :18889

# Check logs
pm2 logs crewswarm-rt
# or
docker-compose logs rt-bus
```

**Issue:** Dashboard can't connect to RT bus

- Verify `VITE_RT_URL` points to correct RT bus URL
- Check RT_AUTH_TOKEN matches between dashboard and bus
- Verify network connectivity and firewall rules

**Issue:** High memory usage

- Review agent model assignments (smaller models for non-critical tasks)
- Configure memory limits in Docker/Kubernetes
- Enable garbage collection logging: `node --expose-gc --trace-gc app.js`

---

## Additional Resources

- [Official Documentation](https://crewswarm.ai/docs)
- [Architecture Guide](docs/ARCHITECTURE.md)
- [Troubleshooting Guide](docs/TROUBLESHOOTING.md)
- [Model Recommendations](docs/MODEL-RECOMMENDATIONS.md)

---

**Last updated:** 2026-03-25
