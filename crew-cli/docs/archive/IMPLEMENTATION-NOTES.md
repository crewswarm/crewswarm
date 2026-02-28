# crew-cli Implementation Notes

## Fix: Implemented Agent Router Dispatch Logic

### Problem
The `src/agent/router.js` file had placeholder TODO comments instead of actual implementation:
- `dispatch()` returned mock data instead of calling the CrewSwarm gateway
- `listAgents()` returned hardcoded agents instead of querying the gateway
- `getStatus()` returned hardcoded status instead of checking the gateway

This caused timeout errors when trying to dispatch tasks to agents like crew-coder.

### Solution
Implemented full HTTP client integration with the CrewSwarm gateway (port 5010):

#### 1. `dispatch(agentName, task, options)`
- Makes HTTP POST to `/api/dispatch` with agent, task, sessionId, and projectDir
- Receives taskId from the gateway
- Polls `/api/status/:taskId` every 2 seconds until completion or timeout
- Returns result with success status, taskId, and agent response

#### 2. `pollTaskStatus(gatewayUrl, taskId, timeoutMs)`
- Polls the gateway status endpoint every 2 seconds
- Returns when status is 'done' or 'error'
- Throws timeout error after configured timeout (default 300s)

#### 3. `listAgents()`
- Queries `/status` endpoint to get list of available agents
- Maps agent names to roles (Full Stack Coder, QA, etc.)
- Falls back to default agent list if gateway unreachable

#### 4. `getStatus()`
- Queries `/status` endpoint for system health
- Returns agent count, RT bus status, and gateway connection status
- Handles errors gracefully with fallback responses

### Configuration
The router uses `ConfigManager` to get the gateway URL:
- Default: `http://localhost:5010`
- Configurable via `~/.crewswarm/config.json` (`crewLeadUrl` key)
- Can be overridden per-dispatch via options.gateway

### API Endpoints Used
- `POST /api/dispatch` - Dispatch task to agent
- `GET /api/status/:taskId` - Poll for task completion
- `GET /status` - Get system status and agent list

### Testing
To test the implementation:

```bash
# Start the CrewSwarm gateway first
cd /Users/jeffhobbs/Desktop/CrewSwarm
npm run crew-lead

# In another terminal, test the CLI
cd /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli
npm start dispatch crew-coder "Fix the authentication bug"
```

### Files Changed
- `src/agent/router.js` - Implemented all TODO functions with HTTP client logic
