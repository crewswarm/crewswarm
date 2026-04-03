/**
 * Local Semantic Code Search
 * Uses ripgrep + smart ranking for semantic codebase understanding
 * Zero external dependencies, 100% local, instant results
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Extract meaningful keywords from natural language query
 */
function extractKeywords(query) {
  const stopwords = new Set([
    'how', 'does', 'what', 'where', 'when', 'why', 'the', 'is', 'are',
    'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'this', 'that', 'these', 'those', 'a', 'an', 'and', 'or', 'but'
  ]);
  
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopwords.has(word))
    .slice(0, 5); // Top 5 keywords
}

/**
 * Parse ripgrep JSON output
 */
function parseRipgrepJson(output) {
  if (!output || !output.trim()) return [];
  
  const matches = [];
  const lines = output.split('\n').filter(l => l.trim());
  
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.type === 'match') {
        matches.push({
          file: item.data.path.text,
          line: item.data.line_number,
          content: item.data.lines.text,
          matches: item.data.submatches.map(sm => sm.match.text)
        });
      }
    } catch (e) {
      // Skip malformed JSON
    }
  }
  
  return matches;
}

/**
 * Rank search results by relevance
 */
function rankByRelevance(results, query, keywords) {
  const queryLower = query.toLowerCase();
  
  return results
    .map(result => {
      let score = 0;
      const contentLower = result.content.toLowerCase();
      
      // Exact query match = highest score
      if (contentLower.includes(queryLower)) score += 100;
      
      // Keyword matches
      for (const keyword of keywords) {
        if (contentLower.includes(keyword)) score += 10;
      }
      
      // Boost for function/class definitions
      if (/^(function|class|def|const|let|var|export)\s/.test(result.content.trim())) {
        score += 20;
      }
      
      // Boost for common patterns
      if (/auth|login|session|token|verify/.test(contentLower) && /auth/i.test(query)) {
        score += 15;
      }
      
      return { ...result, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Search codebase with natural language query
 * @param {string} query - Natural language question (e.g., "how does authentication work?")
 * @param {string} projectDir - Root directory to search
 * @param {object} options - Search options
 * @returns {Promise<{query: string, keywords: string[], results: Array, summary: string}>}
 */
export async function searchCode(query, projectDir = process.cwd(), options = {}) {
  const {
    maxResults = 20,
    contextLines = 3,
    fileTypes = null // e.g., ['js', 'ts', 'mjs']
  } = options;
  
  // Extract keywords from query
  const keywords = extractKeywords(query);
  
  if (keywords.length === 0) {
    return {
      query,
      keywords: [],
      results: [],
      summary: 'No meaningful keywords found in query'
    };
  }
  
  // Build ripgrep command
  const searchPattern = keywords.join('|');
  let cmd = `rg --json --context ${contextLines} --max-count ${maxResults} -i`;
  
  if (fileTypes && fileTypes.length > 0) {
    cmd += ` ${fileTypes.map(t => `-t ${t}`).join(' ')}`;
  }
  
  cmd += ` "${searchPattern}" "${projectDir}"`;
  
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });
    
    const matches = parseRipgrepJson(output);
    const ranked = rankByRelevance(matches, query, keywords);
    
    // Group by file
    const fileGroups = {};
    for (const match of ranked) {
      if (!fileGroups[match.file]) {
        fileGroups[match.file] = [];
      }
      fileGroups[match.file].push(match);
    }
    
    return {
      query,
      keywords,
      results: ranked.slice(0, maxResults),
      fileGroups,
      summary: `Found ${ranked.length} matches across ${Object.keys(fileGroups).length} files`
    };
    
  } catch (error) {
    // ripgrep exits with code 1 if no matches found
    if (error.status === 1) {
      return {
        query,
        keywords,
        results: [],
        summary: 'No matches found'
      };
    }
    throw error;
  }
}

/**
 * Format search results for LLM context injection
 */
export function formatSearchResults(searchResults, maxChars = 4000) {
  const { query, results, summary } = searchResults;
  
  if (results.length === 0) {
    return `## Code Search: "${query}"\n\n${summary}`;
  }
  
  let output = `## Code Search: "${query}"\n\n${summary}\n\n`;
  let charsUsed = output.length;
  
  for (const result of results) {
    const entry = `### ${result.file}:${result.line}\n\`\`\`\n${result.content}\n\`\`\`\n\n`;
    
    if (charsUsed + entry.length > maxChars) {
      output += `\n_(${results.length - results.indexOf(result)} more results truncated)_\n`;
      break;
    }
    
    output += entry;
    charsUsed += entry.length;
  }
  
  return output;
}

/**
 * Find files by pattern
 */
export async function findFiles(pattern, projectDir = process.cwd()) {
  try {
    const safePattern = pattern.replace(/["`$\\]/g, '\\$&');
    const output = execSync(`rg --files | rg "${safePattern}"`, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    
    return output.split('\n').filter(f => f.trim());
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

/**
 * Search for specific code patterns (regex-based)
 */
export async function searchPattern(pattern, projectDir = process.cwd(), options = {}) {
  const { fileTypes = null, contextLines = 2 } = options;
  
  let cmd = `rg --json --context ${contextLines}`;
  
  if (fileTypes && fileTypes.length > 0) {
    cmd += ` ${fileTypes.map(t => `-t ${t}`).join(' ')}`;
  }
  
  cmd += ` "${pattern}" "${projectDir}"`;
  
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024
    });
    
    return parseRipgrepJson(output);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

/**
 * Helper: Search for function definitions
 */
export async function findFunctions(name, projectDir = process.cwd()) {
  // Matches: function name, const name =, export function name, etc.
  // Escape special regex characters in name
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `(function|const|let|export)\\s+${escapedName}`;
  return await searchPattern(pattern, projectDir, { fileTypes: ['js', 'ts'] });
}

/**
 * Helper: Search for class definitions
 */
export async function findClasses(name, projectDir = process.cwd()) {
  const pattern = `class\\s+${name}\\s*[{(]`;
  return await searchPattern(pattern, projectDir, { fileTypes: ['js', 'ts'] });
}
