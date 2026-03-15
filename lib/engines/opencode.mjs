import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";

let _deps = {};

export function initOpenCode(deps) {
  _deps = deps;
}

export function runOpenCodeTask(prompt, payload = {}) {
  const {
    CREWSWARM_OPENCODE_BIN, CREWSWARM_RT_AGENT, CREWSWARM_OPENCODE_MODEL,
    CREWSWARM_OPENCODE_TIMEOUT_MS, CREWSWARM_OPENCODE_AGENT,
    getAgentOpenCodeConfig, getOpencodeProjectDir,
    extractProjectDirFromTask, readAgentSessionId, writeAgentSessionId,
    parseMostRecentSessionId, isOpencodeRateLimitBanner,
  } = _deps;
  return new Promise((resolve, reject) => {
    const bin = fs.existsSync(CREWSWARM_OPENCODE_BIN) ? CREWSWARM_OPENCODE_BIN : "opencode";
    // Model priority: explicit payload > per-agent opencodeModel > global default
    const agentId = String(payload?.agentId || payload?.agent || CREWSWARM_RT_AGENT || "");
    const agentOcCfg = getAgentOpenCodeConfig(agentId);
    const model = String(payload?.model || agentOcCfg.model || CREWSWARM_OPENCODE_MODEL);
    const OC_AGENT_MAP = {
      "crew-coder":         "coder",
      "crew-coder-front":   "coder-front",
      "crew-coder-back":    "coder-back",
      "crew-fixer":         "fixer",
      "crew-frontend":      "frontend",
      "crew-qa":            "qa",
      "crew-security":      "security",
      "crew-pm":            "pm",
      "crew-main":          "main",
      "crew-copywriter":    "copywriter",
      "crew-github":        "github",
      "crew-orchestrator":  "orchestrator",
      "orchestrator":       "orchestrator",
    };
    const ocAgentName = OC_AGENT_MAP[agentId] || agentId.replace(/^crew-/, "") || payload?.agent || CREWSWARM_OPENCODE_AGENT || "admin";
    const agent = String(ocAgentName).trim();
    const configuredDir = getOpencodeProjectDir();
    let projectDir = payload?.projectDir || configuredDir || null;
    // Only fall through to task-text extraction when NO dir is configured at all.
    // Avoid when configuredDir === process.cwd() — extractProjectDirFromTask can
    // pick up sentence-ending periods (e.g. "…/crewswarm.") producing an invalid cwd.
    if (!projectDir) {
      const fromTask = extractProjectDirFromTask(prompt);
      if (fromTask) projectDir = fromTask;
    }
    // Strip trailing punctuation that sentence parsing may have attached to the path.
    projectDir = String(projectDir || process.cwd()).replace(/[.,;!?]+$/, "");
    if (!payload?.projectDir && !configuredDir && projectDir === process.cwd()) {
      console.warn(`[OpenCode] No project dir configured — writing to cwd (${process.cwd()}). Set one in Dashboard → Settings → OpenCode Project Directory.`);
    }
    const agentPrefix = agentId ? `[${agentId}] ` : "";
    const titledPrompt = agentPrefix + String(prompt);
    // Omit --dir to avoid triggering opencode's rg (ripgrep) spawn without stdin:ignore
    // (opencode bug: rg hangs waiting for stdin when --dir is passed — PR pending).
    // cwd on the spawn call below sets the working directory equivalently.
    const args = ["run", titledPrompt, "--model", model];
    if (agent) args.push("--agent", agent);

    // Session continuity: reuse the agent's last session so it remembers previous work
    const existingSessionId = readAgentSessionId(agentId);
    if (existingSessionId) {
      args.push("--session", existingSessionId);
      console.error(`[OpenCode] Continuing session ${existingSessionId} for ${agentId}`);
    }

    console.error(`[OpenCode] Running: ${bin} run [prompt] --model ${model} (cwd=${projectDir})`);

    const cleanEnv = { ...process.env };
    delete cleanEnv.OPENCODE_SERVER_USERNAME;
    delete cleanEnv.OPENCODE_SERVER_PASSWORD;
    delete cleanEnv.OPENCODE_CLIENT;
    delete cleanEnv.OPENCODE;

    // Helper: restart opencode serve if it's not responding (causes ENOENT on spawn)
    async function ensureOpencodeServe() {
      try {
        const r = await fetch("http://127.0.0.1:4096/", { signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (r && r.ok) return; // serve is healthy
      } catch {}
      // Serve is down — kill any stale instance and restart
      console.warn("[OpenCode] serve not responding — restarting...");
      try { spawn("pkill", ["-f", "opencode serve"], { stdio: "ignore" }); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      const serveProc = spawn(bin, ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {
        detached: true, stdio: "ignore", env: cleanEnv,
      });
      serveProc.unref();
      await new Promise(r => setTimeout(r, 3000)); // wait for serve to be ready
      console.warn("[OpenCode] serve restarted");
    }

    // Validate cwd exists — spawn throws ENOENT if the directory doesn't exist
    const safeProjectDir = (projectDir && fs.existsSync(projectDir)) ? projectDir : process.cwd();
    if (safeProjectDir !== projectDir) {
      console.warn(`[OpenCode] projectDir "${projectDir}" does not exist, using cwd: ${safeProjectDir}`);
    }

    const child = spawn(bin, args, {
      cwd: safeProjectDir,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lastProgressAt = Date.now();
    const agentLabel = agentId || CREWSWARM_RT_AGENT || "opencode";

    // Emit agent_working event so dashboard + SwiftBar can show live indicator
    _deps._rtClientForApprovals?.publish({ channel: "events", type: "agent_working", to: "broadcast", payload: { agent: agentLabel, model, ts: Date.now() } });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // SIGKILL fallback if SIGTERM doesn't work within 5 seconds
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          console.warn(`[OpenCode:${agentLabel}] SIGTERM failed, sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, 5000);
      reject(new Error(`OpenCode timeout after ${CREWSWARM_OPENCODE_TIMEOUT_MS}ms`));
    }, CREWSWARM_OPENCODE_TIMEOUT_MS);

    // Stream progress to log and RT bus so you can watch it live
    child.stdout.on("data", (d) => {
      const chunk = d.toString("utf8");
      stdout += chunk;
      lastProgressAt = Date.now();
      const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        console.log(`[OpenCode:${agentLabel}] ${line}`);
      }
    });
    // Lines from OpenCode stderr that are known-harmless and must NOT be returned
    // as task output or logged as errors — they would poison agent conversation history.
    const OC_NOISE_PATTERNS = [
      /realtime\s+daemon\s+error/i,
      /invalid\s+realtime\s+token/i,
      /realtime\s+error:/i,
      /ExperimentalWarning/i,
      /--experimental/i,
    ];
    const isOcNoise = (line) => OC_NOISE_PATTERNS.some(p => p.test(line));

    child.stderr.on("data", (d) => {
      const chunk = d.toString("utf8");
      lastProgressAt = Date.now();
      const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (isOcNoise(line)) continue; // swallow — don't accumulate, don't log
        stderr += line + "\n";
        console.log(`[OpenCode:${agentLabel}] ${line}`);
      }
    });
    // Stall detector — kill and reject if no output for too long so fallback can kick in
    const STALL_TIMEOUT_MS = 180_000;
    const stallCheck = setInterval(() => {
      const stalledMs = Date.now() - lastProgressAt;
      if (stalledMs > STALL_TIMEOUT_MS) {
        clearTimeout(timer);
        clearInterval(stallCheck);
        child.kill("SIGTERM");
        // SIGKILL fallback for stalled processes
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) {
            console.warn(`[OpenCode:${agentLabel}] Stall SIGTERM failed, sending SIGKILL`);
            child.kill("SIGKILL");
          }
        }, 5000);
        console.warn(`[OpenCode:${agentLabel}] No output for ${Math.round(stalledMs/1000)}s — killing and triggering fallback`);
        _deps._rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast", payload: { agent: agentLabel, stalled: true, ts: Date.now() } });
        reject(new Error(`OpenCode stalled (no output for ${Math.round(stalledMs/1000)}s)`));
      } else if (stalledMs > 60000) {
        console.warn(`[OpenCode:${agentLabel}] No output for ${Math.round(stalledMs/1000)}s — may be stalled`);
      }
    }, 30000);
    child.on("error", (err) => {
      clearTimeout(timer);
      clearInterval(stallCheck);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(stallCheck);
      // stdout is the actual task reply; stderr (already noise-filtered above) is diagnostics only.
      // Never let stderr noise (realtime token errors etc.) become the returned output.
      const out = (stdout || stderr || "").trim();
      if (code !== 0) {
        // If the only non-empty output is noise that slipped through, treat as unknown error
        const cleanOut = out.replace(/• ?(realtime daemon error|invalid realtime token)[^\n]*/gi, "").trim();
        const bannerOnly = isOpencodeRateLimitBanner(cleanOut || out);
        if (bannerOnly) {
          console.warn(`[OpenCode:${agentLabel}] Rate limit detected (banner-only exit null) — will rotate model`);
          reject(new Error(`OpenCode rate limited (banner-only): ${model}`));
        } else {
          const errMsg = cleanOut || "unknown error (possibly realtime token noise — task may have succeeded)";
          console.error(`[OpenCode:${agentLabel}] Failed (exit ${code}): ${errMsg.slice(0, 300)}`);
          reject(new Error(`OpenCode exited ${code}: ${errMsg}`));
        }
        return;
      }
      console.log(`[OpenCode:${agentLabel}] Done — ${out.length} chars output`);
      _deps._rtClientForApprovals?.publish({ channel: "events", type: "agent_idle", to: "broadcast", payload: { agent: agentLabel, ts: Date.now() } });

      // Persist the session ID for this agent so the next task continues from here.
      // Filter by agentPrefix (e.g. "[crew-coder]") so parallel agents don't steal
      // each other's most-recent session when finishing at the same time.
      if (agentId) {
        try {
          const listOut = execFileSync(bin, ["session", "list"], {
            cwd: projectDir, env: cleanEnv, timeout: 8000, encoding: "utf8",
          });
          const prefix = agentId ? `[${agentId}]` : null;
          const newSessionId = parseMostRecentSessionId(listOut, prefix);
          if (newSessionId) {
            writeAgentSessionId(agentId, newSessionId);
            console.error(`[OpenCode:${agentLabel}] Session saved: ${newSessionId}`);
          } else {
            console.warn(`[OpenCode:${agentLabel}] No matching session found for prefix "${prefix}" — session not saved`);
          }
        } catch (sessErr) {
          console.warn(`[OpenCode:${agentLabel}] Could not save session: ${sessErr.message}`);
        }
      }

      resolve(out || "(opencode completed with no output)");
    });
  });
}
