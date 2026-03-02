# Background Agent System — Quick Reference

**PDD**: `PDD-BACKGROUND-AGENT-AUTOFIX.md`  
**Roadmap**: `ROADMAP.md` → crew-lead Pending Work #2  
**Priority**: P1 (High)  
**Effort**: 10-14 days

---

## What It Does

**Background autonomous agent** that automatically:
- Detects bugs, vulnerabilities, quality issues
- Generates fixes using specialized agents
- Self-reviews fixes (tests, security, blast radius)
- Creates pull requests with full context

**Inspired by**: GitHub Copilot Coding Agent (Feb 2026)

---

## GitHub's Approach vs Ours

### GitHub Copilot Coding Agent

✅ **What they have**:
- Background agent creates PRs while you work
- 3x faster vulnerability remediation
- Self-review before PR creation
- Built-in security scanning
- Autofix for 90% of CodeQL issues

❌ **Limitations**:
- GitHub-only (no GitLab, Bitbucket, local)
- Requires Advanced Security ($)
- Single generic agent
- Limited to security + basic fixes

---

### CrewSwarm AutoFix

✅ **Our advantages**:
- **Multi-platform**: GitHub, GitLab, Bitbucket, local repos
- **14 specialized agents**: crew-security, crew-fixer, crew-qa, crew-copywriter
- **Multi-provider LLMs**: OpenAI, Anthropic, xAI, Groq, Ollama
- **More issue types**: Security, quality, tests, docs, dependencies
- **Open-source**: Self-hosted option, no vendor lock-in
- **Cost control**: Use cheap local models for simple fixes

---

## How It Works

```
1. SCAN
   ├─ Security (npm audit, CodeQL, secrets)
   ├─ Quality (ESLint, TypeScript, code smells)
   ├─ Tests (failures, flaky, low coverage)
   └─ Docs (broken links, outdated)

2. ROUTE
   ├─ Security issues → crew-security
   ├─ Quality issues → crew-fixer
   ├─ Test issues → crew-qa
   └─ Doc issues → crew-copywriter

3. FIX
   └─ Generate fix in isolated sandbox

4. REVIEW
   ├─ Run tests
   ├─ Security scan
   ├─ Code quality check
   └─ Blast radius analysis

5. PR
   └─ Create PR with:
       ├─ Fix description
       ├─ Test results
       ├─ Security impact
       └─ Confidence score
```

---

## Usage

### CLI Commands
```bash
# Scan for issues
crew autofix scan

# Generate fixes interactively
crew autofix run --interactive

# Auto-create PRs (no approval)
crew autofix run --auto-pr --max-prs 5

# Run as daemon
crew autofix daemon --config .crew/autofix.json
```

---

### GitHub Actions (Scheduled)
```yaml
# .github/workflows/autofix.yml
name: CrewSwarm AutoFix

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM

jobs:
  autofix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @crewswarm/cli
      - run: crew autofix run --max-prs 3
```

---

### Configuration
```json
// .crew/autofix.json
{
  "enabled": true,
  "schedule": "0 2 * * *",
  "scanners": {
    "security": {
      "enabled": true,
      "severity": ["high", "critical"]
    },
    "quality": {
      "enabled": true,
      "autofix": true
    }
  },
  "limits": {
    "maxPRsPerRun": 3,
    "minConfidence": 0.7
  }
}
```

---

## Implementation Phases

**Phase 1**: Core Scanner (3-4 days)  
→ `crew autofix scan`

**Phase 2**: Fix Generator (3-4 days)  
→ `crew autofix run --issue <id>`

**Phase 3**: Self-Review Layer (2-3 days)  
→ Validation before PR

**Phase 4**: PR Creation (2-3 days)  
→ `gh pr create` with context

**Phase 5**: Scheduler & Daemon (2 days)  
→ `crew autofix daemon`

**Total**: 10-14 days

---

## Success Metrics

| Metric | Week 1 | Month 1 | Month 3 |
|--------|--------|---------|---------|
| Issues detected | 50 | 500 | 5,000 |
| PRs created | 5 | 50 | 500 |
| PRs merged | 3 | 30 | 300 |
| Time saved (hrs) | 10 | 100 | 1,000 |

---

## Business Impact

**Market opportunity**:
- GitHub's Copilot Coding Agent just launched (Feb 2026)
- Huge demand for automated bug fixing
- No open-source alternative exists

**Pricing model**:
- Free tier: 10 PRs/month
- Pro: $29/month (100 PRs/month)
- Team: $99/month (unlimited)
- Enterprise: Self-hosted

**Competitive edge**:
- Open-source + multi-platform
- More specialized agents
- More issue types
- Lower cost (local models supported)

---

## Questions for Decision

1. **Priority**: Should this be next (P1) or after Copilot CLI parity (P2)?
2. **Scope**: Security-only first, or full issue types?
3. **Platform**: GitHub Actions first, or build daemon?
4. **Business**: Open-source + SaaS, or SaaS-first?

---

**Recommendation**: **P1** — This is GitHub's latest differentiator. We should match it (and beat it) ASAP to stay competitive.
