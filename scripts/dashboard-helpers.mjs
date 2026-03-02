/**
 * Standardized error handlers and response helpers for Dashboard API
 */

// ── Response Helpers ──────────────────────────────────────────────────────

/**
 * Send a successful JSON response
 */
export function jsonOk(res, data = {}) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ...data }));
}

/**
 * Send an error JSON response with appropriate HTTP status
 */
export function jsonError(res, status, message, details = null) {
  res.writeHead(status, { 'content-type': 'application/json' });
  const payload = { ok: false, error: message };
  if (details) payload.details = details;
  res.end(JSON.stringify(payload));
}

/**
 * Send a validation error (400)
 */
export function validationError(res, message, details = null) {
  jsonError(res, 400, message, details);
}

/**
 * Send a not found error (404)
 */
export function notFoundError(res, message = 'Resource not found') {
  jsonError(res, 404, message);
}

/**
 * Send an internal server error (500)
 */
export function serverError(res, message = 'Internal server error', details = null) {
  jsonError(res, 500, message, details);
}

// ── Request Helpers ───────────────────────────────────────────────────────

/**
 * Parse JSON body from request with error handling
 */
export async function parseJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  
  if (!body.trim()) {
    return { ok: false, error: 'Empty request body' };
  }
  
  try {
    const parsed = JSON.parse(body);
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: 'Invalid JSON: ' + err.message };
  }
}

// ── Process Helpers ───────────────────────────────────────────────────────

/**
 * Spawn a child process with better error handling and timeout
 * Replaces execSync for safer command execution
 */
export async function spawnAsync(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const timeout = options.timeout || 10000;
      const encoding = options.encoding || 'utf8';
    
    const proc = spawn(command, args, {
      ...options,
      timeout: undefined, // We'll handle timeout manually
    });
    
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1000); // Force kill after 1s
    }, timeout);
    
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        stdout += data.toString(encoding);
      });
    }
    
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        stderr += data.toString(encoding);
      });
    }
    
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });
    
    proc.on('close', (code) => {
      clearTimeout(timer);
      
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeout}ms: ${command} ${args.join(' ')}`));
      } else if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Command exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
  });
}

/**
 * Check if a process is running by pattern
 */
export async function isProcessRunning(pattern) {
  try {
    const { stdout } = await spawnAsync('pgrep', ['-f', pattern], { timeout: 2000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get PID of a process by pattern
 */
export async function getProcessPid(pattern) {
  try {
    const { stdout } = await spawnAsync('pgrep', ['-f', pattern], { timeout: 2000 });
    const pids = stdout.trim().split('\n').filter(Boolean).map(p => parseInt(p, 10));
    return pids.length > 0 ? pids[0] : null;
  } catch {
    return null;
  }
}

/**
 * Get all PIDs of a process by pattern
 */
export async function getAllProcessPids(pattern) {
  try {
    const { stdout } = await spawnAsync('pgrep', ['-f', pattern], { timeout: 2000 });
    return stdout.trim().split('\n').filter(Boolean).map(p => parseInt(p, 10));
  } catch {
    return [];
  }
}

/**
 * Count processes matching pattern
 */
export async function countProcesses(pattern) {
  try {
    const pids = await getAllProcessPids(pattern);
    return pids.length;
  } catch {
    return 0;
  }
}

/**
 * Kill a process by pattern
 */
export async function killProcess(pattern, signal = 'SIGTERM') {
  try {
    await spawnAsync('pkill', [signal === 'SIGKILL' ? '-9' : '', '-f', pattern].filter(Boolean), { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a port is in use
 */
export async function isPortInUse(port) {
  try {
    await spawnAsync('lsof', ['-ti', `:${port}`], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill process using a specific port
 */
export async function killProcessOnPort(port, force = false) {
  try {
    const { stdout } = await spawnAsync('lsof', ['-ti', `:${port}`], { timeout: 2000 });
    const pids = stdout.trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid, 10), force ? 'SIGKILL' : 'SIGTERM');
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a command/binary exists
 */
export async function commandExists(command) {
  try {
    await spawnAsync('which', [command], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get process start time
 */
export async function getProcessStartTime(pid) {
  try {
    const { stdout } = await spawnAsync('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 1500 });
    return stdout.trim() ? new Date(stdout.trim()).getTime() : null;
  } catch {
    return null;
  }
}

// ── File Locking Helpers ──────────────────────────────────────────────────

import lockfile from 'proper-lockfile';
import { promises as fsPromises } from 'node:fs';

/**
 * Write to a config file with proper locking to prevent corruption
 */
export async function writeConfigSafely(filePath, data) {
  const lockOptions = {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
    stale: 5000,
    realpath: false  // Don't resolve symlinks
  };
  
  let release;
  try {
    // Ensure parent directory exists
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    await fsPromises.mkdir(dir, { recursive: true });
    
    // Create file if it doesn't exist
    try {
      await fsPromises.access(filePath);
    } catch {
      await fsPromises.writeFile(filePath, '{}');
    }
    
    // Acquire lock
    release = await lockfile.lock(filePath, lockOptions);
    
    // Write data
    const jsonData = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    await fsPromises.writeFile(filePath, jsonData, 'utf8');
    
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to write ${filePath}: ${err.message}` };
  } finally {
    if (release) {
      try {
        await release();
      } catch {}
    }
  }
}

/**
 * Read from a config file with proper locking
 */
export async function readConfigSafely(filePath) {
  const lockOptions = {
    retries: { retries: 3, minTimeout: 50, maxTimeout: 500 },
    stale: 5000,
    realpath: false
  };
  
  let release;
  try {
    // Check if file exists
    try {
      await fsPromises.access(filePath);
    } catch {
      return { ok: false, error: 'File does not exist' };
    }
    
    // Acquire shared lock for reading
    release = await lockfile.lock(filePath, { ...lockOptions, shared: true });
    
    // Read and parse
    const content = await fsPromises.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `Failed to read ${filePath}: ${err.message}` };
  } finally {
    if (release) {
      try {
        await release();
      } catch {}
    }
  }
}

// ── Error Handler Wrapper ─────────────────────────────────────────────────

/**
 * Wrap an async route handler with error handling
 */
export function asyncHandler(handler) {
  return async (req, res, url) => {
    try {
      await handler(req, res, url);
    } catch (err) {
      console.error('[dashboard] Unhandled error:', err);
      if (!res.headersSent) {
        serverError(res, err.message, process.env.NODE_ENV === 'development' ? err.stack : undefined);
      }
    }
  };
}

// ── Path Sanitization ─────────────────────────────────────────────────────

import { resolve, normalize } from 'path';
import { homedir } from 'os';

/**
 * Validate that a path is safe (prevents path traversal attacks)
 * Safe paths must be within the workspace or user's home directory
 * @param {string} targetPath - Path to validate
 * @param {string} workspaceRoot - Root of the workspace
 * @returns {{ok: boolean, error?: string, sanitized?: string}}
 */
export function sanitizePath(targetPath, workspaceRoot) {
  try {
    if (!targetPath || typeof targetPath !== 'string') {
      return { ok: false, error: 'Invalid path: must be a non-empty string' };
    }
    
    // Normalize and resolve the path
    const sanitized = normalize(resolve(targetPath));
    const wsRoot = normalize(resolve(workspaceRoot));
    const home = normalize(homedir());
    
    // Check if path is within workspace or home directory
    const inWorkspace = sanitized.startsWith(wsRoot + '/') || sanitized === wsRoot;
    const inHome = sanitized.startsWith(home + '/') || sanitized === home;
    
    if (!inWorkspace && !inHome) {
      return { 
        ok: false, 
        error: `Path must be within workspace (${wsRoot}) or home directory (${home})` 
      };
    }
    
    // Block dangerous path components
    const dangerous = ['..', '.git', 'node_modules/.bin'];
    const parts = sanitized.split('/');
    for (const danger of dangerous) {
      if (parts.includes(danger)) {
        return { ok: false, error: `Path contains dangerous component: ${danger}` };
      }
    }
    
    return { ok: true, sanitized };
  } catch (err) {
    return { ok: false, error: `Path validation failed: ${err.message}` };
  }
}
