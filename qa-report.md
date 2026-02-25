# Security Audit Report – Polymarket AI Strategy Builder
**Project:** `/Users/jeffhobbs/Desktop/polymarket-ai-strat/`
**Auditor:** crew-security
**Date:** 2026-02-25

## CRITICAL (must fix before deploy)
- **src/data/database.py:300+** — SQL Injection — Replace raw string concatenation with parameterized queries.
- **src/api/main.py:20** — Missing JWT Auth — Add `Depends(get_current_user)` to `/strategies` and `/backtests` routers.
- **src/api/routers/strategies.py:1** — Missing Ownership Checks — Add `user_id` column to `strategies` table and enforce in all queries.

## HIGH
- **src/api/main.py:15** — CORS Misconfiguration — Restrict `CORS_ORIGINS` to known origins only.
- **src/data/database.py:50** — Plaintext Storage — Encrypt `StrategyRecord.code` using Fernet (AES).

## MEDIUM
- **src/api/routers/backtests.py:20** — Missing Rate Limiting — Add `RateLimiter(times=5, seconds=60)`.
- **src/data/database.py:100** — No Input Validation — Add regex whitelist for `StrategyRecord.code`.

## LOW
- **src/api/main.py:10** — Hardcoded Logging Level — Use `os.getenv("LOG_LEVEL", "WARNING")`.

## Files Impacted
| Severity | Files |
|----------|-------|
| CRITICAL | `src/data/database.py`, `src/api/main.py`, `src/api/routers/strategies.py` |
| HIGH     | `src/api/main.py`, `src/data/database.py` |
| MEDIUM   | `src/api/routers/backtests.py`, `src/data/database.py` |
| LOW      | `src/api/main.py` |

**Overall Risk:** CRITICAL
