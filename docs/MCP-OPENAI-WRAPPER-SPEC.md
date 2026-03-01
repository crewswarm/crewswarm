# MCP OpenAI Wrapper Specification

**Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** Implemented in `scripts/mcp-server.mjs`

## Purpose

This spec defines how CrewSwarm's MCP server translates OpenAI-compatible API requests into crew-lead/agent dispatch calls. It ensures behavior parity between:
- **Standalone mode** (crew-cli with built-in router)
- **Connected mode** (main repo MCP server → crew-lead)

## Requirements

### 1. Message Array Parsing

**Input:** OpenAI `messages` array
```typescript
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;           // for role: "tool"
  tool_call_id?: string;   // for role: "tool"
  tool_calls?: ToolCall[]; // for role: "assistant"
}
```

**Output:** Parsed and categorized messages
```typescript
{
  message: string,          // Last user message (primary task)
  context: string,          // Composed context (system + history)
  messageCounts: {
    system: number,
    assistant: number,
    user: number,
    total: number
  },
  inputChars: number        // Total input length for token estimation
}
```

### 2. Content Extraction

Support both string and multimodal content:
```typescript
// String content
{ role: "user", content: "Hello" }

// Multimodal content (extract text only for now)
{ role: "user", content: [
  { type: "text", text: "Describe this:" },
  { type: "image_url", image_url: { url: "data:..." } }  // skip
]}
```

**Behavior:** Extract all text parts, join with newlines, ignore non-text parts.

### 3. Context Composition

**Order of precedence:**
1. System messages → top of context
2. Recent conversation history (last 10 items)
3. Last user message → primary task (not in context)

**Format:**
```
SYSTEM INSTRUCTIONS:
<all system message content joined with double newline>

RECENT CONTEXT:
<last 10 assistant + prior user messages joined with double newline>
```

**Limits:**
- Max context: 12,000 characters
- If exceeded: truncate from the left (keep most recent)
- History lookback: 10 messages (configurable)

### 4. Routing Logic

```javascript
if (model === "crewswarm" || model === "crew-lead") {
  // Chat route: POST /chat
  payload = {
    message: lastUserMessage,
    context: composedContext,
    sessionId: `openai-compat-${timestamp}`,
    metadata: { source, clientModel, temperature, ... }
  }
} else {
  // Dispatch route: POST /api/dispatch
  payload = {
    agent: model,
    task: lastUserMessage,
    context: composedContext,
    sessionId: `openai-compat-${timestamp}`,
    metadata: { source, clientModel, temperature, ... }
  }
}
```

### 5. OpenAI Field Passthrough

Forward these fields as metadata:
```typescript
{
  temperature?: number,
  top_p?: number,
  max_tokens?: number,
  tools?: Tool[],
  tool_choice?: "auto" | "required" | { type: "function", function: { name: string } },
  stream?: boolean
}
```

**Note:** `stream: true` is acknowledged but not implemented (returns non-streaming response).

### 6. Tool Calls

**Status:** ✅ Implemented (2026-03-01)

Supports full OpenAI tool-calling semantics:

```typescript
// Assistant calls tool
{ role: "assistant", content: "", tool_calls: [
  { id: "call_123", type: "function", function: { name: "get_weather", arguments: "{...}" }}
]}

// Tool result injected
{ role: "tool", content: "70°F sunny", tool_call_id: "call_123", name: "get_weather" }

// Assistant continues
{ role: "assistant", content: "It's 70°F and sunny today." }
```

**Implemented behavior:**
- ✅ Parse `tool` role messages
- ✅ Forward tool results in context (TOOL RESULTS section)
- ✅ Respect `tool_choice` parameter (none|auto|required|{function})
- ✅ Generate OpenAI-compatible `tool_calls` responses
- ✅ Support streaming and non-streaming tool call responses
- ✅ Heuristic selection on `tool_choice: auto` (action verb detection)

**Implementation functions:**
- `selectToolCallName()` - handles tool_choice semantics (line 106)
- `buildToolCallResponse()` - generates tool_calls payload (line 128)
- Tool result extraction in `composeChatPayloadFromOpenAI()` (line 82)

**Future:** Map CrewSwarm `@@SKILL` execution back to tool results

### 7. Token Usage Calculation

```typescript
{
  prompt_tokens: Math.ceil(inputChars / 4),
  completion_tokens: Math.ceil(replyChars / 4),
  total_tokens: prompt + completion
}
```

Where `inputChars` = total length of all message content (system + history + user).

### 8. Response Format

**Non-streaming:**
```json
{
  "id": "chatcmpl-{timestamp}",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "crewswarm",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 100,
    "total_tokens": 142
  }
}
```

**Streaming (future):**
```json
data: {"id":"chatcmpl-{id}","object":"chat.completion.chunk","created":1234567890,"model":"crewswarm","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-{id}","object":"chat.completion.chunk","created":1234567890,"model":"crewswarm","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-{id}","object":"chat.completion.chunk","created":1234567890,"model":"crewswarm","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 9. Model List Metadata

Each model in `/v1/models` must include:
```json
{
  "id": "crewswarm",
  "object": "model",
  "created": 1700000000,
  "owned_by": "crewswarm",
  "description": "🧠 Stinki — crew-lead, general purpose commander",
  "capabilities": ["chat", "coordination", "dispatch"],
  "mode": "chat"
}
```

**Capabilities:**
- `chat` - Direct chat endpoint support
- `coordination` - Multi-agent coordination
- `dispatch` - Single-agent task execution
- `tools` - Tool/skill execution

**Mode:**
- `chat` - Routes to `/chat` endpoint
- `agent` - Routes to `/api/dispatch`

### 10. Request Logging

Every request must log:
```
[openai-wrapper] model=<model> stream=<bool> route=<chat|dispatch> msgs=<count> (sys:<n>,asst:<n>,usr:<n>) contextChars=<length> latencyMs=<time>
```

Example:
```
[openai-wrapper] model=crewswarm stream=false route=chat msgs=4 (sys:1,asst:1,usr:2) contextChars=193 latencyMs=7095
```

## Implementation Checklist

- [x] Parse `messages[]` array (string + multimodal content)
- [x] Extract system messages
- [x] Extract conversation history (assistant + prior users)
- [x] Extract tool role messages and include in context
- [x] Compose context with 12KB limit
- [x] Route to chat vs dispatch based on model
- [x] Forward OpenAI fields as metadata
- [x] Calculate accurate token usage from full input
- [x] Add request trace logging
- [x] Add model metadata (capabilities, mode)
- [x] Implement tool_choice handling (none|auto|required|forced)
- [x] Generate tool_calls responses (streaming + non-streaming)
- [x] Heuristic tool selection on auto mode
- [ ] Implement streaming responses for chat
- [ ] Execute tools via CrewSwarm `@@SKILL` and return results
- [ ] Map tool execution results back to role: tool format

## Testing

**Test suite:** `scripts/test-mcp-context.mjs`

**Required tests:**
1. Simple single-turn (no context)
2. With system prompt
3. Full conversation history (sys + asst + 2+ users)
4. Agent dispatch with context
5. Multimodal content (text extraction)
6. Context truncation (>12KB)
7. Token usage accuracy
8. Tool call with auto choice (action verb detection)
9. Tool call with required choice
10. Tool call with forced function name
11. Tool results in conversation context
12. Streaming tool call responses

**Success criteria:**
- All messages parsed correctly
- Context chars match logged value
- Token usage reflects full input
- No data loss in context composition

## Compatibility

**Works with:**
- Cursor AI (via MCP server config)
- Continue.dev (OpenAI provider)
- Aider (--openai-api-base)
- LM Studio (OpenAI-compatible endpoint)
- Open WebUI (OpenAI API connection)
- Any tool supporting OpenAI-compatible API

**Configuration example:**
```json
{
  "provider": "openai",
  "apiBase": "http://127.0.0.1:5020/v1",
  "model": "crewswarm",
  "apiKey": "any-string"
}
```

## Maintenance

**When to update this spec:**
- OpenAI adds new message roles or features
- CrewSwarm adds tool execution capabilities
- Streaming implementation begins
- Context composition strategy changes

**Version history:**
- v1.0 (2026-03-01): Initial spec with message parsing and context forwarding
- v1.1 (2026-03-01): Add tool-calling support (tool_choice, tool_calls, role: tool)

## References

- OpenAI Chat Completions API: https://platform.openai.com/docs/api-reference/chat
- MCP Protocol: https://modelcontextprotocol.io/
- Implementation: `scripts/mcp-server.mjs` (lines 48-180, 570-720)
- Tests: `scripts/test-mcp-context.mjs`
