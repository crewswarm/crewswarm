import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { getAgentRuntimeMetadata, getCliEngineMetadata, logTestEvidence } from "./test-log.mjs";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".crewswarm", "crewswarm.json");

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function loadRuntimeConfig(configPath = DEFAULT_CONFIG_PATH) {
  return safeReadJson(configPath) || {};
}

export function logEngineTestContext({
  test,
  file,
  engine,
  agent,
  timeout_ms,
  target_file,
  project_dir,
  notes,
}) {
  const agentMeta = agent ? getAgentRuntimeMetadata(agent) : null;
  const engineMeta = engine ? getCliEngineMetadata(engine) : null;
  return logTestEvidence({
    category: "engine_context",
    test,
    file,
    engine,
    agent,
    timeout_ms,
    target_file,
    project_dir,
    notes,
    agent_runtime: agentMeta,
    engine_runtime: engineMeta,
  });
}
