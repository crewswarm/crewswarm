# Legacy root-level guides (redirect)

Older releases shipped many `*-COMPLETE.md` / integration guides in the **repository root**. Those files were **removed or folded into canonical docs** to keep the root readable.

Use this map if you have bookmarks or old links:

| Old path (removed) | Use instead |
|--------------------|-------------|
| `STUDIO-SETUP-COMPLETE.md` (root) | [`apps/vibe/STUDIO-SETUP-COMPLETE.md`](../../apps/vibe/STUDIO-SETUP-COMPLETE.md), [`apps/vibe/README.md`](../../apps/vibe/README.md) |
| `CREWCHAT-QUICKSTART.md` | [`apps/crewchat/`](../../apps/crewchat/) (sources), [`docs/CANONICAL/INSTALL.md`](../../CANONICAL/INSTALL.md) (optional build flags) |
| `MULTIMODAL-TAB-UI-COMPLETE.md` | [`docs/CANONICAL/SURFACES.md`](../../CANONICAL/SURFACES.md), [`docs/CANONICAL/DASHBOARD-TABS.md`](../../CANONICAL/DASHBOARD-TABS.md) |
| `CHAT-HISTORY-AND-RAG-COMPLETE.md` | [`docs/CANONICAL/MEMORY.md`](../../CANONICAL/MEMORY.md), [`docs/UNIFIED-API.md`](../../UNIFIED-API.md) |
| `SHARED-MEMORY-INTEGRATION.md` | [`docs/CANONICAL/MEMORY.md`](../../CANONICAL/MEMORY.md), [`crew-cli/docs/SHARED-MEMORY.md`](../../../crew-cli/docs/SHARED-MEMORY.md) |
| `WHATSAPP-TELEGRAM-INTEGRATION.md` | [`docs/CANONICAL/SURFACES.md`](../../CANONICAL/SURFACES.md), [`docs/TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md), bridge sources `telegram-bridge.mjs` / `whatsapp-bridge.mjs` |
| `GENERIC-COLLECTIONS.md` | [`lib/collections/index.mjs`](../../../lib/collections/index.mjs), [`docs/CANONICAL/MEMORY.md`](../../CANONICAL/MEMORY.md) (RAG role) |
| `FINAL-TEST-RESULTS.md` | [`docs/CANONICAL/TESTING.md`](../../CANONICAL/TESTING.md) |
| `TELEGRAM-TOPIC-AGENT-PERMISSIONS.md` / `TELEGRAM-SELF-DISPATCH.md` | [`docs/CANONICAL/DASHBOARD-TABS.md`](../../CANONICAL/DASHBOARD-TABS.md) (Comms), [`AGENTS.md`](../../../AGENTS.md) (Telegram section), `telegram-bridge.mjs` |

**Current root `.md` policy:** keep only `README.md`, `AGENTS.md`, `ROADMAP.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, plus maintainer checklist under `docs/internal/`.
