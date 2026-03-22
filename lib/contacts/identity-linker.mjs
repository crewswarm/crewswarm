/**
 * Identity Linker — Link Multiple Platform Identities to a Master Identity
 * 
 * Enables unified conversation history across WhatsApp, Telegram, Dashboard, etc.
 * All your platform identities link to one master identity (e.g., "owner").
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// Try to import better-sqlite3, but make it optional
let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch (e) {
  console.warn('[Identity Linker] better-sqlite3 not available - identity linking disabled');
  Database = null;
}

let _db = null;

function getDb() {
  if (!Database) {
    return null; // Silent fail - identity linking disabled
  }
  
  if (_db) return _db;
  
  const dbPath = join(homedir(), '.crewswarm', 'contacts.db');
  const dir = dirname(dbPath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true});
  }
  
  _db = new Database(dbPath);
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  // Schema already created by lib/contacts/index.mjs
  // Just ensure platform_links column exists (added in migration)
  try {
    db.exec(`
      ALTER TABLE contacts ADD COLUMN platform_links TEXT;
    `);
  } catch (e) {
    // Column already exists, ignore
  }
}

/**
 * Link multiple platform identities to a master identity
 * @param {string} masterIdentity - "owner", "jeff", etc.
 * @param {Object} links - { dashboard: "owner", telegram: "...", whatsapp: "..." }
 */
export function linkIdentities(masterIdentity, links) {
  const db = getDb();
  if (!db) return false; // Identity linking unavailable

  // Build platform_links object
  const platformLinks = {
    master_identity: masterIdentity,
    ...links
  };
  
  // Create or update master identity contact
  const existing = db.prepare('SELECT * FROM contacts WHERE contact_id = ?').get(masterIdentity);
  
  if (existing) {
    db.prepare(`
      UPDATE contacts 
      SET platform_links = ?, last_seen = ?
      WHERE contact_id = ?
    `).run(
      JSON.stringify(platformLinks),
      Date.now(),
      masterIdentity
    );
  } else {
    db.prepare(`
      INSERT INTO contacts (
        contact_id, platform, display_name, platform_links, 
        first_seen, last_seen, message_count, preferences, tags
      ) VALUES (?, 'unified', ?, ?, ?, ?, 0, '{}', '[]')
    `).run(
      masterIdentity,
      masterIdentity,
      JSON.stringify(platformLinks),
      Date.now(),
      Date.now()
    );
  }
  
  // Update each linked platform identity to point back to master
  for (const [platform, contactId] of Object.entries(links)) {
    if (platform === 'master_identity') continue;
    
    const linkedContact = db.prepare('SELECT * FROM contacts WHERE contact_id = ?').get(contactId);
    
    if (linkedContact) {
      db.prepare(`
        UPDATE contacts 
        SET platform_links = ?, last_seen = ?
        WHERE contact_id = ?
      `).run(
        JSON.stringify({ master_identity: masterIdentity }),
        Date.now(),
        contactId
      );
    } else {
      // Create contact if it doesn't exist
      db.prepare(`
        INSERT INTO contacts (
          contact_id, platform, display_name, platform_links, 
          first_seen, last_seen, message_count, preferences, tags
        ) VALUES (?, ?, ?, ?, ?, ?, 0, '{}', '[]')
      `).run(
        contactId,
        platform,
        contactId,
        JSON.stringify({ master_identity: masterIdentity }),
        Date.now(),
        Date.now()
      );
    }
  }
  
  return platformLinks;
}

/**
 * Get master identity for any platform identity
 * @param {string} contactId - Any platform identity
 * @returns {string|null} Master identity or null if not linked
 */
export function getMasterIdentity(contactId) {
  const db = getDb();
  if (!db) return null; // Identity linking unavailable
  
  const contact = db.prepare('SELECT platform_links FROM contacts WHERE contact_id = ?').get(contactId);
  
  if (!contact?.platform_links) return null;
  
  try {
    const links = JSON.parse(contact.platform_links);
    return links.master_identity || null;
  } catch {
    return null;
  }
}

/**
 * Get all linked identities for a master identity
 * @param {string} masterIdentity - Master identity
 * @returns {Object} All platform links
 */
export function getLinkedIdentities(masterIdentity) {
  const db = getDb();
  if (!db) return {}; // Identity linking unavailable
  
  const contact = db.prepare('SELECT platform_links FROM contacts WHERE contact_id = ?').get(masterIdentity);
  
  if (!contact?.platform_links) return {};
  
  try {
    return JSON.parse(contact.platform_links);
  } catch {
    return {};
  }
}

/**
 * Unlink a specific platform from master identity
 * @param {string} contactId - Platform identity to unlink
 */
export function unlinkIdentity(contactId) {
  const db = getDb();
  if (!db) return false; // Identity linking unavailable

  db.prepare(`
    UPDATE contacts
    SET platform_links = NULL
    WHERE contact_id = ?
  `).run(contactId);
}

/**
 * Unlink all identities from a master identity
 * @param {string} masterIdentity - Master identity
 */
export function unlinkAll(masterIdentity) {
  const db = getDb();
  if (!db) return false; // Identity linking unavailable
  
  const links = getLinkedIdentities(masterIdentity);
  
  // Unlink all platform identities
  for (const contactId of Object.values(links)) {
    if (contactId === masterIdentity) continue;
    unlinkIdentity(contactId);
  }
  
  // Unlink master
  unlinkIdentity(masterIdentity);
}

/**
 * List all master identities (users with linked accounts)
 * @returns {Array} List of master identities with their links
 */
export function listLinkedIdentities() {
  const db = getDb();
  if (!db) return []; // Identity linking unavailable

  const contacts = db.prepare(`
    SELECT contact_id, display_name, platform_links
    FROM contacts
    WHERE platform = 'unified' OR (platform_links IS NOT NULL AND platform_links != '{}')
  `).all();
  
  return contacts.map(c => ({
    contactId: c.contact_id,
    displayName: c.display_name,
    links: c.platform_links ? JSON.parse(c.platform_links) : {}
  }));
}

/**
 * Check if a contact has unified identity enabled
 * @param {string} contactId - Any platform identity or master identity
 * @returns {boolean}
 */
export function hasUnifiedIdentity(contactId) {
  return getMasterIdentity(contactId) !== null;
}

/**
 * Close database connection
 */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
