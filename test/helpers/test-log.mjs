import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const RESULTS_DIR = process.env.TEST_RESULTS_DIR || path.join(process.cwd(), "test-results");
const LOG_PATH = path.join(RESULTS_DIR, "test-log.jsonl");
const CURRENT_RUN_PATH = path.join(RESULTS_DIR, ".current-run.json");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".crewswarm", "crewswarm.json");

function ensureResultsDir() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function truncate(value, limit = 400) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function slugify(value) {
  return String(value || "unnamed")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unnamed";
}

function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/authorization|x-api-key|cookie/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function currentRunInfo() {
  return safeReadJson(CURRENT_RUN_PATH) || {};
}

export function logTestEvidence(entry = {}) {
  ensureResultsDir();
  const run = currentRunInfo();
  const testId = entry.testId || buildTestId(entry.file, entry.test || entry.name || entry.operation || "unknown");
  const artifactDir = entry.artifactDir || getArtifactDir(run.runId || "unknown-run", testId);
  const payload = {
    runId: entry.runId || run.runId || "unknown-run",
    timestamp: new Date().toISOString(),
    entry_type: "evidence",
    testId,
    artifactDir,
    ...entry,
  };
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(payload)}\n`);
  const evidencePath = path.join(artifactDir, "evidence.jsonl");
  fs.appendFileSync(evidencePath, `${JSON.stringify(payload)}\n`);
  return payload;
}

export function buildTestId(file, name) {
  return `${slugify(path.relative(process.cwd(), file || "no-file"))}__${slugify(name || "unnamed-test")}`;
}

export function getRunDir(runId) {
  return path.join(RESULTS_DIR, "runs", runId);
}

export function getArtifactDir(runId, testId) {
  return path.join(getRunDir(runId), testId);
}

export function writeArtifactFile({ runId, testId, filename, content }) {
  const artifactDir = getArtifactDir(runId, testId);
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, filename);
  fs.writeFileSync(artifactPath, content);
  return artifactPath;
}

export function detectProviderFromModel(model) {
  if (!model) return null;
  if (model.includes("/")) return model.split("/")[0] || null;
  if (/^gpt-|^o\d|^codex/i.test(model)) return "openai";
  if (/^claude/i.test(model)) return "anthropic";
  if (/^gemini/i.test(model)) return "google";
  return null;
}

export function getBinaryMetadata(bin, versionArgs = ["--version"]) {
  let resolvedPath = null;
  let version = null;
  try {
    resolvedPath = execSync(`which ${bin}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || null;
  } catch {}
  try {
    const cmd = resolvedPath || bin;
    version = execSync(`${cmd} ${versionArgs.join(" ")}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim().split("\n")[0] || null;
  } catch {}
  return { bin, path: resolvedPath, version };
}

export function getCliEngineMetadata(engine) {
  const map = {
    claude: { provider: "anthropic", binary: getBinaryMetadata("claude") },
    cursor: { provider: "cursor", binary: getBinaryMetadata("agent") },
    gemini: { provider: "google", binary: getBinaryMetadata("gemini") },
    codex: { provider: "openai", binary: getBinaryMetadata("codex") },
    opencode: { provider: "opencode", binary: getBinaryMetadata("opencode") },
    "crew-cli": { provider: "openai", binary: getBinaryMetadata("crew") },
  };
  return { engine, ...(map[engine] || {}) };
}

export function getAgentRuntimeMetadata(agentId, configPath = DEFAULT_CONFIG_PATH) {
  const cfg = safeReadJson(configPath) || {};
  const agent = Array.isArray(cfg.agents) ? cfg.agents.find((item) => item?.id === agentId) : null;
  if (!agent) {
    return {
      agent: agentId,
      configPath,
      configFound: false,
    };
  }
  const routeFlags = {
    useCodex: !!agent.useCodex,
    useCursorCli: !!agent.useCursorCli,
    useGeminiCli: !!agent.useGeminiCli,
    useOpenCode: !!agent.useOpenCode,
    useCrewCLI: !!agent.useCrewCLI,
    useClaudeCode: !!agent.useClaudeCode,
  };
  const enabledRoute = Object.entries(routeFlags).find(([, enabled]) => enabled)?.[0] || null;
  return {
    agent: agentId,
    configPath,
    configFound: true,
    model: agent.model || null,
    provider: detectProviderFromModel(agent.model),
    cursorCliModel: agent.cursorCliModel || null,
    opencodeModel: agent.opencodeModel || null,
    routeFlags,
    enabledRoute,
  };
}

export function fingerprintFileSync(filePath) {
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  return {
    path: filePath,
    size_bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

export function logFileVerification({ test, file, expected, extra = {} }) {
  const details = { exists: false, path: file };
  try {
    Object.assign(details, { exists: true }, fingerprintFileSync(file));
  } catch (error) {
    details.error = truncate(error.message || error);
  }
  return logTestEvidence({
    category: "file_verification",
    test,
    expected,
    file_details: details,
    ...extra,
  });
}

export function logHttpInteraction({
  test,
  file,
  operation,
  url,
  method,
  timeout_ms,
  status,
  duration_ms,
  request_headers,
  response_body,
  response_headers,
  error,
  extra = {},
}) {
  return logTestEvidence({
    category: "http",
    test,
    file,
    operation,
    method,
    url,
    timeout_ms,
    status,
    duration_ms,
    request_headers: redactHeaders(request_headers),
    response_headers: redactHeaders(response_headers),
    response_preview: truncate(
      typeof response_body === "string" ? response_body : JSON.stringify(response_body)
    ),
    error: error ? truncate(error.message || error) : undefined,
    ...extra,
  });
}
