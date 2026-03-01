# crew-cli

Command-line interface for CrewSwarm agent orchestration with local safety rails (sandbox diffs, session state, routing/cost logs), team sync, CI/browser helpers, and voice mode.

---
**[OVERVIEW.md](docs/OVERVIEW.md)** - 🚀 1-minute summary of what this is and how it works.
---

## Requirements

- Node.js 20+
- Git
- Optional for full integration: running CrewSwarm gateway (`http://127.0.0.1:5010`)

## Install

```bash
npm install
npm run build
```

Run the CLI:

```bash
node bin/crew.js --help
```

## Core Commands

```bash
crew chat "refactor auth middleware"
crew dispatch crew-coder "fix failing tests"
crew explore "refactor database layer" # parallel speculative execution
crew plan "add OAuth login" --parallel
crew preview
crew apply --check "npm test"
crew rollback
```

## Intelligence Commands

```bash
crew map --graph                     # visual dependency graph
crew shell "list large files"        # NL to shell command translation
crew docs "how does auth work"       # RAG search over docs/markdown
crew blast-radius                    # impact analysis of current changes
crew memory "auth login"             # recall prior task memory
crew lsp check src/cli/index.ts      # TypeScript diagnostics
crew lsp complete src/cli/index.ts 10 5
crew repl                            # interactive multi-agent REPL
crew tui                             # terminal UI adapter (same runtime as REPL)
crew github "list open issues"       # NL GitHub flows
crew github doctor                   # GitHub CLI health check
```

## Advanced Commands

```bash
crew sync --status
crew privacy --show
crew serve --mode standalone         # unified /v1 API for dashboard/CLI/headless
crew serve --mode connected          # proxy unified API to crew-lead/gateway
crew exec "vim src/server.ts"        # interactive terminal (PTY)
crew listen --duration-sec 6
crew browser-debug --url http://127.0.0.1:4319
crew ci-fix --check "npm test"
crew doctor
```

## Context Flags

`chat` and `dispatch` accept these context injection flags:

- `--docs` — auto-retrieve relevant doc chunks via collections search
- `--cross-repo` — inject sibling repo context
- `--context-file <path>` — attach a file
- `--context-repo <path>` — attach git context from another repo
- `--stdin` — pipe stdin as context

## What Is Implemented

- Phase 1 (MVP): complete
- Phase 2 (Intelligence): complete
- Phase 3 (Polish/Launch): complete
- Phase 4 (Advanced): complete
- Phase 5 (3-Tier LLM Scale-Up): complete

See [ROADMAP.md](ROADMAP.md) and [progress.md](progress.md) for tracked completion.

## Testing

```bash
npm run build
npm run check
npm test
```

Latest local QA pass (2026-03-01):
- Build: passing
- Check: passing
- Tests: 78 passing, 0 failing

## Documentation

- [QUICKSTART.md](docs/QUICKSTART.md)
- [EXAMPLES.md](docs/EXAMPLES.md)
- [VIDEO-SCRIPT.md](docs/VIDEO-SCRIPT.md) - 🎬 Demo script & shot list
- [DEMO-SCENARIO.md](docs/DEMO-SCENARIO.md) - 🏁 Deterministic demo scenario
- [demo.mp4](docs/marketing/demo.mp4) - 🎥 **Watch the Demo Video**
- [BENCHMARK-RESULTS.md](docs/BENCHMARK-RESULTS.md) - 📊 Performance metrics
- [API.md](docs/API.md)
- [API-UNIFIED-v1.md](docs/API-UNIFIED-v1.md) - Unified dashboard/CLI/headless contract
- [openapi.unified.v1.json](docs/openapi.unified.v1.json) - OpenAPI spec for unified endpoints
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [CONTRIBUTING.md](docs/CONTRIBUTING.md)
- [SECURITY.md](docs/SECURITY.md)

## Marketing Drafts

- `docs/marketing/blog-post.md`
- `docs/marketing/hacker-news.md`
- `docs/marketing/product-hunt.md`
- `docs/marketing/social-launch-pack.md`
