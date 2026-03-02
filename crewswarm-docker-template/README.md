# CrewSwarm Docker Template

Deploy a multi-agent system on Docker.

## What's Included

| Agent           | Pattern      | Description                              |
| --------------- | ------------ | ---------------------------------------- |
| Knowledge Agent | Agentic RAG  | Answers questions from a knowledge base. |
| MCP Agent       | MCP Tool Use | Connects to external services via MCP.   |
| Assistant Agent | General      | Helpful assistant with memory.           |

## Quick Start

```bash
# Clone the template
git clone https://github.com/your-org/crewswarm-docker-template.git agentos
cd agentos

# Add API keys
cp example.env .env
# Edit .env and add your OPENAI_API_KEY or GROQ_API_KEY

# Start the application
docker compose up -d --build

# Load documents for the knowledge agent (optional)
docker exec -it crewswarm-api node agents/knowledge_agent.mjs --load

# Check health
curl http://localhost:4319/api/health
```

Confirm CrewSwarm is running at <http://localhost:4319>

### Connect to the Dashboard

The dashboard is available at `http://localhost:4319`

1. Open your browser to <http://localhost:4319>
2. Click on the **Chat** tab
3. Start chatting with your agents

For the full AgentOS UI with tracing and monitoring:

1. Open [os.agno.com](https://os.agno.com) (optional, not required)
2. Add OS → Local → `http://localhost:4319`
3. Click "Connect"

## The Agents

### Knowledge Agent

Answers questions using semantic search over a vector database (Agentic RAG).

**Load documents:**

```bash
# Add your own documents
mkdir -p data/docs
cp your-docs.pdf data/docs/

# Load into vector DB
docker exec -it crewswarm-api node agents/knowledge_agent.mjs --load
```

**Try it:**

```
What is CrewSwarm?
How do I create my first agent?
What documents are in your knowledge base?
```

### MCP Agent

Connects to external tools via the Model Context Protocol.

**Try it:**

```
What tools do you have access to?
Search the docs for deployment guides
Find examples of agents with memory
```

### Assistant Agent

General-purpose assistant with memory and tool use.

**Try it:**

```
Help me plan a project roadmap
Write a README for my new repo
What did we discuss last time?
```

## Common Tasks

### Add your own agent

1. Create `agents/my_agent.mjs`:

```javascript
import { Agent } from '../node_modules/agno/agent/index.js';
import { OpenAI } from '../node_modules/agno/models/openai/index.js';
import { getPostgresDb } from './db/index.mjs';

export const myAgent = new Agent({
    id: "my-agent",
    name: "My Agent",
    model: new OpenAI({ id: "gpt-4o" }),
    db: getPostgresDb(),
    instructions: "You are a helpful assistant.",
    add_history_to_messages: true,
});
```

2. Register in `app/main.mjs`:

```javascript
import { myAgent } from '../agents/my_agent.mjs';

const agentOs = new AgentOS({
    name: "CrewSwarm",
    agents: [knowledgeAgent, mcpAgent, assistantAgent, myAgent],
    // ...
});
```

3. Rebuild: `docker compose up -d --build`

### Add tools to an agent

CrewSwarm includes 100+ tool integrations.

```javascript
import { SlackTools } from '../node_modules/agno/tools/slack/index.js';
import { GoogleCalendarTools } from '../node_modules/agno/tools/google_calendar/index.js';

export const myAgent = new Agent({
    // ...
    tools: [
        new SlackTools(),
        new GoogleCalendarTools(),
    ],
});
```

### Use a different model provider

1. Add your API key to `.env` (e.g., `ANTHROPIC_API_KEY`)
2. Update agents to use the new provider:

```javascript
import { Claude } from '../node_modules/agno/models/anthropic/index.js';

const agent = new Agent({
    model: new Claude({ id: "claude-sonnet-4-5" }),
    // ...
});
```

3. Add dependency to `package.json` and rebuild

---

## Local Development

For development without Docker:

```bash
# Install dependencies
npm install

# Start PostgreSQL (required)
docker compose up -d crewswarm-db

# Set environment
cp example.env .env
export $(cat .env | xargs)

# Run the app
node app/main.mjs
```

## Environment Variables

| Variable         | Required | Default   | Description                |
| ---------------- | -------- | --------- | -------------------------- |
| OPENAI_API_KEY   | No*      | -         | OpenAI API key             |
| GROQ_API_KEY     | No*      | -         | Groq API key (free)        |
| ANTHROPIC_API_KEY| No*      | -         | Anthropic API key          |
| DB_HOST          | No       | localhost | Database host              |
| DB_PORT          | No       | 5432      | Database port              |
| DB_USER          | No       | crewswarm | Database user              |
| DB_PASS          | No       | crewswarm | Database password          |
| DB_DATABASE      | No       | crewswarm | Database name              |
| RUNTIME_ENV      | No       | prd       | Set to dev for auto-reload |
| CREW_LEAD_PORT   | No       | 5010      | crew-lead API port         |
| SWARM_DASH_PORT  | No       | 4319      | Dashboard port             |

*At least one model provider key is required.

## Architecture

```
┌─────────────────┐
│   Dashboard     │  Port 4319 - Web UI
│   (Vite + API)  │
└────────┬────────┘
         │
┌────────▼────────┐
│   crew-lead     │  Port 5010 - Chat & dispatch
│  (Coordinator)  │
└────────┬────────┘
         │
┌────────▼────────┐
│  Gateway Bridge │  Agent daemons
│   (Executors)   │  - knowledge-agent
└────────┬────────┘  - mcp-agent
         │            - assistant-agent
┌────────▼────────┐
│   RT Bus        │  Port 18889 - WebSocket
│  (Message Bus)  │
└────────┬────────┘
         │
┌────────▼────────┐
│   PostgreSQL    │  Port 5432
│   (State)       │
└─────────────────┘
```

## Learn More

* [CrewSwarm Documentation](https://github.com/your-org/CrewSwarm/tree/main/docs)
* [CrewSwarm Discord](https://discord.gg/crewswarm)
* [Agno Documentation](https://docs.agno.com)

## License

Apache 2.0
