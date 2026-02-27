# Model Context Window Reference

Effective context windows are often significantly smaller than advertised.
Use **Effective** limits when estimating whether a task will fit in context.

| Model | Memory Score | Advertised (tokens) | Effective (tokens) |
|---|---|---|---|
| GPT-4.1 | 87.5 | 1,050k | ~1,025k |
| GPT-4.1 Mini | 87.5 | 1,050k | ~1,025k |
| Gemini-2.5-Flash | 67.5 | 1,050k | ~1,025k |
| Claude Opus 4 | 85 | 200k | ~130k |
| Claude Opus 4.1 | 85 | 200k | ~130k |
| GPT-4o | 82.5 | 130k | ~125k |
| Claude Sonnet 4 | 82.5 | 1,000k | ~510k |
| Claude 3.5 Sonnet | 80 | 200k | ~130k |
| GPT-5 | 74.3 | 1,000k | ~408k |
| Deepseek-chat-v3.1 | 70 | 165k | ~130k |
| Gemini-2.5-Flash | 67.5 | 1,050k | ~1,025k |
| Claude Sonnet 4.5 | 67.5 | 1,000k | ~510k |
| Claude 3.7 Sonnet | 67.5 | 200k | ~130k |
| Grok-3 | 50 | 130k | ~130k |

## Key takeaways for routing

- **GPT-4.1 / GPT-4.1 Mini** — best memory + true 1M context; ideal for long-document tasks
- **Claude Sonnet 4** — high memory score but effective window is only ~510k despite 1M advertised
- **GPT-5** — 1M advertised but effective ~408k; weaker memory score (74.3)
- **Claude Opus 4/4.1** — strong memory (85) but capped at ~130k effective — avoid for very large tasks
- **Grok-3** — weakest memory score (50); avoid for tasks requiring long-range recall
