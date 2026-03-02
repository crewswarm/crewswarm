# crew-cli Worker Prompts — Enhanced Standards

**Date:** 2026-03-02  
**Status:** ✅ Complete — Wired + Beefed Up

---

## What Was Added

Enhanced `crew-cli/src/prompts/registry.ts` with production-grade standards from the main repo's `~/.crewswarm/agent-prompts.json` (55KB, 32 specialized prompts).

### Templates Enhanced

1. **`executor-code-v1`** (General Coder)
   - ✅ Error handling standards: try/catch, guard nulls, validate inputs
   - ✅ Code quality rules: small functions, clear names, no dead code
   - ✅ Workflow: surgical edits, match existing patterns
   - ✅ Pre-completion checks: unclosed brackets, missing imports, mental trace

2. **`specialist-frontend-v1`** (UI/UX)
   - ✅ Apple/Linear/Vercel design standards (non-negotiable)
   - ✅ 8px grid system
   - ✅ Typography scale: 16-18px body, 1.5 line-height, weight hierarchy
   - ✅ Spacing: 48-96px sections, generous padding
   - ✅ Motion: 200-300ms ease-out, prefers-reduced-motion
   - ✅ Layout: mobile-first (640/768/1024/1280px), max-width 1200px
   - ✅ Components: 8-12px corners, soft shadows, no hard borders
   - ✅ Accessibility: semantic HTML, focus-visible, 4.5:1 contrast

3. **`specialist-backend-v1`** (API/Server)
   - ✅ ES modules, async/await, no callbacks
   - ✅ Endpoint standards: validation, error handling, proper HTTP codes
   - ✅ Database: parameterized queries, connection pooling, transactions
   - ✅ Auth: bcrypt/argon2 for passwords, JWT + refresh tokens
   - ✅ Logging: structured JSON, request ID, timestamp, level
   - ✅ Config: env vars only, validate at startup

4. **`specialist-qa-v1`** (Testing)
   - ✅ Test strategy: happy path + 3 edge cases minimum
   - ✅ Checklist: functionality, input validation, error handling, security (OWASP), performance
   - ✅ Output format: CRITICAL/HIGH/MEDIUM/LOW with exact line numbers and fixes
   - ✅ Verdict: PASS / PASS WITH WARNINGS / FAIL (CRITICAL = auto-FAIL)

5. **`specialist-security-v1`** (Audits)
   - ✅ OWASP Top 10 checklist
   - ✅ Secrets: hardcoded keys, .env committed, secrets in logs
   - ✅ Injection: SQL, XSS, command injection, path traversal (with specific checks)
   - ✅ Auth: missing checks, broken sessions, privilege escalation, CORS
   - ✅ Data: plaintext passwords, sensitive data in URLs, missing rate limiting
   - ✅ Output: severity + file:line + remediation

6. **`specialist-pm-v1`** (Planning)
   - ✅ Task principles: independently deliverable, imperative form
   - ✅ Format: "Create X in /path → agent | AC: done means Y"
   - ✅ Size: 1-2 min completable, split if bigger
   - ✅ Always include: agent assignment, file paths, acceptance criteria

---

## Before → After Comparison

### Before (Generic)
```typescript
basePrompt: `You are a frontend and UX specialist.

Deliver high-quality UI implementation with:
- accessible semantics and keyboard support
- responsive layouts across desktop/mobile
- clear visual hierarchy and interaction states
- maintainable component structure

Return concrete code-oriented guidance or edits.`
```

### After (Beefed Up)
```typescript
basePrompt: `You are a frontend specialist. Every UI you produce must meet Apple/Linear/Vercel-level polish.

## Design Standards (Non-Negotiable)
- Typography: system font stack or Inter. 16-18px body, 1.5 line-height. Weight hierarchy (400/500/600/700).
- Spacing: 8px grid. Generous section padding (48-96px). Content breathes.
- Color: muted neutrals + one accent. Dark mode via CSS custom properties. No pure black (#000).
- Motion: 200-300ms ease-out. Fade + slight translate for reveals. Respect prefers-reduced-motion.
- Layout: mobile-first (640/768/1024/1280px), CSS Grid + Flexbox, max-width 1200px.
- Components: rounded corners (8-12px), soft layered shadows, no hard borders.
- Accessibility: semantic HTML, focus-visible, 4.5:1 contrast, aria-labels.

## Rules
- Match existing design system when present
- If none exists, establish CSS custom properties (--color-*, --space-*, --radius-*)
- Mobile-first breakpoints (375px, 768px, 1440px must all look intentional)
- Format code in markdown blocks.

Return production-ready code with proper HTML semantics and CSS structure.`
```

---

## What This Fixes

### Problem
Workers were using generic prompts like "deliver high-quality UI" with no concrete standards. Frontend tasks got mediocre output because the worker had no design DNA.

### Solution
Each specialist template now contains:
1. **Specific standards** (8px grid, OWASP checklist, HTTP status codes)
2. **Concrete rules** (no pure black, parameterized queries only, 1-2 min task size)
3. **Output format** (markdown code blocks, severity levels, acceptance criteria)
4. **Quality gates** (mental trace, 3 edge cases, CRITICAL = auto-FAIL)

---

## Testing

```bash
# 1. Verify build contains enhanced content
cd crew-cli
grep -o "Apple/Linear/Vercel" dist/crew.mjs  # Should print: Apple/Linear/Vercel
grep -o "OWASP Top 10" dist/crew.mjs         # Should print: OWASP Top 10 (2x)
grep -o "8px grid" dist/crew.mjs              # Should print: 8px grid

# 2. Run a frontend task to verify specialization
cd ..
node crew-cli/dist/crew.mjs run "Create a dark-theme landing page with hero section" --trace

# Expected worker output should mention:
# - 8px grid system
# - Apple/Linear design standards
# - CSS custom properties (--color-*)
# - 200-300ms ease-out transitions
# - Mobile-first breakpoints

# 3. Test security audit
node crew-cli/dist/crew.mjs run "Review this auth endpoint for vulnerabilities: /api/login" --persona crew-security --trace

# Expected output should include:
# - OWASP Top 10 checklist
# - SQL injection check
# - XSS check
# - Rate limiting check
```

**Real-world proof:** When a worker executes, `unified.ts` line 1122-1123 extracts the `basePrompt` and passes it as `systemPrompt` to the LLM API call. The enhanced standards are injected into the system message.

---

## Next Steps (Optional)

1. **Add More Specialists**
   - crew-architect: infrastructure standards, ADR format
   - crew-seo: schema.org types, Core Web Vitals targets
   - crew-copywriter: voice/tone rules, no-buzzword list

2. **Expand Existing Templates**
   - Frontend: add Lucide icons preference, no Font Awesome rule
   - Backend: add specific rate limiting thresholds (e.g., 5 req/min auth)
   - Security: add CVE lookup workflow, penetration test checklist

3. **Allow Per-Agent Overrides**
   - Let individual agents in `crewswarm.json` override `basePrompt` for one-off customization without editing registry

---

## Files Changed

- `crew-cli/src/prompts/registry.ts` — 6 templates enhanced
- `crew-cli/dist/crew.mjs` — rebuilt

## Before You Deploy

```bash
# Quick sanity check: verify enhanced content is in the build
cd crew-cli
grep -c "Apple/Linear" dist/crew.mjs  # Should be > 0
grep -c "OWASP" dist/crew.mjs         # Should be > 0
grep -c "8px grid" dist/crew.mjs      # Should be > 0

# All 3 should return count > 0, confirming beefed-up templates are compiled
```

**How it works:**
1. Worker execution hits `src/pipeline/unified.ts` line 1122
2. Extracts `basePrompt` from `PROMPT_TEMPLATES[templateId]`
3. Passes it as `systemPrompt` to `LocalExecutor.execute()` (line 1131)
4. LLM receives specialized prompt as system message

---

**Status:** ✅ Wired. ✅ Beefed up. ✅ Rebuilt. Ready for real tasks.
