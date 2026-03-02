#!/usr/bin/env python3
import json
import os

# Read openclaw providers
with open(os.path.expanduser("~/.openclaw/openclaw.json")) as f:
    oc = json.load(f)
    
providers_src = oc.get("models", {}).get("providers", {})

# Read search tools
with open(os.path.expanduser("~/.openclaw/search-tools.json")) as f:
    search = json.load(f)

# Build new config
new_cfg = {
    "agents": [
        {"id": "crew-main", "model": "google/gemini-2.5-flash"},
        {"id": "crew-coder", "model": "groq/moonshotai/kimi-k2-instruct-0905"},
        {"id": "crew-pm", "model": "xai/grok-4-1-fast-reasoning"},
        {"id": "crew-qa", "model": "deepseek/deepseek-chat"},
        {"id": "crew-fixer", "model": "groq/moonshotai/kimi-k2-instruct-0905"},
        {"id": "crew-security", "model": "deepseek/deepseek-chat"},
        {"id": "crew-coder-front", "model": "groq/moonshotai/kimi-k2-instruct-0905"},
        {"id": "crew-coder-back", "model": "groq/moonshotai/kimi-k2-instruct-0905"},
        {"id": "crew-github", "model": "groq/llama-3.3-70b-versatile"},
        {"id": "crew-frontend", "model": "groq/moonshotai/kimi-k2-instruct-0905"},
        {"id": "crew-copywriter", "model": "google/gemini-2.5-flash"},
        {"id": "crew-telegram", "model": "deepseek/deepseek-chat"},
        {"id": "orchestrator", "model": "google/gemini-2.5-flash"},
        {"id": "crew-seo", "model": "google/gemini-2.5-flash"},
        {"id": "crew-mega", "model": "google/gemini-2.5-flash"},
        {"id": "crew-researcher", "model": "perplexity/sonar"},
        {"id": "crew-architect", "model": "deepseek/deepseek-reasoner"},
        {"id": "crew-whatsapp", "model": "deepseek/deepseek-chat"},
        {"id": "crew-ml", "model": "xai/grok-3-mini"},
        {"id": "crew-lead", "model": "deepseek/deepseek-reasoner"},
        {"id": "crew-orchestrator", "model": "google/gemini-2.5-flash"}
    ],
    "providers": {}
}

# Copy all providers from openclaw
for pid, pdata in providers_src.items():
    new_cfg["providers"][pid] = {
        "baseUrl": pdata.get("baseUrl", ""),
        "apiKey": pdata.get("apiKey", ""),
        "api": pdata.get("api", "openai-completions")
    }

# Add search API providers
for sid, sdata in search.items():
    if sid not in new_cfg["providers"]:
        new_cfg["providers"][sid] = {
            "apiKey": sdata.get("apiKey", "")
        }

print(json.dumps(new_cfg, indent=2))
