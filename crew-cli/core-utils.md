# Core Utility Functions

This document lists the core utility functions used throughout the CrewSwarm project.

## File System Utilities

### from gateway-bridge.mjs
- `async ensureDirectoryExists(path)` - Creates directory if it doesn't exist
- `async writeFile(path, content)` - Writes content to file with directory creation
- `async readFile(path)` - Reads file content safely
- `async appendFile(path, content)` - Appends content to existing file

### from crew-lead.mjs
- `async ensureDirectoryExists(path)` - Creates directory if it doesn't exist
- `async writeFile(path, content)` - Writes content to file with directory creation
- `async readFile(path)` - Reads file content safely

## Network/HTTP Utilities

### from crew-lead.mjs
- `async fetchWithTimeout(url, options = {})` - HTTP fetch with timeout
- `createSseResponse(res)` - Creates Server-Sent Events response
- `sendSseData(res, data)` - Sends SSE data to client

### from gateway-bridge.mjs
- `async fetchWithTimeout(url, options = {})` - HTTP fetch with timeout
- `setupCors(res)` - Sets up CORS headers

## System/Process Utilities

### from gateway-bridge.mjs
- `getAgentConfig(agentName)` - Retrieves agent configuration
- `updateAgentConfig(agentName, updates)` - Updates agent configuration
- `broadcastMessage(message)` - Broadcasts message to all agents
- `sendToAgent(agentName, message)` - Sends message to specific agent

### from opencrew-rt-daemon.mjs
- `setupWebSocketServer()` - Sets up WebSocket server
- `broadcastToClients(message)` - Broadcasts to WebSocket clients
- `handleClientConnection(ws)` - Handles WebSocket client connections

## Validation/Security Utilities

### from gateway-bridge.mjs
- `validateAgentPermissions(agentName, toolName)` - Validates agent tool permissions
- `sanitizeInput(input)` - Sanitizes user input
- `logActivity(agentName, action, details)` - Logs agent activities

## Configuration Utilities

### from crew-lead.mjs
- `loadConfig()` - Loads system configuration
- `saveConfig(config)` - Saves system configuration
- `getEngineConfig(engineName)` - Gets engine-specific configuration

## Error Handling Utilities

### Common across files
- `handleError(error, context)` - Centralized error handling
- `sanitizeError(error)` - Removes sensitive info from errors
- `retryAsync(fn, maxRetries, delay)` - Retries async operations

## Data Processing Utilities

### from gateway-bridge.mjs
- `parseJsonSafely(jsonString)` - Safely parses JSON
- `formatResponse(data, error)` - Standardizes response format
- `extractStackTrace(error)` - Extracts clean stack trace

## Time/Date Utilities

### Common functions
- `formatDuration(ms)` - Formats milliseconds to human readable
- `getTimestamp()` - Gets standardized timestamp
- `sleep(ms)` - Async delay utility

## Agent Communication Utilities

### from gateway-bridge.mjs
- `dispatchTask(agentName, task)` - Dispatches task to agent
- `getAgentStatus(agentName)` - Gets agent status
- `waitForAgentResponse(agentName, timeout)` - Waits for agent response

## Security/Auth Utilities

### from crew-lead.mjs
- `validateApiKey(key)` - Validates API key
- `generateSessionId()` - Generates secure session ID
- `hashSecret(secret)` - Hashes sensitive data

## File Path Utilities

### Common functions
- `resolvePath(basePath, relativePath)` - Safely resolves paths
- `isSafePath(path)` - Checks for path traversal attacks
- `getFileExtension(filename)` - Gets file extension safely

## Logging Utilities

### Common across files
- `logInfo(message, data)` - Info level logging
- `logError(message, error)` - Error level logging
- `logDebug(message, data)` - Debug level logging

## System Info Utilities

### from opencrew-rt-daemon.mjs
- `getSystemStatus()` - Gets system health status
- `getConnectedClients()` - Gets connected client count
- `getUptime()` - Gets server uptime

## Message Processing Utilities

### from gateway-bridge.mjs
- `parseMessage(message)` - Parses incoming messages
- `createResponse(type, data)` - Creates standardized responses
- `validateMessageFormat(message)` - Validates message structure

## Environment Utilities

### Common functions
- `getEnvVar(name, defaultValue)` - Safely gets environment variables
- `isDevelopment()` - Checks if running in development mode
- `getSystemInfo()` - Gets system information
