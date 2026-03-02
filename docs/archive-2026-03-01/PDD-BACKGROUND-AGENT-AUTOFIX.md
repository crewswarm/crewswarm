# Product Design Document: Background Agent System
**"CrewSwarm AutoFix & Maintenance"**

**Status**: Not Started  
**Priority**: High (competitive feature, market demand)  
**Effort**: 10-14 days  
**Owner**: TBD  
**Inspired by**: GitHub Copilot Coding Agent, GitHub Advanced Security Autofix

---

## Problem Statement

Developers spend significant time on:
- **Security vulnerabilities** (CVEs, dependency issues)
- **Code quality issues** (linter errors, tech debt)
- **Test failures** (flaky tests, missing coverage)
- **Documentation drift** (outdated docs, missing API docs)
- **Dependency updates** (npm, pip, etc.)

**GitHub's solution**: Background autonomous agent that creates fix PRs while you work

**Our opportunity**: Build a **more powerful, open-source, multi-provider** version that works with ANY repo (not just GitHub) and ANY agent (not just Copilot).

---

## Solution: CrewSwarm Background Agent System

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Background Scheduler                    │
│  (Cron, GitHub Actions, or continuous daemon)           │
└───────────────┬─────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────┐
│              Issue Detection Layer                       │
│  - CodeQL / Semgrep / ESLint / TypeScript diagnostics  │
│  - Dependency scanner (npm audit, pip-audit)           │
│  - Test runner (detect flaky/failing tests)            │
│  - Docs linter (check for broken links, outdated)      │
└───────────────┬─────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────┐
│              Agent Dispatcher                            │
│  Routes issues to specialized agents:                   │
│  - crew-security → CVEs, security findings             │
│  - crew-fixer → Code quality, linter errors            │
│  - crew-qa → Test failures, coverage gaps              │
│  - crew-coder → Feature improvements                   │
│  - crew-copywriter → Documentation updates             │
└───────────────┬─────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────┐
│              Fix Generation                              │
│  Agent creates fix with:                                │
│  - Code changes (via crew-cli sandbox)                 │
│  - Tests (to validate fix)                             │
│  - Documentation (changelog, PR description)           │
└───────────────┬─────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────┐
│              Self-Review Layer                           │
│  Agent reviews its own work:                            │
│  - crew-qa audits code quality                         │
│  - crew-security checks for new vulnerabilities        │
│  - Run tests locally                                   │
│  - Blast radius analysis                               │
└───────────────┬─────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────┐
│              PR Creation                                 │
│  Create pull request with:                              │
│  - Fix description & reasoning                         │
│  - Test results                                        │
│  - Security impact analysis                            │
│  - Confidence score                                    │
└─────────────────────────────────────────────────────────┘
```

---

## Core Features

### 1. Issue Detection (Scanners)

**Security Scanner**:
```typescript
// src/autofix/scanners/security.ts
export async function scanSecurityIssues(repoPath: string): Promise<SecurityIssue[]> {
  const results = [];
  
  // Run npm audit / pip-audit
  const depIssues = await runDependencyAudit(repoPath);
  
  // Run CodeQL / Semgrep
  const codeIssues = await runStaticAnalysis(repoPath);
  
  // Run secret scanning
  const secrets = await scanForSecrets(repoPath);
  
  return [...depIssues, ...codeIssues, ...secrets];
}
```

**Code Quality Scanner**:
```typescript
// src/autofix/scanners/quality.ts
export async function scanCodeQuality(repoPath: string): Promise<QualityIssue[]> {
  // Run ESLint, TypeScript compiler, etc.
  const lintErrors = await runLinters(repoPath);
  
  // Detect code smells
  const smells = await detectCodeSmells(repoPath);
  
  return [...lintErrors, ...smells];
}
```

**Test Scanner**:
```typescript
// src/autofix/scanners/tests.ts
export async function scanTestIssues(repoPath: string): Promise<TestIssue[]> {
  // Run test suite
  const failures = await runTests(repoPath);
  
  // Detect flaky tests
  const flaky = await detectFlakyTests(repoPath);
  
  // Check coverage
  const lowCoverage = await findLowCoverage(repoPath);
  
  return [...failures, ...flaky, ...lowCoverage];
}
```

---

### 2. Agent Dispatcher (Route to Specialist)

```typescript
// src/autofix/dispatcher.ts
export async function dispatchIssue(issue: Issue): Promise<FixResult> {
  const agent = selectAgent(issue);
  
  // Route to specialized agent
  switch (agent) {
    case 'crew-security':
      return await fixSecurityIssue(issue);
    case 'crew-fixer':
      return await fixCodeQuality(issue);
    case 'crew-qa':
      return await fixTestIssue(issue);
    case 'crew-copywriter':
      return await fixDocumentation(issue);
  }
}

function selectAgent(issue: Issue): string {
  if (issue.type === 'security' || issue.type === 'dependency') {
    return 'crew-security';
  }
  if (issue.type === 'lint' || issue.type === 'code-smell') {
    return 'crew-fixer';
  }
  if (issue.type === 'test-failure' || issue.type === 'flaky-test') {
    return 'crew-qa';
  }
  if (issue.type === 'docs') {
    return 'crew-copywriter';
  }
  return 'crew-coder';
}
```

---

### 3. Fix Generation

```typescript
// src/autofix/generator.ts
export async function generateFix(issue: Issue, agent: string): Promise<Fix> {
  // Create isolated sandbox
  const sandbox = new Sandbox(issue.repoPath);
  
  // Generate prompt for agent
  const prompt = buildFixPrompt(issue);
  
  // Dispatch to agent via crew-cli
  const result = await execSync(
    `crew dispatch ${agent} --task "${prompt}" --sandbox ${sandbox.id}`
  );
  
  // Extract changes from sandbox
  const changes = await sandbox.getDiff();
  
  return {
    agent,
    issue,
    changes,
    description: result.description,
    confidence: result.confidence
  };
}

function buildFixPrompt(issue: Issue): string {
  return `
Fix this ${issue.type} issue:

**Issue**: ${issue.title}
**Severity**: ${issue.severity}
**Location**: ${issue.file}:${issue.line}
**Description**: ${issue.description}

Requirements:
1. Fix the issue without breaking existing functionality
2. Add tests to prevent regression
3. Update documentation if needed
4. Explain your reasoning

Blast radius: Keep changes minimal and isolated.
`.trim();
}
```

---

### 4. Self-Review Layer

**Before creating PR, agent reviews its own work**:

```typescript
// src/autofix/self-review.ts
export async function selfReview(fix: Fix): Promise<ReviewResult> {
  const checks = [];
  
  // 1. Run tests
  const testResult = await runTests(fix.sandbox);
  checks.push({ name: 'tests', passed: testResult.passed });
  
  // 2. Security audit
  const securityResult = await execSync(`crew dispatch crew-security --task "Audit this fix for security issues" --context ${fix.diff}`);
  checks.push({ name: 'security', passed: !securityResult.issuesFound });
  
  // 3. Code quality check
  const qaResult = await execSync(`crew dispatch crew-qa --task "Audit code quality" --context ${fix.diff}`);
  checks.push({ name: 'quality', passed: qaResult.score > 7 });
  
  // 4. Blast radius analysis
  const blastRadius = await analyzeBlastRadius(fix.changedFiles);
  checks.push({ name: 'blast-radius', passed: blastRadius.risk === 'low' });
  
  const allPassed = checks.every(c => c.passed);
  
  return {
    approved: allPassed,
    checks,
    confidence: allPassed ? 'high' : 'medium'
  };
}
```

---

### 5. PR Creation

```typescript
// src/autofix/pr-creator.ts
export async function createFixPR(fix: Fix, review: ReviewResult): Promise<string> {
  // Create branch
  const branchName = `autofix/${fix.issue.type}/${fix.issue.id}`;
  await git.checkout('-b', branchName);
  
  // Apply changes
  await fix.sandbox.applyToRepo();
  
  // Commit
  await git.add('.');
  await git.commit('-m', generateCommitMessage(fix));
  
  // Push
  await git.push('origin', branchName);
  
  // Create PR via gh CLI
  const prBody = generatePRDescription(fix, review);
  const result = await execSync(`gh pr create --title "${fix.issue.title}" --body "${prBody}"`);
  
  return result.prUrl;
}

function generatePRDescription(fix: Fix, review: ReviewResult): string {
  return `
## Automated Fix: ${fix.issue.title}

**Agent**: ${fix.agent}  
**Confidence**: ${review.confidence}  
**Severity**: ${fix.issue.severity}

### Issue Description
${fix.issue.description}

### Fix Strategy
${fix.description}

### Changes Made
${fix.changes.summary}

### Self-Review Results
${review.checks.map(c => `- ${c.name}: ${c.passed ? '✅' : '❌'}`).join('\n')}

### Test Results
- Tests passed: ${review.checks.find(c => c.name === 'tests')?.passed ? 'Yes' : 'No'}
- Security scan: ${review.checks.find(c => c.name === 'security')?.passed ? 'Clean' : 'Issues found'}
- Code quality: ${review.checks.find(c => c.name === 'quality')?.passed ? 'Good' : 'Needs review'}

### Blast Radius
Risk level: ${review.checks.find(c => c.name === 'blast-radius')?.risk || 'unknown'}

---
*This PR was automatically generated by CrewSwarm AutoFix*
`.trim();
}
```

---

## Scheduling & Triggers

### Option 1: GitHub Actions (Recommended for GitHub repos)

```yaml
# .github/workflows/autofix.yml
name: CrewSwarm AutoFix

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:      # Manual trigger
  issues:
    types: [labeled]      # When issue labeled "autofix"

jobs:
  scan-and-fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install CrewSwarm CLI
        run: npm install -g @crewswarm/cli
      
      - name: Scan for issues
        run: crew autofix scan --output issues.json
      
      - name: Generate fixes
        run: crew autofix run --issues issues.json --max-prs 3
      
      - name: Report results
        run: crew autofix report --format markdown >> $GITHUB_STEP_SUMMARY
```

---

### Option 2: Continuous Daemon (For local/self-hosted)

```typescript
// src/autofix/daemon.ts
export async function startAutofixDaemon(config: AutofixConfig) {
  console.log('Starting CrewSwarm AutoFix daemon...');
  
  while (true) {
    try {
      // Scan for issues
      const issues = await scanAllIssues(config.repoPath);
      
      // Filter by priority & limits
      const toFix = prioritizeIssues(issues, config.maxPRsPerRun);
      
      // Generate fixes
      for (const issue of toFix) {
        const fix = await generateFix(issue, selectAgent(issue));
        const review = await selfReview(fix);
        
        if (review.approved) {
          const prUrl = await createFixPR(fix, review);
          console.log(`Created PR: ${prUrl}`);
        }
      }
      
      // Sleep until next run
      await sleep(config.intervalMs);
    } catch (error) {
      console.error('AutoFix daemon error:', error);
      await sleep(60000); // Wait 1 min before retry
    }
  }
}
```

---

### Option 3: On-Demand CLI Command

```bash
# Scan for issues
crew autofix scan

# Generate fixes (with approval gates)
crew autofix run --interactive

# Auto-create PRs (no approval)
crew autofix run --auto-pr --max-prs 5
```

---

## Configuration

```json
// .crew/autofix.json
{
  "enabled": true,
  "schedule": "0 2 * * *",  // Daily at 2 AM
  "scanners": {
    "security": {
      "enabled": true,
      "tools": ["npm-audit", "codeql", "semgrep"],
      "severity": ["high", "critical"]
    },
    "quality": {
      "enabled": true,
      "tools": ["eslint", "typescript"],
      "autofix": true
    },
    "tests": {
      "enabled": true,
      "fixFlaky": true,
      "improveCoverage": false
    },
    "docs": {
      "enabled": true,
      "checkLinks": true,
      "updateOutdated": true
    }
  },
  "agents": {
    "security": "crew-security",
    "quality": "crew-fixer",
    "tests": "crew-qa",
    "docs": "crew-copywriter"
  },
  "limits": {
    "maxPRsPerRun": 3,
    "maxIssuesPerPR": 1,
    "minConfidence": 0.7
  },
  "pr": {
    "createDraft": false,
    "autoMerge": false,
    "reviewers": ["@team/security"],
    "labels": ["autofix", "bot"]
  }
}
```

---

## Implementation Plan

### Phase 1: Core Scanner (3-4 days)
**Files**:
- `src/autofix/scanners/security.ts`
- `src/autofix/scanners/quality.ts`
- `src/autofix/scanners/tests.ts`
- `src/autofix/scanners/index.ts`

**Tasks**:
- [ ] Security scanner (npm audit, pip-audit, secret scanning)
- [ ] Code quality scanner (ESLint, TypeScript, Semgrep)
- [ ] Test scanner (detect failures, flaky tests, low coverage)
- [ ] Issue prioritization (severity, impact, confidence)
- [ ] CLI command: `crew autofix scan`

**Validation**:
```bash
crew autofix scan --output issues.json
# Should return: 10 security issues, 5 quality issues, 3 test failures
```

---

### Phase 2: Fix Generator (3-4 days)
**Files**:
- `src/autofix/dispatcher.ts`
- `src/autofix/generator.ts`
- `src/autofix/prompt-builder.ts`

**Tasks**:
- [ ] Agent dispatcher (route to specialized agents)
- [ ] Fix prompt builder (context + requirements)
- [ ] Sandbox integration (isolated fix generation)
- [ ] CLI command: `crew autofix run --issue <id>`

**Validation**:
```bash
crew autofix run --issue SEC-001 --dry-run
# Should return: Fix diff, agent used, confidence score
```

---

### Phase 3: Self-Review Layer (2-3 days)
**Files**:
- `src/autofix/self-review.ts`
- `src/autofix/validators/tests.ts`
- `src/autofix/validators/security.ts`
- `src/autofix/validators/quality.ts`

**Tasks**:
- [ ] Test runner integration
- [ ] Security re-scan after fix
- [ ] Code quality validation
- [ ] Blast radius analysis
- [ ] Confidence scoring

**Validation**:
```bash
crew autofix review --fix <fix-id>
# Should return: All checks passed, confidence: high
```

---

### Phase 4: PR Creation (2-3 days)
**Files**:
- `src/autofix/pr-creator.ts`
- `src/autofix/formatters/pr-description.ts`
- `src/autofix/git-ops.ts`

**Tasks**:
- [ ] Branch creation
- [ ] Commit generation
- [ ] PR creation via `gh` CLI
- [ ] PR description formatting (with review results)
- [ ] Label/reviewer assignment

**Validation**:
```bash
crew autofix run --issue SEC-001 --create-pr
# Should create: Branch, commit, PR with full description
```

---

### Phase 5: Scheduler & Daemon (2 days)
**Files**:
- `src/autofix/daemon.ts`
- `src/autofix/scheduler.ts`
- `.github/workflows/autofix.yml` (template)

**Tasks**:
- [ ] Continuous daemon mode
- [ ] Cron-based scheduler
- [ ] GitHub Actions template
- [ ] Configuration loading

**Validation**:
```bash
crew autofix daemon --config .crew/autofix.json
# Should run continuously, creating PRs as issues found
```

---

## Success Metrics

| Metric | Week 1 | Month 1 | Month 3 |
|--------|--------|---------|---------|
| **Issues detected** | 50 | 500 | 5,000 |
| **PRs created** | 5 | 50 | 500 |
| **PRs merged** | 3 | 30 | 300 |
| **Time saved (hrs)** | 10 | 100 | 1,000 |
| **Vulnerabilities fixed** | 5 | 50 | 500 |

---

## Competitive Analysis

### GitHub Copilot Coding Agent

**What they have**:
- ✅ Background autonomous agent
- ✅ Self-review before PR creation
- ✅ Built-in security scanning
- ✅ Model selection (fast vs robust)
- ✅ Autofix for CodeQL alerts (90% of issues)
- ✅ 3x faster vulnerability remediation

**Limitations**:
- ❌ GitHub-only (no GitLab, Bitbucket, local repos)
- ❌ Requires GitHub Advanced Security ($)
- ❌ Single agent (not specialized)
- ❌ Limited to security + basic fixes
- ❌ No control over LLM provider

---

### CrewSwarm AutoFix (Our Advantages)

**What we offer**:
- ✅ **Open-source & multi-platform** (GitHub, GitLab, Bitbucket, local)
- ✅ **14 specialized agents** (security, qa, fixer, copywriter, etc.)
- ✅ **Multi-provider LLMs** (OpenAI, Anthropic, xAI, Groq, Ollama, etc.)
- ✅ **More issue types** (security, quality, tests, docs, dependencies)
- ✅ **Self-hosted option** (no data leaves your network)
- ✅ **Configurable limits** (max PRs, confidence thresholds, scanners)
- ✅ **Cost control** (use cheap local models for simple fixes)

---

## Pricing Model

**For SaaS/Hosted Version**:
- Free tier: 10 PRs/month
- Pro: $29/month (100 PRs/month)
- Team: $99/month (unlimited PRs, priority queue)
- Enterprise: Custom (self-hosted, SLA)

**For Open-Source/Self-Hosted**:
- Free (bring your own API keys)
- Optional cloud sync ($9/month)

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Agent creates broken PRs** | Self-review layer + blast radius analysis + confidence thresholds |
| **Too many PRs overwhelm reviewers** | Configurable limits (max 3 PRs/day by default) |
| **Security false positives** | Require high confidence (0.8+) for auto-PRs, otherwise flag for human review |
| **Cost explosion (API calls)** | Use cheap models for scanning, expensive only for complex fixes |
| **Rate limiting (GitHub API)** | Queue system + exponential backoff |

---

## Future Enhancements (Phase 2)

1. **Multi-repo support** (fix issues across entire org)
2. **Dependency updates** (automated Dependabot-style PRs)
3. **Performance optimization** (detect slow code, suggest improvements)
4. **AI-powered test generation** (add missing tests)
5. **Documentation generation** (auto-generate API docs)
6. **Code refactoring** (clean up tech debt)
7. **Slack/Discord notifications** (PR summaries)
8. **Analytics dashboard** (track fix success rate, time saved)

---

## Questions for Captain

1. **Priority level**: Should this be P1 (next up) or P2 (after Copilot CLI parity)?
2. **Scope**: Start with security-only (like GitHub) or full issue types?
3. **Platform**: GitHub Actions first, or build daemon for self-hosted?
4. **Agent pool**: Use existing crew-* agents or create dedicated `crew-autofix` agent?
5. **Business model**: Open-source + optional SaaS, or SaaS-first?

---

**Files**:
- This PDD: `PDD-BACKGROUND-AGENT-AUTOFIX.md`
- Roadmap entry: `ROADMAP.md` (add to "Pending Work" section)
