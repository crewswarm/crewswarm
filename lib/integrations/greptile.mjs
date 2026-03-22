/**
 * Greptile API Integration
 * Semantic codebase search and RAG for crewswarm agents
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GREPTILE_API_BASE = "https://api.greptile.com/v2";

/**
 * Get Greptile API key from config or environment
 */
function getApiKey() {
  // Try environment first
  if (process.env.GREPTILE_API_KEY) {
    return process.env.GREPTILE_API_KEY;
  }
  
  // Try crewswarm.json
  try {
    const cfgPath = path.join(os.homedir(), ".crewswarm/crewswarm.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return cfg.providers?.greptile?.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * Index a GitHub repository
 * @param {string} repository - Format: "owner/repo" (e.g. "vercel/next.js")
 * @param {string} branch - Branch name (e.g. "main", "master", "canary")
 * @param {string} remote - Remote type (default: "github")
 * @returns {Promise<{message: string, statusEndpoint: string, repoData: object}>}
 */
export async function indexRepository(repository, branch = "main", remote = "github") {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Greptile API key not found. Set GREPTILE_API_KEY or add to ~/.crewswarm/crewswarm.json");
  }

  const response = await fetch(`${GREPTILE_API_BASE}/repositories`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ remote, repository, branch }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Greptile index failed (${response.status}): ${error}`);
  }

  return await response.json();
}

/**
 * Get repository indexing status
 * @param {string} repository - Format: "owner/repo"
 * @param {string} branch - Branch name
 * @param {string} remote - Remote type (default: "github")
 * @returns {Promise<{status: string, filesProcessed: number, numFiles: number}>}
 */
export async function getRepositoryStatus(repository, branch = "main", remote = "github") {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Greptile API key not found");
  }

  // Format: github:branch:owner%2Frepo
  const repoId = `${remote}:${branch}:${repository.replace("/", "%2F")}`;
  
  const response = await fetch(`${GREPTILE_API_BASE}/repositories/${repoId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Greptile status check failed (${response.status}): ${error}`);
  }

  return await response.json();
}

/**
 * Query repositories using natural language
 * @param {string} query - Natural language question
 * @param {Array<{remote: string, repository: string, branch: string}>} repositories
 * @param {string} sessionId - Optional session ID for conversation history
 * @returns {Promise<{message: string, sources: Array}>}
 */
export async function queryRepositories(query, repositories, sessionId = null) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Greptile API key not found");
  }

  const payload = {
    messages: [{ id: "msg-1", content: query, role: "user" }],
    repositories,
    stream: false,
  };

  if (sessionId) payload.sessionId = sessionId;

  const response = await fetch(`${GREPTILE_API_BASE}/repositories/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Github-Token": process.env.GITHUB_TOKEN || "",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Greptile query failed (${response.status}): ${error}`);
  }

  return await response.json();
}

/**
 * Helper: Index crewswarm repository
 */
export async function indexcrewswarm() {
  return await indexRepository("crewswarm/crewswarm", "main");
}

/**
 * Helper: Search crewswarm codebase
 */
export async function searchcrewswarm(query) {
  return await queryRepositories(query, [
    { remote: "github", repository: "crewswarm/crewswarm", branch: "main" }
  ]);
}

// Alias for backwards compatibility
export const searchRepositories = queryRepositories;
