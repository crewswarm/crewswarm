# CrewSwarm VS Code Extension

Multi-agent AI coding assistant. Dispatch 20+ specialist agents directly from your editor.

## Features

- **Chat with Stinki**: Direct access to crew-lead (Stinki) in a VS Code panel
- **Agent Dispatch**: Send tasks to specialist agents (crew-coder, crew-qa, crew-security, etc.)
- **Real-time Communication**: WebSocket connection to CrewSwarm runtime
- **Context-Aware**: Agents see your current file, selection, and workspace

## Prerequisites

CrewSwarm must be running on your system:

```bash
# Install CrewSwarm
git clone https://github.com/crewswarm/CrewSwarm
cd CrewSwarm
npm install
bash install.sh

# Start services
npm run restart-all
```

## Installation

### From VSIX (Local Install)
```bash
cd crew-cli/extensions/vscode
npm install
npm run compile
vsce package
code --install-extension crewswarm-0.1.0.vsix
```

### From Source (Development)
```bash
cd crew-cli/extensions/vscode
npm install
npm run compile
code --extensionDevelopmentPath=$(pwd)
```

## Usage

### Open Chat Panel
1. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type "CrewSwarm: Open Chat"
3. Press Enter

OR use keybinding: `Cmd+Shift+C` / `Ctrl+Shift+C`

### Send a Message
Type in the chat input and press Enter. Stinki (crew-lead) will respond.

### Dispatch an Agent
```
dispatch crew-coder to refactor this function
```

Stinki routes the task to the appropriate agent.

## Configuration

Open VS Code Settings (`Cmd+,`) and search for "CrewSwarm":

- **API URL**: Base URL for CrewSwarm API (default: `http://127.0.0.1:5010/v1`)
- **Theme**: Chat panel theme (dark or light)

## Troubleshooting

**"Failed to connect to CrewSwarm"**
- Check if crew-lead is running: `curl http://127.0.0.1:5010/health`
- If not: `cd ~/CrewSwarm && npm run restart-all`

**"Extension failed to activate"**
- Recompile: `npm run compile`
- Check for errors in Output panel (View → Output → Extension Host)

**Webview is blank**
- Open Developer Tools: `Cmd+Shift+P` → "Developer: Toggle Developer Tools"
- Check Console for JavaScript errors

## Development

### Project Structure
```
vscode/
├── package.json          Extension manifest
├── tsconfig.json         TypeScript config
├── src/
│   ├── extension.ts      Entry point
│   ├── api-client.ts     CrewSwarm API wrapper
│   ├── diff-handler.ts   Code diff parsing
│   └── webview/
│       ├── chat.html     Chat UI
│       ├── chat.js       Frontend logic
│       └── styles.css    Styling
└── out/                  Compiled JavaScript
```

### Build
```bash
npm run compile
```

### Watch Mode
```bash
npm run watch
```

### Package
```bash
npm install -g @vscode/vsce
vsce package
```

### Publish
```bash
vsce publish
```

## Roadmap

- [ ] Custom Activity Bar icon with agent status
- [ ] Inline code suggestions from agents
- [ ] Task panel showing active/completed agent work
- [ ] Context menu: "Dispatch to CrewSwarm"
- [ ] Agent selection dropdown
- [ ] Real-time task progress indicators
- [ ] Multi-file diff preview
- [ ] Agent memory viewer
- [ ] Full CrewSwarm color theme

## License

MIT

## Links

- [CrewSwarm GitHub](https://github.com/crewswarm/CrewSwarm)
- [Documentation](https://crewswarm.com/docs)
- [Report Issues](https://github.com/crewswarm/CrewSwarm/issues)
