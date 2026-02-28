# GitHub Automation Notes

This repo includes safe OpenCode v1 workflows:

- `.github/workflows/opencode-comment.yml`
- `.github/workflows/opencode-pr-review.yml`
- `.github/workflows/opencode-triage.yml`
- `.github/workflows/opencode-scheduled.yml`

## What It Does

### Comment command workflow

- Listens for new issue/PR comments (and manual dispatch).
- Runs when comment includes `/oc` or `/opencode`.
- Restricts comment-triggered execution to trusted associations:
  - `OWNER`
  - `MEMBER`
  - `COLLABORATOR`

### PR review workflow

- Runs on `pull_request` open/reopen/synchronize/ready_for_review.
- Skips draft PRs by default.
- Uses a review-focused prompt (regressions, security, tests, maintainability).

### Issue triage workflow

- Runs on `issues` open/edit/reopen (and manual dispatch).
- Uses custom triage prompt (classification, missing info, labels/owner).
- Includes anti-spam gate:
  - allows trusted associations immediately
  - otherwise requires account age >= 30 days
  - blocks bot accounts

### Scheduled maintenance workflow

- Runs weekly on cron (`30 14 * * 1`) and supports manual dispatch.
- Uses a maintenance-specific prompt:
  - TODO/FIXME hygiene
  - docs drift checks
  - low-risk dependency hygiene
  - small/safe follow-up recommendations

## QA Checklist

- See `docs/github-qa-checklist.md` for end-to-end validation steps and pass criteria.

## Required Secrets

- `ANTHROPIC_API_KEY` in repo/org GitHub secrets.

The workflow uses the built-in GitHub token (`github.token`) for GitHub operations.

## Usage

Comment on an issue or PR:

```text
/oc investigate failing tests and propose a fix
```

or

```text
/opencode review this PR for regressions
```

PR review and issue triage run automatically on their respective events.

## Inline Review Comments (Files Tab)

When you leave a review comment on a specific changed line in a PR (Files tab), the
`pull_request_review_comment` event includes:

- file path
- line number + side
- diff hunk context

Example trigger comment on a PR diff line:

```text
/oc review this null-check and propose the safest fix
```

Recommended pattern for line-level reviews:

1. Ask for a narrow fix tied to the commented hunk.
2. Request test impact for that exact change.
3. If needed, follow with a second `/oc` comment for broader repo cleanup.

## Safety Note

`smoke-test.yml` includes a `crew doctor` check that may fail in CI if local CrewSwarm services are not running on `localhost:5010`. This is documented inline in that workflow.
