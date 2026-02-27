/**
 * Task complexity classifier — extracted from crew-lead.mjs
 * Cheap pre-flight LLM call that rates task complexity 1-5 and suggests agents.
 */

let _loadConfig = () => ({});

export function initClassifier({ loadConfig }) {
  if (loadConfig) _loadConfig = loadConfig;
}

export const TASK_VERBS = /\b(build|create|write|add|fix|refactor|deploy|implement|design|plan|make|update|change|convert|generate|set.?up|migrate|scaffold|integrate|optimize|debug|ship|launch|configure|refactor|rewrite|delete|remove)\b/i;
export const QUESTION_START = /^(what|how|why|who|when|where|can you|do you|is it|are you|tell me|explain|show me|what is|what are|is there|does|did|will|would|should|could|have you|i('m| am) asking|no[,\s]|just |i mean|verify|verifying|checking|confirming|testing|looking|seeing)/i;
export const STATUS_CHECK = /\b(verify|verif|check(ing)?|confirm(ing)?|status|health|is .* (up|down|running|broken|working)|no .* issues?|any .* issues?|timeout issues?|looking at|seeing if)\b/i;

export async function classifyTask(message, cfg) {
  const words = message.trim().split(/\s+/).length;
  if (words < 10) return null;
  if (QUESTION_START.test(message.trim())) return null;
  if (STATUS_CHECK.test(message)) return null;
  if (!TASK_VERBS.test(message)) return null;

  const providers = cfg.providers || {};
  let baseUrl, apiKey, model;
  if (providers.groq?.apiKey) {
    baseUrl = providers.groq.baseUrl || "https://api.groq.com/openai/v1";
    apiKey  = providers.groq.apiKey;
    model   = "llama-3.1-8b-instant";
  } else if (providers.cerebras?.apiKey) {
    baseUrl = providers.cerebras.baseUrl || "https://api.cerebras.ai/v1";
    apiKey  = providers.cerebras.apiKey;
    model   = "llama-3.1-8b";
  } else {
    return null;
  }

  const agentList = (cfg.agents || [])
    .map(a => `${a.id}(${a.identity?.theme || a._role || ""})`)
    .join(", ")
    .slice(0, 400);

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: `Rate this task for a multi-agent AI coding system.
1-2=SIMPLE: one agent, one clear action (fix bug, add function, write doc).
3=MODERATE: could go either way.
4-5=COMPLEX: multiple specialists needed, or requires planning + multiple deliverables.

Task: "${message.slice(0, 500)}"
Agents available: ${agentList}

Reply ONLY with valid JSON (no markdown, no explanation):
{"score":<1-5>,"reason":"<10 words>","agents":["agent-id"],"breakdown":["step 1","step 2"]}`,
        }],
        max_tokens: 150,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      console.log(`[classifier] score=${result.score}/5 agents=${(result.agents||[]).join(",")} — "${message.slice(0,60)}"`);
      return result;
    }
  } catch (e) {
    console.log(`[classifier] skipped: ${e.message}`);
  }
  return null;
}
