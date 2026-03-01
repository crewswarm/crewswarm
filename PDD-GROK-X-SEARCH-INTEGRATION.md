# Product Design Document: X-Search Tool Integration

**Status**: Not Started  
**Priority**: High  
**Effort**: 2-3 days  
**Owner**: TBD

---

## Problem Statement

The current `grok.x-search` skill at `~/.crewswarm/skills/grok.x-search.json` **does not work**. It has this note:

> "This skill requires a wrapper in gateway-bridge or a custom skill handler to transform 'query' param into OpenAI messages format. Currently sends raw params which won't work with chat completions API."

The skill tries to call `/v1/chat/completions` but doesn't format the request correctly.

---

## Solution: Use xAI Tools API (x_search tool)

Based on xAI documentation at https://docs.x.ai/developers/tools/x-search, we should use the **built-in `x_search` tool** instead of a custom skill.

### How xAI X-Search Actually Works

**API**: `POST https://api.x.ai/v1/responses`  
**Tool**: Built-in server-side tool (`x_search`)  
**Model**: `grok-4-1-fast-reasoning` or `grok-beta`

**Request Format**:
```json
{
  "model": "grok-4-1-fast-reasoning",
  "input": [
    {
      "role": "user",
      "content": "What are people saying about CrewSwarm on X?"
    }
  ],
  "tools": [
    {
      "type": "x_search",
      "allowed_x_handles": ["elonmusk"],           // Optional: only these handles
      "excluded_x_handles": ["spambot"],           // Optional: exclude these
      "from_date": "2025-10-01",                   // Optional: ISO8601
      "to_date": "2025-10-10",                     // Optional: ISO8601
      "enable_image_understanding": true,          // Optional: analyze images
      "enable_video_understanding": true           // Optional: analyze videos
    }
  ]
}
```

**Response includes**:
- Synthesized answer in `output[].content[]`
- **Citations** with X post URLs in `citations` field

---

## Implementation Options

### Option A: Update Skill to Use Responses API (Recommended)

**Change**: Modify `grok.x-search.json` to call `/v1/responses` endpoint

**New skill definition**:
```json
{
  "description": "Search Twitter/X in real-time using Grok's built-in x_search tool",
  "url": "https://api.x.ai/v1/responses",
  "method": "POST",
  "auth": {
    "type": "bearer",
    "keyFrom": "providers.xai.apiKey"
  },
  "headers": {
    "Content-Type": "application/json"
  },
  "transformRequest": {
    "model": "grok-4-1-fast-reasoning",
    "input": [
      {
        "role": "user",
        "content": "{{query}}"
      }
    ],
    "tools": [
      {
        "type": "x_search",
        "from_date": "{{from_date}}",
        "to_date": "{{to_date}}",
        "allowed_x_handles": "{{allowed_handles}}",
        "excluded_x_handles": "{{excluded_handles}}",
        "enable_image_understanding": "{{enable_images || false}}",
        "enable_video_understanding": "{{enable_videos || false}}"
      }
    ]
  },
  "transformResponse": {
    "text": "choices[0].message.content",
    "citations": "citations"
  },
  "paramNotes": "query (required): search topic. Optional: from_date, to_date (ISO8601), allowed_handles (array), excluded_handles (array), enable_images (bool), enable_videos (bool)",
  "aliases": ["x-search", "twitter-search", "grok-search"],
  "requiresApproval": false,
  "timeout": 30000
}
```

**Pros**: 
- Simple, uses existing skill system
- No gateway code changes
- Access to citations

**Cons**: 
- Skill params need transformation (model always hardcoded)
- Limited to one tool at a time

---

### Option B: Add Native Grok Tool Support to Gateway

**Change**: Add Grok as a provider in `gateway-bridge` with native tool support

**Files to modify**:
- `lib/engines/xai.mjs` (new) - xAI API client
- `lib/agents/registry.mjs` - Add xai provider
- `lib/tools/xai-tools.mjs` (new) - x_search, web_search, code_interpreter wrappers

**Agent config**:
```json
{
  "id": "crew-researcher-x",
  "name": "X/Twitter Researcher",
  "model": "xai/grok-4-1-fast-reasoning",
  "tools": ["x_search", "web_search"],
  "systemPrompt": "You are a social media research specialist..."
}
```

**Usage**:
```bash
@@AGENT crew-researcher-x "What's the sentiment on AI coding tools?"
```

**Pros**:
- Native tool calling (no skill transformation hacks)
- Access to all xAI tools (x_search, web_search, code_interpreter, collections_search)
- Streaming support
- Citations automatically included

**Cons**:
- More complex (new engine adapter)
- 2-3 days implementation

---

## Recommendation: Option B (Native Grok Support)

**Why**:
1. **Future-proof**: xAI will add more tools (collections_search already announced)
2. **Better UX**: Native agents vs skill hacks
3. **Citations**: Responses API includes source URLs
4. **Streaming**: Better for long searches
5. **Tool composition**: Can combine x_search + web_search + code_interpreter

**Implementation Plan**:

### Step 1: Add xAI Engine Adapter (Day 1)
```javascript
// lib/engines/xai.mjs
import fetch from 'node-fetch';

export class XAIEngine {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseURL = 'https://api.x.ai/v1';
  }

  async run(messages, options = {}) {
    const response = await fetch(`${this.baseURL}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || 'grok-4-1-fast-reasoning',
        input: messages,
        tools: options.tools || [],
        stream: options.stream || false
      })
    });
    
    const data = await response.json();
    return {
      content: data.output[0]?.content[0]?.text || '',
      citations: data.citations || [],
      usage: data.usage
    };
  }
}
```

### Step 2: Add Tool Definitions (Day 1)
```javascript
// lib/tools/xai-tools.mjs
export const X_SEARCH = {
  type: 'x_search',
  description: 'Search X/Twitter for recent posts and trends',
  parameters: {
    allowed_x_handles: { type: 'array', items: { type: 'string' } },
    excluded_x_handles: { type: 'array', items: { type: 'string' } },
    from_date: { type: 'string', format: 'date' },
    to_date: { type: 'string', format: 'date' },
    enable_image_understanding: { type: 'boolean', default: false },
    enable_video_understanding: { type: 'boolean', default: false }
  }
};
```

### Step 3: Register Agent (Day 2)
```json
// ~/.crewswarm/crewswarm.json
{
  "agents": [
    {
      "id": "crew-researcher-x",
      "name": "X/Twitter Researcher",
      "model": "xai/grok-4-1-fast-reasoning",
      "provider": "xai",
      "tools": ["x_search"],
      "systemPrompt": "You are a social media research specialist. Use x_search to find relevant X/Twitter posts, analyze sentiment, and track trends. Always cite sources."
    }
  ]
}
```

### Step 4: Test & Document (Day 2-3)
```bash
# Test basic search
@@AGENT crew-researcher-x "What are people saying about CrewSwarm?"

# Test with filters
@@AGENT crew-researcher-x "Search tweets from @elonmusk about AI in the last week"

# Test with image understanding
@@AGENT crew-researcher-x "Find posts with screenshots of AI coding tools"
```

---

## API Details for Implementation

### Endpoints
- **Base URL**: `https://api.x.ai/v1`
- **Responses**: `POST /responses` (recommended - supports tools)
- **Chat**: `POST /chat/completions` (legacy - no tools)

### Authentication
```http
Authorization: Bearer xai-...
```

### Models
- `grok-4-1-fast-reasoning` - Latest, supports reasoning tokens
- `grok-beta` - Stable
- `grok-vision-beta` - Multimodal

### Built-in Tools
1. `x_search` - Search X/Twitter
2. `web_search` - General web search
3. `code_interpreter` - Execute Python code
4. `collections_search` - RAG over uploaded docs (like xAI collections)

### Pricing (2026)
- Input: $0.20/M tokens
- Output: $0.50/M tokens
- Tool invocations: $0.000001 per search query

### Rate Limits
- Free tier: 60 requests/min, 1,000 requests/day
- Paid: Higher (check xAI docs)

---

## Validation Criteria

- [ ] `@@AGENT crew-researcher-x "what's trending on X?"` returns results
- [ ] Citations include X post URLs
- [ ] Date filters work (`from_date`, `to_date`)
- [ ] Handle filters work (`allowed_x_handles`, `excluded_x_handles`)
- [ ] Image/video understanding flags work
- [ ] Streaming works for long searches
- [ ] Cost tracking accurate (tokens + tool invocations)
- [ ] Error handling (rate limits, auth failures)

---

## Migration Path

**Phase 1**: Implement Option B (native support)  
**Phase 2**: Deprecate `grok.x-search.json` skill  
**Phase 3**: Update docs to use `crew-researcher-x` agent

**Timeline**: 3 days for Phase 1

---

## Additional Roadmap Items to Add

Based on this investigation, here are more items for the roadmap:

### 1. Web Search Tool (Grok)
**What**: Add `web_search` tool (not just x_search)  
**Why**: Grok has general web search too  
**Effort**: 0 days (comes free with xAI engine)

### 2. Code Interpreter (Grok)
**What**: Add `code_interpreter` tool  
**Why**: Execute Python in sandbox, generate charts  
**Effort**: 0 days (comes free with xAI engine)

### 3. Collections Search (Grok)
**What**: Add `collections_search` tool (RAG)  
**Why**: Query uploaded docs (like xAI collections)  
**Effort**: 1 day (need file upload support)

### 4. Multi-Tool Agents
**What**: Agent can use x_search + web_search + code_interpreter together  
**Why**: More powerful research (search X, search web, analyze data)  
**Effort**: 0 days (automatic with tool support)

### 5. Function Calling Support
**What**: Add parallel function calling (multiple tools at once)  
**Why**: Grok supports it, speeds up research  
**Effort**: 1 day (parallel tool execution)

---

## Questions for Captain

1. **Should we do Option A (quick hack) or Option B (proper implementation)?**
   - Recommendation: Option B (2-3 days but future-proof)

2. **Should we add all Grok tools or just x_search?**
   - Recommendation: All (web_search, code_interpreter come free)

3. **Should this be in crew-lead or crew-cli?**
   - Recommendation: Both (crew-lead gets it first, crew-cli routing can delegate)

4. **Priority vs other roadmap items?**
   - Recommendation: High (market opportunity, Grok CLI doesn't exist)

---

**Status**: Awaiting approval to proceed with Option B implementation.
