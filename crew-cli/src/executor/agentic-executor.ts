/**
 * Agentic L3 Executor v2 — 10/10 competitive CLI engine
 *
 * Features:
 * - 34+ tools via GeminiToolAdapter (LSP, git, web, memory, tracker, etc.)
 * - Streaming output — real-time token display as LLM generates
 * - JIT context discovery — files discovered by tools are indexed for next turn
 * - Turn compression — Topic-Action-Summary keeps prompts lean on long sessions
 * - Multi-model routing — cheap models for simple tasks, heavy for complex
 * - Auto-retry — failed tool calls retry up to 3 times with correction
 * - Repo-map context — TF-IDF semantic search injected before execution
 */

import type { AutonomousResult, TurnResult } from '../worker/autonomous-loop.js';
import type { ToolDeclaration } from '../tools/base.js';
import type { Sandbox } from '../sandbox/index.js';
import { executeAutonomous } from '../worker/autonomous-loop.js';
import { GeminiToolAdapter, type ConstraintLevel, constraintLevelForPersona } from '../tools/gemini/crew-adapter.js';
import {
  openAICompatibleTurn,
  anthropicTurn,
  type LLMTurnResult
} from './multi-turn-drivers.js';
import { CorrectionStore } from '../learning/corrections.js';
import { estimateTokens, getContextWindow, adaptiveCompressionRatio, calculateTokenBudget, compactConversation, type CompactedMessage } from '../context/token-compaction.js';
import { ExecutionTranscript } from '../execution/transcript.js';
import { getOAuthToken, forceRefreshOAuthToken } from '../auth/oauth-keychain.js';
import { getOpenAIOAuthToken, forceRefreshOpenAIOAuth, OPENAI_CODEX_API_URL } from '../auth/openai-oauth.js';
import { getGeminiOAuthToken, forceRefreshGeminiOAuth } from '../auth/gemini-oauth.js';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

// Repair common JSON quirks from provider tool call responses
export function repairJson(raw: string): string {
  if (!raw || raw.trim() === '') return '{}';
  let s = raw.trim();
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Fix single quotes to double quotes (but not inside strings)
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"');
  }
  // Fix unquoted keys: { key: "value" } → { "key": "value" }
  s = s.replace(/([{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  // Handle truncated JSON from streaming — close open braces/brackets
  const openBraces = (s.match(/{/g) || []).length;
  const closeBraces = (s.match(/}/g) || []).length;
  for (let i = 0; i < openBraces - closeBraces; i++) s += '}';
  const openBrackets = (s.match(/\[/g) || []).length;
  const closeBrackets = (s.match(/]/g) || []).length;
  for (let i = 0; i < openBrackets - closeBrackets; i++) s += ']';
  return s;
}

const L3_SYSTEM_PROMPT = `You are a senior AI engineer executing coding tasks autonomously.

## Cognitive Loop: THINK → ACT → OBSERVE

Every turn, follow this exact pattern:

**THINK** (internal reasoning, 1-3 sentences):
- What is the current state? What do I know from previous tool results?
- What is the minimal next action to make progress?
- Am I done? If so, summarize and stop.

**ACT** (one or more tool calls):
- Choose the most targeted tool for the job.
- Prefer small, verifiable steps over large changes.
- When multiple independent lookups are needed, call multiple tools in parallel.

**OBSERVE** (after tools return):
- Did the tool succeed or fail? What does the output tell me?
- Do I need to adjust my approach?

## Operating Principles

- Match the request. Do what was asked — nothing more. A bug fix is just a bug fix. Don't refactor adjacent code, add docstrings to unchanged functions, or suggest rewrites beyond the task scope.
- Simplest approach first. Don't over-engineer. Three similar lines are better than a premature abstraction. Only add error handling, validation, or fallbacks at system boundaries (user input, external APIs), not for internal guarantees.
- Own mistakes. If a tool call fails or your approach is wrong, say so briefly and try a different approach. Don't repeat the same failing action. If the same failure pattern repeats twice, switch strategy.
- Be security-conscious. Don't introduce injection, XSS, or hardcoded secrets. Validate at trust boundaries.

## Available Tools

**Files**: read_file, write_file, replace (edit with replace_all flag), read_many_files, glob, grep_search (output_mode: content/files/count, context, type filter), list_directory, mkdir
**Shell**: run_shell_command (Docker isolation when staged files exist; run_in_background for long commands; configurable timeout via CREW_SHELL_TIMEOUT, default 120s, max 600s), check_background_task
**Git**: git (status, diff, log, add, commit, show, branch, stash, tag, blame, checkout, fetch, pull, merge, rebase, cherry-pick, worktree — force-push and --no-verify blocked)
**Web**: google_web_search, web_fetch
**Memory**: save_memory (persist facts across sessions), write_todos
**Docs**: get_internal_docs (read project documentation)
**Agents**: spawn_agent (spawn autonomous sub-agent for independent subtasks — isolated sandbox branch, cheap model by default, merges changes on completion)

## File Reading Strategy

1. ALWAYS read a file before editing it. Never guess at file contents.
2. For large files (500+ lines): read specific line ranges instead of the whole file.
3. If a read_file result looks truncated, re-read with a narrower range around the area of interest.
4. Use grep_search to locate exact strings before attempting replace/edit.

## Edit Strategy

1. ALWAYS read_file before editing. Edits on unread files will be rejected.
2. Use replace (edit) for surgical changes — provide exact old_string that uniquely matches.
3. Use replace_all:true when renaming a variable/function across the file.
4. For new files, use write_file.
5. Never rewrite an entire existing file — always use targeted edits.
6. If an edit fails with "not unique", provide more surrounding context or use replace_all:true.
7. If an edit fails with "String not found", re-read the file and retry with current content.

## Shell Strategy

1. For long-running commands (builds, tests, installs), use run_in_background:true.
2. Use check_background_task to poll for results.
3. Prefer dedicated tools over shell: use read_file not cat, grep_search not rg, glob not find.
4. Never use destructive commands (rm -rf, git reset --hard) without explicit task instruction.

## Verification

1. After code changes: run the build command (usually "npm run build" or "tsc --noEmit").
2. After logic changes: run relevant tests ("npm test", or specific test file).
3. Check git diff to confirm only intended changes were made.

## Output

- Lead with what you did, not how you thought about it. Skip preamble.
- For informational queries (listing files, reading code, checking status): include the actual tool output in your response so the user sees the data.
- For code changes: concise summary of files modified, what changed, verification result.
- When you used a tool to answer a question, show the results — don't just say "I listed the files" without showing them.

## Stop Conditions — When to Finish

- The task is fully complete and verified.
- You have confirmed the changes work (via build, test, or diagnostic check).
- Do NOT keep reading files or running tools after the work is done.
- Do NOT repeat yourself or restate your work — just give a concise summary.

## Anti-Patterns to Avoid

- Do NOT read every file in the project to "understand context" — read only what's needed.
- Do NOT make speculative changes to files you haven't read.
- Do NOT run the same command twice if it already succeeded.
- Do NOT apologize or explain failures at length — just fix them and move on.
- Do NOT add features, refactor, or "improve" code beyond what the task asks.
- Do NOT add comments, docstrings, or type annotations to code you didn't change.`;

// ---------------------------------------------------------------------------
// Corrections injection — load recent corrections to prevent repeat mistakes
// ---------------------------------------------------------------------------

async function loadCorrectionsContext(projectDir: string): Promise<string> {
  try {
    const store = new CorrectionStore(projectDir);
    const entries = await store.loadAll();
    if (entries.length === 0) return '';

    // Take last 10 corrections (most recent = most relevant)
    const recent = entries.slice(-10);
    const lines = recent.map(c => {
      const tags = c.tags?.length ? ` [${c.tags.join(', ')}]` : '';
      return `- ${c.prompt.slice(0, 100)}${tags}: ${c.corrected.slice(0, 200)}`;
    });

    return `\n\n## Past Corrections (avoid repeating these mistakes)\n${lines.join('\n')}`;
  } catch {
    return ''; // No corrections file or parse error — non-fatal
  }
}

// ---------------------------------------------------------------------------
// Turn Compression — Topic-Action-Summary model
// ---------------------------------------------------------------------------

interface CompressedTurn {
  turn: number;
  topic: string;   // what was being worked on
  action: string;  // tool + brief params
  outcome: string; // success/fail + short result
}

export function compressTurnHistory(history: TurnResult[]): CompressedTurn[] {
  return history.map(h => {
    const paramStr = JSON.stringify(h.params);
    // Extract the most important param (usually file_path, pattern, or command)
    const keyParam = h.params.file_path || h.params.pattern || h.params.command
      || h.params.query || h.params.path || h.params.dir_path || '';
    const action = `${h.tool}(${String(keyParam).slice(0, 80)})`;

    const isError = Boolean(h.error);
    const resultText = isError
      ? h.error!
      : (typeof h.result === 'object' && h.result && 'output' in h.result)
        ? String((h.result as any).output ?? '')
        : String(h.result ?? '');

    // Compress outcome to most useful info
    const outcome = isError
      ? `FAIL: ${resultText.slice(0, 120)}`
      : `OK: ${resultText.slice(0, 120)}`;

    // Infer topic from tool + params
    const topic = h.params.file_path
      ? String(h.params.file_path).split('/').pop() || 'file'
      : h.tool;

    return { turn: h.turn, topic, action, outcome };
  });
}

/** Format a tool result as a string, truncated for context */
export function formatToolResult(h: TurnResult, maxLen = 1500): string {
  const res = h.error
    ? `ERROR: ${h.error}`
    : (typeof h.result === 'object' && h.result && 'output' in h.result)
      ? String((h.result as { output?: string }).output ?? '')
      : String(h.result ?? '');
  return res.slice(0, maxLen);
}

/**
 * Convert TurnResult[] into provider-specific structured messages.
 * Each TurnResult becomes an assistant tool_call + user tool_result pair.
 * For long histories, middle turns are compressed to text summary while
 * the first 3 (initial context) and last 5 (recent work) use full structured format.
 */
export function historyToGeminiContents(history: TurnResult[], model?: string): any[] {
  if (history.length === 0) return [];
  const contents: any[] = [];

  // Estimate current token usage to pick adaptive compression ratio
  const totalChars = history.reduce((sum, h) => {
    const paramStr = JSON.stringify(h.params);
    const resultStr = typeof h.result === 'string' ? h.result : JSON.stringify(h.result || '');
    return sum + paramStr.length + resultStr.length;
  }, 0);
  const estimatedHistoryTokens = estimateTokens(String.fromCharCode(0).repeat(totalChars));
  const contextWindow = getContextWindow(model || 'gemini-2.5-flash');
  const usagePct = estimatedHistoryTokens / contextWindow;

  // Adaptive compression: more aggressive as context fills up
  const { firstN, lastN } = adaptiveCompressionRatio(history.length, usagePct);
  const needsCompression = history.length > firstN + lastN;
  const headDetailed = needsCompression ? history.slice(0, firstN) : [];
  const middleTurns = needsCompression ? history.slice(firstN, -lastN) : [];
  const structuredTurns = needsCompression ? history.slice(-lastN) : history;

  // Emit head turns (initial context) as full structured messages
  for (const h of headDetailed) {
    contents.push({
      role: 'model',
      parts: [{ functionCall: { name: h.tool, args: h.params } }]
    });
    const resultObj = h.error
      ? { error: h.error }
      : (typeof h.result === 'object' && h.result) ? h.result : { output: formatToolResult(h) };
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: h.tool, response: resultObj } }]
    });
  }

  // Emit compressed summary of middle turns
  if (middleTurns.length > 0) {
    const compressed = compressTurnHistory(middleTurns);
    const summary = compressed.map(c => `[${c.turn}] ${c.action} → ${c.outcome}`).join('\n');
    contents.push(
      { role: 'model', parts: [{ text: `[Earlier execution summary]\n${summary}` }] },
      { role: 'user', parts: [{ text: 'Acknowledged. Continue with the task.' }] }
    );
  }

  for (const h of structuredTurns) {
    // Model made a tool call
    contents.push({
      role: 'model',
      parts: [{ functionCall: { name: h.tool, args: h.params } }]
    });
    // User provided tool result
    const resultObj = h.error
      ? { error: h.error }
      : (typeof h.result === 'object' && h.result) ? h.result : { output: formatToolResult(h) };
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: h.tool, response: resultObj } }]
    });
  }
  return contents;
}

export function historyToOpenAIMessages(history: TurnResult[], model?: string): any[] {
  if (history.length === 0) return [];
  const messages: any[] = [];

  // Estimate token usage for adaptive compression
  const totalChars = history.reduce((sum, h) => {
    const paramStr = JSON.stringify(h.params);
    const resultStr = typeof h.result === 'string' ? h.result : JSON.stringify(h.result || '');
    return sum + paramStr.length + resultStr.length;
  }, 0);
  const estimatedHistoryTokens = estimateTokens(String.fromCharCode(0).repeat(totalChars));
  const contextWindow = getContextWindow(model || 'gpt-4o');
  const usagePct = estimatedHistoryTokens / contextWindow;

  const { firstN, lastN } = adaptiveCompressionRatio(history.length, usagePct);
  const needsCompression = history.length > firstN + lastN;
  const headDetailed = needsCompression ? history.slice(0, firstN) : [];
  const middleTurns = needsCompression ? history.slice(firstN, -lastN) : [];
  const structuredTurns = needsCompression ? history.slice(-lastN) : history;

  // Emit head turns (initial context) as full structured messages
  for (const h of headDetailed) {
    const callId = `call_${h.turn}_${h.tool}`;
    messages.push({
      role: 'assistant',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: h.tool, arguments: JSON.stringify(h.params) }
      }]
    });
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      content: formatToolResult(h)
    });
  }

  // Emit compressed summary of middle turns
  if (middleTurns.length > 0) {
    const compressed = compressTurnHistory(middleTurns);
    const summary = compressed.map(c => `[${c.turn}] ${c.action} → ${c.outcome}`).join('\n');
    messages.push(
      { role: 'assistant', content: `[Earlier execution summary]\n${summary}` },
      { role: 'user', content: 'Acknowledged. Continue with the task.' }
    );
  }

  for (const h of structuredTurns) {
    const callId = `call_${h.turn}_${h.tool}`;
    messages.push({
      role: 'assistant',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: h.tool, arguments: JSON.stringify(h.params) }
      }]
    });
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      content: formatToolResult(h)
    });
  }
  return messages;
}

function historyToAnthropicMessages(history: TurnResult[]): any[] {
  if (history.length === 0) return [];
  const messages: any[] = [];

  // Selective compression: keep first 3 + last 5 detailed, compress only middle
  const firstN = 3;
  const lastN = 5;
  const needsCompression = history.length > firstN + lastN;
  const headDetailed = needsCompression ? history.slice(0, firstN) : [];
  const middleTurns = needsCompression ? history.slice(firstN, -lastN) : [];
  const structuredTurns = needsCompression ? history.slice(-lastN) : history;

  // Emit head turns (initial context) as full structured messages
  for (const h of headDetailed) {
    const useId = `tu_${h.turn}_${h.tool}`;
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: useId,
        name: h.tool,
        input: h.params
      }]
    });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: useId,
        content: formatToolResult(h)
      }]
    });
  }

  // Emit compressed summary of middle turns
  if (middleTurns.length > 0) {
    const compressed = compressTurnHistory(middleTurns);
    const summary = compressed.map(c => `[${c.turn}] ${c.action} → ${c.outcome}`).join('\n');
    messages.push(
      { role: 'assistant', content: `[Earlier execution summary]\n${summary}` },
      { role: 'user', content: 'Acknowledged. Continue with the task.' }
    );
  }

  for (const h of structuredTurns) {
    const useId = `tu_${h.turn}_${h.tool}`;
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: useId,
        name: h.tool,
        input: h.params
      }]
    });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: useId,
        content: formatToolResult(h)
      }]
    });
  }
  return messages;
}

/** Legacy text-based history for fallback (markers-only providers) */
function historyToContext(history: TurnResult[]): string {
  if (history.length === 0) return '';

  // For short histories, use detailed format
  if (history.length <= 5) {
    const lines = history.map(h => {
      return `[Turn ${h.turn}] ${h.tool}(${JSON.stringify(h.params).slice(0, 200)}) → ${formatToolResult(h, 800)}`;
    });
    return '\n\nPrevious tool results:\n' + lines.join('\n');
  }

  // For longer histories, use compressed Topic-Action-Summary
  const compressed = compressTurnHistory(history);
  const recentDetailed = history.slice(-3); // Keep last 3 turns detailed
  const olderCompressed = compressed.slice(0, -3);

  let ctx = '\n\nExecution summary (compressed):\n';
  ctx += olderCompressed.map(c =>
    `[${c.turn}] ${c.action} → ${c.outcome}`
  ).join('\n');

  ctx += '\n\nRecent actions (detailed):\n';
  ctx += recentDetailed.map(h => {
    return `[Turn ${h.turn}] ${h.tool}(${JSON.stringify(h.params).slice(0, 200)}) → ${formatToolResult(h, 800)}`;
  }).join('\n');

  return ctx;
}

// ---------------------------------------------------------------------------
// Multi-model routing — more providers, task-based selection
// ---------------------------------------------------------------------------

interface ProviderEntry {
  id: string;
  envKey: string;
  model: string;
  driver: 'gemini' | 'openai' | 'anthropic' | 'openrouter';
  apiUrl?: string;
  modelPrefix?: string;
  tier: 'fast' | 'standard' | 'heavy'; // for complexity-based routing
}

const PROVIDER_ORDER: ProviderEntry[] = [
  // Heavy tier — L2 brain (complex multi-file tasks, planning)
  { id: 'openai', envKey: 'OPENAI_API_KEY', model: 'gpt-4.1', driver: 'openai', apiUrl: 'https://api.openai.com/v1/chat/completions', modelPrefix: 'gpt', tier: 'heavy' },
  { id: 'anthropic', envKey: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-20250514', driver: 'anthropic', modelPrefix: 'claude', tier: 'heavy' },
  { id: 'grok', envKey: 'XAI_API_KEY', model: 'grok-3-mini-beta', driver: 'openai', apiUrl: 'https://api.x.ai/v1/chat/completions', modelPrefix: 'grok', tier: 'heavy' },
  // Standard tier — L3 workers (execution, parallel tasks)
  { id: 'gemini', envKey: 'GEMINI_API_KEY', model: 'gemini-2.5-flash', driver: 'gemini', modelPrefix: 'gemini', tier: 'standard' },
  { id: 'gemini', envKey: 'GOOGLE_API_KEY', model: 'gemini-2.5-flash', driver: 'gemini', modelPrefix: 'gemini', tier: 'standard' },
  { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY', model: 'deepseek-chat', driver: 'openai', apiUrl: 'https://api.deepseek.com/v1/chat/completions', modelPrefix: 'deepseek', tier: 'standard' },
  { id: 'kimi', envKey: 'MOONSHOT_API_KEY', model: 'moonshot-v1-128k', driver: 'openai', apiUrl: 'https://api.moonshot.cn/v1/chat/completions', modelPrefix: 'kimi', tier: 'standard' },
  // Fast tier — L1 routing (classification, cheap)
  { id: 'groq', envKey: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile', driver: 'openai', apiUrl: 'https://api.groq.com/openai/v1/chat/completions', modelPrefix: 'llama', tier: 'fast' },
  // Fallback — free tier
  { id: 'openrouter', envKey: 'OPENROUTER_API_KEY', model: 'google/gemini-2.0-flash-exp:free', driver: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1/chat/completions', modelPrefix: 'openrouter', tier: 'standard' },
  // Additional providers (OpenAI-compatible, cheap workers)
  { id: 'together', envKey: 'TOGETHER_API_KEY', model: 'Qwen/Qwen3.5-397B-A17B', driver: 'openai', apiUrl: 'https://api.together.xyz/v1/chat/completions', modelPrefix: 'qwen', tier: 'standard' },
  { id: 'fireworks', envKey: 'FIREWORKS_API_KEY', model: 'accounts/fireworks/models/qwen3.5-397b-a17b', driver: 'openai', apiUrl: 'https://api.fireworks.ai/inference/v1/chat/completions', modelPrefix: 'fireworks', tier: 'standard' },
];

export type ResolvedProvider = { key: string; model: string; driver: string; apiUrl?: string; id: string; isOAuth?: boolean };

function stripSchemaMetadata(value: any): any {
  if (Array.isArray(value)) return value.map(stripSchemaMetadata);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (['description', 'title', 'examples', 'default', '$comment'].includes(key)) continue;
    if (key === 'properties' && child && typeof child === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(child).map(([prop, schema]) => [prop, stripSchemaMetadata(schema)])
      );
      continue;
    }
    out[key] = stripSchemaMetadata(child);
  }
  return out;
}

function compactToolDeclarations(tools: ToolDeclaration[], turn: number): ToolDeclaration[] {
  const enabled = String(process.env.CREW_TOOL_SCHEMA_COMPACTION || 'true').trim().toLowerCase();
  if (turn <= 1 || enabled === 'false' || enabled === '0' || enabled === 'off') return tools;
  return tools.map((tool) => ({
    name: tool.name,
    description: '',
    parameters: stripSchemaMetadata(tool.parameters)
  }));
}

async function resolveProvider(modelOverride?: string, preferTier?: string): Promise<ResolvedProvider | null> {
  const effectiveModel = (modelOverride || process.env.CREW_EXECUTION_MODEL || '').trim().toLowerCase();

  // Is this an explicit user-chosen model (via CREW_EXECUTION_MODEL env)?
  // If not, the model was auto-selected by the router and we should prefer OAuth regardless.
  const userExplicitModel = (process.env.CREW_EXECUTION_MODEL || '').trim().toLowerCase();

  // ── OAuth first: subscription-based auth (free, highest priority) ──
  // When no explicit model override is set, try ALL OAuth providers (Claude > OpenAI > Gemini).
  // When user explicitly chose a model, only try the matching OAuth provider.

  if (process.env.CREW_NO_OAUTH !== 'true') {
    // 1. Claude OAuth (macOS Keychain — Claude Max/Pro subscription)
    const wantsClaude = !userExplicitModel || userExplicitModel.includes('claude') || userExplicitModel.includes('anthropic');
    if (wantsClaude) {
      try {
        const oauth = await getOAuthToken();
        if (oauth?.accessToken) {
          const oauthModel = userExplicitModel && userExplicitModel.includes('claude')
            ? userExplicitModel
            : String(process.env.CREW_OAUTH_CLAUDE_MODEL || 'claude-opus-4.6');
          return {
            key: oauth.accessToken,
            model: oauthModel,
            driver: 'anthropic',
            id: `anthropic-oauth-${oauth.subscriptionType || 'unknown'}`,
            isOAuth: true
          };
        }
      } catch {
        // Claude OAuth unavailable — try next
      }
    }

    // 2. OpenAI OAuth (Codex CLI auth — ChatGPT Plus/Pro subscription)
    const wantsOpenAI = !userExplicitModel || userExplicitModel.includes('gpt') || userExplicitModel.includes('openai') || userExplicitModel.includes('codex');
    if (wantsOpenAI) {
      try {
        const oauth = await getOpenAIOAuthToken();
        if (oauth?.accessToken) {
          const oauthModel = userExplicitModel && (userExplicitModel.includes('gpt') || userExplicitModel.includes('codex'))
            ? userExplicitModel
            : String(process.env.CREW_OAUTH_OPENAI_MODEL || 'gpt-5.4');
          return {
            key: oauth.accessToken,
            model: oauthModel,
            driver: 'openai',
            apiUrl: OPENAI_CODEX_API_URL,
            id: 'openai-oauth-codex',
            isOAuth: true
          };
        }
      } catch {
        // OpenAI OAuth unavailable — try next
      }
    }

    // 3. Gemini OAuth (Google ADC or Gemini CLI — Google account)
    const wantsGemini = !userExplicitModel || userExplicitModel.includes('gemini') || userExplicitModel.includes('google');
    if (wantsGemini) {
      try {
        const oauth = await getGeminiOAuthToken();
        if (oauth?.accessToken) {
          const oauthModel = userExplicitModel && userExplicitModel.includes('gemini')
            ? userExplicitModel
            : String(process.env.CREW_OAUTH_GEMINI_MODEL || 'gemini-2.5-flash');
          return {
            key: oauth.accessToken,
            model: oauthModel,
            driver: 'gemini',
            id: 'gemini-oauth-adc',
            isOAuth: true
          };
        }
      } catch {
        // Gemini OAuth unavailable — try next
      }
    }
  }

  // ── API key providers (fallback when OAuth unavailable) ──
  // If a specific model is requested, find the matching provider
  if (effectiveModel) {
    for (const p of PROVIDER_ORDER) {
      const key = process.env[p.envKey];
      if (!key || key.length < 5) continue;
      if (p.envKey === 'GOOGLE_API_KEY' && process.env.GEMINI_API_KEY) continue;
      if (p.modelPrefix && effectiveModel.includes(p.modelPrefix)) {
        return { key, model: modelOverride || process.env.CREW_EXECUTION_MODEL || p.model, driver: p.driver, apiUrl: p.apiUrl, id: p.id };
      }
    }
  }

  // Tier-based routing
  const targetTier = preferTier || 'standard';
  // Try preferred tier first, then fall back to any
  const tieredOrder = [
    ...PROVIDER_ORDER.filter(p => p.tier === targetTier),
    ...PROVIDER_ORDER.filter(p => p.tier !== targetTier)
  ];

  for (const p of tieredOrder) {
    const key = process.env[p.envKey];
    if (!key || key.length < 5) continue;
    if (p.envKey === 'GOOGLE_API_KEY' && process.env.GEMINI_API_KEY) continue;
    return { key, model: p.model, driver: p.driver, apiUrl: p.apiUrl, id: p.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Streaming LLM turn — real-time token output
// ---------------------------------------------------------------------------

/** Image attachment for multimodal input */
export interface ImageAttachment {
  data: string;      // base64-encoded image data
  mimeType: string;  // e.g. 'image/png', 'image/jpeg'
}

async function executeStreamingGeminiTurn(
  fullTask: string,
  tools: ToolDeclaration[],
  key: string,
  model: string,
  systemPrompt: string,
  stream: boolean,
  images?: ImageAttachment[],
  historyMessages?: any[],
  isOAuth?: boolean
): Promise<LLMTurnResult> {
  const functionDeclarations = tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }));

  // Build user parts: text + optional images
  const userParts: any[] = [{ text: `${systemPrompt}\n\nTask:\n${fullTask}` }];
  if (images?.length) {
    for (const img of images) {
      userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }
  const contents: any[] = [
    { role: 'user', parts: userParts },
    // Insert structured history (tool call/result pairs)
    ...(historyMessages || []),
    // Continuation prompt if we have history
    ...(historyMessages?.length ? [{ role: 'user', parts: [{ text: 'Continue executing the task based on the results above.' }] }] : [])
  ];

  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';

  // OAuth uses Bearer auth header; API keys use ?key= query parameter
  const url = isOAuth
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}${stream ? '?alt=sse' : ''}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}?key=${encodeURIComponent(key)}${stream ? '&alt=sse' : ''}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isOAuth) {
    headers['Authorization'] = `Bearer ${key}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      contents,
      tools: [{ functionDeclarations }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
    })
  });

  if (!res.ok) {
    // On 401 with OAuth, try refreshing the token and retrying once
    if (res.status === 401 && isOAuth) {
      const refreshed = await forceRefreshGeminiOAuth();
      if (refreshed?.accessToken && refreshed.accessToken !== key) {
        return executeStreamingGeminiTurn(
          fullTask, tools, refreshed.accessToken, model,
          systemPrompt, stream, images, historyMessages, true
        );
      }
    }
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err.slice(0, 300)}`);
  }

  if (stream && res.body) {
    // Parse SSE stream
    let fullText = '';
    const toolCalls: Array<{ tool: string; params: Record<string, any> }> = [];
    let totalCost = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(jsonStr);
            const parts = chunk?.candidates?.[0]?.content?.parts ?? [];

            for (const part of parts) {
              if (part.text) {
                process.stdout.write(part.text);
                fullText += part.text;
              }
              if (part.functionCall) {
                toolCalls.push({
                  tool: part.functionCall.name || '',
                  params: part.functionCall.args || {}
                });
              }
            }

            // Accumulate usage
            const usage = chunk?.usageMetadata;
            if (usage) {
              totalCost = (usage.promptTokenCount || 0) * 0.075 / 1_000_000
                + (usage.candidatesTokenCount || 0) * 0.30 / 1_000_000;
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (fullText) process.stdout.write('\n');

    if (toolCalls.length > 0) {
      return { toolCalls, response: fullText, cost: totalCost };
    }
    return { response: fullText, status: 'COMPLETE', cost: totalCost };
  }

  // Non-streaming fallback
  const data = await res.json() as any;
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const usage = data?.usageMetadata ?? {};
  const cost = (usage.promptTokenCount || 0) * 0.075 / 1_000_000 + (usage.candidatesTokenCount || 0) * 0.30 / 1_000_000;

  const toolCalls: Array<{ tool: string; params: Record<string, any> }> = [];
  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({ tool: part.functionCall.name || '', params: part.functionCall.args || {} });
    }
  }

  if (toolCalls.length > 0) return { toolCalls, response: '', cost };

  const textPart = parts.find((p: any) => p.text);
  return { response: textPart?.text ?? '', status: 'COMPLETE', cost };
}

async function executeStreamingOpenAITurn(
  fullTask: string,
  tools: ToolDeclaration[],
  apiUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  stream: boolean,
  images?: ImageAttachment[],
  historyMessages?: any[],
  isOAuth?: boolean
): Promise<LLMTurnResult> {
  // Build user content: text + optional images as content array
  let userContent: any = fullTask;
  if (images?.length) {
    const parts: any[] = [{ type: 'text', text: fullTask }];
    for (const img of images) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.data}` }
      });
    }
    userContent = parts;
  }
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
    // Insert structured history (assistant tool_calls + tool results)
    ...(historyMessages || [])
  ];

  const openaiTools = tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));

  // GPT-5/6 only support temperature=1; other values cause 400
  const temp = (model?.startsWith?.('gpt-5') || model?.startsWith?.('gpt-6')) ? 1 : 0.3;
  const body: any = {
    model,
    messages,
    tools: openaiTools,
    temperature: temp,
    max_tokens: 8192,
    stream
  };

  // Codex OAuth endpoint uses store:false for stateless requests
  if (isOAuth && apiUrl === OPENAI_CODEX_API_URL) {
    body.store = false;
  }

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // On 401 with OAuth, try refreshing the token and retrying once
    if (res.status === 401 && isOAuth) {
      const refreshed = await forceRefreshOpenAIOAuth();
      if (refreshed?.accessToken && refreshed.accessToken !== apiKey) {
        return executeStreamingOpenAITurn(
          fullTask, tools, apiUrl, refreshed.accessToken, model,
          systemPrompt, stream, images, historyMessages, true
        );
      }
    }
    const err = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${err.slice(0, 300)}`);
  }

  if (stream && res.body) {
    let fullText = '';
    const toolCallAccumulator = new Map<number, { name: string; args: string }>();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(jsonStr);
            const delta = chunk?.choices?.[0]?.delta;
            if (!delta) continue;

            // Stream text content
            if (delta.content) {
              process.stdout.write(delta.content);
              fullText += delta.content;
            }

            // Accumulate tool calls (streamed in pieces)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulator.has(idx)) {
                  toolCallAccumulator.set(idx, { name: '', args: '' });
                }
                const acc = toolCallAccumulator.get(idx)!;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (fullText) process.stdout.write('\n');

    // Parse accumulated tool calls
    const toolCalls: Array<{ tool: string; params: Record<string, any> }> = [];
    for (const [, tc] of toolCallAccumulator) {
      if (tc.name) {
        let params = {};
        try { params = JSON.parse(repairJson(tc.args)); } catch {}
        toolCalls.push({ tool: tc.name, params });
      }
    }

    if (toolCalls.length > 0) return { toolCalls, response: fullText, cost: 0 };
    return { response: fullText, status: 'COMPLETE', cost: 0 };
  }

  // Non-streaming fallback to multi-turn-drivers
  // (this path shouldn't be hit normally since we always stream)
  const data = await res.json() as any;
  const choice = data?.choices?.[0];
  const msg = choice?.message;

  if (msg?.tool_calls?.length > 0) {
    const toolCalls = msg.tool_calls.map((tc: any) => {
      let params = {};
      try { params = JSON.parse(repairJson(tc.function?.arguments || '{}')); } catch {}
      return { tool: tc.function?.name || '', params };
    });
    return { toolCalls, response: msg?.content || '', cost: 0 };
  }

  return { response: msg?.content || '', status: 'COMPLETE', cost: 0 };
}

// ---------------------------------------------------------------------------
// Anthropic SDK path — uses official SDK with authToken for OAuth
// ---------------------------------------------------------------------------

async function executeAnthropicSDKTurn(
  fullTask: string,
  tools: ToolDeclaration[],
  authToken: string,
  model: string,
  systemPrompt: string,
  images?: ImageAttachment[],
  historyMessages?: any[]
): Promise<LLMTurnResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({
    authToken,
    apiKey: null as any,
    defaultHeaders: { 'x-app': 'cli' }
  });

  // Build user content
  let userContent: any = fullTask;
  if (images?.length) {
    const parts: any[] = [{ type: 'text', text: fullTask }];
    for (const img of images) {
      parts.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data }
      });
    }
    userContent = parts;
  }

  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters as any
  }));

  try {
    // Use beta.messages.create with oauth-2025-04-20 to enable OAuth auth
    const response = await (client.beta.messages.create as any)({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        { role: 'user' as const, content: userContent },
        ...(historyMessages || [])
      ],
      temperature: 0.3,
      tools: anthropicTools,
      betas: [
        'oauth-2025-04-20',           // Required for OAuth auth
        'interleaved-thinking-2025-05-14', // Think between tool calls
        'prompt-caching-2025-04-11',   // Better prompt caching
      ],
      stream: false
    });

    const usage = (response as any).usage || {} as any;
    const cost = ((usage.input_tokens || 0) * 3 + (usage.output_tokens || 0) * 15) / 1_000_000;

    const content = response.content || [];
    const toolUseBlocks = content.filter((b: any) => b.type === 'tool_use');
    const textBlocks = content.filter((b: any) => b.type === 'text');
    const textResponse = textBlocks.map((b: any) => b.text).join('\n');

    if (textResponse) process.stdout.write(textResponse);

    if (toolUseBlocks.length > 0) {
      const toolCalls = toolUseBlocks.map((b: any) => ({
        tool: b.name,
        params: b.input || {}
      }));
      return { toolCalls, response: textResponse, cost };
    }

    return { response: textResponse, status: 'COMPLETE', cost };
  } catch (err: any) {
    // On auth error, try refreshing token
    if (err?.status === 401) {
      const refreshed = await forceRefreshOAuthToken();
      if (refreshed?.accessToken && refreshed.accessToken !== authToken) {
        return executeAnthropicSDKTurn(fullTask, tools, refreshed.accessToken, model, systemPrompt, images, historyMessages);
      }
    }
    throw err;
  }
}

async function executeStreamingAnthropicTurn(
  fullTask: string,
  tools: ToolDeclaration[],
  apiKey: string,
  model: string,
  systemPrompt: string,
  stream: boolean,
  images?: ImageAttachment[],
  historyMessages?: any[],
  isOAuth?: boolean
): Promise<LLMTurnResult> {
  // ── SDK path for OAuth (uses @anthropic-ai/sdk with authToken) ──
  if (isOAuth) {
    return executeAnthropicSDKTurn(fullTask, tools, apiKey, model, systemPrompt, images, historyMessages);
  }

  // Build user content: text + optional images
  let userContent: any = fullTask;
  if (images?.length) {
    const parts: any[] = [{ type: 'text', text: fullTask }];
    for (const img of images) {
      parts.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data }
      });
    }
    userContent = parts;
  }

  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));

  const body: any = {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userContent },
      // Insert structured history (assistant tool_use + user tool_result)
      ...(historyMessages || [])
    ],
    temperature: 0.3,
    tools: anthropicTools,
    stream
  };

  // API keys use x-api-key
  const authHeaders: Record<string, string> = { 'x-api-key': apiKey };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      'anthropic-version': '2023-06-01'
    },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // On 401 with OAuth, try refreshing the token and retrying once
    if (res.status === 401 && isOAuth) {
      const refreshed = await forceRefreshOAuthToken();
      if (refreshed?.accessToken && refreshed.accessToken !== apiKey) {
        return executeStreamingAnthropicTurn(
          fullTask, tools, refreshed.accessToken, model,
          systemPrompt, stream, images, historyMessages, true
        );
      }
    }
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 300)}`);
  }

  if (stream && res.body) {
    let fullText = '';
    const toolBlocks = new Map<number, { name: string; inputJson: string }>();
    let totalCost = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                toolBlocks.set(event.index, {
                  name: event.content_block.name || '',
                  inputJson: ''
                });
              }
            }

            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                process.stdout.write(event.delta.text);
                fullText += event.delta.text;
              }
              if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                const block = toolBlocks.get(event.index);
                if (block) block.inputJson += event.delta.partial_json;
              }
            }

            if (event.type === 'message_delta' && event.usage) {
              totalCost = (event.usage.input_tokens || 0) * 3 / 1_000_000
                + (event.usage.output_tokens || 0) * 15 / 1_000_000;
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (fullText) process.stdout.write('\n');

    // Parse accumulated tool calls
    const toolCalls: Array<{ tool: string; params: Record<string, any> }> = [];
    for (const [, block] of toolBlocks) {
      if (block.name) {
        let params = {};
        try { params = JSON.parse(repairJson(block.inputJson)); } catch {}
        toolCalls.push({ tool: block.name, params });
      }
    }

    if (toolCalls.length > 0) return { toolCalls, response: fullText, cost: totalCost };
    return { response: fullText, status: 'COMPLETE', cost: totalCost };
  }

  // Non-streaming fallback
  const data = await res.json() as any;
  const usage = data?.usage || {};
  const cost = (usage.input_tokens || 0) * 3 / 1_000_000 + (usage.output_tokens || 0) * 15 / 1_000_000;
  const content = data?.content || [];
  const toolUseBlocks = content.filter((b: any) => b.type === 'tool_use');
  const textBlocks = content.filter((b: any) => b.type === 'text');
  const textResponse = textBlocks.map((b: any) => b.text).join('\n');

  if (toolUseBlocks.length > 0) {
    const toolCalls = toolUseBlocks.map((b: any) => ({ tool: b.name, params: b.input || {} }));
    return { toolCalls, response: textResponse, cost };
  }
  return { response: textResponse, status: 'COMPLETE', cost };
}

async function executeLLMTurn(
  task: string,
  tools: ToolDeclaration[],
  history: TurnResult[],
  model: string,
  systemPrompt: string,
  stream: boolean,
  images?: ImageAttachment[]
): Promise<LLMTurnResult> {
  const resolved = await resolveProvider(model);
  if (!resolved) {
    throw new Error(
      'No LLM providers available. Use OAuth (free with subscriptions) or set an API key:\n' +
      '  OAuth (auto-detected, no config needed):\n' +
      '  → Claude Code login  → uses Claude Max/Pro subscription\n' +
      '  → Codex CLI login    → uses ChatGPT Plus/Pro subscription\n' +
      '  → gcloud auth login  → uses Google account for Gemini\n' +
      '  API keys (fallback):\n' +
      '  → GEMINI_API_KEY (free tier — https://aistudio.google.com/apikey)\n' +
      '  → GROQ_API_KEY   (free — https://console.groq.com/keys)\n' +
      '  → XAI_API_KEY    ($5/mo free credits — https://console.x.ai)\n' +
      'Or any of: OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY\n' +
      'Run "crew doctor" to check your setup.'
    );
  }

  const { key, model: effectiveModel, driver, apiUrl, id, isOAuth } = resolved;

  // Show auth method per turn so user knows OAuth vs API key
  const authBadge = isOAuth ? 'OAuth' : 'API';
  console.error(`\x1b[2m[${effectiveModel} ${authBadge}]\x1b[0m`);

  // Gemini: structured multi-turn with functionCall/functionResponse
  if (driver === 'gemini') {
    const historyMsgs = historyToGeminiContents(history, effectiveModel);
    return executeStreamingGeminiTurn(task, tools, key, effectiveModel, systemPrompt, stream, images, historyMsgs, isOAuth);
  }

  // Anthropic: structured multi-turn with tool_use/tool_result
  if (driver === 'anthropic') {
    const historyMsgs = historyToAnthropicMessages(history);
    return executeStreamingAnthropicTurn(task, tools, key, effectiveModel, systemPrompt, stream, images, historyMsgs, isOAuth);
  }

  // OpenAI-compatible: structured multi-turn with tool_calls/tool messages
  if (driver === 'openai' || driver === 'openrouter') {
    const historyMsgs = historyToOpenAIMessages(history, effectiveModel);
    return executeStreamingOpenAITurn(task, tools, apiUrl!, key, effectiveModel, systemPrompt, stream, images, historyMsgs, isOAuth);
  }

  throw new Error(`Unsupported driver: ${driver}`);
}

// ---------------------------------------------------------------------------
// JIT Context Discovery — index files as tools discover them
// ---------------------------------------------------------------------------

class JITContextTracker {
  private discoveredFiles = new Set<string>();
  private contextCache: string = '';

  /** Hydrate from a prior session's discovered files */
  static fromPrior(files: string[]): JITContextTracker {
    const tracker = new JITContextTracker();
    for (const f of files) tracker.discoveredFiles.add(f);
    return tracker;
  }

  /** Serialize discovered files for session persistence */
  toFileList(): string[] {
    return Array.from(this.discoveredFiles);
  }

  /** Track a file that was read/written/grepped during tool execution */
  trackFile(filePath: string) {
    if (filePath && !this.discoveredFiles.has(filePath)) {
      this.discoveredFiles.add(filePath);
    }
  }

  /** Extract file paths from tool calls and results */
  trackFromToolResult(toolName: string, params: Record<string, any>, result: any) {
    // Track files referenced in tool params
    for (const key of ['file_path', 'path', 'dir_path']) {
      if (params[key]) this.trackFile(String(params[key]));
    }

    // Track files discovered by glob/grep results
    if ((toolName === 'glob' || toolName === 'grep_search' || toolName === 'grep_search_ripgrep') && result?.output) {
      const lines = String(result.output).split('\n');
      for (const line of lines) {
        const match = line.match(/^([^\s:]+\.[a-zA-Z]+)/);
        if (match) this.trackFile(match[1]);
      }
    }

    // Track files from list_directory
    if (toolName === 'list_directory' && result?.output) {
      const lines = String(result.output).split('\n');
      const dir = params.dir_path || params.path || '.';
      for (const line of lines) {
        const match = line.match(/^[fd]\s+(.+)/);
        if (match && match[1].includes('.')) {
          this.trackFile(`${dir}/${match[1]}`);
        }
      }
    }
  }

  /** Build enriched context from discovered files for next turn */
  async buildJITContext(projectDir: string): Promise<string> {
    if (this.discoveredFiles.size === 0) return '';

    try {
      const { buildCollectionIndex, searchCollection } = await import('../collections/index.js');

      // Index only the discovered files/directories
      const uniqueDirs = new Set<string>();
      for (const f of this.discoveredFiles) {
        const parts = f.split('/');
        if (parts.length > 1) {
          uniqueDirs.add(parts.slice(0, -1).join('/'));
        }
      }

      // If we've discovered specific directories, search them
      const dirsToIndex = Array.from(uniqueDirs).slice(0, 5);
      if (dirsToIndex.length === 0) return '';

      const { resolve: resolvePath } = await import('node:path');
      const paths = dirsToIndex.map(d => resolvePath(projectDir, d));

      const index = await buildCollectionIndex(paths, { includeCode: true });
      if (index.chunkCount === 0) return '';

      // Search for related patterns based on discovered file names
      const query = Array.from(this.discoveredFiles).slice(0, 10).join(' ');
      const results = searchCollection(index, query, 3);
      if (results.hits.length === 0) return '';

      const newContext = results.hits.map(h =>
        `--- JIT: ${h.source}:${h.startLine} ---\n${h.text.slice(0, 400)}`
      ).join('\n\n');

      this.contextCache = newContext;
      return `\n\nJIT-discovered context:\n${newContext}`;
    } catch {
      return '';
    }
  }

  get fileCount() { return this.discoveredFiles.size; }
}

// ---------------------------------------------------------------------------
// Repo-map context builder
// ---------------------------------------------------------------------------

async function buildRepoMapContext(task: string, projectDir: string): Promise<string> {
  try {
    // Skip indexing for home directory or root — too large, will hang
    const { homedir } = await import('node:os');
    if (projectDir === homedir() || projectDir === '/') return '';

    const { buildCollectionIndex, searchCollection } = await import('../collections/index.js');
    const index = await buildCollectionIndex([projectDir], { includeCode: true });
    if (index.chunkCount === 0) return '';

    const results = searchCollection(index, task, 5);
    if (results.hits.length === 0) return '';

    const chunks = results.hits.map(h =>
      `--- ${h.source}:${h.startLine} (score: ${h.score}) ---\n${h.text.slice(0, 600)}`
    );
    return `\n\nRelevant codebase context (${index.fileCount} files indexed, ${index.chunkCount} chunks):\n${chunks.join('\n\n')}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Auto-retry wrapper
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

interface ToolExecResult {
  output: string;
  success: boolean;
  error?: string;
  handled?: boolean;       // false = worker MUST address this, not ignore it
  recovery?: string;       // hint for how to fix
}

async function executeToolWithRetry(
  adapter: GeminiToolAdapter,
  name: string,
  params: Record<string, any>,
  verbose: boolean
): Promise<ToolExecResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await adapter.executeTool(name, params);
    if (result.success) {
      return { output: result.output ?? '', success: true };
    }

    // Constraint-level blocks are never retryable — propagate immediately with recovery hint
    if (result.handled === false && result.recovery) {
      const msg = result.recovery
        ? `${result.error}\n\n[RECOVERY HINT]: ${result.recovery}`
        : result.error || 'Tool blocked';
      return { output: msg, success: false, error: result.error, handled: false, recovery: result.recovery };
    }

    // If first attempt failed and we have retries left, try with corrections
    if (attempt < MAX_RETRIES) {
      if (verbose) {
        console.log(`  ⟳ Retry ${attempt}/${MAX_RETRIES - 1} for ${name}: ${(result.error || '').slice(0, 80)}`);
      }

      // Auto-correct common errors
      if (result.error?.includes('String not found') && params.old_string) {
        // Edge case fix: re-read the file to get fresh content before retrying
        if (params.file_path) {
          try {
            const freshRead = await adapter.executeTool('read_file', { file_path: params.file_path });
            if (freshRead.success && freshRead.output) {
              // Return the fresh content as error context so the LLM can see it on next turn
              return {
                output: `File content has changed. Current content of ${params.file_path}:\n${freshRead.output.slice(0, 3000)}`,
                success: false,
                error: `String not found in ${params.file_path}. File was re-read — content returned above for correction.`
              };
            }
          } catch { /* fall through to trim retry */ }
        }
        // Fallback: try trimming whitespace
        params.old_string = params.old_string.trim();
      } else if (result.error?.includes('No such file') && params.file_path) {
        // For file ops: try without leading ./
        params.file_path = params.file_path.replace(/^\.\//, '');
      } else {
        // No auto-correction available, don't retry — propagate handled/recovery
        return { output: result.output ?? '', success: false, error: result.error, handled: result.handled, recovery: result.recovery };
      }
    } else {
      return { output: result.output ?? '', success: false, error: result.error, handled: result.handled, recovery: result.recovery };
    }
  }

  return { output: '', success: false, error: 'Max retries exceeded' };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export interface AgenticExecutorResult {
  success: boolean;
  output: string;
  cost: number;
  turns?: number;
  toolsUsed?: string[];
  providerId?: string;
  modelUsed?: string;
  filesDiscovered?: number;
  discoveredFiles?: string[];
  history?: TurnResult[];
  stopReason?: string;
  transcript?: ExecutionTranscript;
  constraintLevel?: ConstraintLevel;
}

export async function runAgenticWorker(
  task: string,
  sandbox: Sandbox,
  options: {
    systemPrompt?: string;
    model?: string;
    maxTurns?: number;
    projectDir?: string;
    verbose?: boolean;
    stream?: boolean;
    tier?: 'fast' | 'standard' | 'heavy';
    images?: ImageAttachment[];
    onToolCall?: (name: string, params: Record<string, any>) => void;
    priorDiscoveredFiles?: string[];
    constraintLevel?: ConstraintLevel;
    persona?: string;
  } = {}
): Promise<AgenticExecutorResult> {
  // Resolve constraint level: explicit > persona-derived > full (default)
  const constraintLevel = options.constraintLevel
    || (options.persona ? constraintLevelForPersona(options.persona) : 'full');
  const adapter = new GeminiToolAdapter(sandbox, constraintLevel);
  const allTools = adapter.getToolDeclarations() as ToolDeclaration[];
  const systemPrompt = options.systemPrompt || L3_SYSTEM_PROMPT;
  const model = options.model || process.env.CREW_EXECUTION_MODEL || '';
  const maxTurns = options.maxTurns ?? 25;
  const projectDir = options.projectDir || (sandbox as any).baseDir || process.cwd();
  const verbose = options.verbose ?? Boolean(process.env.CREW_DEBUG);
  const stream = options.stream ?? !process.env.CREW_NO_STREAM; // Stream by default
  const jit = options.priorDiscoveredFiles?.length
    ? JITContextTracker.fromPrior(options.priorDiscoveredFiles)
    : new JITContextTracker();

  // Resolve provider early to report which model/provider is being used
  const resolvedProvider = await resolveProvider(model, options.tier);

  // Auth summary — always show so user knows OAuth vs API key
  if (resolvedProvider) {
    const authMethod = resolvedProvider.isOAuth ? 'OAuth' : 'API key';
    console.error(`\x1b[2m[auth] ${resolvedProvider.model} via ${authMethod} (${resolvedProvider.id})\x1b[0m`);
  }

  if (verbose) {
    const prov = resolvedProvider ? `${resolvedProvider.id}/${resolvedProvider.model}` : 'none';
    console.log(`[AgenticExecutor] Provider: ${prov} | Stream: ${stream} | Tools: ${allTools.length} | Constraint: ${constraintLevel}`);
  }

  // Inject repo-map context
  let enrichedTask = task;
  try {
    const repoContext = await buildRepoMapContext(task, projectDir);
    if (repoContext) {
      enrichedTask = `${task}${repoContext}`;
      if (verbose) {
        console.log(`[AgenticExecutor] Repo-map: ${repoContext.length} chars injected`);
      }
    }
  } catch {
    // Non-fatal
  }

  // Inject past corrections to prevent repeat mistakes
  try {
    const correctionsContext = await loadCorrectionsContext(projectDir);
    if (correctionsContext) {
      enrichedTask = `${enrichedTask}${correctionsContext}`;
      if (verbose) {
        console.log(`[AgenticExecutor] Corrections context injected`);
      }
    }
  } catch {
    // Non-fatal
  }

  if (verbose) {
    console.log(`[AgenticExecutor] ${allTools.length} tools: ${allTools.map(t => t.name).join(', ')}`);
  }

  let totalCost = 0;
  const toolsUsed = new Set<string>();
  const transcript = new ExecutionTranscript();

  const executeTool = async (name: string, params: Record<string, any>) => {
    toolsUsed.add(name);

    // Always fire onToolCall callback (for REPL tool progress display)
    options.onToolCall?.(name, params);

    if (verbose) {
      const paramStr = JSON.stringify(params).slice(0, 120);
      process.stdout.write(`  🔧 ${name}(${paramStr})...`);
    }

    const toolStart = Date.now();
    const result = await executeToolWithRetry(adapter, name, params, verbose);
    const durationMs = Date.now() - toolStart;

    // Record in transcript (immutable log)
    transcript.record({
      ts: toolStart,
      toolName: name,
      params,
      success: result.success,
      outputPreview: (result.output || result.error || '').slice(0, 200),
      durationMs,
      error: result.error,
      handled: result.handled,
      recovery: result.recovery
    });

    // Auto-pagination: if read_file result looks truncated, hint for narrower read
    if (name === 'read_file' && result.success && result.output) {
      const outputLen = result.output.length;
      if (outputLen > 8000 && (result.output.includes('... (truncated)') || result.output.includes('content truncated'))) {
        result.output += '\n\n[NOTE: File output was truncated. Use line_start and line_end parameters to read specific sections.]';
      }
    }

    // JIT: track discovered files
    jit.trackFromToolResult(name, params, result);

    if (verbose) {
      const status = result.success ? '✓' : '✗';
      const preview = (result.output || result.error || '').slice(0, 80).replace(/\n/g, ' ');
      console.log(` ${status} ${preview}`);
    }
    return result;
  };

  let turnCount = 0;

  const result: AutonomousResult = await executeAutonomous(
    enrichedTask,
    async (prompt, tools, history) => {
      turnCount++;

      // JIT: inject discovered context every 3 turns
      let taskWithJIT = enrichedTask;
      let historyForTurn = history;
      if (turnCount > 1 && turnCount % 3 === 0 && jit.fileCount > 0) {
        try {
          const jitContext = await jit.buildJITContext(projectDir);
          if (jitContext) {
            taskWithJIT = `${enrichedTask}${jitContext}`;
            if (verbose) {
              console.log(`  [JIT] Injected context from ${jit.fileCount} discovered files`);
            }
          }
        } catch {
          // Non-fatal
        }
      }

      // Token compaction: check if history is getting too large for context window
      if (turnCount > 4 && history.length > 8) {
        const historyText = history.map(h => JSON.stringify(h)).join('\n');
        const budget = calculateTokenBudget(
          [{ content: systemPrompt }, { content: taskWithJIT }, { content: historyText }],
          model
        );
        if (budget.shouldCompact) {
          const { firstN, lastN } = adaptiveCompressionRatio(history.length, 1 - budget.remainingPct);
          // Compact history by keeping first N + last M tool results and summarizing the middle.
          const historyMsgs: CompactedMessage[] = history.map(h => ({
            role: 'assistant',
            content: `[Turn ${h.turn}] ${h.tool}(${JSON.stringify(h.params).slice(0, 100)}) → ${typeof h.result === 'string' ? h.result.slice(0, 200) : JSON.stringify(h.result || h.error || '').slice(0, 200)}`
          }));
          const compacted = await compactConversation(historyMsgs, {
            keepFirst: firstN,
            keepLast: lastN,
            targetTokens: 1000
          });
          const summary = compacted.find(msg => msg.isCompacted)?.content;
          if (summary) {
            taskWithJIT = `${taskWithJIT}\n\n${summary}`;
            const keepHead = history.slice(0, Math.min(firstN, history.length));
            const tailStart = Math.max(keepHead.length, history.length - lastN);
            historyForTurn = [...keepHead, ...history.slice(tailStart)];
          }
          if (verbose && compacted.length < historyMsgs.length) {
            console.log(`  [Compaction] ${historyMsgs.length} → ${compacted.length} messages (${Math.round(budget.remainingPct * 100)}% context remaining)`);
          }
        }
      }

      // Only inject images on the first turn to avoid context bloat
      const turnImages = turnCount === 1 ? options.images : undefined;
      const turnTools = compactToolDeclarations(allTools, turnCount);
      const turnResult = await executeLLMTurn(taskWithJIT, turnTools, historyForTurn, model, systemPrompt, stream, turnImages);
      totalCost += turnResult.cost || 0;
      return {
        toolCalls: turnResult.toolCalls,
        response: turnResult.response,
        status: turnResult.status
      };
    },
    async (name, params) => {
      return await executeTool(name, params);
    },
    {
      maxTurns,
      tools: allTools,
      onProgress: verbose
        ? (turn, action) => {
            console.log(`  [Turn ${turn}] ${action}`);
          }
        : undefined
    }
  );

  // Freeze transcript — immutable after execution completes
  transcript.freeze();

  return {
    success: result.success ?? false,
    output: result.finalResponse ?? result.history?.map(h => {
      if (!h.result) return '';
      if (typeof h.result === 'string') return h.result;
      return h.result.output || h.result.error || JSON.stringify(h.result);
    }).filter(Boolean).join('\n') ?? '',
    cost: totalCost,
    turns: result.turns,
    toolsUsed: Array.from(toolsUsed),
    providerId: resolvedProvider?.id,
    modelUsed: resolvedProvider?.model,
    filesDiscovered: jit.fileCount,
    discoveredFiles: jit.toFileList(),
    history: result.history,
    stopReason: result.reason,
    transcript,
    constraintLevel
  };
}
