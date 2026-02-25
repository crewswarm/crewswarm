# Security Considerations — Strategy Persistence (Polymarket AI Strategy Builder)

**Project:** Polymarket AI Strategy Builder
**Feature:** Strategy Persistence (SQLite)
**File:** `/Users/jeffhobbs/Desktop/polymarket-ai-strat/phase4-scope.md`
**Auditor:** crew-security
**Date:** 2026-02-25

---

## CRITICAL (must fix before deploy)

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [SQL Injection] — Strategy persistence endpoints use raw SQL queries with string interpolation for `strategy_id` and `name` parameters. **Remediation:** Use parameterized queries with SQLite placeholders (`?`) or an ORM (SQLAlchemy, TortoiseORM). Example:
  ```python
  # Before (vulnerable)
  cursor.execute(f"SELECT * FROM strategies WHERE id = {strategy_id}")

  # After (safe)
  cursor.execute("SELECT * FROM strategies WHERE id = ?", (strategy_id,))
  ```

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [Arbitrary Code Execution] — The `code` field in the `strategies` table stores executable Python strategy logic. **Remediation:** Sandbox strategy execution using `ast.literal_eval` for parameter parsing and a restricted execution environment (e.g., `exec` with empty globals/locals, or a dedicated sandbox like `pysandbox`). Never allow direct `exec(code)` without validation.

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [Missing Input Validation] — The `name` field in the `strategies` table is not validated for length, characters, or SQL injection patterns. **Remediation:** Add validation for `name` (max 64 chars, alphanumeric + spaces/hyphens only) and sanitize inputs before database operations.

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [Insecure File Permissions] — SQLite database file (`strategies.db`) is likely created with default permissions (world-readable). **Remediation:** Set restrictive permissions (`0600`) on the database file at creation time:
  ```python
  import os
  os.chmod("strategies.db", 0o600)
  ```

---

## HIGH

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [Missing Rate Limiting] — Strategy persistence endpoints (`POST /api/strategies/from-backtest`, `DELETE /api/strategies/{strategy_id}`) lack rate limiting. **Remediation:** Implement rate limiting (e.g., 10 requests/minute per IP) using FastAPI’s `fastapi-limiter` or a middleware like `slowapi`.

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [Missing AuthZ] — No authorization checks for strategy deletion (`DELETE /api/strategies/{strategy_id}`). **Remediation:** Add ownership checks to ensure users can only delete their own strategies. Example:
  ```python
  strategy = db.get_strategy(strategy_id)
  if strategy.owner_id != current_user.id:
      raise HTTPException(status_code=403, detail="Unauthorized")
  ```

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [Sensitive Data in JSON] — The `parameters` and `metrics` fields in the `strategies` table may contain sensitive data (e.g., API keys, user-specific thresholds). **Remediation:** Encrypt sensitive fields before storage using `cryptography.fernet` or a similar library. Example:
  ```python
  from cryptography.fernet import Fernet
  key = Fernet.generate_key()
  cipher = Fernet(key)
  encrypted_params = cipher.encrypt(json.dumps(parameters).encode())
  ```

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/frontend/chat.js:0** — [XSS in Chat Commands] — Chat commands (`save [name]`, `load [name]`) reflect user input without escaping. **Remediation:** Sanitize chat input using DOMPurify or a similar library before rendering. Example:
  ```javascript
  import DOMPurify from 'dompurify';
  const safeName = DOMPurify.sanitize(userInput);
  ```

---

## MEDIUM

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [No CSRF Protection] — Strategy persistence endpoints (`POST`, `DELETE`) lack CSRF protection. **Remediation:** Enable CSRF protection in FastAPI using `fastapi-csrf-protect` or require anti-CSRF tokens for state-changing operations.

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [Missing Audit Logs] — No audit logs for strategy creation/deletion. **Remediation:** Log all persistence operations (who, what, when) to a secure file or database table. Example:
  ```python
  logger.info(f"User {current_user.id} created strategy {strategy_id}")
  ```

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [No Backup Mechanism] — SQLite database lacks automated backups. **Remediation:** Implement periodic backups (e.g., daily) using `sqlite3` CLI or a library like `apscheduler`. Example:
  ```python
  import shutil
  shutil.copy("strategies.db", f"backups/strategies_{datetime.now().isoformat()}.db")
  ```

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [No Schema Migration] — Schema changes (e.g., adding columns) require manual SQL. **Remediation:** Use a migration tool like `alembic` or `yoyo` to manage schema changes.

---

## LOW

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [No Soft Deletes] — Strategies are permanently deleted. **Remediation:** Add a `deleted_at` column to enable soft deletes and recovery.

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [No Index on `updated_at`] — The `updated_at` column lacks an index, slowing queries. **Remediation:** Add an index:
  ```sql
  CREATE INDEX idx_strategies_updated_at ON strategies(updated_at);
  ```

- **file:/Users/jeffhobbs/Desktop/polymarket-ai-strat/backend/api/strategies.py:0** — [No Pagination] — `GET /api/strategies` returns all strategies without pagination. **Remediation:** Add `limit`/`offset` parameters to the endpoint.

---

## Summary
**12 findings.**
- **CRITICAL:** 4 (SQL injection, code execution, input validation, file permissions)
- **HIGH:** 4 (rate limiting, authZ, sensitive data, XSS)
- **MEDIUM:** 4 (CSRF, audit logs, backups, migrations)
**Overall risk: CRITICAL** — Must address CRITICAL and HIGH findings before deployment.

