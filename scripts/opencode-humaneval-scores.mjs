#!/usr/bin/env node
/**
 * Cross-reference OpenCode models (from crewswarm providers.opencode) with
 * ZeroEval HumanEval leaderboard. Only shows models OpenCode actually supports.
 *
 * Run: node scripts/opencode-humaneval-scores.mjs
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CREWSWARM = join(process.env.HOME || "", ".crewswarm", "crewswarm.json");
const ZEROEVAL_URL = "https://api.zeroeval.com/leaderboard/benchmarks/humaneval";

// OpenCode model id -> possible ZeroEval model_name substrings
const OC_TO_ZEROEVAL = {
  "gpt-5-codex": ["gpt-5", "gpt5"],
  "gpt-5.1-codex": ["gpt-5", "gpt5"],
  "gpt-5.1-codex-max": ["gpt-5", "gpt5"],
  "gpt-5.2-codex": ["gpt-5", "gpt5"],
  "gpt-5.3-codex": ["gpt-5", "gpt5"],
  "alpha-gpt-5.3-codex": ["gpt-5", "gpt5"],
  "alpha-gpt-5.4": ["gpt-5", "gpt5"],
  "gpt-5": ["gpt-5", "gpt5"],
  "gpt-5-nano": ["gpt-5", "gpt5"],
  "kimi-k2": ["kimi k2"],
  "kimi-k2-instruct": ["kimi k2"],
  "kimi-k2-instruct-0905": ["kimi k2 0905"],
  "kimi-k2-thinking": ["kimi k2"],
  "kimi-k2.5": ["kimi k2"],
  "claude-opus-4-1": ["claude opus 4"],
  "claude-opus-4-5": ["claude opus 4"],
  "claude-opus-4-6": ["claude opus 4"],
  "claude-sonnet-4": ["claude 3.5 sonnet", "claude sonnet"],
  "claude-sonnet-4-5": ["claude 3.5 sonnet", "claude sonnet"],
  "claude-sonnet-4-6": ["claude sonnet"],
  "claude-3-5-haiku": ["claude 3.5 haiku"],
  "claude-haiku-4-5": ["claude haiku"],
  "deepseek-reasoner": ["deepseek"],
  "deepseek-v3.1": ["deepseek"],
  "mistral-large": ["mistral large"],
  "gemini-2.5-pro": ["gemini"],
  "gemini-3-flash": ["gemini"],
  "gemini-3-pro": ["gemini"],
};

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function main() {
  let ocModels = [];
  if (existsSync(CREWSWARM)) {
    const cfg = JSON.parse(readFileSync(CREWSWARM, "utf8"));
    const list = cfg?.providers?.opencode?.models || [];
    ocModels = list.map((m) => m.id || m.name || "").filter(Boolean);
  }
  if (!ocModels.length) {
    console.log("No OpenCode models in ~/.crewswarm/crewswarm.json providers.opencode.models");
    process.exit(1);
  }

  const r = await fetch(ZEROEVAL_URL, { signal: AbortSignal.timeout(15000) });
  const data = await r.json();
  const leaderboard = data.models || [];

  const matches = [];
  for (const ocId of ocModels) {
    const patterns = OC_TO_ZEROEVAL[ocId] || [ocId.replace(/-/g, " ")];
    const found = leaderboard.find((m) => {
      const name = (m.model_name || m.model_id || "").toLowerCase();
      return patterns.some((p) => name.includes(p.toLowerCase()));
    });
    if (found) {
      const score = ((found.normalized_score ?? found.score ?? 0) * 100).toFixed(1);
      matches.push({ ocId, zeroevalName: found.model_name, rank: found.rank, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  console.log("OpenCode models on HumanEval (from ZeroEval):\n");
  console.log("| OpenCode model | ZeroEval name | Rank | Score |");
  console.log("|----------------|---------------|------|-------|");
  for (const m of matches) {
    console.log(`| ${m.ocId} | ${m.zeroevalName} | ${m.rank} | ${m.score}% |`);
  }
  console.log(`\n${matches.length} of ${ocModels.length} OpenCode models found on HumanEval.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
