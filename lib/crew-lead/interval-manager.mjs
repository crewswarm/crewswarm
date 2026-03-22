export function initIntervalManagers(deps) {
    const {
        sseThrottle,
        activeOpenCodeAgents,
        broadcastSSE,
        autoRetryAttempts,
    } = deps;

    // Cleanup throttle map every 5 minutes to prevent unbounded growth
    setInterval(() => {
        const now = Date.now();
        const stale = 5 * 60 * 1000; // 5 min
        for (const [key, ts] of sseThrottle.entries()) {
            if (now - ts > stale) sseThrottle.delete(key);
        }
    }, 5 * 60 * 1000);

    // Auto-clear stale inOpenCode sessions (prevents agents stuck as "busy")
    // If an agent emits agent_working but never emits agent_idle (crash/timeout),
    // this cleanup will mark it idle after 15 minutes
    setInterval(() => {
        const staleThresholdMs = 15 * 60 * 1000; // 15 min
        const now = Date.now();
        for (const [agentId, { since }] of activeOpenCodeAgents.entries()) {
            if (now - since > staleThresholdMs) {
                console.warn(`[crew-lead] Clearing stale inOpenCode for ${agentId} (active for ${Math.round((now - since) / 60000)}m)`);
                activeOpenCodeAgents.delete(agentId);
                broadcastSSE({ type: "agent_idle", agent: agentId, ts: now, stale: true });
            }
        }
    }, 60000); // Check every 60 seconds

    // Cleanup stale retry tracking every 5 minutes
    setInterval(() => {
        const now = Date.now();
        const AUTO_RETRY_TTL = 10 * 60 * 1000; // 10 min
        for (const [taskId, data] of autoRetryAttempts.entries()) {
            if (now - data.timestamp > AUTO_RETRY_TTL) autoRetryAttempts.delete(taskId);
        }
    }, 5 * 60 * 1000);
}
