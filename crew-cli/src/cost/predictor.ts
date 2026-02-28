export interface ModelPricing {
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface CostEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

const DEFAULT_OUTPUT_TOKENS = 1200;

const MODEL_PRICING: Record<string, ModelPricing> = {
  'openai/gpt-4o': { model: 'openai/gpt-4o', inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'openai/gpt-4o-mini': { model: 'openai/gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'anthropic/claude-3-5-sonnet': { model: 'anthropic/claude-3-5-sonnet', inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'deepseek/deepseek-chat': { model: 'deepseek/deepseek-chat', inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'groq/llama-3.3-70b-versatile': { model: 'groq/llama-3.3-70b-versatile', inputPerMillion: 0.59, outputPerMillion: 0.79 }
};

function normalizeModel(model?: string): string {
  if (!model) {
    return 'openai/gpt-4o-mini';
  }
  return model;
}

export function estimateTokens(text: string): number {
  const safe = text || '';
  // "Similar tokenizer" heuristic for mixed code + prose:
  // split by words, numbers, punctuation, and whitespace groups.
  const pieces = safe.match(/[A-Za-z_]+|\d+|[^\sA-Za-z0-9_]|[\s]+/g) || [];
  let tokens = 0;
  for (const piece of pieces) {
    if (/^\s+$/.test(piece)) {
      tokens += Math.max(1, Math.ceil(piece.length / 4));
    } else if (/^[A-Za-z_]+$/.test(piece)) {
      tokens += Math.max(1, Math.ceil(piece.length / 4));
    } else if (/^\d+$/.test(piece)) {
      tokens += Math.max(1, Math.ceil(piece.length / 3));
    } else {
      tokens += 1;
    }
  }
  return Math.max(1, tokens);
}

export function estimateCost(
  text: string,
  model?: string,
  outputTokens = DEFAULT_OUTPUT_TOKENS
): CostEstimate {
  const selected = normalizeModel(model);
  const pricing = MODEL_PRICING[selected] || MODEL_PRICING['openai/gpt-4o-mini'];
  const inputTokens = estimateTokens(text);
  const inputUsd = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputUsd = (Math.max(1, outputTokens) / 1_000_000) * pricing.outputPerMillion;

  return {
    model: pricing.model,
    inputTokens,
    outputTokens: Math.max(1, outputTokens),
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd
  };
}

export function compareModelCosts(
  text: string,
  outputTokens = DEFAULT_OUTPUT_TOKENS,
  models = Object.keys(MODEL_PRICING)
): CostEstimate[] {
  return models
    .map(model => estimateCost(text, model, outputTokens))
    .sort((a, b) => a.totalUsd - b.totalUsd);
}

export function getCheapestAlternative(text: string, outputTokens = DEFAULT_OUTPUT_TOKENS): CostEstimate {
  return compareModelCosts(text, outputTokens)[0];
}
