# Progress Update

Date: 2026-02-28

## Completed

- Added OpenCode GitHub v1 automation workflow:
  - `.github/workflows/opencode-comment.yml`
- Workflow gates:
  - Runs on `/oc` or `/opencode` comment commands.
  - Restricted to `OWNER`, `MEMBER`, `COLLABORATOR`.
- Added GitHub operations notes:
  - `github.md` with setup, required secrets, usage, and safety notes.
- Added two additional OpenCode workflows:
  - `.github/workflows/opencode-pr-review.yml` for automatic PR review
  - `.github/workflows/opencode-triage.yml` for issue triage
- Added scheduled OpenCode maintenance workflow:
  - `.github/workflows/opencode-scheduled.yml` (weekly cron + manual dispatch)
- Added custom prompts per workflow and anti-spam gating for triage:
  - trusted associations allowed immediately
  - non-trusted users must have account age >= 30 days
  - bot accounts are blocked from auto-triage

## Notes

- OpenCode workflow requires `ANTHROPIC_API_KEY` secret.
- Workflow uses built-in `github.token` for repo writes/comments.
- Added Node 24 test compatibility fix:
  - Replaced `chalk` dependency in `src/utils/logger.ts` with internal ANSI color helpers
  - Removes ESM import mismatch in `tests/orchestrator.test.js` and `tests/router.test.js`
- Latest verification:
  - `npm run build` ✓
  - `npm run check` ✓
  - `npm test` ✓ (34 passing, 0 failing on Node v24.10.0)
