# GitHub Automation QA Checklist

Date: 2026-02-28
Scope: OpenCode workflows in `.github/workflows/opencode-*.yml`

## Preconditions

- `ANTHROPIC_API_KEY` is set in GitHub repo/org secrets.
- OpenCode workflows are present:
  - `opencode-comment.yml`
  - `opencode-pr-review.yml`
  - `opencode-triage.yml`
  - `opencode-scheduled.yml`

## 1) Manual trigger smoke (`workflow_dispatch`)

Run each workflow manually from GitHub Actions UI:

1. OpenCode Comment Command
2. OpenCode PR Review
3. OpenCode Issue Triage
4. OpenCode Scheduled Maintenance

Pass criteria:
- Workflow starts and reaches OpenCode step.
- No YAML/permissions/secrets wiring errors.

## 2) Comment command workflow

### Issue comment test

1. Create a test issue.
2. Comment: `/oc summarize this issue and propose next steps`.

Pass criteria:
- `opencode-comment.yml` runs.
- Bot posts a relevant response.

### PR line-comment test

1. Open a test PR with a small code diff.
2. In Files tab, add line comment: `/oc review this block for regressions`.

Pass criteria:
- `opencode-comment.yml` runs on `pull_request_review_comment`.
- Response uses line-level context.

### Gate test (untrusted)

1. Comment from non-collaborator account.

Pass criteria:
- No OpenCode action run from untrusted association.

## 3) PR review workflow

1. Open or update a non-draft PR.

Pass criteria:
- `opencode-pr-review.yml` runs automatically.
- Review feedback is posted and references code/test risk.

## 4) Issue triage workflow

### Trusted user test

1. Open issue from OWNER/MEMBER/COLLABORATOR account.

Pass criteria:
- `opencode-triage.yml` runs.
- Triage output includes classification + missing info.

### Anti-spam gate test

1. Open issue from account younger than 30 days (or simulate with test account).
2. Open issue from bot account if available.

Pass criteria:
- Workflow exits early with gate message.
- No expensive OpenCode step executed.

## 5) Scheduled workflow

1. Use `workflow_dispatch` to simulate weekly run now.
2. Verify cron exists: `30 14 * * 1`.

Pass criteria:
- `opencode-scheduled.yml` runs with maintenance prompt.
- Result is bounded (no broad unsafe changes).

## 6) Failure-mode checks

### Missing secret behavior

1. Temporarily run in a test repo without `ANTHROPIC_API_KEY`.

Pass criteria:
- Workflow fails fast with clear secret/auth error.

### Permissions behavior

1. Confirm workflow permissions are sufficient but not excessive.

Pass criteria:
- Comment workflow: `contents/pull-requests/issues: write`.
- PR review/triage/scheduled: only needed scopes present.

## 7) Post-QA sign-off

- Record run URLs for all four workflows.
- Record one successful example per trigger type:
  - issue_comment
  - pull_request_review_comment
  - pull_request
  - issues
  - schedule (simulated by dispatch)
- If all pass, mark GitHub automation as production-ready.
