/**
 * Memory Relevance Scorer
 *
 * Score memories by relevance to a query using:
 * 1. Recency     — newer memories score higher (exponential decay, ~30-day half-life)
 * 2. Frequency   — memories accessed more often score higher (normalised log)
 * 3. Keyword     — TF-IDF-like scoring against query terms (inverse-length weighting)
 * 4. Context     — memories from the same project/agent/session score higher
 *
 * Pure functions only — zero I/O, zero dependencies.
 */

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Tokenise a string into lowercase alpha-numeric tokens of length >= 2.
 * @param {string} text
 * @returns {string[]}
 */
function tokenise(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

// ─── Individual scoring components ──────────────────────────────────────────

/**
 * Recency score: exponential decay with ~30-day half-life.
 * Returns 1.0 for brand-new memories, approaching 0 for very old ones.
 *
 * @param {string|number|Date} timestamp - ISO string, epoch ms, or Date
 * @param {number} nowMs - current epoch ms (injectable for testing)
 * @returns {number} [0, 1]
 */
export function computeRecency(timestamp, nowMs = Date.now()) {
  if (timestamp == null) return 0;
  const createdAt = timestamp instanceof Date
    ? timestamp.getTime()
    : new Date(timestamp).getTime();
  if (Number.isNaN(createdAt)) return 0;
  const daysSince = Math.max(0, (nowMs - createdAt) / (1000 * 60 * 60 * 24));
  return Math.exp(-daysSince / 30);
}

/**
 * Frequency score: log-normalised access count relative to a max.
 * Both accessCount and maxAccessCount must be >= 0.
 *
 * @param {number} accessCount
 * @param {number} maxAccessCount - upper bound for normalisation (default 100)
 * @returns {number} [0, 1]
 */
export function computeFrequency(accessCount, maxAccessCount = 100) {
  const count = Math.max(0, Number(accessCount) || 0);
  const maxCount = Math.max(1, Number(maxAccessCount) || 100);
  return Math.min(1, Math.log(1 + count) / Math.log(1 + maxCount));
}

/**
 * Keyword match score: TF-IDF-like overlap between query tokens and memory content.
 * Rarer (longer) query words are weighted more heavily.
 *
 * @param {string} content - memory content
 * @param {string} query
 * @returns {number} [0, 1]
 */
export function computeKeywordMatch(content, query) {
  const queryTokens = tokenise(query);
  const contentTokens = tokenise(content);

  if (queryTokens.length === 0 || contentTokens.length === 0) return 0;

  const contentSet = new Set(contentTokens);

  // Weight each query token by its length (longer words are more specific)
  let weightedMatch = 0;
  let totalWeight = 0;

  for (const token of queryTokens) {
    // IDF proxy: weight proportional to token length (longer = rarer heuristic)
    const weight = Math.log(1 + token.length);
    totalWeight += weight;
    if (contentSet.has(token)) {
      weightedMatch += weight;
    }
  }

  if (totalWeight === 0) return 0;
  return weightedMatch / totalWeight;
}

/**
 * Context match score: bonus points for shared project / agent / session.
 *
 * @param {object} memory - memory object with optional projectId, agentId, sessionId
 * @param {object} context - { projectId?, agentId?, sessionId? }
 * @returns {number} [0, 1]
 */
export function computeContextMatch(memory, context = {}) {
  if (!memory || !context) return 0;

  let score = 0;

  if (context.projectId && memory.projectId &&
      context.projectId === memory.projectId) {
    score += 0.5;
  }

  if (context.agentId && memory.agentId &&
      context.agentId === memory.agentId) {
    score += 0.3;
  }

  if (context.sessionId && memory.sessionId &&
      context.sessionId === memory.sessionId) {
    score += 0.2;
  }

  // Cap at 1.0
  return Math.min(1, score);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Score a single memory object for relevance to a query + context.
 *
 * Expected memory shape (all fields optional except content):
 * {
 *   content:     string,
 *   timestamp:   string|number|Date,   // ISO or epoch ms
 *   accessCount: number,
 *   projectId:   string,
 *   agentId:     string,
 *   sessionId:   string,
 * }
 *
 * @param {object} memory
 * @param {string} query
 * @param {object} [context]   - { projectId?, agentId?, sessionId? }
 * @param {object} [opts]
 * @param {number} [opts.nowMs]            - override current time (for testing)
 * @param {number} [opts.maxAccessCount]   - normalisation ceiling for frequency
 * @returns {number} weighted relevance score in [0, 1]
 */
export function scoreMemory(memory, query, context = {}, opts = {}) {
  if (!memory) return 0;

  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const maxAccessCount = opts.maxAccessCount != null ? opts.maxAccessCount : 100;

  const recencyScore  = computeRecency(memory.timestamp, nowMs);
  const frequencyScore = computeFrequency(memory.accessCount || 0, maxAccessCount);
  const keywordScore  = computeKeywordMatch(memory.content || '', query);
  const contextScore  = computeContextMatch(memory, context);

  return (
    0.30 * recencyScore  +
    0.20 * frequencyScore +
    0.35 * keywordScore  +
    0.15 * contextScore
  );
}

/**
 * Rank an array of memories by relevance and return the top N.
 * Attaches a `relevanceScore` property to each returned object.
 *
 * @param {object[]} memories
 * @param {string}   query
 * @param {object}   [context]   - { projectId?, agentId?, sessionId? }
 * @param {number}   [maxResults=10]
 * @param {object}   [opts]      - forwarded to scoreMemory
 * @returns {object[]} sorted slice with relevanceScore attached
 */
export function rankMemories(memories, query, context = {}, maxResults = 10, opts = {}) {
  if (!Array.isArray(memories) || memories.length === 0) return [];

  return memories
    .map(m => ({ ...m, relevanceScore: scoreMemory(m, query, context, opts) }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, Math.max(1, maxResults));
}

/**
 * Derive the max accessCount from a collection of memories.
 * Useful for caller-side normalisation when passing opts.maxAccessCount.
 *
 * @param {object[]} memories
 * @returns {number}
 */
export function maxAccessCount(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return 0;
  return memories.reduce((max, m) => Math.max(max, m.accessCount || 0), 0);
}
