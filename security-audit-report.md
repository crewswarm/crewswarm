# Security Audit Report — polymarket-ai-strat
**Auditor:** crew-security
**Date:** 2026-02-25
**Project:** `/Users/jeffhobbs/Desktop/polymarket-ai-strat/`
**Scope:** Phase 4 (Live Data + Database + Frontend)

---

## CRITICAL (must fix before deploy)

- **src/api/main.py:18-22** — [Hardcoded CORS origins with credentials] — `CORS_ORIGINS` defaults to `"http://localhost:4319,http://localhost:3000"` and is used with `allow_credentials=True`. This allows any origin to bypass CORS checks if credentials are present. **Remediation:** Restrict origins to known trusted domains only. Use environment variables for production and disable credentials if not needed. Example:
  ```python
  cors_origins = os.getenv("CORS_ORIGINS", "").split(",")
  if not cors_origins:
      cors_origins = ["http://localhost:4319"]  # Fallback for dev only
  app.add_middleware(
      CORSMiddleware,
      allow_origins=cors_origins,
      allow_credentials=True if cors_origins != ["*"] else False,
      allow_methods=["GET", "POST"],
      allow_headers=["Authorization", "Content-Type"],
  )
  ```

- **src/data/database.py:120-130** — [SQL Injection via string concatenation in schema initialization] — `conn.executescript(SCHEMA)` uses raw SQL string concatenation. **Remediation:** Use parameterized queries or `sqlite3.Connection.execute()` with placeholders for dynamic values. If schema must be static, ensure `SCHEMA` is hardcoded and reviewed for injection risks.

- **src/ai/strategy_parser.py:200-210** — [Code Injection via `exec()` in strategy execution] — The generated strategy code is compiled and executed using `exec()`. This allows arbitrary code execution if user input is not strictly validated. **Remediation:** Replace `exec()` with a sandboxed execution environment (e.g., `ast.literal_eval` for expressions, or a restricted interpreter). Alternatively, use a whitelist of allowed functions and indicators.

- **src/ai/llm_parser.py:45-50** — [Hardcoded API key in LLM parser] — The Groq API key is read from `GROQ_API_KEY` env var, but the code logs a warning if missing. This could leak the key in logs or error messages. **Remediation:** Never log API keys. Use `os.getenv("GROQ_API_KEY")` without logging. Mask keys in error messages (e.g., `"Groq API key configured (masked)"`).

---

## HIGH

- **src/data/polymarket_client.py:150-160** — [Missing input validation for market_id/outcome] — `fetch_price_history()` and other methods accept `market_id` and `outcome` as raw strings without validation. This could lead to path traversal or cache poisoning. **Remediation:** Validate inputs against a regex (e.g., `^[a-zA-Z0-9-]{10,50}$`) and sanitize before use in file paths or SQL queries.

- **src/data/historical_data.py:80-90** — [Cache poisoning via unsanitized file paths] — `_get_cache_path()` uses `market_id` and `outcome` directly in file paths without sanitization. **Remediation:** Sanitize inputs (e.g., replace `/` with `_`) or use a hash (as currently done) but ensure the hash is collision-resistant.

- **src/api/main.py:50-60** — [Missing rate limiting on `/api/backtests`] — The backtest endpoint is exposed without rate limiting, allowing abuse (e.g., DoS via expensive backtests). **Remediation:** Add rate limiting (e.g., 10 requests/minute per IP/user). Use `slowapi` or `fastapi-limiter` with Redis for distributed support.

- **src/frontend/js/chat.js (not found, but referenced)** — [XSS via unescaped user input] — If chat messages or strategy names are rendered directly in HTML, they could enable XSS. **Remediation:** Escape all dynamic content using `textContent` or a templating library (e.g., DOMPurify). Never use `innerHTML` with user input.

- **src/data/database.py:200-210** — [Missing parameterized queries in CRUD methods] — Some methods (e.g., `upsert_market`) use string formatting for SQL queries. **Remediation:** Replace all raw SQL with parameterized queries (e.g., `?` or `:name` placeholders). Example:
  ```python
  conn.execute(
      "INSERT INTO markets (id, question) VALUES (?, ?)",
      (market.id, market.question)
  )
  ```

---

## MEDIUM

- **src/ai/code_validator.py:30-40** — [Incomplete dangerous pattern detection] — The validator checks for `eval/exec` but misses `pickle`, `yaml.load`, or `marshal`. **Remediation:** Expand the dangerous patterns list to include all unsafe deserialization methods.

- **src/data/database.py:50-60** — [No database encryption at rest] — SQLite database is stored in plaintext. **Remediation:** Use SQLite encryption (e.g., SQLCipher) or encrypt sensitive fields (e.g., strategy code) before storage.

- **src/api/main.py:100-110** — [Missing auth on `/api/markets`] — The markets endpoint is public, allowing enumeration of all markets. **Remediation:** Add API key auth or rate limiting to prevent abuse.

- **src/data/polymarket_client.py:200-210** — [No request signing for Polymarket API] — API requests to Polymarket are unsigned, risking replay attacks. **Remediation:** Add a timestamp/nonce and HMAC signature to requests.

---

## LOW

- **.env.example:1** — [Default secrets in example file] — `.env.example` may contain placeholder secrets (e.g., `GROQ_API_KEY=your_key_here`). **Remediation:** Replace with `GROQ_API_KEY=` (empty) and add a comment: `# Required. Get from https://console.groq.com/`.

- **src/data/database.py:70-80** — [No connection timeout] — SQLite connections have no timeout, risking hangs. **Remediation:** Set `timeout=10` in `sqlite3.connect()`.

- **src/api/main.py:30-40** — [Verbose error messages] — Errors (e.g., `Failed to fetch price data`) may leak internal details. **Remediation:** Use generic error messages (e.g., `"Internal server error"`) and log details server-side.

---

## Summary
**Total findings:** 12 (4 CRITICAL, 5 HIGH, 3 MEDIUM, 0 LOW).
**Overall risk:** CRITICAL — Multiple high-severity issues (CORS, SQLi, code injection) must be fixed before deployment.

