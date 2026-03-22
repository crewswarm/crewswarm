/**
 * Intent parsing and task brief — extracted from crew-lead.mjs
 */

import fs from "node:fs";
import path from "node:path";

let _loadConfig = () => ({});
let _classifyTask = async () => null;

export function initIntent({ loadConfig, classifyTask }) {
  if (loadConfig) _loadConfig = loadConfig;
  if (classifyTask) _classifyTask = classifyTask;
}

export function writeTaskBrief(agent, task, projectDir) {
  if (!projectDir) return task;
  try {
    const briefName = `_crew-${agent.replace("crew-","")}-brief-${Date.now()}.md`;
    const briefPath = path.join(projectDir, briefName);
    const ts = new Date().toISOString().replace("T"," ").slice(0,19);
    fs.writeFileSync(briefPath, `# Task Brief for ${agent}\n_Created: ${ts}_\n\n${task}\n`, "utf8");
    return `@@READ_FILE ${briefPath}\n\nRead the task brief above and complete all items. Write results/reports to the paths specified in the brief. Delete the brief file when done.`;
  } catch {
    return task;
  }
}

export function parseServiceIntent(msg) {
  const t = msg.trim().toLowerCase();

  if (/restart\s+(all\s+)?agents?|bring\s+agents?\s+(back|online|up)|start\s+all\s+agents?|agents?\s+back\s+up/.test(t))
    return { action: "restart", id: "agents" };

  if (/restart\s+(the\s+)?tele?gram|start\s+(the\s+)?tele?gram|tele?gram\s+(back|up)|tg\s+(back|up|restart)/.test(t))
    return { action: "restart", id: "telegram" };

  if (/restart\s+(the\s+)?rt(\s+bus)?|rt\s+bus\s+(down|crash|restart)/.test(t))
    return { action: "restart", id: "rt-bus" };

  const agentMatch = t.match(/restart\s+(crew-[a-z0-9-]+)/);
  if (agentMatch) return { action: "restart", id: agentMatch[1] };

  if (/restart\s+(them|it|everything|the\s+crew|all|bridges?)|bring\s+(them|the\s+crew|everyone)\s+back/.test(t))
    return { action: "restart", id: "agents" };

  if (/stop\s+(the\s+)?tele?gram|stop\s+tg\b/.test(t))
    return { action: "stop", id: "telegram" };

  return null;
}

export function messageNeedsSearch(msg) {
  const t = msg.trim().toLowerCase();
  if (t.length < 6) return false;
  const delegationPattern = /(?:ask|tell|have|send|forward|give|pass)\s+(?:the\s+)?(?:writer|copywriter|pm|planner|coder|fixer|qa|security|github|frontend|main|crew-[a-z0-9-]+|planx|frank|blazer|antoine|copycopy|copycat|testy|stinki)/i;
  if (delegationPattern.test(t)) return false;
  const searchTriggers = [
    "go search", "search for", "search ", "research ", "look up", "look it up", "look that up",
    "can you search", "please search", "please look up", "please research",
    "run a search", "do a search",
  ];
  return searchTriggers.some(phrase => t.includes(phrase));
}

export const DISPATCH_INTENT_REQUIRED = [
  /\bgo\s+(build|write|create|make|fix|test|audit|ship|deploy|run|add|update|generate|implement|refactor|optimize)\b/i,
  /\b(build|create|make|generate|implement|write|ship|deploy)\s+(me\b|a\b|an\b|the\b|it\b|this\b|some\b)/i,
  /\bhave\s+(crew-\S+|\w+)\s+(do|fix|build|write|create|audit|test|run|check|handle|implement)/i,
  /\btell\s+(crew-\S+|\w+)\s+to\b/i,
  /\bask\s+(crew-\S+|\w+)\s+to\b/i,
  /\b(dispatch|send)\s+(to\s+)?(crew-\S+|\w+)\b/i,
  /\b(kick\s*off|rally|launch|start)\s+(the\s+)?(crew|pipeline|build|task|project)\b/i,
  /\b(fix|debug|refactor|optimize|audit|review|test|deploy)\s+(the\s+|this\s+|my\s+)?\S+/i,
];

export const DISPATCH_NEVER_PATTERNS = [
  /^(hi|hello|hey|sup|yo|ok|okay|sure|nope|no|yes|yep|nah|what|why|how|huh|lol|lmao|wtf|fixed|working|done|thanks|thx|cool|nice|great|good)\??\.?$/i,
  /^(what|why|how|when|where|who|is|are|can|did|does|was|were|do|tell me|show me|explain|what is|what are|what does|what happened|what did|did you|did he|did she|did we|did it)\b/i,
  /^(i never|i didn'?t|i don'?t|i haven'?t|i wasn'?t|i wasn|i'm not|i am not|i was not|that'?s not|that is not|no i|nope i)\b/i,
  /\?\s*$/,
];

export function isDispatchIntended(userMessage) {
  if (!userMessage) return false;
  const msg = userMessage.trim();
  const wordCount = msg.split(/\s+/).length;

  if (DISPATCH_NEVER_PATTERNS.some(re => re.test(msg))) {
    console.log(`[crew-lead] 🚫 Dispatch blocked — message matches non-directive pattern: "${msg.slice(0, 60)}"`);
    return false;
  }

  if (DISPATCH_INTENT_REQUIRED.some(re => re.test(msg))) return true;

  if (wordCount <= 8) {
    console.log(`[crew-lead] 🚫 Dispatch blocked — short message with no dispatch intent: "${msg.slice(0, 60)}"`);
    return false;
  }

  return true;
}
