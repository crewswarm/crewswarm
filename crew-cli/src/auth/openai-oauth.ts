/**
 * OpenAI OAuth Provider — reads Codex CLI OAuth tokens for ChatGPT Plus/Pro/Max.
 *
 * OpenAI Codex CLI stores OAuth credentials in ~/.codex/auth.json or
 * ~/.local/share/opencode/auth.json. This module reads them and provides
 * Bearer auth for the Codex backend API (chatgpt.com/backend-api/codex/responses),
 * giving crew-cli free GPT-5.x access on ChatGPT subscriptions.
 *
 * Token refresh is handled automatically when the token is within 5 min of expiry.
 */

import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenAIOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const CACHE_TTL_MS = 30_000; // Cache reads for 30s

// OpenAI Codex public client ID (same as Codex CLI)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';

// The Codex backend API — uses ChatGPT subscription billing, not API credits
export const OPENAI_CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';

// Possible token file locations (Codex CLI, OpenCode, openai-oauth)
const TOKEN_PATHS = [
  join(homedir(), '.codex', 'auth.json'),
  join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
  join(homedir(), '.codex-auth', 'auth.json'),
];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let _cachedTokens: OpenAIOAuthTokens | null = null;
let _cacheTimestamp = 0;
let _refreshInFlight: Promise<OpenAIOAuthTokens | null> | null = null;

// ---------------------------------------------------------------------------
// Read from disk
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTokenFile(): Promise<OpenAIOAuthTokens | null> {
  for (const tokenPath of TOKEN_PATHS) {
    if (!(await fileExists(tokenPath))) continue;

    try {
      const raw = await readFile(tokenPath, 'utf8');
      const data = JSON.parse(raw);

      // Format 1: { "openai-codex": { type: "oauth", access, refresh, expires } }
      const codexEntry = data['openai-codex'] || data['codex'] || data['openai'];
      if (codexEntry?.access) {
        return {
          accessToken: codexEntry.access,
          refreshToken: codexEntry.refresh || null,
          expiresAt: codexEntry.expires || null,
        };
      }

      // Format 1b: nested auth object used by some Codex/OpenCode builds
      const nestedAuth = data.auth || data.oauth || data.credentials;
      if (nestedAuth?.accessToken || nestedAuth?.access_token || nestedAuth?.access) {
        return {
          accessToken: nestedAuth.accessToken || nestedAuth.access_token || nestedAuth.access,
          refreshToken: nestedAuth.refreshToken || nestedAuth.refresh_token || nestedAuth.refresh || null,
          expiresAt: nestedAuth.expiresAt || nestedAuth.expires_at || nestedAuth.expires || null,
        };
      }

      // Format 2: flat { access_token, refresh_token, expires_at }
      if (data.access_token) {
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || null,
          expiresAt: data.expires_at || data.expires || null,
        };
      }

      // Format 3: { token: "..." } (simple bearer token)
      if (data.token) {
        return {
          accessToken: data.token,
          refreshToken: data.refresh_token || null,
          expiresAt: data.expires_at || null,
        };
      }
    } catch {
      // Parse error — try next path
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token Refresh
// ---------------------------------------------------------------------------

async function refreshToken(current: OpenAIOAuthTokens): Promise<OpenAIOAuthTokens | null> {
  if (!current.refreshToken) return null;

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[OpenAI OAuth] Token refresh failed: ${response.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as any;
    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || current.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    };
  } catch (err) {
    console.error(`[OpenAI OAuth] Token refresh error: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function isTokenExpired(tokens: OpenAIOAuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return Date.now() >= tokens.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Get a valid OpenAI OAuth access token from Codex CLI auth files.
 * Returns null if unavailable or expired and unrefreshable.
 *
 * Caches reads for 30s and deduplicates concurrent refresh attempts.
 */
export async function getOpenAIOAuthToken(): Promise<OpenAIOAuthTokens | null> {
  // Check cache first
  if (_cachedTokens && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    if (!isTokenExpired(_cachedTokens)) return _cachedTokens;
  }

  let tokens = await readTokenFile();
  if (!tokens) return null;

  // Check if refresh needed
  if (isTokenExpired(tokens)) {
    if (!_refreshInFlight) {
      _refreshInFlight = refreshToken(tokens).finally(() => { _refreshInFlight = null; });
    }
    const refreshed = await _refreshInFlight;
    if (refreshed) {
      tokens = refreshed;
    }
    // If refresh failed, use existing token — might still work
  }

  _cachedTokens = tokens;
  _cacheTimestamp = Date.now();
  return tokens;
}

/**
 * Force re-read and refresh (ignoring cache).
 * Useful after a 401 to check if another process refreshed the token.
 */
export async function forceRefreshOpenAIOAuth(): Promise<OpenAIOAuthTokens | null> {
  _cachedTokens = null;
  _cacheTimestamp = 0;

  const tokens = await readTokenFile();
  if (!tokens) return null;

  if (tokens.refreshToken) {
    if (!_refreshInFlight) {
      _refreshInFlight = refreshToken(tokens).finally(() => { _refreshInFlight = null; });
    }
    const refreshed = await _refreshInFlight;
    if (refreshed) {
      _cachedTokens = refreshed;
      _cacheTimestamp = Date.now();
      return refreshed;
    }
  }

  _cachedTokens = tokens;
  _cacheTimestamp = Date.now();
  return tokens;
}

/**
 * Quick check for OpenAI OAuth availability.
 */
export async function hasOpenAIOAuthTokens(): Promise<boolean> {
  const tokens = await getOpenAIOAuthToken();
  return tokens !== null;
}
