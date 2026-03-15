# crew-cli Quick Start

## Installation

```bash
cd /Users/jeffhobbs/Desktop/crewswarm/crew-cli
npm install
chmod +x bin/crew.js
```

## Prerequisites

The crew-cli requires the crewswarm gateway to be running:

```bash
# In a separate terminal
cd /Users/jeffhobbs/Desktop/crewswarm
npm run crew-lead
```

The gateway should start on port 5010.

## Usage

### Check System Status
```bash
./bin/crew.js status
```

Expected output:
```
System Status:
Agents Online: 10
Tasks Active: 0
RT Bus: connected
```

### List Available Agents
```bash
./bin/crew.js list
```

Expected output:
```
✓ crew-coder - Full Stack Coder
✓ crew-qa - Quality Assurance
✓ crew-fixer - Bug Fixer
✓ crew-frontend - UI/UX Specialist
✓ crew-coder-back - Backend Specialist
...
```

### Dispatch a Task
```bash
./bin/crew.js dispatch crew-coder "Fix authentication bug in auth.js"
```

### Speculative Execution
Compare multiple implementation strategies in parallel:
```bash
crew explore "refactor the database layer"
```

### Natural Language Shell
Translate your intent into an exact shell command:
```bash
crew shell "list all large files in src sorted by size"
```

### GitHub Intelligence
Run health checks and perform issue/PR actions with natural language:
```bash
crew github doctor
crew github "create issue 'Add rate limiting' body: describe steps here" --dry-run
```

### Interactive Terminal
Run interactive tools directly with PTY support:
```bash
crew exec "vim src/app.js"
```

### Parallel Planning
Execute complex multi-step plans in parallel:
```bash
crew plan "implement user dashboard" --parallel --concurrency 4
```

## Configuration

Create `~/.crewswarm/config.json` to customize settings:

```json
{
  "crewLeadUrl": "http://localhost:5010",
  "rtBusUrl": "ws://localhost:18889",
  "dashboardUrl": "http://localhost:4319",
  "timeout": 300000,
  "agents": []
}
```

## Troubleshooting

### "Gateway not reachable"
- Ensure the crewswarm gateway is running: `npm run crew-lead`
- Check the gateway is on port 5010: `curl http://localhost:5010/health`

### "Timeout waiting for agent"
- Check if the RT bus is connected: `./bin/crew.js status`
- Increase timeout: `--timeout 600000` (10 minutes)
- Check agent logs in the crewswarm dashboard

### "Agent not found"
- List available agents: `./bin/crew.js list`
- Use exact agent name: `crew-coder` not `coder`

## Architecture

```
┌─────────────┐
│  crew-cli   │  Your command-line interface
└──────┬──────┘
       │ HTTP POST /api/dispatch
       ↓
┌─────────────┐
│  crew-lead  │  Gateway (port 5010)
└──────┬──────┘
       │ WebSocket RT bus (port 18889)
       ↓
┌─────────────┐
│   Agents    │  crew-coder, crew-qa, crew-fixer, etc.
└─────────────┘
```

## Development

Run tests:
```bash
npm test
# or
node --test tests/
```

Lint code:
```bash
npm run lint
```

Check syntax:
```bash
npm run check
```

## Features Ready for Launch

- [x] **Session State Management** (via `.crew/session.json`)
- [x] **Git Context Auto-Injection** (automated prompts)
- [x] **OAuth Token Finder** (`crew auth`)
- [x] **Sandbox Mode** (`crew preview`, `crew branch`)
- [x] **Plan-First Workflow** (`crew plan`)
- [x] **Automated Debugging** (`crew apply --check`)
- [x] **Voice & Browser Debugging** (`crew listen`, `crew browser-debug`)
- [x] **Multi-Repo & Team Sync** (`crew repos-scan`, `crew sync`)
- [x] **Speculative Execution** (`crew explore`)
- [x] **DevEx Intelligence** (`crew lsp-check`, `crew map --graph`, `crew docs`)

See `ROADMAP.md` for full completion status.
