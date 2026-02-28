# Troubleshooting Guide

This guide helps you resolve common issues encountered while using `crew-cli`.

## General Issues

### `Gateway not reachable` or `Connection Refused`
**Symptom:** The CLI fails immediately when running `crew dispatch` or `crew chat`.
**Cause:** The local CrewSwarm gateway is not running or is on a different port.
**Fix:**
1. Ensure the gateway is running: `cd /path/to/CrewSwarm && node crew-lead.mjs`
2. Verify the port in `~/.crewswarm/config.json`. It defaults to `http://localhost:5010`.

### `Unauthorized — Bearer token required`
**Symptom:** The CLI connects to the gateway but tasks fail.
**Cause:** The CrewSwarm API requires authentication, but no token is found in the local config.
**Fix:**
Ensure your `~/.crewswarm/config.json` has the correct authentication setup or use the `crew auth` command to find local tokens to integrate into your global config.

### `esbuild: command not found`
**Symptom:** Build fails.
**Cause:** Development dependencies are missing.
**Fix:** Run `npm install` in the project root.

## Sandbox Issues

### `Branch "..." not found`
**Cause:** You are trying to switch to or merge a branch that hasn't been created.
**Fix:** Run `crew branches` to see available branches, or create it via `crew branch <name>`.

### Changes are not applying correctly (Search block not found)
**Symptom:** When the agent tries to edit a file, the `Orchestrator` logs an error about "Search block not found".
**Cause:** The code agent hallucinated the original code or used incorrect indentation/spacing in the `<<<<<< SEARCH` block.
**Fix:** 
1. The Sandbox uses exact matching for safety.
2. Provide a clearer prompt to the agent, or manually open the file, make the change, and run `crew chat "I fixed it manually, moving on."`

## Diagnostics

Use the built-in diagnostic tool to check your environment:

```bash
crew doctor
```

This will verify Node.js version, Git installation, Config presence, and Gateway reachability.
