# crewswarm vibe — ROADMAP

## Phase 1: Core IDE ✅
- [x] Monaco editor integration
- [x] File tree navigation
- [x] Chat with agents (crew-lead, direct agents, CLI bypass)
- [x] Project selection
- [x] Authentication (Bearer token)
- [x] CORS fixes for Vibe ↔ Dashboard ↔ crew-lead

## Phase 2: Advanced Features 🔄
- [x] Cmd+K inline chat overlay  ✓ 12:50:06 AM (crew-coder-front)
- [x] Diff preview modal for agent changes AM  ✓ 1:20:18 AM (crew-coder-front)
- [x] File content loading from local Studio server  ✓ 1:22:32 AM (crew-coder-front)
- [x] Terminal integration (bottom panel) AM  ✓ 1:28:52 AM (crew-fixer)
- [x] Settings panel (link to main dashboard)  ✓ 1:31:55 AM (crew-coder-front)
- [x] Change from studio to vibe (only in the UI and docs; directory and runtime names unchanged)


## Phase 3: Polish 📋
- [x] All panels adjustable / resize the views AM  ✓ 2:55:51 AM (crew-fixer)
- [x] Syntax highlighting for the bundled Monaco language set (`css`, `html`, `javascript`, `markdown`, `python`, `typescript`)
- [x] Dark/light theme toggle AM AM  ✓ 3:21:24 AM (crew-fixer)
- [x] Keyboard shortcuts guide AM  ✓ 3:25:51 AM (crew-coder-front)
- [x] Performance optimization AM AM PM PM  ✓ 1:19:08 AM (crew-coder-back)
- [x] Error handling improvements PM PM  ✓ 1:24:08 AM (crew-coder-back)

## Notes
- All CORS issues resolved (wildcard headers)
- Local Studio API working: `/api/studio/projects`, `/api/studio/files`, `/api/studio/file-content`
- crew-lead chat working: `/chat` with Bearer auth
- Vibe port: 3333, Dashboard: 4319, crew-lead: 5010

---

## PM-Generated (Round 1)

- [x] Add a color contrast analyzer tool to the project to ensure that the color schemes used in the application meet the latest accessibility standards and provide a good user experience for users with visual impairments. PM PM  ✓ 1:30:42 AM (crew-coder-back)
- [x] Implement a comprehensive testing framework that includes automated tests for accessibility, performance, and security to ensure that the application is robust, reliable, and meets the latest web development trends and best practices. PM PM  ✓ 1:35:44 AM (crew-coder-back)


