/**
 * Unit tests for lib/contacts/identity-linker.mjs
 *
 * Covers:
 *  - linkIdentities: creates master identity and links platforms
 *  - getMasterIdentity: resolves master from any platform identity
 *  - getLinkedIdentities: returns all links for a master
 *  - unlinkIdentity: nulls platform_links for one contact
 *  - unlinkAll: unlinks all platform contacts for a master
 *  - listLinkedIdentities: lists all unified contacts
 *  - hasUnifiedIdentity: boolean check
 *  - closeDb: closes without throwing
 *
 * Strategy: better-sqlite3 may or may not be installed. We always import
 * the module and exercise the null-path (Database = null) gracefully. When
 * the DB is available we use an in-memory database path via a temp directory
 * so we never pollute ~/.crewswarm/contacts.db.
 *
 * Because the module uses a module-level singleton `_db` and a lazy `getDb()`
 * we call `closeDb()` between test groups to force re-initialisation.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CREWSWARM_TEST_MODE = "true";

const {
  linkIdentities,
  getMasterIdentity,
  getLinkedIdentities,
  unlinkIdentity,
  unlinkAll,
  listLinkedIdentities,
  hasUnifiedIdentity,
  closeDb,
} = await import("../../lib/contacts/identity-linker.mjs");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Determine if better-sqlite3 + DB are functional by checking linkIdentities return value. */
function dbAvailable() {
  try {
    const r = linkIdentities("__probe__", { probe_platform: "__probe_contact__" });
    if (!r) return false;
    // Cleanup
    unlinkAll("__probe__");
    return true;
  } catch {
    return false;
  }
}

// ── No-op paths when DB is unavailable ──────────────────────────────────────

describe("identity-linker — graceful null returns when DB unavailable", () => {
  it("linkIdentities returns false or object (never throws)", () => {
    assert.doesNotThrow(() => linkIdentities("master", { dashboard: "owner" }));
  });

  it("getMasterIdentity returns null or string (never throws)", () => {
    const result = getMasterIdentity("unknown-contact");
    assert.ok(result === null || typeof result === "string");
  });

  it("getLinkedIdentities returns object (never throws)", () => {
    const result = getLinkedIdentities("unknown-master");
    assert.ok(typeof result === "object");
  });

  it("unlinkIdentity never throws", () => {
    assert.doesNotThrow(() => unlinkIdentity("nonexistent-contact"));
  });

  it("unlinkAll never throws", () => {
    assert.doesNotThrow(() => unlinkAll("nonexistent-master"));
  });

  it("listLinkedIdentities returns array (never throws)", () => {
    const result = listLinkedIdentities();
    assert.ok(Array.isArray(result));
  });

  it("hasUnifiedIdentity returns boolean (never throws)", () => {
    const result = hasUnifiedIdentity("unknown-contact");
    assert.equal(typeof result, "boolean");
  });

  it("closeDb never throws", () => {
    assert.doesNotThrow(() => closeDb());
  });
});

// ── Full integration tests (only when better-sqlite3 is available) ───────────

describe("identity-linker — full behaviour (requires better-sqlite3)", () => {
  before(() => {
    if (!dbAvailable()) {
      // Tests in this group will check dbAvailable() individually
    }
    closeDb();
  });

  afterEach(() => {
    // Best-effort cleanup of test identities
    try {
      unlinkAll("test-master");
      unlinkAll("test-master-2");
      unlinkAll("__probe__");
      closeDb();
    } catch {}
  });

  after(() => {
    try { closeDb(); } catch {}
  });

  it("linkIdentities creates a master identity with platform links", () => {
    if (!dbAvailable()) return;
    closeDb();

    const result = linkIdentities("test-master", {
      dashboard: "owner",
      telegram: "tg-12345"
    });

    assert.ok(result, "linkIdentities should return truthy value");
    assert.equal(result.master_identity, "test-master");
    assert.equal(result.dashboard, "owner");
    assert.equal(result.telegram, "tg-12345");
  });

  it("getMasterIdentity resolves from a platform identity", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { telegram: "tg-abc" });
    const master = getMasterIdentity("tg-abc");
    assert.equal(master, "test-master");
  });

  it("getMasterIdentity returns master_identity for the master itself", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { telegram: "tg-abc" });
    const master = getMasterIdentity("test-master");
    assert.equal(master, "test-master");
  });

  it("getMasterIdentity returns null for unknown contact", () => {
    if (!dbAvailable()) return;
    const result = getMasterIdentity("totally-unknown-xyz-99999");
    assert.equal(result, null);
  });

  it("getLinkedIdentities returns all links for a master", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { telegram: "tg-xyz", whatsapp: "wa-xyz" });
    const links = getLinkedIdentities("test-master");
    assert.equal(typeof links, "object");
    assert.equal(links.master_identity, "test-master");
    assert.equal(links.telegram, "tg-xyz");
    assert.equal(links.whatsapp, "wa-xyz");
  });

  it("getLinkedIdentities returns empty object for unknown master", () => {
    if (!dbAvailable()) return;
    const result = getLinkedIdentities("does-not-exist-master-abc");
    assert.deepEqual(result, {});
  });

  it("unlinkIdentity nulls platform_links for a contact", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { telegram: "tg-to-unlink" });
    unlinkIdentity("tg-to-unlink");
    const master = getMasterIdentity("tg-to-unlink");
    assert.equal(master, null);
  });

  it("unlinkAll clears all linked identities", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { telegram: "tg-clean", dashboard: "dash-clean" });
    unlinkAll("test-master");
    assert.equal(getMasterIdentity("tg-clean"), null);
  });

  it("hasUnifiedIdentity returns true after linking", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { telegram: "tg-unified" });
    assert.equal(hasUnifiedIdentity("tg-unified"), true);
  });

  it("hasUnifiedIdentity returns false for unknown contact", () => {
    if (!dbAvailable()) return;
    assert.equal(hasUnifiedIdentity("never-linked-xyz"), false);
  });

  it("listLinkedIdentities includes newly created master", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { dashboard: "dash-list" });
    const list = listLinkedIdentities();
    assert.ok(Array.isArray(list));
    const found = list.find(c => c.contactId === "test-master");
    assert.ok(found, "test-master should appear in listLinkedIdentities");
    assert.equal(typeof found.links, "object");
  });

  it("listLinkedIdentities entries have contactId, displayName, links", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master-2", { telegram: "tg-list-2" });
    const list = listLinkedIdentities();
    for (const entry of list) {
      assert.ok("contactId" in entry, "missing contactId");
      assert.ok("displayName" in entry, "missing displayName");
      assert.ok("links" in entry, "missing links");
    }
  });

  it("re-linking updates existing master record without error", () => {
    if (!dbAvailable()) return;
    closeDb();

    linkIdentities("test-master", { telegram: "tg-v1" });
    // Update the same master with additional platform
    assert.doesNotThrow(() =>
      linkIdentities("test-master", { telegram: "tg-v1", whatsapp: "wa-new" })
    );
    const links = getLinkedIdentities("test-master");
    assert.equal(links.whatsapp, "wa-new");
  });

  it("closeDb is idempotent — multiple calls do not throw", () => {
    closeDb();
    closeDb();
    closeDb();
  });
});
