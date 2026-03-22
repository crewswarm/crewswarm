# crewswarm Vibe — Quick Reference Card

## Start Vibe

```bash
npm install
npm run build
npm start
# -> http://127.0.0.1:3333
```

---

## Layout

```
┌─────────────────────────────────────────────┐
│ 🐝 crewswarm Vibe            Project Name   │
├───────┬─────────────────┬───────────────────┤
│ Files │  Editor (Monaco)│  Chat + Agents    │
├───────┴─────────────────┴───────────────────┤
│ Terminal (Agent Activity Logs)              │
└─────────────────────────────────────────────┘
```

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| **Enter** | Send chat message |
| **Shift+Enter** | Insert a new line in chat |
| **⌘+S** | Save file (also auto-saves after 1s) |
| Click file in tree | Open in editor |
| Click × on tab | Close file |

---

## Agent Status Icons

| Icon | Meaning |
|---|---|
| 🟢 | Online |
| ⚡ | Working |
| ✅ | Complete |
| 🔴 | Error |

---

## Terminal Log Colors

| Color | Type |
|---|---|
| Cyan | Info |
| Green | Success |
| Red | Error |
| Orange | Warning |

---

## Workflow

1. **Open file** → Click in file tree
2. **Edit** → Type in Monaco editor
3. **Save** → Auto-saves (or ⌘+S)
4. **Run Codex** → Switch mode to `cli:codex`, type a task, press Enter
5. **Watch progress** → Terminal shows RT updates

---

## Connections

Always local:
- **Vibe** (:3333) — projects, file IO, local `cli:codex`

Optional shared services:
- **Dashboard** (:4319) — auth, agents, crew-lead passthrough
- **crew-lead** (:5010) — shared chat backend
- **RT Bus** (:18889) — agent activity

---

## File Structure

```
apps/vibe/
├── index.html       # UI layout
├── src/main.js      # All logic
├── vite.config.js   # Dev server
└── server.mjs       # Prod server
```

---

## Commands

```bash
# Dev mode
npm run dev

# Production build
npm run build

# Production server
npm start

# Smoke test
npm test
```

---

## Troubleshooting

**Vibe won't start?**
```bash
cd apps/vibe
rm -rf node_modules
npm install
npm run dev
```

**Codex mode not working?**
- Check Codex CLI: `codex --help`
- Use `cli:codex` for standalone local coding

**Terminal not acting like a full shell?**
- The bottom terminal opens a real local shell for the selected project
- It still is not a full PTY-backed terminal emulator, so use an external terminal for heavy TUI workflows
- Use `cli:codex` for real local file-changing execution

**RT bus disconnected?**
- Check RT daemon: `ps aux | grep "rt-daemon"`

**File tree empty?**
- Check the selected project path exists
- Check local server: `curl http://127.0.0.1:3333/api/studio/projects`

---

## Ports

| Service | Port |
|---|---|
| Vibe | 3333 |
| Dashboard | 4319 |
| crew-lead | 5010 |
| RT Bus | 18889 |

---

## Docs

- `README.md`
- `ARCHITECTURE.md`
- `VISUAL-GUIDE.md`

---

## Phase Status

**Local Core (Complete):**
- ✅ Monaco editor
- ✅ Local project persistence
- ✅ Real file operations
- ✅ Local `cli:codex` execution
- ✅ Smoke test coverage

**Still shared / optional:**
- 🔄 crew-lead chat
- 🔄 broader agent routing
- 🔄 RT activity from the full crewswarm stack

---

## Quick Tips

- **File not saving?** Check terminal for the save error line and confirm the file is inside the selected project directory
- **Want dark theme?** Already using vs-dark (Monaco default)
- **Multiple tabs?** Click files to open, × to close
- **Agent not responding?** Check dashboard → Agents tab for status
- **Customize layout?** Edit `apps/vibe/index.html` CSS grid

---

## Example Chat

```
You: Add validation to the login form

Mode: cli:codex

[Terminal]
[14:30:00] fake codex started
[14:30:05] fake codex finished

codex: wrote files in the project directory
```

---

**Built with:** Monaco • Vite • local HTTP server • Codex CLI  
**License:** MIT  
**Version:** 1.0.0

---

**Need help?** Open GitHub issue with `[Vibe]` tag.

**Enjoy!** 🐝✨
