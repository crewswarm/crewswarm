# Git / Cursor worktree recovery (2026-03-20)

## What was done

1. **Frozen copies** of all five broken Cursor worktrees to:
   - `/Users/jeffhobbs/Desktop/CrewSwarm-recovery-backup-2026-03-20/worktree-{cju,ehh,fuc,jvk,leb}/`
   - Total size ~2.5 GB (full tree snapshots, not Git objects).

2. **Inventory** — `diff -rq` of backup `cju/crew-cli` vs repo `crew-cli` (268 lines):
   - `/Users/jeffhobbs/Desktop/CrewSwarm-recovery-backup-2026-03-20/inventory-diff-cju-crew-cli-vs-main.txt`
   - Backup has many extra root-level `.md` notes and differs in `LICENSE` / `README.md`; main repo has paths like `.opencode/` and deleted Gemini tests.

3. **Git metadata cleanup**
   - Removed dangling ref `refs/heads/backup-before-stash-merge` (missing `36365db…`) from `.git/packed-refs` and `.git/info/refs`.
   - Ran `git worktree remove --force` for all five paths under `~/.cursor/worktrees/CrewSwarm/*` (Git removed admin dirs; `~/.cursor/worktrees/CrewSwarm/` is now empty).

4. **Integrity / crew-cli**
   - `git fsck --full` still reports **many** missing objects and broken links (historical damage; unreachable trees). **Current `main` at `HEAD` remains usable** for normal work; a **fresh clone** is the nuclear option if fsck noise matters.
   - `npm --prefix crew-cli run build` ✅  
   - `npm --prefix crew-cli run typecheck` ✅  
   - `npm --prefix crew-cli test` ✅ (32 tests)

## Gemini tool tests — restored 2026-03-20

- **Restored from backup** into `crew-cli/src/tools/gemini/`: all `*.test.ts` (36 files) and `__snapshots__` / `definitions/__snapshots__` (`.snap` files).
- **Default `npm test`** still runs only `tests/unit/*.test.js` — unchanged, still passes.
- **Gemini Vitest suite is not runnable yet** in this repo:
  - Tests import **`vitest`** (not a current `devDependency`).
  - They depend on **`src/tools/utils/*`**, **`src/tools/test-utils/*`**, **`src/tools/config/*`**, **`src/tools/services/*`**, etc. — those paths are **missing or empty** here (and were also absent under `worktree-cju` backup), so this tree only holds the **gemini/** slice, not the full upstream Gemini CLI package layout.
- **To make `src/tools/gemini/*.test.ts` pass:** add `vitest` (and likely wire a `vitest.config.ts`), then **vendor or symlink** the missing sibling modules from [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) (matching the import layout your `gemini/*.ts` files expect), or narrow tests to what crewswarm actually ships.

## Not done (your call)

- **Run / green the Gemini Vitest tree** — see above.
- **Optional:** `git reflog expire` / `git gc` after backup — can drop more unreachable objects; only if you accept losing old reflog recovery.
- **`.git/filter-repo/`** metadata still mentions the old backup ref; harmless. Remove manually if you want zero references.

## Restoring files from backup

```bash
BACKUP="/Users/jeffhobbs/Desktop/CrewSwarm-recovery-backup-2026-03-20"
# Example: restore one Gemini test (adjust paths)
cp "$BACKUP/worktree-cju/crew-cli/src/tools/gemini/read-file.test.ts" \
   /Users/jeffhobbs/Desktop/CrewSwarm/crew-cli/src/tools/gemini/
```

Review diffs before bulk restore; backup includes a lot of scratch `.md` you may not want on `main`.
