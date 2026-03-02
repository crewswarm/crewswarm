# Unified REST API

## Overview

CrewSwarm now has a consolidated REST API that unifies:
- crew-lead chat and dispatch endpoints (`:5010`)
- Dashboard management endpoints (`:4319`)  
- MCP tool exposure (`:5020`)

All available at a single base URL with OpenAPI documentation.

## Quick Start

```bash
# Start the unified API
node scripts/unified-api.mjs

# View OpenAPI spec
curl http://localhost:5000/v1/openapi.json

# View Swagger docs
open http://localhost:5000/docs

# Health check
curl http://localhost:5000/v1/health
```

## API Design

### Base URL

```
http://localhost:5000/v1
```

### Authentication

All endpoints accept Bearer tokens:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:5000/v1/agents
```

Token is read from `~/.crewswarm/config.json → rt.authToken`

### User Scoping

All endpoints accept `userId` to isolate data:

```bash
curl -X POST http://localhost:5000/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "sessionId": "session1",
    "message": "Hello"
  }'
```

## Core Endpoints

### Chat & Sessions

```bash
# Send chat message
POST /v1/chat
{
  "message": "Deploy to production",
  "userId": "user123",
  "sessionId": "default",
  "projectId": "my-app"
}

# List sessions
GET /v1/sessions?userId=user123

# Get session messages
GET /v1/sessions/default/messages?userId=user123&limit=50
```

### Agents

```bash
# List agents
GET /v1/agents
→ { "ok": true, "agents": [...] }

# Get agent config
GET /v1/agents/crew-coder/config

# Update agent config
PUT /v1/agents/crew-coder/config
{
  "model": "anthropic/claude-sonnet-4-5",
  "engine": "direct"
}
```

### Task Dispatch

```bash
# Dispatch task
POST /v1/dispatch
{
  "agent": "crew-coder",
  "task": "Write a login endpoint",
  "userId": "user123",
  "context": {"outputDir": "/tmp/project"}
}
→ { "ok": true, "taskId": "abc123" }

# Poll task status
GET /v1/tasks/abc123
→ { "ok": true, "status": "done", "result": "..." }
```

### Pipelines

```bash
# Run multi-agent pipeline
POST /v1/pipelines
{
  "userId": "user123",
  "steps": [
    {"wave": 1, "agent": "crew-coder", "task": "Write auth.ts"},
    {"wave": 2, "agent": "crew-qa", "task": "Test auth.ts"}
  ]
}
→ { "ok": true, "pipelineId": "xyz789" }

# Get pipeline status
GET /v1/pipelines/xyz789
→ { "ok": true, "status": "running", "currentWave": 1 }
```

### Skills

```bash
# List skills
GET /v1/skills
→ { "ok": true, "skills": [...] }

# Run skill
POST /v1/skills/twitter.post
{
  "params": {"text": "Hello world"}
}
→ { "ok": true, "result": {...} }
```

### Memory

```bash
# Query memory
GET /v1/memory?query=authentication&userId=user123&limit=10

# Add fact
POST /v1/memory/facts
{
  "userId": "user123",
  "agentId": "crew-lead",
  "content": "Use bcrypt for password hashing"
}
```

### Approvals

```bash
# List pending approvals
GET /v1/approval?userId=user123

# Approve action
POST /v1/approval/cmd-123456/approve
{
  "userId": "admin@company.com"
}

# Reject action
POST /v1/approval/cmd-123456/reject
{
  "userId": "admin@company.com"
}
```

## OpenAPI Specification

Full spec available at `http://localhost:5000/v1/openapi.json`

View interactive documentation:
- Swagger UI: `http://localhost:5000/docs`
- ReDoc: `https://redocly.github.io/redoc/?url=http://localhost:5000/v1/openapi.json`

## Client Generation

Generate typed clients from the OpenAPI spec:

```bash
# TypeScript client
npx openapi-typescript http://localhost:5000/v1/openapi.json \
  -o ./client/crewswarm-api.ts

# Python client
openapi-generator-cli generate \
  -i http://localhost:5000/v1/openapi.json \
  -g python \
  -o ./client/python
```

## Migration from Old APIs

### crew-lead (port 5010)

**Before:**
```bash
curl -X POST http://localhost:5010/api/chat \
  -d '{"message": "Hello"}'
```

**After:**
```bash
curl -X POST http://localhost:5000/v1/chat \
  -d '{"message": "Hello", "userId": "default", "sessionId": "default"}'
```

### Dashboard (port 4319)

**Before:**
```bash
curl http://localhost:4319/api/agents
```

**After:**
```bash
curl http://localhost:5000/v1/agents
```

## Implementation Status

- [x] OpenAPI specification
- [x] HTTP server with CORS
- [x] Health check endpoint
- [x] OpenAPI JSON endpoint
- [x] Swagger UI redirect
- [ ] Proxy to crew-lead for chat endpoints
- [ ] Proxy to dashboard for management endpoints
- [ ] Implement all endpoints
- [ ] Add authentication middleware
- [ ] Add rate limiting
- [ ] Add request logging

## Configuration

Set environment variables:

```bash
# API port
export CREWSWARM_API_PORT=5000

# Bind host
export CREWSWARM_BIND_HOST=0.0.0.0

# Enable API
export CREWSWARM_UNIFIED_API=1
```

## Security

1. **Authentication** - Bearer tokens required for all endpoints
2. **User isolation** - userId filters all queries
3. **Admin endpoints** - Config changes require admin role
4. **Rate limiting** - 100 requests/minute per user (planned)
5. **CORS** - Configurable allowed origins

## Future Enhancements

- [ ] GraphQL endpoint (`/v1/graphql`)
- [ ] WebSocket streaming (`/v1/ws`)
- [ ] Batch operations (`/v1/batch`)
- [ ] Webhooks (`/v1/webhooks`)
- [ ] API key management
- [ ] Request/response logging
- [ ] Metrics endpoint (`/v1/metrics`)
