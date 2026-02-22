/**
 * CrewSwarm plugin for OpenClaw
 *
 * Gives every OpenClaw agent access to a local CrewSwarm crew via:
 *   • crewswarm_dispatch  — agent tool (call crew-coder, crew-qa, etc.)
 *   • crewswarm_status    — agent tool (poll a previously dispatched task)
 *   • crewswarm_agents    — agent tool (list available agents)
 *   • /crewswarm          — slash command (dispatch from any channel)
 *   • crewswarm.dispatch  — Gateway RPC
 *   • crewswarm.status    — Gateway RPC
 *   • crewswarm.agents    — Gateway RPC
 *
 * Config (plugins.entries.crewswarm.config):
 *   url            — crew-lead base URL  (default: http://127.0.0.1:5010)
 *   token          — RT auth token from ~/.crewswarm/config.json → rt.authToken
 *   pollIntervalMs — status poll cadence (default: 4000)
 *   pollTimeoutMs  — max wait for a result (default: 300000 = 5 min)
 */

interface CrewSwarmConfig {
  url?: string;
  token: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface DispatchResult {
  ok: boolean;
  taskId?: string;
  agent?: string;
  error?: string;
}

interface StatusResult {
  ok: boolean;
  taskId: string;
  status: "pending" | "done" | "unknown";
  agent?: string;
  result?: string;
  elapsedMs?: number;
  error?: string;
}

function getConfig(api: any): CrewSwarmConfig {
  return api.config?.plugins?.entries?.crewswarm?.config ?? {};
}

function baseUrl(cfg: CrewSwarmConfig): string {
  return (cfg.url ?? "http://127.0.0.1:5010").replace(/\/$/, "");
}

function authHeaders(cfg: CrewSwarmConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.token}`,
  };
}

async function apiDispatch(
  base: string,
  headers: Record<string, string>,
  agent: string,
  task: string,
  verify?: string,
  done?: string,
): Promise<DispatchResult> {
  try {
    const body: Record<string, string> = { agent, task };
    if (verify) body.verify = verify;
    if (done) body.done = done;
    const res = await fetch(`${base}/api/dispatch`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return res.json() as Promise<DispatchResult>;
  } catch (e: any) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
}

async function apiStatus(
  base: string,
  headers: Record<string, string>,
  taskId: string,
): Promise<StatusResult> {
  try {
    const res = await fetch(`${base}/api/status/${taskId}`, { headers });
    return res.json() as Promise<StatusResult>;
  } catch (e: any) {
    return { ok: false, taskId, status: "unknown", error: `Network error: ${e.message}` };
  }
}

async function apiAgents(
  base: string,
  headers: Record<string, string>,
): Promise<string[]> {
  try {
    const res = await fetch(`${base}/api/agents`, { headers });
    const data = await res.json() as { ok: boolean; agents: string[] };
    return data.agents ?? [];
  } catch {
    return [];
  }
}

/** Dispatch and wait for result, polling until done or timeout */
async function dispatchAndWait(
  api: any,
  agent: string,
  task: string,
  verify?: string,
  done?: string,
): Promise<string> {
  const cfg = getConfig(api);
  if (!cfg.token) return "Error: no CrewSwarm token configured (plugins.entries.crewswarm.config.token)";

  const base = baseUrl(cfg);
  const headers = authHeaders(cfg);
  const pollMs = cfg.pollIntervalMs ?? 4000;
  const timeoutMs = cfg.pollTimeoutMs ?? 300_000;

  const dispatch = await apiDispatch(base, headers, agent, task, verify, done);
  if (!dispatch.ok || !dispatch.taskId) {
    return `Error dispatching to ${agent}: ${dispatch.error ?? "unknown error"}`;
  }

  const taskId = dispatch.taskId;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const s = await apiStatus(base, headers, taskId);
    if (s.status === "done") return s.result ?? "(no result)";
    if (s.status === "unknown") return `Error: task ${taskId} not found`;
  }

  return `Timeout: ${agent} did not complete within ${timeoutMs / 1000}s (taskId: ${taskId})`;
}

export default function register(api: any) {
  // ── Agent tools ───────────────────────────────────────────────────────────

  api.registerTool({
    name: "crewswarm_dispatch",
    description:
      "Dispatch a task to a CrewSwarm specialist agent and wait for the result. " +
      "Use this to delegate coding, QA, writing, security review, or any other task " +
      "to the appropriate crew member. The call blocks until the agent replies.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description:
            "Target agent id. Common values: crew-coder, crew-qa, crew-fixer, " +
            "crew-pm, crew-security, crew-copywriter, crew-frontend, crew-coder-back. " +
            "Call crewswarm_agents first if unsure.",
        },
        task: {
          type: "string",
          description: "Full task description for the agent.",
        },
        verify: {
          type: "string",
          description:
            "Optional: how the agent should verify its output (e.g. 'curl returns 200').",
        },
        done: {
          type: "string",
          description:
            "Optional: explicit done condition (e.g. 'file contains const express').",
        },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    handler: async ({ agent, task, verify, done }: {
      agent: string; task: string; verify?: string; done?: string;
    }) => {
      return dispatchAndWait(api, agent, task, verify, done);
    },
  });

  api.registerTool({
    name: "crewswarm_status",
    description:
      "Poll the status of a previously dispatched CrewSwarm task by taskId. " +
      "Returns pending, done (with result), or unknown.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "taskId returned by crewswarm_dispatch" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    handler: async ({ taskId }: { taskId: string }) => {
      const cfg = getConfig(api);
      if (!cfg.token) return "Error: no CrewSwarm token configured";
      const s = await apiStatus(baseUrl(cfg), authHeaders(cfg), taskId);
      if (s.status === "done") return `Done: ${s.result}`;
      if (s.status === "pending") return `Pending (${s.elapsedMs ?? 0}ms elapsed)`;
      return `Unknown task: ${taskId}`;
    },
  });

  api.registerTool({
    name: "crewswarm_agents",
    description: "List all available CrewSwarm agents by id.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const cfg = getConfig(api);
      if (!cfg.token) return "Error: no CrewSwarm token configured";
      const agents = await apiAgents(baseUrl(cfg), authHeaders(cfg));
      return agents.length
        ? `Available agents:\n${agents.map((a) => `  • ${a}`).join("\n")}`
        : "No agents found — is crew-lead running?";
    },
  });

  // ── Slash command: /crewswarm <agent> <task> ──────────────────────────────

  api.registerCommand({
    name: "crewswarm",
    description: "Dispatch a task to CrewSwarm. Usage: /crewswarm <agent> <task>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = (ctx.args ?? "").trim();
      if (!args) {
        const cfg = getConfig(api);
        const agents = await apiAgents(baseUrl(cfg), authHeaders(cfg));
        return {
          text: agents.length
            ? `CrewSwarm agents: ${agents.join(", ")}\n\nUsage: /crewswarm <agent> <task>`
            : "crew-lead not reachable. Is CrewSwarm running?",
        };
      }

      const [agent, ...rest] = args.split(" ");
      const task = rest.join(" ").trim();
      if (!task) return { text: `Usage: /crewswarm <agent> <task>\nExample: /crewswarm crew-coder write hello.js` };

      const result = await dispatchAndWait(api, agent, task);
      return { text: `[${agent}]: ${result}` };
    },
  });

  // ── Gateway RPC ───────────────────────────────────────────────────────────

  api.registerGatewayMethod("crewswarm.dispatch", async ({ params, respond }: any) => {
    const { agent, task, verify, done } = params ?? {};
    if (!agent || !task) {
      respond(false, { error: "agent and task are required" });
      return;
    }
    const cfg = getConfig(api);
    const dispatch = await apiDispatch(baseUrl(cfg), authHeaders(cfg), agent, task, verify, done);
    respond(dispatch.ok, dispatch);
  });

  api.registerGatewayMethod("crewswarm.status", async ({ params, respond }: any) => {
    const { taskId } = params ?? {};
    if (!taskId) { respond(false, { error: "taskId required" }); return; }
    const cfg = getConfig(api);
    const s = await apiStatus(baseUrl(cfg), authHeaders(cfg), taskId);
    respond(s.ok, s);
  });

  api.registerGatewayMethod("crewswarm.agents", async ({ respond }: any) => {
    const cfg = getConfig(api);
    const agents = await apiAgents(baseUrl(cfg), authHeaders(cfg));
    respond(true, { agents });
  });

  // ── Background health check (logs warning on startup if unreachable) ──────

  api.registerService({
    id: "crewswarm-health",
    start: async () => {
      const cfg = getConfig(api);
      if (!cfg.token) {
        api.logger?.warn("[crewswarm] No token configured — set plugins.entries.crewswarm.config.token");
        return;
      }
      try {
        const res = await fetch(`${baseUrl(cfg)}/health`);
        const data = await res.json() as { ok: boolean };
        if (data.ok) {
          api.logger?.info(`[crewswarm] Connected to crew-lead at ${baseUrl(cfg)}`);
        } else {
          api.logger?.warn(`[crewswarm] crew-lead health check returned not-ok`);
        }
      } catch {
        api.logger?.warn(`[crewswarm] crew-lead unreachable at ${baseUrl(cfg)} — start CrewSwarm first`);
      }
    },
    stop: () => {},
  });
}
