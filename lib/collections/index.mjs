/**
 * Generic Collections System — Universal RAG + Metadata Filtering
 * 
 * Wraps the existing TF-IDF search (crew-cli/src/collections/index.ts)
 * and adds SQLite persistence + structured metadata filtering.
 * 
 * Use cases:
 * - crewswarm: projects, documentation, tools, agent memory
 * - GrabLoco: venues, menu items, reviews
 * - Any structured data that needs semantic search + filters
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// Try to import better-sqlite3, but make it optional
let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch (e) {
  console.warn('[Collections] better-sqlite3 not available - RAG features disabled:', e.message);
  Database = null;
}
/**
 * Hash a string into a vector (simple feature hashing for cosine similarity)
 */
function toHashedVector(text, dim = 256) {
  const vec = new Float64Array(dim);
  const tokens = text.toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
  
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[Math.abs(h) % dim] += 1;
  }
  
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  
  return vec;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  const dim = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < dim; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Tokenize text for TF-IDF
 */
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Generic Collection with RAG search + metadata filtering
 */
export class Collection {
  constructor(dbPath, collectionName) {
    if (!Database) {
      throw new Error('better-sqlite3 not available - install with: npm install better-sqlite3');
    }
    
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    this.db = new Database(dbPath);
    this.name = collectionName;
    this.initSchema();
  }
  
  initSchema() {
    this.db.exec(`
      -- Generic items table (any structured data)
      CREATE TABLE IF NOT EXISTS collection_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_name TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      
      -- Pre-computed search index chunks
      CREATE TABLE IF NOT EXISTS collection_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        chunk_vector TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES collection_items(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_collection_name ON collection_items(collection_name);
      CREATE INDEX IF NOT EXISTS idx_item_tags ON collection_items(tags);
      CREATE INDEX IF NOT EXISTS idx_chunk_item ON collection_chunks(item_id);
    `);
  }
  
  /**
   * Add item to collection
   */
  add(item) {
    const { title, content, metadata = {}, tags = [] } = item;
    
    const result = this.db.prepare(`
      INSERT INTO collection_items (collection_name, title, content, metadata, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.name,
      title,
      content,
      JSON.stringify(metadata),
      JSON.stringify(tags),
      Date.now(),
      Date.now()
    );
    
    // Build search chunks
    this.indexItem(result.lastInsertRowid, content);
    
    return result.lastInsertRowid;
  }
  
  /**
   * Update item
   */
  update(id, updates) {
    const { title, content, metadata, tags } = updates;
    
    const fields = [];
    const params = [];
    
    if (title !== undefined) { fields.push('title = ?'); params.push(title); }
    if (content !== undefined) { fields.push('content = ?'); params.push(content); }
    if (metadata !== undefined) { fields.push('metadata = ?'); params.push(JSON.stringify(metadata)); }
    if (tags !== undefined) { fields.push('tags = ?'); params.push(JSON.stringify(tags)); }
    
    if (fields.length === 0) return;
    
    fields.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);
    
    this.db.prepare(`
      UPDATE collection_items SET ${fields.join(', ')} WHERE id = ?
    `).run(...params);
    
    // Re-index if content changed
    if (content !== undefined) {
      this.db.prepare('DELETE FROM collection_chunks WHERE item_id = ?').run(id);
      this.indexItem(id, content);
    }
  }
  
  /**
   * Delete item
   */
  delete(id) {
    this.db.prepare('DELETE FROM collection_items WHERE id = ?').run(id);
  }
  
  /**
   * Get item by ID
   */
  get(id) {
    const item = this.db.prepare(`
      SELECT * FROM collection_items WHERE id = ? AND collection_name = ?
    `).get(id, this.name);
    
    if (!item) return null;
    
    return {
      ...item,
      metadata: JSON.parse(item.metadata || '{}'),
      tags: JSON.parse(item.tags || '[]')
    };
  }
  
  /**
   * List all items (with pagination)
   */
  list(options = {}) {
    const { limit = 100, offset = 0, orderBy = 'updated_at', order = 'DESC' } = options;
    
    const items = this.db.prepare(`
      SELECT * FROM collection_items
      WHERE collection_name = ?
      ORDER BY ${orderBy} ${order}
      LIMIT ? OFFSET ?
    `).all(this.name, limit, offset);
    
    return items.map(item => ({
      ...item,
      metadata: JSON.parse(item.metadata || '{}'),
      tags: JSON.parse(item.tags || '[]')
    }));
  }
  
  /**
   * Count items
   */
  count() {
    return this.db.prepare(`
      SELECT COUNT(*) as count FROM collection_items WHERE collection_name = ?
    `).get(this.name).count;
  }
  
  /**
   * Search with TF-IDF + metadata filtering
   */
  search(query, filters = {}, limit = 10) {
    // Step 1: Apply metadata filters to get candidates
    let sql = `SELECT * FROM collection_items WHERE collection_name = ?`;
    const params = [this.name];
    
    // Tag filter
    if (filters.tags) {
      const tagList = Array.isArray(filters.tags) ? filters.tags : [filters.tags];
      for (const tag of tagList) {
        sql += ` AND tags LIKE ?`;
        params.push(`%"${tag}"%`);
      }
    }
    
    // Custom metadata filters
    if (filters.metadata) {
      for (const [key, value] of Object.entries(filters.metadata)) {
        if (Array.isArray(value)) {
          // Array contains check (e.g., dietary_options contains "vegan")
          sql += ` AND json_extract(metadata, ?) LIKE ?`;
          params.push(`$.${key}`, `%${value[0]}%`);
        } else {
          // Exact match
          sql += ` AND json_extract(metadata, ?) = ?`;
          params.push(`$.${key}`, value);
        }
      }
    }
    
    // Exclude filters (e.g., exclude_allergens)
    if (filters.exclude) {
      for (const [key, values] of Object.entries(filters.exclude)) {
        const valueList = Array.isArray(values) ? values : [values];
        for (const val of valueList) {
          sql += ` AND (json_extract(metadata, ?) IS NULL OR json_extract(metadata, ?) NOT LIKE ?)`;
          params.push(`$.${key}`, `$.${key}`, `%${val}%`);
        }
      }
    }
    
    const candidates = this.db.prepare(sql).all(...params);
    
    if (candidates.length === 0) {
      return [];
    }
    
    // Step 2: TF-IDF + Vector scoring
    const queryTokens = tokenize(query);
    const queryVector = toHashedVector(query);
    
    // Build term index from candidates
    const termIndex = new Map();
    const itemChunks = new Map();
    
    for (const item of candidates) {
      const chunks = this.db.prepare(`
        SELECT chunk_text, chunk_vector FROM collection_chunks WHERE item_id = ?
      `).all(item.id);
      
      itemChunks.set(item.id, chunks);
      
      for (const chunk of chunks) {
        const tokens = tokenize(chunk.chunk_text);
        for (const token of tokens) {
          if (!termIndex.has(token)) termIndex.set(token, []);
          termIndex.get(token).push({ itemId: item.id, chunk });
        }
      }
    }
    
    // Score each item
    const scores = new Map();
    const totalChunks = Array.from(itemChunks.values()).reduce((sum, chunks) => sum + chunks.length, 0);
    
    for (const token of queryTokens) {
      const matches = termIndex.get(token);
      if (!matches) continue;
      
      const idf = Math.log(1 + totalChunks / matches.length);
      
      for (const { itemId, chunk } of matches) {
        if (!scores.has(itemId)) {
          scores.set(itemId, { tfidf: 0, vector: 0, bestChunk: chunk.chunk_text });
        }
        scores.get(itemId).tfidf += idf;
        
        // Vector similarity
        const chunkVector = new Float64Array(JSON.parse(chunk.chunk_vector));
        const cosine = cosineSimilarity(queryVector, chunkVector);
        scores.get(itemId).vector = Math.max(scores.get(itemId).vector, cosine);
      }
    }
    
    // Hybrid scoring: 70% TF-IDF + 30% vector
    const maxTfidf = Math.max(...Array.from(scores.values()).map(s => s.tfidf), 1);
    
    const results = Array.from(scores.entries()).map(([itemId, score]) => {
      const item = candidates.find(c => c.id === itemId);
      const tfidfNorm = score.tfidf / maxTfidf;
      const hybridScore = (tfidfNorm * 0.7) + (score.vector * 0.3);
      
      return {
        ...item,
        metadata: JSON.parse(item.metadata || '{}'),
        tags: JSON.parse(item.tags || '[]'),
        score: Math.round(hybridScore * 1000) / 1000,
        matchedText: score.bestChunk.slice(0, 200)
      };
    });
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    return results.slice(0, limit);
  }
  
  /**
   * Re-index all items (rebuild search chunks)
   */
  reindex() {
    const items = this.list({ limit: 10000 });
    
    // Clear existing chunks
    this.db.prepare(`DELETE FROM collection_chunks WHERE item_id IN (
      SELECT id FROM collection_items WHERE collection_name = ?
    )`).run(this.name);
    
    // Re-index each item
    for (const item of items) {
      this.indexItem(item.id, item.content);
    }
    
    return items.length;
  }
  
  /**
   * Internal: Index an item's content for search
   */
  indexItem(itemId, content) {
    const chunks = this.chunkContent(content);
    
    const insert = this.db.prepare(`
      INSERT INTO collection_chunks (item_id, chunk_text, chunk_vector)
      VALUES (?, ?, ?)
    `);
    
    for (const chunk of chunks) {
      const vector = toHashedVector(chunk);
      insert.run(itemId, chunk, JSON.stringify(Array.from(vector)));
    }
  }
  
  /**
   * Internal: Split content into chunks
   */
  chunkContent(content) {
    // Split on double newlines (paragraphs) or every ~500 chars
    const paragraphs = content.split(/\n\n+/);
    const chunks = [];
    let current = '';
    
    for (const para of paragraphs) {
      if (current.length + para.length < 500) {
        current += (current ? '\n\n' : '') + para;
      } else {
        if (current) chunks.push(current.trim());
        current = para;
      }
    }
    
    if (current) chunks.push(current.trim());
    
    return chunks.filter(c => c.length > 20);
  }
  
  /**
   * Close database connection
   */
  close() {
    this.db.close();
  }
}

/**
 * Get default collections database path
 */
export function getCollectionsDbPath() {
  return join(homedir(), '.crewswarm', 'collections.db');
}

/**
 * Create a collection (convenience wrapper)
 */
export function createCollection(name, dbPath = null) {
  return new Collection(dbPath || getCollectionsDbPath(), name);
}
