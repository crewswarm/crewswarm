# Crew Lessons

Mistake patterns captured automatically by crew-scribe from `@@LESSON:` tags in agent replies.
crew-fixer, crew-coder, crew-coder-front, and crew-coder-back receive this file in every prompt.

---

<!-- crew-scribe appends new entries below automatically -->

## Model Context Windows (effective limits)

Advertised context windows are often much larger than what models actually recall reliably.
Use **effective** limits when deciding which model to route long tasks to.
Full table: `memory/model-context-windows.md`

Key rules of thumb:
- **GPT-4.1 / GPT-4.1 Mini** — best memory score (87.5) + true ~1M effective context. Best for long-document or large-codebase tasks.
- **Claude Sonnet 4** — strong memory (82.5) but effective window ~510k despite 1M advertised.
- **Claude Opus 4/4.1** — strong memory (85) but hard cap ~130k effective. Avoid for very large tasks.
- **GPT-5** — effective window only ~408k despite 1M advertised; memory score 74.3.
- **Grok-3** — weakest memory score (50); avoid for tasks needing long-range recall.
- **Gemini-2.5-Flash** — memory score 67.5 but near-full 1M effective context; good for bulk/cheap large-window work.
