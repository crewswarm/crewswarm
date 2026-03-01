# Grok/xAI Integration Guide

> **Status:** ✅ Fully integrated as of 2026-02-28  
> **Provider:** xAI (https://console.x.ai/)  
> **Base URL:** `https://api.x.ai/v1` (OpenAI-compatible)

---

## Overview

CrewSwarm supports xAI's Grok models with advanced capabilities that differentiate them from other LLM providers:

1. **Real-time X/Twitter access** — Search and retrieve live tweets, trends, and social conversations
2. **Vision capabilities** — Analyze images up to 20MB (JPEG, PNG, WebP, GIF)
3. **128K context window** — Large context for complex multi-document tasks
4. **Function calling** — OpenAI-compatible tool use (API-supported, not yet exposed in skills)

---

## Models Available

| Model | Context | Features | Best For |
|---|---|---|---|
| `xai/grok-beta` | 128K | Real-time X access, function calling | Social intelligence, research, trending analysis |
| `xai/grok-vision-beta` | 128K | Vision + text, real-time X access | Image analysis, UI testing, document OCR |
| `xai/grok-3-mini` | 128K | Fast, cost-effective | Coordination, simple tasks |
| `xai/grok-3` | 128K | Full capabilities | Heavy reasoning (prefer deepseek-chat for cost) |

---

## Skills Included

### 1. **grok.x-search** — Real-time Twitter/X Search

Search Twitter/X for recent tweets, trends, and conversations. Grok uses its native X integration to provide up-to-date social intelligence.

**File:** `~/.crewswarm/skills/grok.x-search.json`  
**Aliases:** `x-search`, `twitter-search`, `grok-search`  
**Auth:** Bearer token from `providers.xai.apiKey` in `~/.crewswarm/crewswarm.json`  
**Timeout:** 30 seconds  
**Approval:** Not required (read-only)

**Usage:**
```javascript
@@SKILL grok.x-search {"query": "What are developers saying about Cursor AI this week?"}
@@SKILL x-search {"query": "CrewSwarm AI sentiment on X"}
```

**Parameters:**
- `query` (required): Search query or topic to look up on X

**Returns:** Summary of findings with tweet excerpts, author mentions, and trending context.

**Use cases:**
- Track competitor launches and product sentiment
- Monitor brand mentions and customer feedback
- Research viral content patterns and hashtag performance
- Identify influencer conversations and trending topics

---

### 2. **grok.vision** — Image Analysis with Grok Vision

Analyze images using Grok Vision — extract text, identify objects, describe scenes, answer questions about visual content.

**File:** `~/.crewswarm/skills/grok.vision.json`  
**Aliases:** `grok-vision`, `vision`, `image-analysis`  
**Auth:** Bearer token from `providers.xai.apiKey`  
**Timeout:** 45 seconds  
**Approval:** Not required

**Usage:**
```javascript
@@SKILL grok.vision {"image_url": "https://example.com/screenshot.png"}
@@SKILL grok.vision {"image_url": "https://example.com/ui.png", "prompt": "Is this UI accessible? Check contrast ratios."}
@@SKILL vision {"image_url": "https://example.com/doc.jpg", "prompt": "Extract all text from this document"}
```

**Parameters:**
- `image_url` (required): URL of image to analyze
- `prompt` (optional): Specific question or instruction about the image. If omitted, provides a detailed description.

**Supported formats:** JPEG, PNG, WebP, GIF (non-animated)  
**Max size:** 20MB

**Returns:** Detailed analysis of the image based on the prompt or general description.

**Use cases:**
- Automated UI screenshot testing and visual regression detection
- Security: analyze phishing images, suspicious documents, identity verification
- Accessibility audits: check color contrast, text readability
- Document OCR: extract text from images, receipts, forms
- Content moderation: identify inappropriate or sensitive content

---

## Configuration

### 1. Add xAI API Key

Get your API key from https://console.x.ai/

Add to `~/.crewswarm/crewswarm.json`:

```json
{
  "providers": {
    "xai": {
      "apiKey": "xai-..."
    }
  }
}
```

Or via the dashboard:
1. Open http://127.0.0.1:4319
2. Navigate to **Providers** tab
3. Find **xAI (Grok)** card
4. Paste API key and click **Save**

### 2. Assign Grok to Agents (Optional)

To use Grok as the primary model for an agent, edit `~/.crewswarm/crewswarm.json`:

```json
{
  "agents": [
    {
      "id": "crew-researcher",
      "model": "xai/grok-beta",
      "tools": {
        "crewswarmAllow": ["read_file", "write_file", "skill"]
      }
    }
  ]
}
```

**Recommended agent assignments:**
- `crew-researcher` → `xai/grok-beta` (for X search and social intelligence)
- `crew-qa` → `xai/grok-vision-beta` (for UI testing and visual validation)
- `crew-security` → `xai/grok-vision-beta` (for document and image verification)
- `crew-copywriter` → `xai/grok-beta` (for viral content research)
- `crew-seo` → `xai/grok-beta` (for brand mention monitoring)

### 3. Use Skills from Any Agent

**Skills are auto-discovered** — no agent config changes needed. Any agent can call:

```javascript
@@SKILL grok.x-search {"query": "..."}
@@SKILL grok.vision {"image_url": "..."}
```

---

## Cost Comparison

| Model | Input | Output | Notes |
|---|---|---|---|
| `xai/grok-beta` | ~$5/M | ~$15/M | Mid-tier pricing, justified by X access |
| `xai/grok-vision-beta` | ~$10/M | ~$30/M | Image tokens cost more |
| `deepseek/deepseek-chat` | $0.27/M | $1.10/M | Alternative for pure text (no X access) |
| `groq/llama-3.3-70b` | Free tier | Free tier | Alternative for simple tasks |
| GPT-4V / Claude 4 Vision | ~$10/M | ~$30/M | Alternative for vision (no X access) |

**Cost optimization tips:**
- Use `xai/grok-beta` only when you need real-time X data or 128K context
- Use `xai/grok-vision-beta` only for image analysis
- Fall back to `deepseek-chat` or `groq/llama-3.3-70b` for general reasoning
- For vision without X access, GPT-4V and Claude 4 Vision have similar pricing

---

## Use Case Examples

### 1. Social Media Intelligence

```javascript
// Track competitor launch sentiment
@@SKILL grok.x-search {"query": "What are people saying about the new Cursor AI features?"}

// Monitor brand mentions
@@SKILL grok.x-search {"query": "CrewSwarm AI mentions in the last 24 hours"}

// Research viral tweet patterns
@@SKILL grok.x-search {"query": "Most retweeted AI development tweets this week"}
```

### 2. Automated UI Testing

```javascript
// Visual regression detection
@@SKILL grok.vision {"image_url": "https://staging.example.com/screenshot.png", "prompt": "Compare this to our production UI. List any visual differences."}

// Accessibility audit
@@SKILL grok.vision {"image_url": "https://example.com/ui.png", "prompt": "Check WCAG 2.1 AA compliance. List any color contrast issues, missing alt text, or keyboard navigation problems."}
```

### 3. Security & Compliance

```javascript
// Phishing detection
@@SKILL grok.vision {"image_url": "https://suspicious-email.com/attachment.jpg", "prompt": "Is this a phishing attempt? Look for fake logos, suspicious URLs, urgency tactics."}

// Document verification
@@SKILL grok.vision {"image_url": "https://example.com/id-card.jpg", "prompt": "Verify this ID document. Check for tampering, mismatched fonts, or altered dates."}
```

### 4. Content Strategy

```javascript
// Viral content research
@@SKILL grok.x-search {"query": "Trending AI memes and viral formats on X this week"}

// Influencer analysis
@@SKILL grok.x-search {"query": "Top AI influencers discussing Cursor on X — who has the most engagement?"}
```

---

## Comparison with Other Providers

| Feature | Grok | Claude 4 | GPT-4 | Perplexity | DeepSeek |
|---|---|---|---|---|---|
| Real-time X/Twitter access | ✅ | ❌ | ❌ | ❌ | ❌ |
| Vision/image analysis | ✅ | ✅ | ✅ | ❌ | ❌ |
| Function calling | ✅ | ✅ | ✅ | ❌ | ❌ |
| 128K+ context | ✅ | ✅ | ✅ | ❌ | ❌ |
| Web search built-in | ❌ | ❌ | ❌ | ✅ | ❌ |
| Cost (per M tokens) | $5/$15 | $3/$15 | $5/$15 | $1/$1 | $0.27/$1.10 |

**When to choose Grok:**
- You need real-time Twitter/X data (unique to Grok)
- Social media intelligence, trend tracking, sentiment analysis
- Combined vision + social context (e.g., analyze viral images on X)
- 128K context for large documents or conversations

**When to choose alternatives:**
- **Claude 4:** Best reasoning quality, no X access needed
- **GPT-4:** Best function calling, no X access needed
- **Perplexity:** General web search (not social-specific)
- **DeepSeek:** Cost optimization for pure text tasks

---

## Troubleshooting

### Skills Not Appearing in Dashboard

1. Check that skill files exist:
   ```bash
   ls -la ~/.crewswarm/skills/grok.*
   ```
2. Restart crew-lead to reload skills:
   ```bash
   pkill -f crew-lead.mjs && node crew-lead.mjs &
   ```
3. Check dashboard **Skills** tab for any errors

### "API key not configured" Error

1. Verify xAI API key in `~/.crewswarm/crewswarm.json`:
   ```bash
   cat ~/.crewswarm/crewswarm.json | grep -A2 xai
   ```
2. Test API key from command line:
   ```bash
   curl https://api.x.ai/v1/models \
     -H "Authorization: Bearer xai-..." \
     -H "Content-Type: application/json"
   ```

### Vision Skill Timeout

- Default timeout is 45 seconds
- Large images (>5MB) may take longer
- Increase timeout in `grok.vision.json`: `"timeout": 60000` (60s)
- Compress images before sending: `convert large.jpg -quality 85 optimized.jpg`

### X Search Returns Generic Response

- Grok's X access may be rate-limited or temporarily unavailable
- Try a more specific query with recent time context:
  - ❌ `"query": "AI news"`
  - ✅ `"query": "What AI tools launched on X this week?"`

---

## Future Enhancements

Potential additions (not yet implemented):

- **Function calling skill** — Expose Grok's native function calling for structured data extraction
- **X post skill** — Post tweets via Grok (requires write permissions)
- **Streaming responses** — Real-time X data as events arrive
- **X Spaces integration** — Transcribe and analyze live audio conversations
- **Image generation** — If/when xAI adds DALL-E-like capabilities

---

## References

- xAI API Documentation: https://docs.x.ai/
- xAI Console: https://console.x.ai/
- CrewSwarm Skills Documentation: See `AGENTS.md` → "Skill plugins" section
- Model Benchmarks: Dashboard → **Benchmarks** tab (ZeroEval / llm-stats.com)

---

**Questions or issues?** File an issue at https://github.com/crewswarm/crewswarm/issues
