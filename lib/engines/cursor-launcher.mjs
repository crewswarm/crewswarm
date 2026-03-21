import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const _cache = new Map();

function canRun(bin, args = []) {
  try {
    execFileSync(bin, args, {
      stdio: "pipe",
      timeout: 4000,
      env: {
        ...process.env,
        NO_OPEN_BROWSER: "1",
      },
    });
    return true;
  } catch (err) {
    const stderr = String(err?.stderr || err?.message || "");
    if (/unknown imports format/i.test(stderr)) return false;
    return false;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isCursorWrapperScript(file) {
  if (!file || !fs.existsSync(file)) return false;
  const text = readText(file);
  return text.includes('NODE_BIN="$SCRIPT_DIR/node"') && text.includes('index.js');
}

function resolveSystemNode24() {
  const candidates = [
    process.env.CURSOR_NODE_BIN,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    process.execPath,
    "node",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const version = String(
        execFileSync(candidate, ["--version"], {
          stdio: "pipe",
          timeout: 3000,
          env: { ...process.env, NO_OPEN_BROWSER: "1" },
        }),
      ).trim();
      const major = Number((version.match(/^v(\d+)/) || [])[1] || 0);
      if (major >= 24) return candidate;
    } catch {
      // Keep scanning candidates.
    }
  }
  return null;
}

function defaultCursorBinary() {
  const homeAgent = path.join(os.homedir(), ".local", "bin", "agent");
  if (fs.existsSync(homeAgent)) return homeAgent;
  return "agent";
}

export function resolveCursorLaunchSpec(configuredBinary = "") {
  const key = String(configuredBinary || "__default__");
  if (_cache.has(key)) return _cache.get(key);

  const requested = String(configuredBinary || "").trim() || defaultCursorBinary();
  let spec = {
    bin: requested,
    argsPrefix: [],
    displayCommand: requested,
  };

  if (isCursorWrapperScript(requested)) {
    const realScript = fs.realpathSync(requested);
    const scriptDir = path.dirname(realScript);
    const bundledNode = path.join(scriptDir, "node");
    const entrypoint = path.join(scriptDir, "index.js");

    if (fs.existsSync(bundledNode) && canRun(bundledNode, ["--version"])) {
      spec = {
        bin: requested,
        argsPrefix: [],
        displayCommand: requested,
      };
    } else {
      const systemNode = resolveSystemNode24();
      if (systemNode && fs.existsSync(entrypoint)) {
        spec = {
          bin: systemNode,
          argsPrefix: [entrypoint],
          displayCommand: `${systemNode} ${entrypoint}`,
        };
      }
    }
  }

  _cache.set(key, spec);
  return spec;
}
