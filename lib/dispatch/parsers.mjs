/**
 * Dispatch, pipeline, and project directive parsers — extracted from crew-lead.mjs
 * Parses @@DISPATCH, @@PIPELINE, and project markers from LLM replies.
 *
 * Inject: initDispatchParsers({ loadConfig, resolveAgentId })
 */

import path from "node:path";
import {
  normalizeProjectDir,
  rewriteWrongDesktopMirrorPaths,
} from "../runtime/project-dir.mjs";

let _loadConfig     = () => ({});
let _resolveAgentId = (cfg, id) => id;

export function initDispatchParsers({ loadConfig, resolveAgentId } = {}) {
  if (loadConfig)     _loadConfig     = loadConfig;
  if (resolveAgentId) _resolveAgentId = resolveAgentId;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export function parseDispatch(text, userMessage = "") {
  // Strip think tags before parsing so <think> content doesn't pollute task text
  const cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const normalizedText = cleanText.replace(
    /\bcrew[-\s]*(?:fucking|fuckin|damn|goddamn)\s+([a-z0-9-]+)\b/gi,
    "crew-$1",
  );

  // Primary: structured @@DISPATCH marker (check original text too in case tags wrap it)
  const match = normalizedText.match(/@@DISPATCH\s+(\{[\s\S]*?\})/);
  if (match) {
    try {
      const d = JSON.parse(match[1]);
      // d.verify and d.done are optional acceptance criteria fields
      if (d.agent && d.task) return d;
    } catch {}
    return null;
  }

  // Direct imperative fallback: "dispatch crew-coder ...", "send it to crew-coder", etc.
  // Skip if structured @@DISPATCH was present (even malformed) — don't re-interpret as NL
  if (/@@DISPATCH\s+\{/.test(normalizedText)) return null;

  const imperativeMatch = normalizedText.match(
    /(?:^|\b)(?:dispatch|send|route|forward|tell|ask|use|sic(?:k)?)\b[^.\n]*?\b(crew-[a-z0-9-]+)/i,
  );
  if (imperativeMatch) {
    let agent = imperativeMatch[1].trim().toLowerCase();
    const taskSource = userMessage || normalizedText;
    const task = taskSource
      .replace(
        /^(?:please\s+)?(?:go\s+)?(?:dispatch|send|route|forward|tell|ask|use|sic(?:k)?)(?:\s+(?:it|this|him|her|them))?(?:\s+to)?\s+(?:fucking\s+|fuckin\s+|damn\s+|goddamn\s+)?(?:crew-[a-z0-9-]+)\b[:\s-]*/i,
        "",
      )
      .trim();
    if (agent && task) {
      console.warn(`[DEPRECATED] Imperative dispatch format detected. Use @@DISPATCH JSON marker instead.`);
      console.log(`[crew-lead] Imperative dispatch fallback: agent=${agent} task="${task.slice(0, 60)}"`);
      return { agent, task };
    }
  }

  // Fallback: LLM described a dispatch in natural language without using @@DISPATCH
  // Only match present/future action phrases — never past tense ("dispatched") which is
  // just description of history and would cause infinite re-dispatch loops.
  const nlMatch = normalizedText.match(
    /(?:dispatching now|I(?:'ll| will| am) dispatch(?:ing)?|sending(?: this)? to|routing to|forwarding to|siccing)\b[^.]*?\b(crew-[a-z0-9-]+)/i
  );
  if (nlMatch) {
    let agent = nlMatch[1].trim();
    // Try to resolve display names to crew-X IDs
    if (!agent.startsWith("crew-")) {
      try {
        const cfg = _loadConfig();
        const resolved = _resolveAgentId(cfg, agent);
        if (resolved && resolved !== agent) agent = resolved;
      } catch {}
    } else {
      agent = agent.toLowerCase();
    }
    const task = userMessage
      ? userMessage.replace(/^(?:go\s+(?:write\s+)?(?:have\s+)?|have\s+|ask\s+|tell\s+)(?:crew-[a-z0-9-]+|[a-z]+)\s+(?:to\s+)?/i, "").trim() || userMessage
      : cleanText.replace(/\n/g, " ").slice(0, 200).trim();
    if (agent && task) {
      console.warn(`[DEPRECATED] Natural language dispatch detected. Use @@DISPATCH JSON marker instead.`);
      console.log(`[crew-lead] NL dispatch fallback: agent=${agent} task="${task.slice(0, 60)}"`);
      return { agent, task };
    }
  }

  return null;
}

export function stripDispatch(text) {
  return text.replace(/@@DISPATCH\s+\{[\s\S]*?\}/g, "").trim();
}

/**
 * When a dashboard project is selected, crew-lead knows `projectDir` but models often emit
 * bare filenames (e.g. content-draft.md). Agents then @@READ_FILE from the wrong cwd.
 * Rewrite obvious bare file tokens to `${projectDir}/filename` (skip if already under a path).
 *
 * @param {Array<{ task?: string }>} steps
 * @param {string|null|undefined} projectDir
 * @returns {typeof steps}
 */
export function applyProjectDirToPipelineSteps(steps, projectDir) {
  if (!projectDir || !Array.isArray(steps) || steps.length === 0) return steps;
  const rootRaw = String(projectDir).trim();
  const root =
    path.resolve(normalizeProjectDir(rootRaw) || rootRaw).replace(/\/+$/, "");
  // Bare `foo.md` / `report.html` not already preceded by path separator or protocol-ish char
  // Disallow `-` before the match so `design-brief.md` is not split into `brief.md`
  const bareFile = new RegExp(
    String.raw`(?<![\w/\\~:-])` +
      String.raw`([A-Za-z0-9][\w.-]*\.(?:md|html|css|js|mjs|ts|tsx|json|yaml|yml|py|sh|sql|toml|txt))` +
      String.raw`(?![\w/.-])`,
    "gi",
  );

  for (const step of steps) {
    if (!step?.task || typeof step.task !== "string") continue;
    step.task = rewriteWrongDesktopMirrorPaths(step.task, root);
    step.task = step.task.replace(bareFile, (full, fname) => {
      const joined = path.join(root, fname).replace(/\\/g, "/");
      if (step.task.includes(joined)) return full;
      return joined;
    });
  }
  return steps;
}

/** Parse all @@DISPATCH {...} from text (e.g. PM reply). Returns array of { agent, task, verify?, done? }. */
export function parseDispatches(text) {
  if (!text || typeof text !== "string") return [];
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const list = [];
  const re = /@@DISPATCH\s+(\{[\s\S]*?\})/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    try {
      const d = JSON.parse(m[1]);
      if (d.agent && d.task) list.push(d);
    } catch {}
  }
  return list;
}

// ── Pipeline DSL ──────────────────────────────────────────────────────────────
// Format: @@PIPELINE [{"wave":1,"agent":"crew-coder","task":"..."},{"wave":1,"agent":"crew-coder-front","task":"..."},{"wave":2,"agent":"crew-qa","task":"..."}]
// Backward-compat: steps without "wave" are assigned sequential waves 1,2,3,...

export function parsePipeline(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Extract JSON array using bracket-counting (regex [\s\S]*?] fails on nested brackets like [SCOPE])
  function extractJsonArray(str, startIdx) {
    if (str[startIdx] !== "[") return null;
    let depth = 0;
    for (let i = startIdx; i < str.length; i++) {
      if (str[i] === "[") depth++;
      else if (str[i] === "]") { depth--; if (depth === 0) return str.slice(startIdx, i + 1); }
    }
    return null;
  }

  let jsonStr = null;

  // Try explicit @@PIPELINE marker first
  const markerIdx = clean.indexOf("@@PIPELINE");
  if (markerIdx !== -1) {
    const bracketIdx = clean.indexOf("[", markerIdx);
    if (bracketIdx !== -1) jsonStr = extractJsonArray(clean, bracketIdx);
  }

  // Fallback: find last JSON array in text that looks like pipeline steps
  if (!jsonStr) {
    let lastBracket = clean.lastIndexOf("[{");
    if (lastBracket !== -1) {
      const candidate = extractJsonArray(clean, lastBracket);
      if (candidate) {
        try {
          const test = JSON.parse(candidate);
          if (Array.isArray(test) && test.length >= 2 && test.every(s => s.agent && s.task)) {
            jsonStr = candidate;
          }
        } catch {}
      }
    }
  }

  if (!jsonStr) return null;
  try {
    const steps = JSON.parse(jsonStr);
    if (!Array.isArray(steps) || steps.length < 2) return null;
    if (!steps.every(s => s.agent && s.task)) return null;

    steps.forEach((s, i) => { if (s.wave == null) s.wave = i + 1; });

    // Auto-append crew-pm ROADMAP update as final wave if any coding agents are present
    // and crew-pm isn't already in the pipeline
    const codingAgents = new Set(['crew-coder','crew-coder-front','crew-coder-back','crew-frontend','crew-fixer','crew-ml']);
    const hasCodingAgent = steps.some(s => codingAgents.has(s.agent) || codingAgents.has((s.agent||'').toLowerCase()));
    const hasPm = steps.some(s => s.agent === 'crew-pm' || s.agent === 'pm');
    const hasQa = steps.some(s => s.agent === 'crew-qa' || s.agent === 'qa');
    const hasFixer = steps.some(s => s.agent === 'crew-fixer' || s.agent === 'fixer');

    // If pipeline has fixer but only one QA pass, insert a re-QA wave after fixer
    // so the pattern is always: ... → fixer → QA (re-check) → pm
    if (hasFixer && hasQa) {
      const fixerWaves = steps.filter(s => s.agent === 'crew-fixer' || s.agent === 'fixer').map(s => Number(s.wave));
      const maxFixerWave = Math.max(...fixerWaves);
      const qaAfterFixer = steps.some(s => (s.agent === 'crew-qa' || s.agent === 'qa') && Number(s.wave) > maxFixerWave);
      if (!qaAfterFixer) {
        // Shift all waves after fixer up by 1 to make room
        steps.forEach(s => { if (Number(s.wave) > maxFixerWave) s.wave = Number(s.wave) + 1; });
        steps.push({
          wave: maxFixerWave + 1,
          agent: 'crew-qa',
          task: 'Re-audit the previously flagged files after crew-fixer ran. Read the existing qa-report.md in the project directory (same folder as ROADMAP.md) to know what was fixed. Run py_compile on all .py files. Confirm CRITICAL and HIGH issues are resolved. Write your updated report to qa-report.md in that same project directory (no other filename).',
        });
      }
    }

    if (hasCodingAgent && !hasPm) {
      const maxWave = Math.max(...steps.map(s => Number(s.wave)));
      steps.push({
        wave: maxWave + 1,
        agent: 'crew-pm',
        task: 'Read the project ROADMAP.md and mark any completed phases/tasks as done based on the work just finished by the coding agents. Use @@READ_FILE to read the roadmap first, then @@WRITE_FILE to update it. Only mark items complete if they were actually built.',
      });
    }

    const waveMap = new Map();
    for (const s of steps) {
      const w = Number(s.wave);
      if (!waveMap.has(w)) waveMap.set(w, []);
      waveMap.get(w).push(s);
    }
    const sortedWaveNums = [...waveMap.keys()].sort((a, b) => a - b);
    return { steps, waves: sortedWaveNums.map(n => waveMap.get(n)) };
  } catch { return null; }
}

export function stripPipeline(text) {
  // Remove pipeline JSON using bracket-counting (handles nested brackets like [SCOPE])
  const markerIdx = text.indexOf("@@PIPELINE");
  if (markerIdx !== -1) {
    const bracketIdx = text.indexOf("[", markerIdx);
    if (bracketIdx !== -1) {
      let depth = 0;
      for (let i = bracketIdx; i < text.length; i++) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]") { depth--; if (depth === 0) return (text.slice(0, markerIdx) + text.slice(i + 1)).trim(); }
      }
    }
  }
  // Fallback: strip trailing JSON array
  const lastBracket = text.lastIndexOf("[{");
  if (lastBracket !== -1) {
    let depth = 0;
    for (let i = lastBracket; i < text.length; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]") { depth--; if (depth === 0) return text.slice(0, lastBracket).trim(); }
    }
  }
  return text.trim();
}

export function parseProject(text) {
  const match = text.match(/@@PROJECT\s+(\{[\s\S]*?\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

export function stripProject(text) {
  return text.replace(/@@PROJECT\s+\{[\s\S]*?\}/, "").trim();
}

/** Parse @@REGISTER_PROJECT {"name":"...","outputDir":"..."} from PM reply so the project appears in the dashboard Projects tab. */
export function parseRegisterProject(text) {
  const match = text.match(/@@REGISTER_PROJECT\s+(\{[\s\S]*?\})/);
  if (!match) return null;
  try {
    const o = JSON.parse(match[1]);
    if (o.name && o.outputDir) return { name: String(o.name).trim(), outputDir: String(o.outputDir).trim(), description: o.description ? String(o.description).trim() : "" };
  } catch {}
  return null;
}

/** Remove <think>...</think> reasoning blocks so they are not shown to the user. */
export function stripThink(text) {
  if (!text || typeof text !== "string") return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/think>/g, "").replace(/<think>/g, "");
  return out.trim();
}
