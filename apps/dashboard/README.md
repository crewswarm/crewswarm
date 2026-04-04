# crewswarm-dashboard

Real-time control panel for CrewSwarm. Vanilla JS + Vite, no framework dependencies.

## Development

```bash
cd apps/dashboard
npm install
npm run dev        # http://localhost:5173
```

## Build

```bash
npm run build      # outputs to dist/
npm run preview    # preview production build
```

## Structure

```
src/
  app.js              # Main app entry, tab routing, SSE connections
  styles.css          # Global styles (dark theme)
  chat/               # Chat tab (crew-lead conversation)
  tabs/               # Tab modules (Build, Swarm, Agents, Engines, etc.)
  components/         # Shared UI components
  core/               # Core utilities (SSE, state, API client)
  cli-process.js      # CLI Process tab
  setup-wizard.js     # First-run setup wizard
  orchestration-status.js  # Pipeline status display
```

## Key tabs

- **Chat** -- Talk to crew-lead, dispatch tasks
- **Build** -- One-click build from a requirement
- **Swarm** -- Active sessions and agent activity
- **Agents** -- Configure sub-agents, models, permissions
- **Engines** -- Manage CLI engines (Claude Code, Codex, Gemini, Cursor)
- **RT Messages** -- Live message bus inspector
- **Services** -- Health status of all services

## Notes

- Connects to crew-lead at `http://localhost:5010` by default
- All state comes from SSE streams and REST API -- no local state management
- Brotli-compressed `.br` files are pre-built for production serving
