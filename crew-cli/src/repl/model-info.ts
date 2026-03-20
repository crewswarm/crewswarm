/**
 * Model info for enhanced /model display
 * Benchmark scores from OpenRouter coding leaderboard (March 2026)
 */

export interface ModelInfo {
  name: string;
  provider: string;
  codingScore: number;   // OpenRouter coding benchmark (0-100)
  inputCost: number;     // $/1M input tokens
  outputCost: number;    // $/1M output tokens
  contextWindow: string; // human-readable
  tier: 'heavy' | 'standard' | 'fast';
  note?: string;
}

export const MODEL_CATALOG: ModelInfo[] = [
  // Heavy tier — L2 brain
  { name: 'gpt-5.4',             provider: 'OpenAI',     codingScore: 57.3, inputCost: 3.00,  outputCost: 15.00, contextWindow: '128K',  tier: 'heavy', note: '#1 coding' },
  { name: 'gemini-3.1-pro',      provider: 'Google',     codingScore: 55.5, inputCost: 2.00,  outputCost: 12.00, contextWindow: '200K',  tier: 'heavy', note: '#2 coding' },
  { name: 'gpt-5.3-codex',       provider: 'OpenAI',     codingScore: 53.1, inputCost: 3.00,  outputCost: 15.00, contextWindow: '128K',  tier: 'heavy' },
  { name: 'claude-sonnet-4.6',   provider: 'Anthropic',  codingScore: 50.9, inputCost: 3.00,  outputCost: 15.00, contextWindow: '200K',  tier: 'heavy' },
  { name: 'claude-opus-4.6',     provider: 'Anthropic',  codingScore: 48.1, inputCost: 3.00,  outputCost: 15.00, contextWindow: '200K',  tier: 'heavy' },
  { name: 'grok-4.20-beta',      provider: 'xAI',        codingScore: 42.2, inputCost: 2.00,  outputCost: 6.00,  contextWindow: '2M',   tier: 'heavy', note: '2M context' },
  { name: 'grok-4',              provider: 'xAI',        codingScore: 40.5, inputCost: 3.00,  outputCost: 15.00, contextWindow: '256K',  tier: 'heavy' },

  // Standard tier — L3 workers
  { name: 'gemini-2.5-pro',      provider: 'Google',     codingScore: 46.7, inputCost: 1.25,  outputCost: 10.00, contextWindow: '1M',   tier: 'standard' },
  { name: 'gemini-3-pro',        provider: 'Google',     codingScore: 46.5, inputCost: 2.00,  outputCost: 12.00, contextWindow: '200K',  tier: 'standard' },
  { name: 'glm-5',               provider: 'Z-AI',       codingScore: 44.2, inputCost: 0.50,  outputCost: 2.00,  contextWindow: '128K',  tier: 'standard' },
  { name: 'gemini-3-flash',      provider: 'Google',     codingScore: 42.6, inputCost: 0.50,  outputCost: 3.00,  contextWindow: '1M',   tier: 'standard' },
  { name: 'minimax-m2.7',        provider: 'MiniMax',    codingScore: 41.9, inputCost: 0.30,  outputCost: 1.00,  contextWindow: '128K',  tier: 'standard' },
  { name: 'qwen3.5-397b',        provider: 'Qwen',       codingScore: 41.3, inputCost: 0.30,  outputCost: 0.90,  contextWindow: '128K',  tier: 'standard' },
  { name: 'gemini-2.5-flash',    provider: 'Google',     codingScore: 38.0, inputCost: 0.30,  outputCost: 2.50,  contextWindow: '1M',   tier: 'standard', note: 'free tier' },
  { name: 'kimi-k2.5',           provider: 'Moonshot',   codingScore: 39.5, inputCost: 0.60,  outputCost: 2.00,  contextWindow: '128K',  tier: 'standard' },
  { name: 'deepseek-v3.2',       provider: 'DeepSeek',   codingScore: 36.0, inputCost: 0.28,  outputCost: 0.42,  contextWindow: '164K',  tier: 'standard', note: 'cheapest' },

  // Fast tier — L1 routing
  { name: 'grok-4.1-fast',       provider: 'xAI',        codingScore: 35.0, inputCost: 0.20,  outputCost: 0.50,  contextWindow: '2M',   tier: 'fast', note: '2M, $0.20/M' },
  { name: 'llama-3.3-70b',       provider: 'Groq',       codingScore: 28.0, inputCost: 0.075, outputCost: 0.30,  contextWindow: '128K',  tier: 'fast', note: 'free tier' },
  { name: 'gemini-2.5-flash-lite', provider: 'Google',   codingScore: 25.0, inputCost: 0.10,  outputCost: 0.40,  contextWindow: '1M',   tier: 'fast', note: 'cheapest' },
];

export function findModelInfo(modelName: string): ModelInfo | undefined {
  const lower = modelName.toLowerCase();
  return MODEL_CATALOG.find(m => lower.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(lower));
}

export function formatModelTable(models: ModelInfo[]): string {
  const header = `  ${'Model'.padEnd(24)} ${'Score'.padStart(5)} ${'In $/M'.padStart(7)} ${'Out $/M'.padStart(8)} ${'Context'.padStart(8)} ${'Note'.padEnd(14)}`;
  const sep    = `  ${'─'.repeat(24)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(14)}`;
  const rows = models.map(m => {
    const score = m.codingScore.toFixed(1).padStart(5);
    const inCost = `$${m.inputCost.toFixed(2)}`.padStart(7);
    const outCost = `$${m.outputCost.toFixed(2)}`.padStart(8);
    const ctx = m.contextWindow.padStart(8);
    const note = (m.note || '').padEnd(14);
    return `  ${m.name.padEnd(24)} ${score} ${inCost} ${outCost} ${ctx} ${note}`;
  });
  return [header, sep, ...rows].join('\n');
}
