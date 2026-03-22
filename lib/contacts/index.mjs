/**
 * Universal Contacts System — User Profiles Across All Platforms
 * 
 * Replaces user_profiles with a unified contacts database that works for:
 * - crewswarm: Team members, work preferences, communication style
 * - GrabLoco: Customers, food preferences, allergies, favorite venues
 * 
 * Platform-agnostic: WhatsApp, Telegram, Slack, Web, iOS all use same schema
 */

import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const require = createRequire(import.meta.url);

// Try to import better-sqlite3, but make it optional
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[Contacts] better-sqlite3 not available - contacts DB disabled');
  Database = null;
}

let _db = null;

function contactsDbAvailable() {
  return Boolean(Database);
}

function getDb() {
  if (!Database) {
    throw new Error('better-sqlite3 not available - install with: npm install better-sqlite3');
  }
  
  if (_db) return _db;
  
  const dbPath = join(homedir(), '.crewswarm', 'contacts.db');
  const dir = dirname(dbPath);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  _db = new Database(dbPath);
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- Universal contacts table (replaces user_profiles)
    CREATE TABLE IF NOT EXISTS contacts (
      contact_id TEXT PRIMARY KEY,        -- "whatsapp:13109050857@s.whatsapp.net"
      platform TEXT NOT NULL,             -- "whatsapp", "telegram", "slack", "web"
      display_name TEXT,                  -- "STOS", "Jeff"
      phone_number TEXT,                  -- "+13109050857"
      email TEXT,
      avatar_url TEXT,
      preferences TEXT,                   -- JSON: domain-specific preferences
      tags TEXT,                          -- JSON: ["vip", "developer", "vegan"]
      notes TEXT,                         -- Admin notes
      platform_links TEXT,                -- JSON: {"whatsapp":"jid","telegram":"chatId"}
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      message_count INTEGER DEFAULT 0,
      last_location TEXT,                 -- Optional: last known city/region
      timezone TEXT,                      -- Optional: "America/Los_Angeles"
      language TEXT DEFAULT 'en'          -- Optional: "en", "es", "fr"
    );
    
    -- Message history (separate from chat history for analytics)
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id TEXT NOT NULL,
      role TEXT NOT NULL,                 -- "user" or "assistant"
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      session_id TEXT,                    -- Optional: link to chat session
      FOREIGN KEY(contact_id) REFERENCES contacts(contact_id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_contact_platform ON contacts(platform);
    CREATE INDEX IF NOT EXISTS idx_contact_last_seen ON contacts(last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_message_contact ON contact_messages(contact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_message_timestamp ON contact_messages(timestamp DESC);
  `);
}

/**
 * Track a contact (create or update last_seen)
 */
export function trackContact(contactId, platform, displayName = null, metadata = {}) {
  if (!contactsDbAvailable()) return null;
  const db = getDb();
  
  const existing = db.prepare('SELECT * FROM contacts WHERE contact_id = ?').get(contactId);
  
  if (existing) {
    // Update last_seen and message_count
    db.prepare(`
      UPDATE contacts 
      SET last_seen = ?, message_count = message_count + 1, display_name = COALESCE(?, display_name)
      WHERE contact_id = ?
    `).run(Date.now(), displayName, contactId);
  } else {
    // Create new contact
    db.prepare(`
      INSERT INTO contacts (
        contact_id, platform, display_name, phone_number, email, 
        preferences, tags, first_seen, last_seen, message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      contactId,
      platform,
      displayName || contactId,
      metadata.phone || null,
      metadata.email || null,
      JSON.stringify({}),
      JSON.stringify([]),
      Date.now(),
      Date.now()
    );
  }
}

/**
 * Get contact by ID
 */
export function getContact(contactId) {
  if (!contactsDbAvailable()) return null;
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE contact_id = ?').get(contactId);
  
  if (!contact) return null;
  
  return {
    ...contact,
    preferences: JSON.parse(contact.preferences || '{}'),
    tags: JSON.parse(contact.tags || '[]'),
    platform_links: JSON.parse(contact.platform_links || '{}')
  };
}

/**
 * Update contact preferences
 */
export function updatePreferences(contactId, preferences) {
  if (!contactsDbAvailable()) return false;
  const db = getDb();
  const existing = getContact(contactId);
  
  if (!existing) {
    throw new Error(`Contact ${contactId} not found`);
  }
  
  const merged = { ...existing.preferences, ...preferences };
  
  db.prepare(`
    UPDATE contacts SET preferences = ?, last_seen = ? WHERE contact_id = ?
  `).run(JSON.stringify(merged), Date.now(), contactId);
}

/**
 * Update contact metadata
 */
export function updateContact(contactId, updates) {
  if (!contactsDbAvailable()) return false;
  const db = getDb();
  const fields = [];
  const params = [];
  
  if (updates.display_name !== undefined) { fields.push('display_name = ?'); params.push(updates.display_name); }
  if (updates.phone_number !== undefined) { fields.push('phone_number = ?'); params.push(updates.phone_number); }
  if (updates.email !== undefined) { fields.push('email = ?'); params.push(updates.email); }
  if (updates.avatar_url !== undefined) { fields.push('avatar_url = ?'); params.push(updates.avatar_url); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); params.push(updates.notes); }
  if (updates.last_location !== undefined) { fields.push('last_location = ?'); params.push(updates.last_location); }
  if (updates.timezone !== undefined) { fields.push('timezone = ?'); params.push(updates.timezone); }
  if (updates.language !== undefined) { fields.push('language = ?'); params.push(updates.language); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }
  if (updates.platform_links !== undefined) { fields.push('platform_links = ?'); params.push(JSON.stringify(updates.platform_links)); }
  if (updates.preferences !== undefined) { fields.push('preferences = ?'); params.push(JSON.stringify(updates.preferences)); }
  
  if (fields.length === 0) return;
  
  params.push(contactId);
  
  db.prepare(`
    UPDATE contacts SET ${fields.join(', ')} WHERE contact_id = ?
  `).run(...params);
}

/**
 * Save message to contact history
 */
export function saveMessage(contactId, role, content, sessionId = null) {
  if (!contactsDbAvailable()) return false;
  const db = getDb();
  
  db.prepare(`
    INSERT INTO contact_messages (contact_id, role, content, timestamp, session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(contactId, role, content, Date.now(), sessionId);
  
  // Update message count
  db.prepare(`
    UPDATE contacts SET message_count = message_count + 1, last_seen = ? WHERE contact_id = ?
  `).run(Date.now(), contactId);
}

/**
 * Get contact message history
 */
export function getContactHistory(contactId, limit = 100) {
  if (!contactsDbAvailable()) return [];
  const db = getDb();
  
  const messages = db.prepare(`
    SELECT role, content, timestamp, session_id
    FROM contact_messages
    WHERE contact_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(contactId, limit);
  
  return messages.reverse(); // Return chronological order
}

/**
 * List all contacts
 */
export function listContacts(filters = {}) {
  if (!contactsDbAvailable()) return [];
  const db = getDb();
  
  let sql = 'SELECT * FROM contacts WHERE 1=1';
  const params = [];
  
  if (filters.platform) {
    sql += ' AND platform = ?';
    params.push(filters.platform);
  }
  
  if (filters.tags) {
    sql += ' AND tags LIKE ?';
    params.push(`%"${filters.tags}"%`);
  }
  
  if (filters.search) {
    sql += ' AND (display_name LIKE ? OR phone_number LIKE ? OR email LIKE ?)';
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }
  
  sql += ' ORDER BY last_seen DESC';
  
  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  
  const contacts = db.prepare(sql).all(...params);
  
  return contacts.map(c => ({
    ...c,
    preferences: JSON.parse(c.preferences || '{}'),
    tags: JSON.parse(c.tags || '[]'),
    platform_links: JSON.parse(c.platform_links || '{}')
  }));
}

/**
 * Search contacts by name or phone
 */
export function searchContacts(query, limit = 20) {
  return listContacts({ search: query, limit });
}

/**
 * Get contacts by platform
 */
export function getContactsByPlatform(platform, limit = 100) {
  return listContacts({ platform, limit });
}

/**
 * Get contact stats
 */
export function getContactStats() {
  if (!contactsDbAvailable()) {
    return { total: 0, byPlatform: [], recentActive: 0, totalMessages: 0 };
  }
  const db = getDb();
  
  const total = db.prepare('SELECT COUNT(*) as count FROM contacts').get().count;
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM contacts
    GROUP BY platform
  `).all();
  
  const recentActive = db.prepare(`
    SELECT COUNT(*) as count
    FROM contacts
    WHERE last_seen > ?
  `).get(Date.now() - (7 * 24 * 60 * 60 * 1000)).count; // Last 7 days
  
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM contact_messages').get().count;
  
  return {
    total,
    byPlatform,
    recentActive,
    totalMessages
  };
}

/**
 * Delete contact and all their messages
 */
export function deleteContact(contactId) {
  if (!contactsDbAvailable()) return false;
  const db = getDb();
  db.prepare('DELETE FROM contacts WHERE contact_id = ?').run(contactId);
  return true;
}

/**
 * Close database connection
 */
export function closeContactsDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export { contactsDbAvailable };
