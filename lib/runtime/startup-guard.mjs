/**
 * Startup guard — Ensures only one instance of a service runs
 * Prevents port conflicts and duplicate processes
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.pid-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolvePidDir() {
  const configured = process.env.CREWSWARM_PID_DIR;
  const homePidDir = path.join(os.homedir(), ".crewswarm", "pids");
  const tmpPidDir = path.join(
    os.tmpdir(),
    `crewswarm-pids-${process.getuid?.() ?? "user"}`,
  );

  const candidates = [configured, homePidDir, tmpPidDir].filter(Boolean);
  for (const dir of candidates) {
    if (isWritableDir(dir)) {
      if (dir !== homePidDir) {
        console.warn(`[startup-guard] Using fallback PID directory: ${dir}`);
      }
      return dir;
    }
  }

  throw new Error(
    `[startup-guard] No writable PID directory found. Tried: ${candidates.join(", ")}`,
  );
}

const PID_DIR = resolvePidDir();

/**
 * Check if a process is alive
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 just checks if process exists
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a port is in use
 */
function isPortInUse(port) {
  try {
    execSync(`lsof -ti :${port}`, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get PID using port
 */
function getPidOnPort(port) {
  try {
    const out = execSync(`lsof -ti :${port}`, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const pids = out
      .split("\n")
      .filter(Boolean)
      .map((p) => parseInt(p, 10));
    return pids.length > 0 ? pids[0] : null;
  } catch {
    return null;
  }
}

/**
 * Remove a pid file without crashing startup on permission issues.
 */
function tryRemovePidFile(pidFile, serviceName, context) {
  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch (err) {
    console.warn(
      `[startup-guard] Failed to remove ${context} PID file for ${serviceName}: ${err.message}`,
    );
    return false;
  }
}

/**
 * Acquire startup lock for a service
 * Returns: { ok: true, pid } if lock acquired
 *          { ok: false, runningPid, message } if already running
 */
export function acquireStartupLock(serviceName, options = {}) {
  const { port = null, killStale = true, maxRetries = 6 } = options;
  const pidFile = path.join(PID_DIR, `${serviceName}.pid`);
  const myPid = process.pid;

  // Check if PID file exists
  if (fs.existsSync(pidFile)) {
    try {
      const savedPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (savedPid && isProcessAlive(savedPid)) {
        // Process is alive - check if it's really the right service
        if (port && !isPortInUse(port)) {
          // PID exists but port is free - stale PID file
          console.log(
            `[startup-guard] Stale PID ${savedPid} for ${serviceName} (port ${port} free) - removing`,
          );
          if (!tryRemovePidFile(pidFile, serviceName, "stale")) {
            return {
              ok: false,
              runningPid: savedPid,
              message: `Cannot remove stale PID file for ${serviceName}: ${pidFile}`,
            };
          }
        } else {
          return {
            ok: false,
            runningPid: savedPid,
            message: `${serviceName} already running (pid ${savedPid})${port ? ` on port ${port}` : ""}`,
          };
        }
      } else {
        // Stale PID file
        console.log(
          `[startup-guard] Removing stale PID file for ${serviceName} (pid ${savedPid} dead)`,
        );
        if (!tryRemovePidFile(pidFile, serviceName, "stale")) {
          return {
            ok: false,
            runningPid: savedPid,
            message: `Cannot remove stale PID file for ${serviceName}: ${pidFile}`,
          };
        }
      }
    } catch (err) {
      // Corrupted PID file
      console.log(
        `[startup-guard] Removing corrupted PID file for ${serviceName}: ${err.message}`,
      );
      if (!tryRemovePidFile(pidFile, serviceName, "corrupted")) {
        return {
          ok: false,
          message: `Cannot remove corrupted PID file for ${serviceName}: ${pidFile}`,
        };
      }
    }
  }

  // Check port conflict
  if (port) {
    const portPid = getPidOnPort(port);
    if (portPid && portPid !== myPid) {
      if (killStale) {
        console.log(
          `[startup-guard] Port ${port} occupied by PID ${portPid} - killing stale process`,
        );
        try {
          process.kill(portPid, 9);
          // Wait for port to be released
          for (let i = 0; i < maxRetries; i++) {
            if (!isPortInUse(port)) break;
            const wait = (i + 1) * 1000;
            console.log(
              `[startup-guard] Port ${port} in use — retry ${i + 1}/${maxRetries} in ${wait}ms`,
            );
            execSync(`sleep ${wait / 1000}`, { stdio: "ignore" });
          }
          if (isPortInUse(port)) {
            return {
              ok: false,
              runningPid: portPid,
              message: `Port ${port} still in use after killing stale process ${portPid}`,
            };
          }
        } catch (err) {
          return {
            ok: false,
            runningPid: portPid,
            message: `Failed to kill stale process ${portPid} on port ${port}: ${err.message}`,
          };
        }
      } else {
        return {
          ok: false,
          runningPid: portPid,
          message: `Port ${port} already in use by process ${portPid}`,
        };
      }
    }
  }

  // Acquire lock by writing PID file
  try {
    fs.writeFileSync(pidFile, String(myPid));
    console.log(
      `[startup-guard] Acquired lock for ${serviceName} (pid ${myPid})${port ? ` on port ${port}` : ""}`,
    );

    // Clean up PID file on exit
    const cleanup = () => {
      try {
        const current = fs.existsSync(pidFile)
          ? fs.readFileSync(pidFile, "utf8").trim()
          : null;
        if (current === String(myPid)) {
          fs.unlinkSync(pidFile);
          console.log(
            `[startup-guard] Released lock for ${serviceName} (pid ${myPid})`,
          );
        }
      } catch {}
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });

    return { ok: true, pid: myPid };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write PID file for ${serviceName}: ${err.message}`,
    };
  }
}

/**
 * Release startup lock (usually automatic via process.on('exit'))
 */
export function releaseStartupLock(serviceName) {
  const pidFile = path.join(PID_DIR, `${serviceName}.pid`);
  try {
    const savedPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (savedPid === process.pid) {
      fs.unlinkSync(pidFile);
      console.log(`[startup-guard] Released lock for ${serviceName}`);
    }
  } catch {}
}
