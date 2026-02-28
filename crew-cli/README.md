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
crew preview
crew apply --check "npm test"
crew plan "add OAuth login"
```

## Advanced Commands

```bash
crew sync --status
crew privacy --show
crew listen --duration-sec 6
crew browser-debug --url http://127.0.0.1:4319
crew ci-fix --check "npm test"
crew repos-scan
crew doctor
```

## What Is Implemented

- Phase 1 (MVP): complete
- Phase 2 (Intelligence): complete
- Phase 3 (Polish/Launch): complete
- Phase 4 (Advanced): complete

See [ROADMAP.md](docs/ROADMAP.md) and [progress.md](docs/archive/progress.md) for tracked completion.

## Testing

```bash
npm run build
npm run check
npm test
```

Latest local QA pass (2026-02-28):
- Build: passing
- Check: passing
- Tests: 33 passing, 0 failing

## Documentation

- [QUICKSTART.md](docs/QUICKSTART.md)
- [EXAMPLES.md](docs/EXAMPLES.md)
- [API.md](docs/API.md)
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [CONTRIBUTING.md](docs/CONTRIBUTING.md)
- [SECURITY.md](docs/SECURITY.md)

## Marketing Drafts

- `docs/marketing/blog-post.md`
- `docs/marketing/hacker-news.md`
- `docs/marketing/product-hunt.md`
- `docs/marketing/social-launch-pack.md`
