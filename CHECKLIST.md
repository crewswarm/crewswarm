# CrewSwarm Cleanup Checklist

## Must-fix before public push

### Product clarity
- [ ] Pick **one primary install/start path**
  - [ ] Decide whether the canonical flow is `install.sh` → `restart-all`
  - [ ] Demote alternate flows like `vibe`, `dashboard`, headless install into secondary sections
- [ ] Define what CrewSwarm **is** in one sentence
- [ ] Define what CrewSwarm **is not**
  - [ ] not just a chat wrapper
  - [ ] not just a CLI
  - [ ] not just a framework
- [ ] Clearly explain the difference between:
  - [ ] CrewSwarm
  - [ ] `crew-cli`
  - [ ] dashboard
  - [ ] vibe
  - [ ] MCP integrations

### README / docs
- [ ] Replace the current README with a cleaner public-facing version
- [ ] Remove repeated sections and duplicate quickstarts
- [ ] Verify every command in the README actually works
- [ ] Verify every port in the README is correct
- [ ] Verify every config path in the README is correct
  - [ ] Fix `~/.crewswarm/config.json` vs `~/.crewswarm/crewswarm.json`
- [ ] Add one **golden-path quickstart**
- [ ] Add one real example prompt and expected outcome
- [ ] Add a short troubleshooting section
- [ ] Add a clean docs index

### Repo hygiene
- [ ] Remove stale experiments
- [ ] Remove dead scripts and half-finished junk
- [ ] Archive or delete obsolete surfaces/features
- [ ] Standardize filenames and naming conventions
- [ ] Clean the root directory
- [ ] Make folder structure legible for a new contributor in under 2 minutes

### Install / onboarding
- [ ] Make install truly one-shot
- [ ] Ensure non-interactive install works cleanly
- [ ] Add clear handling for missing dependencies
- [ ] Make free-tier setup obvious
- [ ] Give users a sane default model/provider path
- [ ] Make first-run success happen fast

### Config sanity
- [ ] Consolidate config locations if there are multiple
- [ ] Document all env vars that matter
- [ ] Remove config sprawl and duplicate knobs
- [ ] Set sensible defaults so users do not need to understand the whole system on day one

### Public repo safety
- [ ] Audit for secrets
  - [ ] env files
  - [ ] sample config
  - [ ] tokens in docs
  - [ ] URLs with credentials
- [ ] Remove private/internal notes
- [ ] Remove internal-only branding or references
- [ ] Check install scripts for brittle or unsafe behavior
- [ ] Make sure public-facing claims are true

---

## Should-fix soon after

### UX / developer experience
- [ ] Add screenshots or short GIFs
- [ ] Add a “what happens when I type a task” flow
- [ ] Add a startup health check users can run immediately
- [ ] Add a “common commands” section
- [ ] Improve error messaging during setup/startup

### Architecture clarity
- [ ] Create one simple system diagram
- [ ] Explain task flow from user prompt → lead → agents → files
- [ ] Explain when command approval is triggered
- [ ] Explain memory files in plain English
- [ ] Explain the execution engines clearly

### Branding / positioning
- [ ] Lock the tagline
- [ ] Lock naming across repo, docs, site, and CLI
- [ ] Make the homepage/README positioning match
- [ ] Tighten comparison against other agent tools
- [ ] Stop over-explaining every feature in the first screenful

### Cursor / editor onboarding
- [ ] Add explicit Cursor setup steps
- [ ] Add explicit Claude Code setup steps
- [ ] Add MCP setup examples
- [ ] Add headless / remote / CI examples that reflect actual usage

---

## Nice-to-have
- [ ] Contribution guide
- [ ] Roadmap section
- [ ] Changelog cleanup
- [ ] Example projects folder
- [ ] Docker path
- [ ] Demo video
- [ ] Benchmarks or proof-of-work examples
- [ ] Comparison page/site section
- [ ] Security policy polish

---

## Suggested execution order

### Phase 1 — Stop the bleeding
- [ ] Pick one install/start path
- [ ] Fix README
- [ ] Fix config-path inconsistencies
- [ ] Clean root folder
- [ ] Remove stale junk
- [ ] Verify commands

### Phase 2 — Make it usable
- [ ] Improve onboarding
- [ ] Improve docs
- [ ] Add screenshots/demo
- [ ] Add troubleshooting
- [ ] Clarify architecture

### Phase 3 — Make it launchable
- [ ] Tighten branding
- [ ] Polish site/repo consistency
- [ ] Add contribution/security/changelog cleanup
- [ ] Make the public repo look intentional

---

## Brutal priority summary
If you only do six things, do these:

- [ ] One true startup path
- [ ] One clean README
- [ ] One consistent config story
- [ ] One clean repo structure
- [ ] One real demo path
- [ ] One pass for secrets/private garbage
