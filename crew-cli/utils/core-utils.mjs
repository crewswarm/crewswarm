/**
 * Core utility functions for crewswarm
 * Shared across all modules for common operations
 */

import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

// File system utilities
export async function ensureDirectoryExists(path) {
  try {
    await fs.mkdir(path, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export async function writeFile(path, content) {
  await ensureDirectoryExists(new URL('.', `file://${path}`).pathname);
  await fs.writeFile(path, content, 'utf8');
}

export async function readFile(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function appendFile(path, content) {
  await ensureDirectoryExists(new URL('.', `file://${path}`).pathname);
  await fs.appendFile(path, content, 'utf8');
}

// Network utilities
export async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 30000);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${options.timeout || 30000}ms`);
    }
    throw error;
  }
}

// JSON utilities
export function parseJsonSafely(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch {
    return defaultValue;
  }
}

// Validation utilities
export function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input.replace(/[<>\"'&]/g, (match) => {
    const entities = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '&': '&amp;' };
    return entities[match];
  });
}

export function isSafePath(path) {
  const resolved = resolve(path);
  const projectRoot = resolve(process.cwd());
  return resolved.startsWith(projectRoot) && !path.includes('..');
}

// Error handling
export function sanitizeError(error) {
  const sanitized = { ...error };
  delete sanitized.stack;
  delete sanitized.innerError;
  return sanitized;
}

export async function retryAsync(fn, maxRetries = 3, delay = 1000) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await sleep(delay * Math.pow(2, i)); // Exponential backoff
      }
    }
  }
  throw lastError;
}

// Time utilities
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function getTimestamp() {
  return new Date().toISOString();
}

// Environment utilities
export function getEnvVar(name, defaultValue = null) {
  return process.env[name] || defaultValue;
}

export function isDevelopment() {
  return process.env.NODE_ENV === 'development';
}

// Logging utilities
export function logInfo(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] INFO: ${message}`, data ? JSON.stringify(data) : '');
}

export function logError(message, error = null) {
  const timestamp = new Date().to Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`, error ? error.message || error : '');
}

export function logDebug(message, data = null) {
  if (isDevelopment()) {
    const timestamp = new Date().toISOString();
    console.debug(`[${timestamp}] DEBUG: ${message}`, data ? JSON.stringify(data) : '');
  }
}

// Response formatting
export function formatResponse(data = null, error = null) {
  if (error) {
    return {
      success: false,
      error: error.message || error,
      timestamp: getTimestamp()
    };
  }
  return {
    success: true,
    data,
    timestamp: getTimestamp()
  };
}

// Message utilities
export function createResponse(type, data = null, error = null) {
  return {
    type,
    success: !error,
    data,
    error: error ? error.message || error : null,
    timestamp: getTimestamp()
  };
}

// System utilities
export function getSystemInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: process.uptime(),
    timestamp: getTimestamp()
  };
}

export default {
  ensureDirectoryExists,
  writeFile,
  readFile,
  appendFile,
  fetchWithTimeout,
  parseJsonSafely,
  sanitizeInput,
  isSafePath,
  sanitizeError,
  retryAsync,
  sleep,
  formatDuration,
  getTimestamp,
  getEnvVar,
  isDevelopment,
  logInfo,
  logError,
  logDebug,
  formatResponse,
  createResponse,
  getSystemInfo
};
