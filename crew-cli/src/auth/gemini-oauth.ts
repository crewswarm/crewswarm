/**
 * Gemini OAuth Provider — reads Google ADC or Gemini CLI OAuth tokens.
 *
 * Supports two token sources:
 * 1. Google ADC (~/.config/gcloud/application_default_credentials.json)
 *    — from `gcloud auth application-default login`
 * 2. Gemini CLI OAuth (~/.gemini/oauth_creds.json)
 *    — from Gemini CLI browser login
 *
 * Uses Bearer auth with generativelanguage.googleapis.com instead of ?key= param.
 * Token refresh is handled automatically when within 5 min of expiry.
 */

import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeminiOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string | null;
  clientSecret: string | null;
  projectId: string | null;
  source: 'adc' | 'gemini-cli';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 30_000;

// Google OAuth token endpoint
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Gemini CLI's OAuth client credentials (public, safe to embed per Google docs)
const GEMINI_CLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLI_CLIENT_SECRET = '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';

// Token file locations
const ADC_PATH = join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
const GEMINI_CLI_PATH = join(homedir(), '.gemini', 'oauth_creds.json');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let _cachedTokens: GeminiOAuthTokens | null = null;
let _cacheTimestamp = 0;
let _refreshInFlight: Promise<GeminiOAuthTokens | null> | null = null;

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

async function resolveGoogleProjectId(): Promise<string | null> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (envProject) return envProject;

  if (await fileExists(ADC_PATH)) {
    try {
      const raw = await readFile(ADC_PATH, 'utf8');
      const data = JSON.parse(raw);
      return data.quota_project_id || data.project_id || null;
    } catch {
      // Ignore malformed ADC files and fall back to null.
    }
  }

  return null;
}

async function readTokenFiles(): Promise<GeminiOAuthTokens | null> {
  const projectId = await resolveGoogleProjectId();
  const preference = String(process.env.CREW_GEMINI_OAUTH_SOURCE || 'auto').trim().toLowerCase();
  const orderedSources =
    preference === 'gemini-cli'
      ? ['gemini-cli', 'adc']
    : preference === 'adc'
        ? ['adc', 'gemini-cli']
        : ['gemini-cli', 'adc'];

  for (const source of orderedSources) {
    if (source === 'adc' && await fileExists(ADC_PATH)) {
      try {
        const raw = await readFile(ADC_PATH, 'utf8');
        const data = JSON.parse(raw);

        // ADC files contain client_id, client_secret, refresh_token (no access_token)
        if (data.refresh_token && data.client_id) {
          const refreshed = await exchangeRefreshToken(
            data.refresh_token,
            data.client_id,
            data.client_secret
          );
          if (refreshed) {
            return {
              ...refreshed,
              clientId: data.client_id,
              clientSecret: data.client_secret,
              projectId: data.quota_project_id || data.project_id || projectId,
              source: 'adc',
            };
          }
        }

        if (data.access_token) {
          return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || null,
            expiresAt: null,
            clientId: data.client_id || null,
            clientSecret: data.client_secret || null,
            projectId: data.quota_project_id || data.project_id || projectId,
            source: 'adc',
          };
        }
      } catch {
        // Parse error — try next source
      }
    }

    if (source === 'gemini-cli' && await fileExists(GEMINI_CLI_PATH)) {
      try {
        const raw = await readFile(GEMINI_CLI_PATH, 'utf8');
        const data = JSON.parse(raw);
        if (data.refresh_token) {
          const refreshed = await exchangeRefreshToken(
            data.refresh_token,
            GEMINI_CLI_CLIENT_ID,
            GEMINI_CLI_CLIENT_SECRET
          );
          if (refreshed) {
            return {
              ...refreshed,
              clientId: GEMINI_CLI_CLIENT_ID,
              clientSecret: GEMINI_CLI_CLIENT_SECRET,
              projectId,
              source: 'gemini-cli',
            };
          }
        }
        if (data.access_token) {
          return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || null,
            expiresAt: data.expiry_date || null,
            clientId: GEMINI_CLI_CLIENT_ID,
            clientSecret: GEMINI_CLI_CLIENT_SECRET,
            projectId,
            source: 'gemini-cli',
          };
        }
      } catch {
        // Parse error — try next source
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token Refresh
// ---------------------------------------------------------------------------

async function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number | null } | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[Gemini OAuth] Token refresh failed: ${response.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    };
  } catch (err) {
    console.error(`[Gemini OAuth] Token exchange error: ${(err as Error).message}`);
    return null;
  }
}

async function refreshTokens(current: GeminiOAuthTokens): Promise<GeminiOAuthTokens | null> {
  if (!current.refreshToken) return null;

  const clientId = current.clientId || GEMINI_CLI_CLIENT_ID;
  const clientSecret = current.clientSecret || GEMINI_CLI_CLIENT_SECRET;

  const result = await exchangeRefreshToken(current.refreshToken, clientId, clientSecret);
  if (!result) return null;

  return {
    ...result,
    clientId,
    clientSecret,
    projectId: current.projectId || null,
    source: current.source,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function isTokenExpired(tokens: GeminiOAuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return Date.now() >= tokens.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Get a valid Gemini OAuth access token from ADC or Gemini CLI creds.
 * Returns null if unavailable or expired and unrefreshable.
 *
 * Caches reads for 30s and deduplicates concurrent refresh attempts.
 */
export async function getGeminiOAuthToken(): Promise<GeminiOAuthTokens | null> {
  // Check cache first
  if (_cachedTokens && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    if (!isTokenExpired(_cachedTokens)) return _cachedTokens;
  }

  let tokens = await readTokenFiles();
  if (!tokens) return null;

  // Check if refresh needed
  if (isTokenExpired(tokens)) {
    if (!_refreshInFlight) {
      _refreshInFlight = refreshTokens(tokens).finally(() => { _refreshInFlight = null; });
    }
    const refreshed = await _refreshInFlight;
    if (refreshed) {
      tokens = refreshed;
    }
  }

  _cachedTokens = tokens;
  _cacheTimestamp = Date.now();
  return tokens;
}

/**
 * Force re-read and refresh (ignoring cache).
 * Useful after a 401 to retry with a fresh token.
 */
export async function forceRefreshGeminiOAuth(): Promise<GeminiOAuthTokens | null> {
  _cachedTokens = null;
  _cacheTimestamp = 0;

  const tokens = await readTokenFiles();
  if (!tokens) return null;

  if (tokens.refreshToken) {
    if (!_refreshInFlight) {
      _refreshInFlight = refreshTokens(tokens).finally(() => { _refreshInFlight = null; });
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
 * Quick check for Gemini OAuth availability.
 */
export async function hasGeminiOAuthTokens(): Promise<boolean> {
  const tokens = await getGeminiOAuthToken();
  return tokens !== null;
}
