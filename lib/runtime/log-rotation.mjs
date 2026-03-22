/**
 * Log rotation utility — prevents unbounded growth of .jsonl files
 * Implements simple size-based rotation: if file exceeds MAX_LOG_SIZE_MB,
 * move it to .1, .2, etc. and keep only KEEP_ROTATIONS backups.
 */

import { existsSync, statSync, renameSync, unlinkSync, appendFileSync } from "fs";
import { appendFile } from "fs/promises";

const MAX_LOG_SIZE_MB = Number(process.env.CREWSWARM_LOG_MAX_SIZE_MB || "10");
const MAX_LOG_SIZE_BYTES = MAX_LOG_SIZE_MB * 1024 * 1024;
const KEEP_ROTATIONS = Number(process.env.CREWSWARM_LOG_KEEP_ROTATIONS || "3");

/**
 * Append a line to a log file with automatic rotation
 * @param {string} filePath - Path to the log file
 * @param {string} content - Content to append (should include newline)
 */
export async function appendWithRotation(filePath, content) {
  // Check if rotation is needed
  if (existsSync(filePath)) {
    const stats = statSync(filePath);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      rotateLog(filePath);
    }
  }
  
  await appendFile(filePath, content, "utf8");
}

/**
 * Synchronous version for non-async contexts
 */
export function appendWithRotationSync(filePath, content) {
  if (existsSync(filePath)) {
    const stats = statSync(filePath);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      rotateLog(filePath);
    }
  }
  
  appendFileSync(filePath, content, "utf8");
}

/**
 * Rotate a log file: rename current to .1, .1 to .2, etc.
 * Delete oldest rotation that exceeds KEEP_ROTATIONS
 */
function rotateLog(filePath) {
  try {
    // Delete the oldest rotation if it exists
    const oldestRotation = `${filePath}.${KEEP_ROTATIONS}`;
    if (existsSync(oldestRotation)) {
      unlinkSync(oldestRotation);
    }
    
    // Shift existing rotations: .2 → .3, .1 → .2, etc.
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }
    
    // Move current log to .1
    renameSync(filePath, `${filePath}.1`);
    
    console.log(`[LOG-ROTATION] Rotated ${filePath} (size exceeded ${MAX_LOG_SIZE_MB}MB)`);
  } catch (err) {
    console.error(`[LOG-ROTATION] Failed to rotate ${filePath}: ${err.message}`);
  }
}

/**
 * Manual rotation trigger (useful for testing or cron jobs)
 */
export function forceRotate(filePath) {
  if (existsSync(filePath)) {
    rotateLog(filePath);
  }
}
