/**
 * Centralized path resolution for CrewSwarm config and state directories.
 * Supports test mode via environment variables for hermetic testing.
 * 
 * Environment variables:
 * - CREWSWARM_CONFIG_DIR: Override config directory (default: ~/.crewswarm)
 * - CREWSWARM_STATE_DIR: Override state directory (default: ~/.crewswarm)
 * - CREWSWARM_TEST_MODE: Set to "true" to automatically use temp directories
 */

import fs from "fs";
import path from "path";
import os from "os";

let _configDir = null;
let _stateDir = null;

/**
 * Get the CrewSwarm configuration directory.
 * Used for: crewswarm.json, config.json, etc.
 */
export function getConfigDir() {
  if (_configDir) return _configDir;
  
  if (process.env.CREWSWARM_TEST_MODE === "true") {
    // Use a consistent temp dir for the entire test process (not per-call)
    _configDir = path.join(os.tmpdir(), `crewswarm-test-${process.pid}`);
  } else {
    _configDir = process.env.CREWSWARM_CONFIG_DIR || path.join(os.homedir(), ".crewswarm");
  }
  
  fs.mkdirSync(_configDir, { recursive: true });
  return _configDir;
}

/**
 * Get the CrewSwarm state directory.
 * Used for: chat-history, spending.json, token-usage.json, logs, etc.
 */
export function getStateDir() {
  if (_stateDir) return _stateDir;
  
  if (process.env.CREWSWARM_TEST_MODE === "true") {
    // Use a consistent temp dir for the entire test process (not per-call)
    _stateDir = path.join(os.tmpdir(), `crewswarm-test-${process.pid}`);
  } else {
    _stateDir = process.env.CREWSWARM_STATE_DIR || path.join(os.homedir(), ".crewswarm");
  }
  
  fs.mkdirSync(_stateDir, { recursive: true });
  return _stateDir;
}

/**
 * Get a path within the config directory.
 * @param {...string} parts - Path components to join
 */
export function getConfigPath(...parts) {
  return path.join(getConfigDir(), ...parts);
}

/**
 * Get a path within the state directory.
 * @param {...string} parts - Path components to join
 */
export function getStatePath(...parts) {
  return path.join(getStateDir(), ...parts);
}

/**
 * Reset cached paths (useful for testing).
 */
export function resetPaths() {
  _configDir = null;
  _stateDir = null;
}
