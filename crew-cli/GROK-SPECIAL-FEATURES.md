# Grok (xAI) API Keys & Special Features

## API Keys Location
Your API keys are stored in environment variables:
```bash
export XAI_API_KEY="your-grok-api-key"      # Grok from x.ai
export GEMINI_API_KEY="your-gemini-key"    # Already set
export DEEPSEEK_API_KEY="your-deepseek-key"
```

## Grok's UNIQUE Features (Why It's Different)

### 1. X-Search Tool (x_search)
**Real-time Twitter/X search** - NO OTHER LLM HAS THIS

```bash
# Use in CrewSwarm CLI:
crew x-search "What are developers saying about AI coding tools?"

# With filters:
crew x-search "AI trends" \
  --from-date 2026-02-01 \
  --to-date 2026-03-01 \
  --allowed-handles elonmusk,sama
```

**API Format**:
```json
{
  "model": "grok-4-1-fast-reasoning",
  "input": [{"role": "user", "content": "query"}],
  "tools": [{
    "type": "x_search",
    "from_date": "2026-02-01",
    "to_date": "2026-03-01",
    "allowed_x_handles": ["elonmusk"],
    "enable_image_understanding": true,
    "enable_video_understanding": true
  }]
}
```

**Returns**: 
- Synthesized answer
- **Citations with X post URLs**
- Image/video analysis

### 2. Web Search Tool (web_search)
General web search (like Perplexity)

### 3. Code Interpreter (code_interpreter)
Execute Python code in sandbox, generate charts

### 4. Collections Search (collections_search)
RAG over uploaded documents

## API Endpoints

### Primary: Responses API (for tools)
```bash
POST https://api.x.ai/v1/responses
Authorization: Bearer $XAI_API_KEY
```

### Legacy: Chat Completions (no tools)
```bash
POST https://api.x.ai/v1/chat/completions
Authorization: Bearer $XAI_API_KEY
```

## Models

| Model | Purpose | Cost (per 1M tokens) |
|-------|---------|----------------------|
| `grok-4-1-fast-reasoning` | Latest, reasoning, tools | $0.20/$0.50 |
| `grok-beta` | Stable | $5/$15 |
| `grok-vision-beta` | Multimodal | $5/$15 |

## Pricing
- Input: $0.20/M tokens
- Output: $0.50/M tokens  
- **Tool calls**: $0.000001 per search query

## Why This Matters for Benchmarking

**You CANNOT directly compare Grok vs Gemini vs DeepSeek** because they have different capabilities:

### Use Grok For:
- ✅ Real-time social intelligence (X/Twitter)
- ✅ Web search with citations
- ✅ Research that needs sources
- ✅ Competitive intelligence
- ✅ Trend analysis

### Use DeepSeek For:
- ✅ Complex reasoning
- ✅ Math/logic problems
- ✅ Cost-efficient execution
- ✅ Structured planning

### Use Gemini For:
- ✅ Free tier testing
- ✅ Fast execution
- ✅ Vision tasks
- ✅ Prototyping

## Recommended 3-Tier Stack

```bash
# For general coding:
CREW_CHAT_MODEL="deepseek-chat"          # Cheap chat
CREW_REASONING_MODEL="deepseek-reasoner" # Best reasoning
CREW_EXECUTION_MODEL="gemini-flash"      # Free execution

# For research/social intelligence:
CREW_CHAT_MODEL="grok"                   # X-search capability
CREW_REASONING_MODEL="grok"              # Web search + reasoning
CREW_EXECUTION_MODEL="deepseek-chat"     # Cheap execution

# For maximum quality:
CREW_CHAT_MODEL="grok"                   # Best chat + tools
CREW_REASONING_MODEL="grok"              # Best reasoning + citations
CREW_EXECUTION_MODEL="grok"              # All tools available
```

## CrewSwarm's Unique Position

**NO OTHER AI CODING TOOL HAS REAL-TIME X/TWITTER INTELLIGENCE**

- ❌ Cursor (Claude): No X access
- ❌ GitHub Copilot: No X access
- ❌ Windsurf: No X access
- ❌ Codeium: No X access
- ✅ **CrewSwarm**: Native Grok integration with `crew x-search`

This is a **major competitive advantage** for:
- Competitive research
- Trend analysis
- Market intelligence
- Real-time developer sentiment

## Next Steps

1. **Get API keys** for all three providers
2. **Test each individually** with `test-direct-llm.mjs`
3. **Test Grok's x-search** with `crew x-search "test query"`
4. **Configure 3-tier stack** based on use case
5. **Benchmark with dual-L2** enabled for complex tasks

See: `PDD-GROK-X-SEARCH-INTEGRATION.md` for full implementation details
