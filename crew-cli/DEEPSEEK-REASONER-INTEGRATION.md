# DeepSeek Reasoner Integration

## Overview
Successfully integrated `deepseek-reasoner` into the 3-tier LLM pipeline with a **hybrid model architecture** that uses each model's strengths.

## Model Architecture

### Hybrid Approach
- **L2 Router** → `deepseek-chat` (structured JSON decisions)
- **L2A Planning Artifacts** → `deepseek-reasoner` (deep reasoning for PDD/ROADMAP/ARCH)
- **L2A Decomposition** → `deepseek-chat` (structured JSON work graph)
- **L2B Policy Validation** → `deepseek-chat` (structured JSON validation)
- **L3 Workers** → `deepseek-chat` (code generation)
- **QA Audit** → `deepseek-chat` (structured quality reports)

### Rationale
`deepseek-reasoner` is optimized for **long-form chain-of-thought reasoning** but struggles with **structured JSON output**. By using it only for planning artifacts (where natural language is acceptable) and using `deepseek-chat` for all structured outputs, we get:
- ✅ Deep reasoning for architecture/design decisions
- ✅ Reliable structured JSON for orchestration
- ✅ Fast code generation from specialized models

## API Response Format

### deepseek-reasoner
Returns TWO fields:
- `reasoning_content`: The chain-of-thought reasoning process
- `content`: The final answer (may contain JSON or natural language)

### deepseek-chat
Returns ONE field:
- `content`: The response (JSON or text)

## Implementation Details

### 1. LocalExecutor (`src/executor/local.ts`)
- **Timeout handling**: 10 minutes for `deepseek-reasoner` with large outputs (maxTokens > 6000)
- **Content validation**: Fallback to `reasoning_content` if `content` is empty/invalid
- **Debug logging**: Set `DEBUG_REASONING=1` to see reasoning traces

```typescript
// Example: handling deepseek-reasoner response
const reasoning_content = data?.choices?.[0]?.message?.reasoning_content;
let content = data?.choices?.[0]?.message?.content;

// Validate content is not just an empty brace
const trimmedContent = (content || '').trim();
if (trimmedContent && trimmedContent !== '{' && trimmedContent !== '{}' && trimmedContent.length > 5) {
  // Valid content - use it
} else if (reasoning_content) {
  // Fallback to reasoning_content
  content = reasoning_content;
}
```

### 2. UnifiedPipeline (`src/pipeline/unified.ts`)
- **New method**: `getRouterModel()` - selects appropriate model for L2 router
- Automatically falls back to `CREW_CHAT_MODEL` when `CREW_REASONING_MODEL=deepseek-reasoner`

```typescript
private getRouterModel(): string | undefined {
  const routerModel = String(process.env.CREW_ROUTER_MODEL || '').trim();
  if (routerModel) return routerModel;
  
  // If CREW_REASONING_MODEL is a reasoning-only model, use chat model
  const reasoningModel = String(process.env.CREW_REASONING_MODEL || '').trim();
  if (reasoningModel && !reasoningModel.includes('deepseek-reasoner')) {
    return reasoningModel;
  }
  
  return String(process.env.CREW_CHAT_MODEL || '').trim() || undefined;
}
```

### 3. DualL2Planner (`src/prompts/dual-l2.ts`)
- **New method**: `getChatModel()` - similar logic for structured outputs
- **Planning artifacts**: Uses `getReasoningModel()` → `deepseek-reasoner`
- **Decomposition/Validation**: Uses `getChatModel()` → `deepseek-chat`

```typescript
private getChatModel(): string | undefined {
  const chatModel = String(process.env.CREW_CHAT_MODEL || '').trim();
  const reasoningModel = String(process.env.CREW_REASONING_MODEL || '').trim();
  
  // Avoid deepseek-reasoner for structured JSON
  if (reasoningModel && !reasoningModel.includes('deepseek-reasoner')) {
    return reasoningModel;
  }
  
  return chatModel || undefined;
}
```

## Bugs Fixed

### 1. JSON Parsing Failures
**Problem**: `deepseek-reasoner` returns `reasoning_content` + `content`, but initial implementation only looked at `content`, which was sometimes empty or malformed (`{`).

**Fix**: Added validation and fallback logic in `executeWithDeepSeek()`.

### 2. Timeout Issues
**Problem**: `deepseek-reasoner` can take 3-5 minutes for large planning tasks, exceeding the default 5-minute executor timeout.

**Fix**: Increased timeout to 10 minutes for `deepseek-reasoner` when maxTokens > 6000.

### 3. Structured Output Failures
**Problem**: L2 router, decomposition, and policy validation need **strict JSON**, but `deepseek-reasoner` embeds JSON in long-form reasoning text.

**Fix**: Use `deepseek-chat` for all structured JSON tasks, reserve `deepseek-reasoner` only for planning artifacts.

### 4. maxTokens Limit
**Problem**: `materializeToFiles()` requested 12000 max_tokens, but `deepseek-chat` only supports up to 8192.

**Fix**: Reduced `maxTokens` to 8000 in benchmark script.

## Environment Variables

```bash
DEEPSEEK_API_KEY=sk-xxx
CREW_CHAT_MODEL=deepseek-chat
CREW_REASONING_MODEL=deepseek-reasoner
CREW_EXECUTION_MODEL=deepseek-chat
CREW_EXECUTOR_TIMEOUT_MS=300000  # 5 minutes default, 10 min for large reasoner tasks
DEBUG_REASONING=1  # Optional: log reasoning traces
```

## Performance Characteristics

### deepseek-reasoner
- **Speed**: Slow (30s - 5min per call)
- **Cost**: ~$1/1M input tokens, ~$8/1M output tokens
- **Output size**: Often hits maxTokens limit (returns 4000-8000 tokens)
- **Quality**: Excellent for architecture/planning decisions
- **JSON reliability**: Poor (embeds in reasoning text)

### deepseek-chat
- **Speed**: Fast (3-10s per call)
- **Cost**: ~$0.14/1M input tokens, ~$0.28/1M output tokens
- **Output size**: Typically 100-2000 tokens
- **Quality**: Very good for code generation
- **JSON reliability**: Excellent

## API Constraints

- **Max tokens**: 8192 for both models
- **Context window**: 64K tokens
- **Rate limits**: TBD (not hit during testing)
- **Multi-round conversations**: Must strip `reasoning_content` from history before next call

## Future Improvements

1. **Streaming support**: Implement streaming for `deepseek-reasoner` to show progress
2. **Reasoning cache**: Store `reasoning_content` for later analysis/debugging
3. **Adaptive timeout**: Calculate timeout based on prompt size and maxTokens
4. **JSON extraction**: More robust extraction of JSON from reasoning text
5. **Cost tracking**: Separate cost reporting for reasoning vs chat models

## Benchmark Status
🔄 Currently running full pipeline benchmark with optimized model routing (ETA: 15-20 min)
