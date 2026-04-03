/**
 * Shared Playwright test helpers for all dashboard/vibe e2e specs.
 *
 * Usage in spec files:
 *   import { setupConsoleErrorCapture, expectNoConsoleErrors } from "./helpers.mjs";
 *
 *   test.beforeEach(async ({ page }) => {
 *     setupConsoleErrorCapture(page);
 *     // ... other setup
 *   });
 *
 *   test.afterEach(async () => {
 *     expectNoConsoleErrors();
 *   });
 */

import { expect } from "@playwright/test";

let _consoleErrors = [];

/**
 * Attach a listener that captures all console.error and console.warn messages
 * from the browser page. Call this in beforeEach.
 *
 * Ignored patterns:
 *  - Favicon 404s
 *  - Third-party resource loading failures
 *  - EventSource connection errors (SSE reconnect noise)
 */
const IGNORED_CONSOLE_PATTERNS = [
  /favicon\.ico/i,
  /ERR_CONNECTION_REFUSED/i,
  /net::ERR_/i,
  /EventSource/i,
  /Failed to load resource.*\/events/i,
  /ResizeObserver loop/i,
];

export function setupConsoleErrorCapture(page) {
  _consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      const isIgnored = IGNORED_CONSOLE_PATTERNS.some((re) => re.test(text));
      if (!isIgnored) {
        _consoleErrors.push(text);
      }
    }
  });

  // Also capture unhandled page errors (uncaught exceptions)
  page.on("pageerror", (err) => {
    const text = err.message || String(err);
    const isIgnored = IGNORED_CONSOLE_PATTERNS.some((re) => re.test(text));
    if (!isIgnored) {
      _consoleErrors.push(`[pageerror] ${text}`);
    }
  });
}

/**
 * Assert no unexpected console errors were captured during the test.
 * Call this in afterEach.
 */
export function expectNoConsoleErrors() {
  const errors = [..._consoleErrors];
  _consoleErrors = [];
  if (errors.length > 0) {
    expect.soft(errors, `Unexpected console errors:\n${errors.join("\n")}`).toHaveLength(0);
  }
}

/**
 * Get the captured console errors (for custom assertions).
 */
export function getConsoleErrors() {
  return [..._consoleErrors];
}

/**
 * Clear captured errors without asserting (use when errors are expected).
 */
export function clearConsoleErrors() {
  _consoleErrors = [];
}
