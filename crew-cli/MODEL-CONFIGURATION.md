# Complete Model Configuration Guide

## Overview

CrewSwarm supports multiple LLM providers across 3 tiers. This guide shows you how to configure the optimal stack for your use case.

## Quick Start Configurations

### 🎯 Recommended (Balanced Cost/Quality)
```bash
export CREW_USE_UNIFIED_ROUTER="true"
export CREW_DUAL_L2_ENABLED="true"

# Tier 1: Chat Interface (cheap, fast)
export CREW_CHAT_MODEL="deepseek-chat"
export DEEPSEEK_API_KEY="your-key"

# Tier 2: Reasoning/Planning (smart, structured)
export CREW_REASONING_MODEL="deepseek-reasoner"

# Tier 3: Execution (free, fast)
export CREW_EXECUTION_MODEL="gemini-flash"
export GEMINI_API_KEY="your-key"

# Cost: ~$0.01 per complex task
```

### 💰 Ultra-Cheap (Maximum Cost Savings)
```bash
export CREW_USE_UNIFIED_ROUTER="true"
export CREW_DUAL_L2_ENABLED="false"  # Skip dual-L2 for simple tasks

export CREW_CHAT_MODEL="gemini-flash"
export CREW_REASONING_MODEL="gemini-flash"
export CREW_EXECUTION_MODEL="gemini-flash"
export GEMINI_API_KEY="your-key"

# Cost: ~$0.00 per task (free tier)
```

### 🏆 Maximum Quality
```bash
export CREW_USE_UNIFIED_ROUTER="true"
export CREW_DUAL_L2_ENABLED="true"

export CREW_CHAT_MODEL="claude-sonnet"
export CREW_REASONING_MODEL="claude-sonnet"
export CREW_EXECUTION_MODEL="claude-sonnet"
export ANTHROPIC_API_KEY="your-key"

# Cost: ~$0.10 per complex task
```

### ⚡ Maximum Speed (Groq)
```bash
export CREW_USE_UNIFIED_ROUTER="true"
export CREW_DUAL_L2_ENABLED="true"

export CREW_CHAT_MODEL="groq-llama"
export CREW_REASONING_MODEL="groq-llama"
export CREW_EXECUTION_MODEL="groq-llama"
export GROQ_API_KEY="your-key"

# Speed: ~500 tokens/sec (vs ~50 for others)
```

### 🖥️ Local/Private (Ollama)
```bash
export CREW_USE_UNIFIED_ROUTER="true"
export CREW_USE_OLLAMA="true"

export CREW_OLLAMA_CHAT="llama3.2:3b"
export CREW_OLLAMA_REASONING="qwen2.5:7b"
export CREW_OLLAMA_EXECUTION="qwen2.5-coder:7b"

# Cost: $0.00 (local compute)
# Speed: Depends on hardware
# Privacy: 100% local
```

## Supported Providers

### Tier 1: Chat Interface (Cheap & Fast)

| Provider | Model | Cost (per 1M tokens) | Speed | Best For |
|----------|-------|---------------------|-------|----------|
| **Gemini** | `gemini-flash` | $0/$0 (free) | Fast | Simple questions, prototyping |
| **DeepSeek** | `deepseek-chat` | $0.14/$0.28 | Medium | Balanced chat, good quality |
| **Grok** | `grok-mini` | $5/$15 | Very Fast | Real-time responses |
| **Groq** | `groq-llama` | $0.59/$0.79 | Ultra Fast | Latency-critical |
| **Ollama** | `llama3.2:3b` | $0/$0 (local) | Fast | Privacy, offline |

**Recommendation**: `deepseek-chat` for best cost/quality, `gemini-flash` if free tier matters

### Tier 2: Reasoning/Planning (Smart & Structured)

| Provider | Model | Cost (per 1M tokens) | Intelligence | Best For |
|----------|-------|---------------------|--------------|----------|
| **DeepSeek** | `deepseek-reasoner` | $0.55/$2.19 | ⭐⭐⭐⭐⭐ | Complex reasoning, planning |
| **Claude** | `claude-sonnet` | $3/$15 | ⭐⭐⭐⭐⭐ | Code quality, accuracy |
| **GPT-4** | `gpt-4o` | $2.5/$10 | ⭐⭐⭐⭐⭐ | General intelligence |
| **Grok** | `grok-2` | $2/$10 | ⭐⭐⭐⭐ | Fast reasoning |
| **Gemini** | `gemini-pro` | $1.25/$5 | ⭐⭐⭐⭐ | Balanced |
| **Ollama** | `qwen2.5:32b` | $0/$0 (local) | ⭐⭐⭐ | Local reasoning |

**Recommendation**: `deepseek-reasoner` for best value, `claude-sonnet` for maximum quality

### Tier 3: Execution (Code Generation)

| Provider | Model | Cost (per 1M tokens) | Code Quality | Best For |
|----------|-------|---------------------|--------------|----------|
| **Gemini** | `gemini-flash` | $0/$0 (free) | ⭐⭐⭐⭐ | Free code generation |
| **DeepSeek** | `deepseek-chat` | $0.14/$0.28 | ⭐⭐⭐⭐ | Cost-effective coding |
| **Qwen** | `qwen-coder` | $0.2/$0.6 | ⭐⭐⭐⭐⭐ | Specialized for code |
| **Claude** | `claude-sonnet` | $3/$15 | ⭐⭐⭐⭐⭐ | Production-ready code |
| **GPT-4o Mini** | `gpt-4o-mini` | $0.15/$0.60 | ⭐⭐⭐⭐ | OpenAI quality, cheaper |
| **Groq** | `groq-llama` | $0.59/$0.79 | ⭐⭐⭐ | Fast iteration |
| **Ollama** | `qwen-coder:7b` | $0/$0 (local) | ⭐⭐⭐ | Private code gen |

**Recommendation**: `gemini-flash` for free tier, `deepseek-chat` for best value, `qwen-coder` for specialized

## Provider Setup Instructions

### DeepSeek (Recommended)
```bash
# Get API key from https://platform.deepseek.com/
export DEEPSEEK_API_KEY="sk-..."

# Available models:
# - deepseek-chat ($0.14/$0.28 per 1M tokens)
# - deepseek-reasoner ($0.55/$2.19 per 1M tokens)
```

### Gemini (Free Tier)
```bash
# Get API key from https://aistudio.google.com/apikey
export GEMINI_API_KEY="AI..."

# Available models:
# - gemini-2.0-flash-exp (FREE)
# - gemini-2.0-pro-exp ($1.25/$5 per 1M tokens)
```

### Grok (x.ai)
```bash
# Get API key from https://console.x.ai/
export XAI_API_KEY="xai-..."

# Available models:
# - grok-beta ($5/$15 per 1M tokens)
# - grok-2-latest ($2/$10 per 1M tokens)
```

### Claude (Anthropic)
```bash
# Get API key from https://console.anthropic.com/
export ANTHROPIC_API_KEY="sk-ant-..."

# Available models:
# - claude-3-5-sonnet-20241022 ($3/$15 per 1M tokens)
# - claude-3-5-haiku-20241022 ($1/$5 per 1M tokens)
```

### OpenAI
```bash
# Get API key from https://platform.openai.com/
export OPENAI_API_KEY="sk-..."

# Available models:
# - gpt-4o ($2.5/$10 per 1M tokens)
# - gpt-4o-mini ($0.15/$0.60 per 1M tokens)
# - o1 ($15/$60 per 1M tokens) - reasoning model
```

### Groq (Ultra-Fast)
```bash
# Get API key from https://console.groq.com/
export GROQ_API_KEY="gsk_..."

# Available models:
# - llama-3.3-70b-versatile ($0.59/$0.79 per 1M tokens)
# - mixtral-8x7b ($0.24/$0.24 per 1M tokens)
```

### Ollama (Local/Private)
```bash
# Install Ollama
# Mac: brew install ollama
# Linux: curl -fsSL https://ollama.ai/install.sh | sh

# Start server
ollama serve

# Pull models
ollama pull llama3.2:3b        # Chat (1.3GB)
ollama pull qwen2.5:7b         # Reasoning (4.7GB)
ollama pull qwen2.5-coder:7b   # Code (4.7GB)

# Configure CrewSwarm
export CREW_USE_OLLAMA="true"
export CREW_OLLAMA_CHAT="llama3.2:3b"
export CREW_OLLAMA_REASONING="qwen2.5:7b"
export CREW_OLLAMA_EXECUTION="qwen2.5-coder:7b"
```

## Use Case Configurations

### For Prototyping/Learning (Free)
```bash
export CREW_CHAT_MODEL="gemini-flash"
export CREW_REASONING_MODEL="gemini-flash"
export CREW_EXECUTION_MODEL="gemini-flash"
export GEMINI_API_KEY="your-key"
```

### For Production (Quality)
```bash
export CREW_CHAT_MODEL="claude-sonnet"
export CREW_REASONING_MODEL="deepseek-reasoner"
export CREW_EXECUTION_MODEL="claude-sonnet"
export ANTHROPIC_API_KEY="your-key"
export DEEPSEEK_API_KEY="your-key"
```

### For High Volume (Cost)
```bash
export CREW_CHAT_MODEL="deepseek-chat"
export CREW_REASONING_MODEL="deepseek-chat"
export CREW_EXECUTION_MODEL="deepseek-chat"
export DEEPSEEK_API_KEY="your-key"
```

### For Offline/Private (Local)
```bash
export CREW_USE_OLLAMA="true"
export CREW_OLLAMA_CHAT="llama3.2:3b"
export CREW_OLLAMA_REASONING="qwen2.5:32b"
export CREW_OLLAMA_EXECUTION="qwen2.5-coder:7b"
```

### For Experimentation (Mixed)
```bash
export CREW_CHAT_MODEL="groq-llama"      # Fast feedback
export CREW_REASONING_MODEL="claude-sonnet"  # Best planning
export CREW_EXECUTION_MODEL="gemini-flash"   # Free execution
```

## Testing Your Configuration

### Run Benchmarks
```bash
cd crew-cli

# Test all configurations
node scripts/benchmark-comprehensive.mjs

# Test Ollama
node scripts/test-ollama.mjs

# Test direct LLMs
node scripts/test-direct-llm.mjs
```

### Interactive Test
```bash
crew repl

# Check current config
crew(manual)> /info

# Try a test prompt
crew(manual)> /mode builder
crew(builder)> write a hello world function
crew(builder)> /trace  # See which models were used
```

## Cost Comparison

### Simple Task (Question)
| Config | Cost | Time |
|--------|------|------|
| Ultra-Cheap (Gemini) | $0.0000 | 2s |
| Recommended (DeepSeek) | $0.0001 | 2s |
| Max Quality (Claude) | $0.0005 | 3s |

### Medium Task (Single Function)
| Config | Cost | Time |
|--------|------|------|
| Ultra-Cheap | $0.0002 | 4s |
| Recommended | $0.0030 | 4s |
| Max Quality | $0.0080 | 5s |

### Complex Task (Multi-File)
| Config | Cost | Time |
|--------|------|------|
| Ultra-Cheap | $0.0010 | 25s |
| Recommended | $0.0180 | 15s |
| Max Quality | $0.0900 | 20s |

## Environment Variable Reference

### Core Settings
```bash
CREW_USE_UNIFIED_ROUTER=true|false    # Use 3-tier pipeline
CREW_DUAL_L2_ENABLED=true|false       # Enable L2A/L2B planning
```

### Model Selection
```bash
CREW_CHAT_MODEL=<model-id>            # L1 chat interface
CREW_REASONING_MODEL=<model-id>       # L2 reasoning/planning
CREW_EXECUTION_MODEL=<model-id>       # L3 code execution
```

### Ollama (Local)
```bash
CREW_USE_OLLAMA=true|false            # Enable Ollama
CREW_OLLAMA_URL=http://localhost:11434  # Ollama server
CREW_OLLAMA_CHAT=<model>              # Chat model
CREW_OLLAMA_REASONING=<model>         # Reasoning model
CREW_OLLAMA_EXECUTION=<model>         # Execution model
```

### API Keys
```bash
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=AI...
XAI_API_KEY=xai-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
```

### Cost/Risk Controls
```bash
CREW_COST_LIMIT=0.50                  # Max cost per task ($)
CREW_ALLOW_CRITICAL=false             # Allow critical risk
CREW_AUTO_APPLY=false                 # Auto-apply changes
```

## Troubleshooting

### "Provider not available"
- Check API key is set: `echo $DEEPSEEK_API_KEY`
- Verify key is valid (test with curl)
- Check provider status page

### "Model not found"
- Check model name spelling
- Verify model is available in your region
- Try alternative model from same provider

### "Cost exceeded limit"
- Increase limit: `export CREW_COST_LIMIT="1.00"`
- Or use cheaper models (Gemini/DeepSeek)

### Ollama connection failed
- Check server is running: `ollama list`
- Verify URL: `curl http://localhost:11434/api/tags`
- Pull model if missing: `ollama pull llama3.2`

## Next Steps

1. Choose a configuration from above
2. Set environment variables
3. Run benchmarks to verify setup
4. Start using REPL: `crew repl`
5. Adjust based on results

See also:
- `TESTING-GUIDE.md` - Comprehensive testing
- `EXTERNAL-TOOL-COMPARISON.md` - Compare with Cursor/Codex
- `EXECUTION-FLOW.md` - How the pipeline works
