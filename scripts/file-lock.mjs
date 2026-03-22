/**
 * File locking utilities for safe config writes
 * Prevents concurrent writes to crewswarm.json that could cause corruption
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const lockDir = path.join(os.tmpdir(), 'crewswarm-locks');
const locks = new Map(); // In-memory lock tracking

/**
 * Acquire a file lock
 * @param {string} filePath - Path to file to lock
 * @param {number} timeout - Max time to wait for lock (ms)
 * @returns {Promise<Function>} Unlock function
 */
export async function acquireFileLock(filePath, timeout = 5000) {
  const lockId = Buffer.from(filePath).toString('base64').replace(/[/+=]/g, '_');
  const lockFile = path.join(lockDir, `${lockId}.lock`);
  
  // Ensure lock directory exists
  try {
    await fs.mkdir(lockDir, { recursive: true });
  } catch {}
  
  const startTime = Date.now();
  
  while (true) {
    // Check if we already have the lock (same process)
    if (locks.has(filePath)) {
      const existing = locks.get(filePath);
      existing.count++;
      return existing.release;
    }
    
    // Try to acquire lock
    try {
      const fd = await fs.open(lockFile, 'wx');
      await fs.writeFile(fd, JSON.stringify({
        pid: process.pid,
        file: filePath,
        acquired: new Date().toISOString(),
      }));
      await fd.close();
      
      // Lock acquired!
      const lockInfo = {
        count: 1,
        release: async () => {
          lockInfo.count--;
          if (lockInfo.count === 0) {
            locks.delete(filePath);
            try {
              await fs.unlink(lockFile);
            } catch {}
          }
        }
      };
      
      locks.set(filePath, lockInfo);
      return lockInfo.release;
      
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      
      // Lock file exists - check if it's stale
      try {
        const lockContent = await fs.readFile(lockFile, 'utf8');
        const lockData = JSON.parse(lockContent);
        
        // Check if process is still alive
        try {
          process.kill(lockData.pid, 0);
          // Process is alive, wait and retry
        } catch {
          // Process is dead, remove stale lock
          await fs.unlink(lockFile);
          continue;
        }
      } catch {
        // Couldn't read lock file, assume stale
        try {
          await fs.unlink(lockFile);
          continue;
        } catch {}
      }
      
      // Check timeout
      if (Date.now() - startTime > timeout) {
        throw new Error(`Failed to acquire lock for ${filePath} after ${timeout}ms`);
      }
      
      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

/**
 * Read a config file with lock
 */
export async function readConfigFile(filePath) {
  const unlock = await acquireFileLock(filePath);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } finally {
    await unlock();
  }
}

/**
 * Write a config file with lock and backup
 */
export async function writeConfigFile(filePath, data, options = {}) {
  const {
    backup = true,
    backupCount = 5,
    prettify = true,
  } = options;
  
  const unlock = await acquireFileLock(filePath, 10000);
  
  try {
    // Create backup if file exists
    if (backup) {
      try {
        await fs.access(filePath);
        const backupPath = `${filePath}.${Date.now()}.bak`;
        await fs.copyFile(filePath, backupPath);
        
        // Clean old backups
        const dir = path.dirname(filePath);
        const basename = path.basename(filePath);
        const files = await fs.readdir(dir);
        const backups = files
          .filter(f => f.startsWith(basename) && f.endsWith('.bak'))
          .map(f => ({ name: f, path: path.join(dir, f) }))
          .sort((a, b) => b.name.localeCompare(a.name));
        
        // Keep only last N backups
        for (const backup of backups.slice(backupCount)) {
          try {
            await fs.unlink(backup.path);
          } catch {}
        }
      } catch {}
    }
    
    // Write file
    const content = prettify ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    await fs.writeFile(filePath, content, 'utf8');
    
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await unlock();
  }
}

/**
 * Update a config file with a transformation function
 */
export async function updateConfigFile(filePath, updateFn) {
  const unlock = await acquireFileLock(filePath, 10000);
  
  try {
    // Read current config
    let config = {};
    try {
      const content = await fs.readFile(filePath, 'utf8');
      config = JSON.parse(content);
    } catch {}
    
    // Apply update
    const updated = await updateFn(config);
    
    // Write back
    const result = await writeConfigFile(filePath, updated, { backup: true });
    return result;
  } finally {
    await unlock();
  }
}
