/**
 * Dead Letter Queue (DLQ) implementation for failed tasks.
 * Writes failed tasks to persistent storage for replay/analysis.
 */

import fs from "node:fs";
import path from "node:path";
import { SWARM_DLQ_DIR } from "./config.mjs";

/**
 * Write a failed task to the DLQ.
 * 
 * @param {Object} task - Task details
 * @param {string} task.taskId - Unique task ID
 * @param {string} task.agent - Target agent
 * @param {string} task.prompt - Task prompt/message
 * @param {string} task.error - Error message
 * @param {number} task.retries - Number of retry attempts
 * @param {Object} task.payload - Original task payload
 * @param {string} task.correlationId - Correlation ID for tracing
 * @returns {Object|null} DLQ entry or null on failure
 */
export function writeToDLQ(task) {
  try {
    // Ensure DLQ directory exists
    fs.mkdirSync(SWARM_DLQ_DIR, { recursive: true });
    
    const dlqEntry = {
      taskId: task.taskId || `task-${Date.now()}`,
      agent: task.agent || "unknown",
      prompt: task.prompt || task.task || task.message || "",
      error: task.error || "Unknown error",
      retries: task.retries || 0,
      correlationId: task.correlationId || null,
      originalPayload: task.payload || {},
      failedAt: new Date().toISOString(),
      ts: Date.now(),
      dlqVersion: "1.0",
    };
    
    // Write to DLQ with taskId as filename
    const dlqPath = path.join(SWARM_DLQ_DIR, `${dlqEntry.taskId}.json`);
    fs.writeFileSync(dlqPath, JSON.stringify(dlqEntry, null, 2));
    
    console.log(`[dlq] Task ${dlqEntry.taskId} written to DLQ (agent: ${dlqEntry.agent}, retries: ${dlqEntry.retries})`);
    
    return dlqEntry;
  } catch (e) {
    console.error(`[dlq] Failed to write to DLQ: ${e.message}`);
    return null;
  }
}

/**
 * Check if a task should be written to DLQ.
 * 
 * @param {Object} task - Task details
 * @param {number} maxRetries - Maximum retries allowed
 * @returns {boolean} True if task should go to DLQ
 */
export function shouldDLQ(task, maxRetries) {
  // Write to DLQ if:
  // 1. Max retries exceeded
  if (task.retries >= maxRetries) return true;
  
  // 2. Catastrophic errors (non-retryable)
  const catastrophicErrors = [
    "ENOENT",
    "EACCES",
    "Module not found",
    "Syntax error",
    "Invalid configuration",
  ];
  
  const errorMsg = String(task.error || "").toLowerCase();
  if (catastrophicErrors.some(e => errorMsg.includes(e.toLowerCase()))) {
    return true;
  }
  
  return false;
}

/**
 * List all DLQ entries.
 * 
 * @returns {Array<Object>} Array of DLQ entries
 */
export function listDLQEntries() {
  try {
    if (!fs.existsSync(SWARM_DLQ_DIR)) return [];
    
    const files = fs.readdirSync(SWARM_DLQ_DIR)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse(); // Newest first
    
    return files.map(file => {
      try {
        const content = fs.readFileSync(path.join(SWARM_DLQ_DIR, file), "utf8");
        return JSON.parse(content);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.error(`[dlq] Failed to list DLQ entries: ${e.message}`);
    return [];
  }
}

/**
 * Get a single DLQ entry by task ID.
 * 
 * @param {string} taskId - Task ID
 * @returns {Object|null} DLQ entry or null if not found
 */
export function getDLQEntry(taskId) {
  try {
    const dlqPath = path.join(SWARM_DLQ_DIR, `${taskId}.json`);
    if (!fs.existsSync(dlqPath)) return null;
    
    return JSON.parse(fs.readFileSync(dlqPath, "utf8"));
  } catch (e) {
    console.error(`[dlq] Failed to read DLQ entry ${taskId}: ${e.message}`);
    return null;
  }
}

/**
 * Delete a DLQ entry (after successful replay).
 * 
 * @param {string} taskId - Task ID to remove from DLQ
 * @returns {boolean} True if deleted successfully
 */
export function deleteDLQEntry(taskId) {
  try {
    const dlqPath = path.join(SWARM_DLQ_DIR, `${taskId}.json`);
    if (fs.existsSync(dlqPath)) {
      fs.unlinkSync(dlqPath);
      console.log(`[dlq] Removed entry ${taskId} from DLQ`);
      return true;
    }
    return false;
  } catch (e) {
    console.error(`[dlq] Failed to delete DLQ entry ${taskId}: ${e.message}`);
    return false;
  }
}
