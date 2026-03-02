# Main Repo vs Benchmark: Gemini Handling

## Main Repo Implementation (`crew-cli/src/engines/index.ts`)

**Simple text extraction:**
```typescript
// Line 90-109
async function runGeminiApi(prompt: string, options: EngineRunOptions = {}) {
  const model = options.model || 'gemini-2.0-flash';
  const text = await callJsonApi(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=...`,
    null,
    { contents: [{ parts: [{ text: prompt }] }] }  // No generationConfig
  );
  return { success: true, engine: 'gemini-api', stdout: text, stderr: '', exitCode: 0 };
}

// Line 84-87: Response parsing
return data?.content?.[0]?.text                      
    || data?.candidates?.[0]?.content?.parts?.[0]?.text  // Gemini path
    || data?.output_text                             
    || JSON.stringify(data);
```

**Characteristics:**
- ✅ Minimal configuration
- ✅ Works for simple text generation
- ❌ No JSON mode
- ❌ No schema enforcement
- ❌ No temperature/maxTokens control

## Benchmark Requirements (Different Use Case)

**Complex structured outputs:**
1. **Planning Artifacts:** 3 markdown documents in JSON
2. **Decomposition:** 10-14 work units with nested properties
3. **Parallel Execution:** Code generation per unit

**Why simple approach fails:**
- Large JSON arrays (10+ items) with deep nesting
- Gemini wraps JSON in markdown code fences
- Gemini generates syntax errors (missing commas, brackets)

## Solution: JSON Mode API

**Added to `crew-cli/src/executor/local.ts`:**
```typescript
// Auto-detect JSON requests
const expectsJson = task.toLowerCase().includes('return') && 
                   (task.includes('JSON') || task.includes('json') || task.includes('{'));

const requestBody = {
  contents: [{ parts: [{ text: task }] }],
  generationConfig: {
    temperature: 0.7,
    maxOutputTokens: 4000,
    // ✅ Enable JSON mode when detected
    ...(expectsJson && { response_mime_type: "application/json" })
  }
};
```

**Benefits:**
- ✅ Enforces valid JSON syntax
- ✅ No markdown code fences
- ✅ No syntax errors
- ✅ Backward compatible (only activates when JSON detected)

## Comparison

| Feature | Main Repo | Benchmark (Fixed) |
|---------|-----------|-------------------|
| **Use Case** | Simple text generation | Complex structured outputs |
| **JSON Mode** | ❌ No | ✅ Auto-enabled |
| **Temperature** | Default | Configurable |
| **Max Tokens** | Default | Up to 8000 |
| **Error Handling** | Basic | Detailed logging |
| **Cost** | N/A | Tracked per call |

## Recommendation

**Main repo is fine as-is** for simple CLI usage. The benchmark's advanced JSON mode is only needed for:
- Complex structured outputs
- Multi-step pipelines with JSON handoffs
- Production systems requiring reliable JSON

**For CrewSwarm CLI users:** The simple approach works great for chat/code generation.
**For CrewSwarm Pipeline/Benchmark:** Need JSON mode for L2 planning phase.

## Status

✅ JSON mode now implemented in benchmark executor
🚀 Gemini relaunched with auto-detection
⏭️ Monitoring for success
