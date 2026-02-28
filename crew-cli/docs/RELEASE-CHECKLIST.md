# Release Go/No-Go Checklist (v0.1.0-alpha)

This document outlines the mandatory checks before tagging and publishing the `crew-cli` package.

## 🟢 1. Technical Readiness (The "Go" Gates)
- [ ] **Build Integrity**: `npm run build` completes without errors and generates `dist/crew.mjs`.
- [ ] **Test Coverage**: `npm test` passes 100% (currently 23/23 tests).
- [ ] **Dependency Audit**: `npm audit` shows 0 vulnerabilities.
- [ ] **Version Bump**: `package.json` version is set to `0.1.0-alpha`.
- [ ] **Bin Permissions**: `bin/crew.js` has executable permissions (`chmod +x`).
- [ ] **Clean Root**: No scratch files (`*.txt`, `*.html`, `*.json`) other than standard config are tracked by git.

## 🟡 2. Functional Smoke Tests (Manual/CI)
- [ ] `crew doctor` reports green for Node and Git.
- [ ] `crew auth` correctly identifies local tokens (if present).
- [ ] `crew branch test-release` successfully creates a sandbox branch.
- [ ] `crew preview` displays unified diffs correctly for staged changes.
- [ ] `crew apply --check "ls"` verifies the validation hook functionality.

## 🔴 3. Security & Privacy
- [ ] **Secrets Check**: No API keys or session tokens are hardcoded in `src/` or `tests/`.
- [ ] **.gitignore Validation**: `.crew/`, `node_modules/`, and `dist/` are correctly ignored.
- [ ] **Path Traversal**: Verified that `Sandbox` restricted to `baseDir`.

## 📦 4. Distribution & Docs
- [ ] **README**: Polymarket/Legacy references removed; points to correct CrewSwarm gateway setup.
- [ ] **EXAMPLES**: All commands in `EXAMPLES.md` are copy-paste runnable.
- [ ] **NPM Registry**: Access to `@crewswarm` scope verified.
- [ ] **Homebrew**: `brew/crew-cli.rb` SHA256 matches the latest build artifact.

## 🚀 5. Launch Ops
- [ ] Blog post drafted in `docs/marketing/blog-post.md`.
- [ ] HN/Reddit/X threads prepared.
- [ ] Product Hunt "Coming Soon" page (optional for alpha).

---
**Approval Status:** 
- **Lead Dev:** _________
- **QA/Security:** _________
- **Product:** _________
