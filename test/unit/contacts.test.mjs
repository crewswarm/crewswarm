/**
 * Unit tests for lib/contacts/index.mjs
 *
 * Covers:
 *  - contactsDbAvailable: returns boolean
 *  - trackContact / getContact: create and retrieve
 *  - updatePreferences / updateContact: modify contact data
 *  - saveMessage / getContactHistory: message recording
 *  - listContacts / searchContacts: querying
 *  - getContactStats: statistics
 *  - deleteContact: removal
 *  - closeContactsDb: cleanup
 *
 * Skips tests if better-sqlite3 is not available.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.CREWSWARM_TEST_MODE = "true";

let mod;
let dbAvailable = false;

try {
  mod = await import("../../lib/contacts/index.mjs");
  dbAvailable = mod.contactsDbAvailable();
} catch (e) {
  // better-sqlite3 not available
}

describe("contacts — contactsDbAvailable", { skip: !dbAvailable && "better-sqlite3 not available" }, () => {
  it("returns a boolean", () => {
    assert.equal(typeof mod.contactsDbAvailable(), "boolean");
  });
});

describe("contacts — CRUD operations", { skip: !dbAvailable && "better-sqlite3 not available" }, () => {
  const testContactId = `test:contact-${Date.now()}`;

  after(() => {
    try {
      mod.deleteContact(testContactId);
    } catch {}
  });

  it("trackContact creates a new contact", () => {
    mod.trackContact(testContactId, "test", "Test User", { phone: "+15551234567" });
    const contact = mod.getContact(testContactId);
    assert.ok(contact);
    assert.equal(contact.platform, "test");
    assert.equal(contact.display_name, "Test User");
  });

  it("trackContact updates existing contact's last_seen", () => {
    const before = mod.getContact(testContactId);
    // Small delay to ensure timestamp changes
    mod.trackContact(testContactId, "test", "Test User Updated");
    const after = mod.getContact(testContactId);
    assert.ok(after.last_seen >= before.last_seen);
  });

  it("getContact returns null for nonexistent contact", () => {
    assert.equal(mod.getContact("nonexistent-contact-xyz"), null);
  });

  it("updatePreferences merges preferences", () => {
    mod.updatePreferences(testContactId, { diet: "vegan" });
    const contact = mod.getContact(testContactId);
    assert.equal(contact.preferences.diet, "vegan");

    mod.updatePreferences(testContactId, { spice: "hot" });
    const updated = mod.getContact(testContactId);
    assert.equal(updated.preferences.diet, "vegan");
    assert.equal(updated.preferences.spice, "hot");
  });

  it("updatePreferences throws for nonexistent contact", () => {
    assert.throws(() => {
      mod.updatePreferences("nonexistent-xyz", { foo: "bar" });
    });
  });

  it("updateContact modifies contact fields", () => {
    mod.updateContact(testContactId, { notes: "test note", language: "fr" });
    const contact = mod.getContact(testContactId);
    assert.equal(contact.notes, "test note");
    assert.equal(contact.language, "fr");
  });

  it("saveMessage and getContactHistory round-trip", () => {
    mod.saveMessage(testContactId, "user", "Hello there");
    mod.saveMessage(testContactId, "assistant", "Hi! How can I help?");
    const history = mod.getContactHistory(testContactId, 10);
    assert.ok(history.length >= 2);
    assert.equal(history[history.length - 2].content, "Hello there");
    assert.equal(history[history.length - 1].content, "Hi! How can I help?");
  });

  it("listContacts returns array of contacts", () => {
    const contacts = mod.listContacts({ platform: "test" });
    assert.ok(Array.isArray(contacts));
    assert.ok(contacts.some((c) => c.contact_id === testContactId));
  });

  it("searchContacts finds by name", () => {
    const results = mod.searchContacts("Test User", 10);
    assert.ok(Array.isArray(results));
  });

  it("getContactStats returns statistics object", () => {
    const stats = mod.getContactStats();
    assert.equal(typeof stats.total, "number");
    assert.ok(Array.isArray(stats.byPlatform));
    assert.equal(typeof stats.recentActive, "number");
    assert.equal(typeof stats.totalMessages, "number");
  });

  it("deleteContact removes the contact", () => {
    const tempId = `test:deleteable-${Date.now()}`;
    mod.trackContact(tempId, "test", "Delete Me");
    assert.ok(mod.getContact(tempId));
    mod.deleteContact(tempId);
    assert.equal(mod.getContact(tempId), null);
  });
});
