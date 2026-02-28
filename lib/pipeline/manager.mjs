/**
 * Pipeline / project manager — extracted from crew-lead.mjs
 * Pending projects, roadmap phases, draft/confirm, auto-advance.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

let _dashboard = "http://127.0.0.1:4319";
let _broadcastSSE = () => {};
let _appendHistory = () => {};
let _handleChat = async () => {};
let _loadConfig = () => ({});

function tryRead(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export const pendingProjects = new Map();

export function initPipelineManager({ dashboard, broadcastSSE, appendHistory, handleChat, loadConfig }) {
  if (dashboard !== undefined) _dashboard = dashboard;
  if (broadcastSSE) _broadcastSSE = broadcastSSE;
  if (appendHistory) _appendHistory = appendHistory;
  if (handleChat) _handleChat = handleChat;
  if (loadConfig) _loadConfig = loadConfig;
}

function getPMLLMProviders() {
  const csSwarm = tryRead(path.join(os.homedir(), ".crewswarm", "crewswarm.json")) || {};
  const p = csSwarm.providers || {};
  const candidates = [
    p.perplexity?.apiKey && { baseUrl: p.perplexity.baseUrl || "https://api.perplexity.ai",       apiKey: p.perplexity.apiKey, model: "sonar-pro",                name: "Perplexity" },
    p.cerebras?.apiKey   && { baseUrl: p.cerebras.baseUrl   || "https://api.cerebras.ai/v1",       apiKey: p.cerebras.apiKey,   model: "llama-3.3-70b",            name: "Cerebras"   },
    p.groq?.apiKey       && { baseUrl: p.groq.baseUrl       || "https://api.groq.com/openai/v1",   apiKey: p.groq.apiKey,       model: "llama-3.3-70b-versatile",  name: "Groq"       },
    p.mistral?.apiKey    && { baseUrl: p.mistral.baseUrl     || "https://api.mistral.ai/v1",        apiKey: p.mistral.apiKey,    model: "mistral-large-latest",     name: "Mistral"    },
    p.openai?.apiKey     && { baseUrl: p.openai.baseUrl      || "https://api.openai.com/v1",        apiKey: p.openai.apiKey,     model: "gpt-4o-mini",              name: "OpenAI"     },
  ].filter(Boolean);

  const cfg = _loadConfig();
  if (cfg.provider?.apiKey && !candidates.find(c => c.apiKey === cfg.provider.apiKey)) {
    candidates.push({ baseUrl: cfg.provider.baseUrl, apiKey: cfg.provider.apiKey, model: cfg.modelId, name: cfg.providerKey });
  }
  return candidates;
}

function templateRoadmap(name, description, outputDir) {
  return `# ${name} — Living Roadmap

> Managed by CrewSwarm PM Loop. Add \`- [ ] items\` here at any time.

---

## Phase 1 — Foundation

- [ ] Set up project structure and entry point in ${outputDir}
- [ ] Create README.md with project overview and setup instructions
- [ ] Define core data models and types for: ${description || name}

## Phase 2 — Core Features

- [ ] Implement primary feature: ${description || name}
- [ ] Build the main UI/frontend in ${outputDir}
- [ ] Add backend logic, API endpoints, and data persistence
- [ ] Add error handling and input validation throughout

## Phase 3 — Polish & QA

- [ ] Write unit tests for core logic
- [ ] QA pass — check for edge cases and broken flows
- [ ] Performance review and optimisation
- [ ] Accessibility and UX improvements

## Phase 4 — Ship

- [ ] Final QA pass
- [ ] Commit all changes to git with clear messages
- [ ] Write deployment/setup documentation
`;
}

async function generateRoadmarkWithAI(name, description, outputDir) {
  const providers = getPMLLMProviders();

  if (!providers.length) {
    console.log("[crew-lead] No PM LLM providers configured — using template roadmap");
    return templateRoadmap(name, description, outputDir);
  }

  const systemPrompt = `You are a senior technical product manager. Generate a detailed, phased ROADMAP.md for a software project.

Rules:
- Output ONLY the roadmap markdown — no preamble, no explanation
- Use EXACTLY this format:

# {Project Name} — Living Roadmap

> Managed by CrewSwarm PM Loop.

---

## Phase 1 — Foundation
- [ ] Task one
- [ ] Task two

## Phase 2 — Core Features
- [ ] Task three

## Phase 3 — Polish & Ship
- [ ] Task

- Include 12-18 total tasks across 3-4 phases
- Each task: specific, actionable, completable by ONE agent in ONE session
- Vary tasks: backend (API/DB/scripts), frontend (HTML/CSS/JS), copy, git, QA, security
- Reference the output directory: ${outputDir}`;

  const userPrompt = `Project: "${name}"
Description: ${description || name}
Output directory: ${outputDir}

Generate the ROADMAP.md:`;

  for (const pmCfg of providers) {
    const isPerplexity = pmCfg.baseUrl.includes("perplexity");
    console.log(`[crew-lead] Generating roadmap via ${pmCfg.name || pmCfg.model}...`);
    try {
      const resp = await fetch(`${pmCfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${pmCfg.apiKey}` },
        body: JSON.stringify({
          model: pmCfg.model,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          max_tokens: 1200,
          temperature: 0.4,
          ...(isPerplexity ? { search_recency_filter: "month" } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        console.warn(`[crew-lead] ${pmCfg.name} returned ${resp.status} — trying next provider`);
        continue;
      }

      const data = await resp.json();
      const roadmap = data?.choices?.[0]?.message?.content?.trim();
      if (!roadmap) { console.warn(`[crew-lead] ${pmCfg.name} returned empty — trying next`); continue; }

      console.log(`[crew-lead] Roadmap generated via ${pmCfg.name} (${roadmap.length} chars)`);
      return roadmap.startsWith("#") ? roadmap : `# ${name} — Living Roadmap\n\n${roadmap}`;
    } catch (e) {
      console.warn(`[crew-lead] ${pmCfg.name} failed: ${e.message} — trying next provider`);
    }
  }

  console.warn("[crew-lead] All PM LLM providers failed — using template roadmap");
  return templateRoadmap(name, description, outputDir);
}

export async function draftProject({ name, description, outputDir }, sessionId) {
  if (!name || !outputDir) {
    throw new Error("draftProject requires name and outputDir");
  }
  const roadmapMd = await generateRoadmarkWithAI(name, description, outputDir);
  const draftId = crypto.randomUUID();
  pendingProjects.set(draftId, { name, description, outputDir, roadmapMd, sessionId, ts: Date.now() });
  console.log(`[crew-lead] Roadmap draft ready: ${name} (draftId=${draftId})`);
  return { draftId, name, description, outputDir, roadmapMd };
}

export async function confirmProject({ draftId, roadmapMd: overrideMd }) {
  const draft = pendingProjects.get(draftId);
  if (!draft) throw new Error(`No pending project for draftId: ${draftId}`);
  pendingProjects.delete(draftId);

  const { name, description, outputDir, sessionId } = draft;
  const finalRoadmap = overrideMd || draft.roadmapMd;

  const createRes = await fetch(`${_dashboard}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: description || "", outputDir }),
    signal: AbortSignal.timeout(10000),
  });
  const proj = await createRes.json();
  if (!proj.ok) throw new Error("Failed to create project: " + (proj.error || "unknown"));
  const projectId = proj.project.id;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "ROADMAP.md"), finalRoadmap, "utf8");
  console.log(`[crew-lead] Project confirmed: ${name} (${projectId}) — roadmap written`);

  try {
    const startRes = await fetch(`${_dashboard}/api/pm-loop/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(10000),
    });
    const startData = await startRes.json();
    console.log(`[crew-lead] PM loop started for ${name}:`, startData.pid || startData.message);
  } catch (e) {
    console.error(`[crew-lead] PM loop start failed: ${e.message}`);
  }

  _appendHistory(sessionId || "owner", "system", `Project "${name}" confirmed and launched. PM loop running.`);
  _broadcastSSE({ type: "project_launched", project: { projectId, name, outputDir } });
  return { projectId, name, outputDir };
}

export function parseRoadmapPhases(content) {
  const phases = [];
  let current = null;
  for (const line of content.split("\n")) {
    const phaseMatch = line.match(/^#{1,3}\s*(Phase\s[\w\d–\-]+.*)/i);
    if (phaseMatch) {
      if (current) phases.push(current);
      current = { title: phaseMatch[1].trim(), items: [], raw: line };
    } else if (current && line.match(/^\s*-\s*\[([ xX])\]/)) {
      current.items.push({ done: /\[x\]/i.test(line), text: line.trim() });
    }
  }
  if (current) phases.push(current);
  return phases;
}

export function findNextRoadmapPhase(projectDir) {
  const roadmapPath = path.join(projectDir, "ROADMAP.md");
  if (!fs.existsSync(roadmapPath)) return null;
  try {
    const content = fs.readFileSync(roadmapPath, "utf8");
    const phases = parseRoadmapPhases(content);
    return phases.find(p => p.items.length > 0 && p.items.some(i => !i.done)) || null;
  } catch { return null; }
}

export async function autoAdvanceRoadmap(projectDir, sessionId) {
  if (!projectDir) return;
  const nextPhase = findNextRoadmapPhase(projectDir);
  if (!nextPhase) {
    console.log(`[roadmap] All phases complete in ${projectDir}`);
    return;
  }
  const unchecked = nextPhase.items.filter(i => !i.done);
  console.log(`[roadmap] Auto-advancing to "${nextPhase.title}" — ${unchecked.length} items pending in ${projectDir}`);

  const task = `The previous pipeline phase just completed. Auto-advancing to the next phase.

Project: ${projectDir}
Next phase: ${nextPhase.title}
Unchecked items:
${unchecked.map(i => i.text).join("\n")}

@@READ_FILE ${path.join(projectDir, "ROADMAP.md")}

Plan and execute this phase as a @@PIPELINE. Use the correct agents for each task. End with crew-qa → crew-fixer → crew-qa → crew-pm (ROADMAP update). All file paths must be absolute.`;

  _appendHistory(sessionId, "system", `[Auto-advance] Starting "${nextPhase.title}" (${unchecked.length} items)`);
  _broadcastSSE({ type: "roadmap_advance", phase: nextPhase.title, projectDir, ts: Date.now() });

  await _handleChat({ message: task, sessionId, _autoAdvance: true });
}
