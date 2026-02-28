# CrewSwarmCLI Project Structure

## Overview
CrewSwarmCLI is a command-line interface for orchestrating CrewSwarm agents. This document describes the project structure for Phase 1: Core Functionality.

## Directory Structure

```
crew-cli/
├── package.json              # Package configuration and dependencies
├── bin/
│   └── crew.js              # Executable entry point
├── src/
│   ├── cli/
│   │   └── index.js         # Main CLI application
│   ├── agent/
│   │   └── router.js        # Agent routing and dispatch logic
│   ├── tools/
│   │   └── manager.js       # Tool management and execution
│   ├── config/
│   │   └── manager.js       # Configuration management
│   └── utils/
│       └── logger.js        # Logging utilities
├── tests/                    # Test files (to be implemented)
├── docs/                     # Documentation
└── examples/                 # Usage examples (to be implemented)
```

## Core Components

### 1. CLI Entry Point (`bin/crew.js`)
- Executable script that bootstraps the CLI application
- Handles errors and process exit codes

### 2. CLI Application (`src/cli/index.js`)
- Main command-line interface using Commander.js
- Commands:
  - `dispatch <agent> <task>` - Dispatch tasks to agents
  - `list` - List available agents
  - `status` - Check system status
- Handles command parsing and execution

### 3. Agent Router (`src/agent/router.js`)
- Manages agent discovery and task routing
- Implements dispatch logic for agent communication
- Provides agent status information

### 4. Tool Manager (`src/tools/manager.js`)
- Manages available tools and their execution
- Provides extensible tool framework
- Handles tool lifecycle and error management

### 5. Configuration Manager (`src/config/manager.js`)
- Loads configuration from `~/.crewswarm/config.json`
- Provides default configuration for RT bus and endpoints
- Manages user-specific settings

### 6. Logger (`src/utils/logger.js`)
- Centralized logging with colored output
- Configurable log levels
- Consistent formatting across the application

## Dependencies

- **commander**: Command-line interface framework
- **chalk**: Terminal string styling
- **ora**: Loading spinners
- **inquirer**: Interactive command-line prompts
- **ws**: WebSocket client for RT bus communication
- **dotenv**: Environment variable loading

## Configuration

The CLI expects configuration in `~/.crewswarm/config.json`:
```json
{
  "rtBusUrl": "ws://localhost:18889",
  "crewLeadUrl": "http://localhost:5010",
  "dashboardUrl": "http://localhost:4319",
  "timeout": 30000,
  "agents": []
}
```

## Usage Examples

```bash
# Install dependencies
npm install

# Make executable
chmod +x bin/crew.js

# List available agents
./bin/crew.js list

# Dispatch a task
./bin/crew.js dispatch crew-coder "Create a new React component"

# Check system status
./bin/crew.js status
```

## Phase 1 Status

✅ CLI framework and command structure
✅ Configuration management
✅ Basic agent routing interface
✅ Tool management framework
✅ Logging utilities

🔲 Actual RT bus integration
🔲 Real agent discovery
🔲 Tool execution implementation
🔲 WebSocket communication
🔲 Comprehensive testing

## Next Steps (Phase 2)

- Implement actual RT bus communication
- Add WebSocket client for real-time messaging
- Implement agent discovery from RT bus
- Add tool execution handlers
- Create comprehensive test suite
- Add example usage scripts
