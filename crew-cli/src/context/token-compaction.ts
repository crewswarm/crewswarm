/**
 * Token-Aware Context Compaction
 *
 * Tracks estimated token usage per turn and triggers intelligent
 * compaction when approaching context window limits. Uses char-to-token
 * ratio estimation (no tiktoken dependency) and can optionally use
 * LLM-based summarization for better compression than truncation.
 */

// Average chars per token varies by content type:
// English prose: ~4 chars/token, code: ~3.5 chars/token, JSON: ~3 chars/token
const CHARS_PER_TOKEN = 3.7;

/** Context window sizes by model family */
const CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-5': 256_000,
  'gpt-5.1': 256_000,
  'gpt-5.2': 256_000,
  'claude-3-5-sonnet': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4': 200_000,
  'grok-4': 131_072,
  'grok-beta': 131_072,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'llama-3.3': 128_000,
};

export interface TokenBudget {
  contextWindow: number;
  estimatedUsed: number;
  remainingTokens: number;
  remainingPct: number;
  shouldCompact: boolean;
}

export interface CompactedMessage {
  role: string;
  content: string;
  isCompacted?: boolean;
}

/** Estimate tokens from a string using char ratio */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Get context window size for a model */
export function getContextWindow(model: string): number {
  const m = String(model || '').toLowerCase();
  // Try exact match first, then prefix match
  for (const [prefix, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (m.startsWith(prefix)) return size;
  }
  return 128_000; // Conservative default
}

/**
 * Calculate token budget for current conversation state.
 * compactThreshold: trigger compaction when this % of context is used (default 75%)
 */
export function calculateTokenBudget(
  messages: Array<{ content: string }>,
  model: string,
  systemPromptTokens: number = 0,
  compactThreshold: number = 0.75
): TokenBudget {
  const contextWindow = getContextWindow(model);
  let estimatedUsed = systemPromptTokens;

  for (const msg of messages) {
    estimatedUsed += estimateTokens(msg.content) + 4; // +4 for message framing tokens
  }

  const remainingTokens = contextWindow - estimatedUsed;
  const remainingPct = remainingTokens / contextWindow;

  return {
    contextWindow,
    estimatedUsed,
    remainingTokens,
    remainingPct,
    shouldCompact: (estimatedUsed / contextWindow) >= compactThreshold
  };
}

/**
 * Compact a conversation by summarizing older messages.
 * Keeps the system prompt, first N and last M messages intact,
 * and summarizes the middle section into a single compressed message.
 *
 * If an LLM summarizer is provided, uses it for semantic summarization.
 * Otherwise falls back to extractive compression (key lines only).
 */
export async function compactConversation(
  messages: CompactedMessage[],
  opts: {
    keepFirst?: number;     // Keep first N messages intact (default 2)
    keepLast?: number;      // Keep last M messages intact (default 6)
    targetTokens?: number;  // Target token count for summary (default 2000)
    summarizer?: (text: string, maxTokens: number) => Promise<string>;
  } = {}
): Promise<CompactedMessage[]> {
  const keepFirst = opts.keepFirst ?? 2;
  const keepLast = opts.keepLast ?? 6;
  const targetTokens = opts.targetTokens ?? 2000;

  if (messages.length <= keepFirst + keepLast) {
    return messages; // Nothing to compact
  }

  const head = messages.slice(0, keepFirst);
  const middle = messages.slice(keepFirst, messages.length - keepLast);
  const tail = messages.slice(-keepLast);

  if (middle.length === 0) return messages;

  // Build text representation of middle messages
  const middleText = middle.map(m => {
    const role = m.role.toUpperCase();
    const text = m.content.slice(0, 2000); // Cap each message for summarization input
    return `[${role}] ${text}`;
  }).join('\n\n');

  let summary: string;

  if (opts.summarizer) {
    // LLM-based semantic summarization
    const prompt = `Summarize this conversation segment concisely, preserving key decisions, file changes, errors, and outcomes. Focus on what was done and what state things are in now:\n\n${middleText}`;
    summary = await opts.summarizer(prompt, targetTokens);
  } else {
    // Extractive compression: keep key lines
    summary = extractiveCompress(middle, targetTokens);
  }

  const summaryMessage: CompactedMessage = {
    role: 'assistant',
    content: `[Context Summary — ${middle.length} earlier messages compressed]\n${summary}`,
    isCompacted: true
  };

  return [...head, summaryMessage, ...tail];
}

/**
 * Extractive compression: select the most important lines from messages.
 * Prioritizes: errors, file paths, tool results, decisions.
 */
function extractiveCompress(messages: CompactedMessage[], targetTokens: number): string {
  const maxChars = targetTokens * CHARS_PER_TOKEN;
  const lines: Array<{ text: string; priority: number }> = [];

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'A' : 'U';
    const content = msg.content || '';

    // Split into lines and score each
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;

      let priority = 1;
      if (/error|fail|exception/i.test(trimmed)) priority = 5;
      if (/\.(ts|js|py|go|rs|tsx|jsx|json)/.test(trimmed)) priority = 3;
      if (/wrote|created|edited|deleted|fixed/i.test(trimmed)) priority = 4;
      if (/→|✓|✗|COMPLETE|OK:|FAIL:/i.test(trimmed)) priority = 3;
      if (/decision|chose|decided|because/i.test(trimmed)) priority = 4;

      lines.push({ text: `[${role}] ${trimmed}`, priority });
    }
  }

  // Sort by priority (high first), then take until we hit token budget
  lines.sort((a, b) => b.priority - a.priority);

  let result = '';
  for (const line of lines) {
    if (result.length + line.text.length > maxChars) break;
    result += line.text + '\n';
  }

  return result || '[No significant content to summarize]';
}

/**
 * Adaptive compression ratios based on context usage.
 * Returns { firstN, lastN } — how many turns to keep in full detail.
 */
export function adaptiveCompressionRatio(
  totalTurns: number,
  contextUsagePct: number
): { firstN: number; lastN: number } {
  if (contextUsagePct < 0.5) {
    // Plenty of room — keep more detail
    return { firstN: 5, lastN: 8 };
  }
  if (contextUsagePct < 0.75) {
    // Getting tight — standard compression
    return { firstN: 3, lastN: 5 };
  }
  // Critical — aggressive compression
  return { firstN: 1, lastN: 3 };
}
