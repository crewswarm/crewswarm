/**
 * RAG Helper — fetch codebase context from crew-cli RAG API
 * Shared by: crew-lead, Telegram, WhatsApp, dashboard
 */

/**
 * Fetch codebase context from crew-cli RAG API
 * Returns context string or empty string if RAG not available
 */
export async function fetchCrewCliRagContext(query, projectDir = process.cwd()) {
  try {
    // Check if coding keywords present
    const codingKeywords = [
      'implement', 'create', 'build', 'write', 'fix', 'refactor',
      'modify', 'update', 'add', 'endpoint', 'function', 'class',
      'component', 'how does', 'where is', 'show me', 'explain'
    ];
    
    const lowerQuery = query.toLowerCase();
    const needsRag = codingKeywords.some(kw => lowerQuery.includes(kw));
    
    if (!needsRag) return '';
    
    const ragPort = process.env.CREW_CLI_RAG_PORT || process.env.CREW_API_PORT || '4317';
    const ragUrl = `http://127.0.0.1:${ragPort}/api/rag/search?q=${encodeURIComponent(query)}&projectDir=${encodeURIComponent(projectDir)}&mode=import-graph`;
    
    // Get auth token if available
    const authToken = getAuthToken();
    const headers = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
    
    const response = await fetch(ragUrl, { 
      signal: AbortSignal.timeout(5000), // 5s timeout
      headers
    });
    
    if (!response.ok) {
      console.warn(`[rag-helper] RAG API error: ${response.status}`);
      return '';
    }
    
    const result = await response.json();
    
    if (result.filesLoaded?.length > 0) {
      console.log(`[rag-helper] RAG loaded ${result.filesLoaded.length} files: ${result.filesLoaded.slice(0, 3).join(', ')}${result.filesLoaded.length > 3 ? '...' : ''}`);
      return `\n\n## Relevant Code Files (Auto-RAG)\n${result.context}`;
    }
    
    return '';
  } catch (error) {
    // RAG server not running or timeout - silently skip
    if (error.name === 'TimeoutError' || error.code === 'ECONNREFUSED') {
      // Expected when crew serve is not running
      return '';
    }
    console.warn('[rag-helper] RAG API call failed:', error.message);
    return '';
  }
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Get auth token from config
 */
function getAuthToken() {
  try {
    const configPath = join(homedir(), '.crewswarm', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config?.rt?.authToken || '';
  } catch {
    return '';
  }
}

/**
 * Check if RAG server is available
 */
export async function isRagServerAvailable() {
  try {
    const ragPort = process.env.CREW_CLI_RAG_PORT || process.env.CREW_API_PORT || '4317';
    const response = await fetch(`http://127.0.0.1:${ragPort}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
