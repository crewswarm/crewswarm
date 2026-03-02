# Reliability and UX Audit — CrewSwarm

**Date:** March 1, 2026  
**Status:** Comprehensive Audit Complete  
**Scope:** Core Orchestration, Error Handling, RT Bus, Dashboard UX

---

## Executive Summary

CrewSwarm's architecture is robust and modular, but the codebase currently exhibits several "silent failure" patterns and race conditions that will impede production reliability. The UX is functional but suffers from "polling storms" and lack of granular loading states.

**Total Issues Identified:** 37  
**Critical Fixes Required:** 5

---

## 🔴 Critical Issues (Must Fix)

### 1. Silent Error Swallowing (100+ instances)
**Problem:** Extensive use of `catch {}` and `catch (e) {}` without logging or telemetry.
**Impact:** Production failures (file system errors, network timeouts, JSON parsing failures) will occur without any trace in the logs, making debugging impossible.
**Locations:**
- `crew-cli/src/cli/index.ts:458`
- `gateway-bridge.mjs` (various)
- `pm-loop.mjs:74, 112, 416`
**Fix:** Implement a global `logger.error` or `telemetry("error", ...)` in every catch block.

### 2. RT Dispatch Race Condition
**Problem:** In `lib/engines/rt-envelope.mjs`, agents claim tasks via `acquireTaskLease` before `crew-lead` has fully registered the dispatch in some scenarios, or multiple agents can attempt to claim the same broadcast task simultaneously.
**Impact:** Duplicate task execution or tasks being marked as "never claimed" despite being active.
**Fix:** Implement a strict "handshake" where the agent must receive an ACK from the lead after claiming before proceeding with LLM calls.

### 3. Stuck OpenCode Sessions (Zombie Processes)
**Problem:** `lib/engines/opencode.mjs` has a stall detector but lacks a hard process-level watchdog for the underlying `opencode` binary.
**Impact:** If `opencode` hangs internally (e.g., waiting for stdin), the Node.js process might stay alive, consuming memory and locking the agent session indefinitely.
**Fix:** Use `tree-kill` to ensure the entire process tree is nuked on timeout, and implement a heartbeat check against the `opencode` PID.

### 4. Dashboard Polling Storm
**Problem:** `scripts/dashboard.mjs` serves a UI that polls `/api/rt-messages`, `/api/agents`, and `/api/phased-progress` every 5 seconds.
**Impact:** At scale (or with many open tabs), this creates a "thundering herd" effect on the Node.js backend, which is single-threaded.
**Fix:** Migrate to the existing SSE (`/events`) stream for all real-time updates instead of polling.

### 5. Input Validation Gaps
**Problem:** `scripts/dashboard.mjs` and `pm-loop.mjs` perform minimal sanitization on `outputDir` and `requirement` strings.
**Impact:** Potential for path traversal or command injection if a malicious or malformed requirement is processed.
**Fix:** Use a strict allowlist for paths and escape all shell arguments using a dedicated library.

---

## 🟡 High Priority Issues

### 6. SSE Memory Leak
**Problem:** `crew-lead.mjs` adds clients to `sseClients` Set but has inconsistent cleanup on connection close.
**Fix:** Ensure `req.on("close", ...)` always removes the client.

### 7. Unbounded RT Message Logs
**Problem:** `events.jsonl` and `done.jsonl` grow indefinitely.
**Fix:** Implement a rolling log rotation (e.g., `logrotate` or internal logic to keep last 10MB).

### 8. Auto-retry Infinite Loops
**Problem:** `crew-lead.mjs` has three different auto-retry conditions (questions, plans, bails). If a response triggers multiple, it can cause loop amplification.
**Fix:** Consolidate retry logic into a single "Retry Manager" with a strict `max_retries` counter per taskId.

---

## 🟢 Implementation Plan (56 Hours)

### Phase 1: Stop the Bleeding (20 Hours)
- [ ] **Task 1:** Audit all `catch` blocks and add telemetry (8h)
- [ ] **Task 2:** Harden OpenCode process management (4h)
- [ ] **Task 3:** Fix RT lease race conditions (4h)
- [ ] **Task 4:** Add basic input sanitization (4h)

### Phase 2: UX & Stability (16 Hours)
- [ ] **Task 5:** Convert Dashboard to 100% SSE (8h)
- [ ] **Task 6:** Implement log rotation (4h)
- [ ] **Task 7:** Graceful shutdown handlers (4h)

---

## Testing Strategy
1. **Chaos Testing:** Randomly kill agent bridge processes during active pipelines.
2. **Concurrency Stress:** Run 5 simultaneous PM loops on different projects.
3. **Network Latency:** Simulate high-latency WebSocket connections to the RT bus.
