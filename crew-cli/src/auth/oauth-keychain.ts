/**
 * OAuth Keychain Provider — reads Claude Max OAuth tokens from macOS Keychain.
 *
 * Claude Code stores OAuth credentials in macOS Keychain at service "Claude Code-credentials".
 * This module reads them and provides Bearer auth for the Anthropic API,
 * giving crew-cli free Claude Opus 4.6 on Max subscriptions.
 *
 * Token refresh is handled automatically when the token is within 5 min of expiry.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType: string | null;   // "max", "pro", "enterprise", "team"
  rateLimitTier: string | null;
}

interface KeychainData {
  claudeAiOauth?: OAuthTokens;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const CACHE_TTL_MS = 30_000; // Cache keychain reads for 30s

// OAuth refresh endpoint (from Claude Code reference — constants/oauth.ts)
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code production client ID

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let _cachedTokens: OAuthTokens | null = null;
let _cacheTimestamp = 0;
let _refreshInFlight: Promise<OAuthTokens | null> | null = null;

// ---------------------------------------------------------------------------
// Read from Keychain
// ---------------------------------------------------------------------------

async function readFromKeychain(): Promise<OAuthTokens | null> {
  // Only works on macOS
  if (process.platform !== 'darwin') return null;

  try {
    // Try with actual username first, then "unknown" (Claude Code uses either)
    let stdout = '';
    const username = userInfo().username;
    for (const acct of [username, 'unknown']) {
      try {
        const result = await execFileAsync('security', [
          'find-generic-password',
          '-a', acct,
          '-s', KEYCHAIN_SERVICE,
          '-w'
        ], { timeout: 5000 });
        const parsed = JSON.parse(result.stdout.trim() || '{}');
        if (parsed.claudeAiOauth?.accessToken) {
          stdout = result.stdout;
          break;
        }
      } catch { /* try next account */ }
    }
    if (!stdout) {
      // Last resort: no account filter
      const result = await execFileAsync('security', [
        'find-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-w'
      ], { timeout: 5000 });
      stdout = result.stdout;
    }

    const raw = stdout.trim();
    if (!raw) return null;

    // Keychain value might be hex-encoded or raw JSON
    let jsonStr: string;
    if (raw.startsWith('{')) {
      jsonStr = raw;
    } else {
      // Try hex decode
      jsonStr = Buffer.from(raw, 'hex').toString('utf8');
    }

    const data: KeychainData = JSON.parse(jsonStr);
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken) return null;

    return oauth;
  } catch {
    // Keychain not available, locked, or entry missing
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token Refresh
// ---------------------------------------------------------------------------

async function refreshToken(currentTokens: OAuthTokens): Promise<OAuthTokens | null> {
  if (!currentTokens.refreshToken) return null;

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: currentTokens.refreshToken,
        client_id: CLIENT_ID
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[OAuth] Token refresh failed: ${response.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as any;
    if (!data.access_token) return null;

    const refreshed: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || currentTokens.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
      scopes: data.scope ? data.scope.split(' ') : currentTokens.scopes,
      subscriptionType: currentTokens.subscriptionType,
      rateLimitTier: currentTokens.rateLimitTier
    };

    // Do NOT write back to keychain — let Claude Code manage its own tokens.
    // Writing back could corrupt the keychain entry (missing mcpOAuth, etc.).

    return refreshed;
  } catch (err) {
    console.error(`[OAuth] Token refresh error: ${(err as Error).message}`);
    return null;
  }
}

async function writeToKeychain(tokens: OAuthTokens): Promise<void> {
  if (process.platform !== 'darwin') return;

  try {
    const username = userInfo().username;
    const data: KeychainData = { claudeAiOauth: tokens };
    const jsonStr = JSON.stringify(data);

    // Delete old entry first (security doesn't support update-in-place)
    await execFileAsync('security', [
      'delete-generic-password',
      '-a', username,
      '-s', KEYCHAIN_SERVICE
    ]).catch(() => {}); // Ignore if doesn't exist

    await execFileAsync('security', [
      'add-generic-password',
      '-a', username,
      '-s', KEYCHAIN_SERVICE,
      '-w', jsonStr,
      '-U' // Update if exists
    ], { timeout: 5000 });
  } catch {
    // Best-effort — don't break if keychain write fails
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function isTokenExpired(tokens: OAuthTokens): boolean {
  if (!tokens.expiresAt) return false; // No expiry info = assume valid
  return Date.now() >= tokens.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Get a valid OAuth access token from macOS Keychain.
 * Returns null if unavailable, expired and unrefreshable, or not on macOS.
 *
 * Caches reads for 30s and deduplicates concurrent refresh attempts.
 */
export async function getOAuthToken(): Promise<OAuthTokens | null> {
  // Check cache first
  if (_cachedTokens && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    if (!isTokenExpired(_cachedTokens)) return _cachedTokens;
  }

  // Read from keychain
  let tokens = await readFromKeychain();
  if (!tokens) return null;

  // Check if refresh needed
  if (isTokenExpired(tokens)) {
    // Deduplicate concurrent refresh attempts
    if (!_refreshInFlight) {
      _refreshInFlight = refreshToken(tokens).finally(() => { _refreshInFlight = null; });
    }
    const refreshed = await _refreshInFlight;
    if (refreshed) {
      tokens = refreshed;
    } else {
      // Refresh failed — use existing token anyway (might still work)
    }
  }

  // Cache
  _cachedTokens = tokens;
  _cacheTimestamp = Date.now();
  return tokens;
}

/**
 * Force re-read from keychain (ignoring cache).
 * Useful after a 401 to check if another process refreshed the token.
 */
export async function forceRefreshOAuthToken(): Promise<OAuthTokens | null> {
  _cachedTokens = null;
  _cacheTimestamp = 0;

  const tokens = await readFromKeychain();
  if (!tokens) return null;

  // Force refresh even if not expired
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
 * Check if OAuth keychain tokens are available (quick check, no refresh).
 */
export async function hasOAuthTokens(): Promise<boolean> {
  const tokens = await getOAuthToken();
  return tokens !== null;
}
