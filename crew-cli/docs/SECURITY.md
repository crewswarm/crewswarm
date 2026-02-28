# Security Policy

## Supported Versions

Only the latest major version (`v0.1.x` and above) receives security updates.

## Reporting a Vulnerability

Please do not open a public issue for security vulnerabilities. Instead, responsibly disclose them by emailing security@crewswarm.ai.

We will acknowledge receipt within 48 hours and provide a timeline for resolution.

## Security Architecture

1. **Local-First Executions**: All codebase modifications are staged in the `.crew/sandbox.json` sandbox. Files are never overwritten without explicit application (`crew apply`).
2. **Token Privacy**: `crew-cli` discovers local tokens (`crew auth`) strictly to facilitate local API connections. These tokens are never transmitted to telemetry or remote servers other than the explicit LLM provider (Anthropic, OpenAI, Google) or your local CrewSwarm gateway.
3. **Subprocess execution**: Child processes and shell commands executed by the CLI are spawned carefully using native Node `child_process` methods, avoiding shell interpolation where not strictly necessary, to prevent arbitrary command injection.
