#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

function safeExec(command) {
  try {
    return execSync(command, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function normalizeRelative(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function fingerprintFile(filePath) {
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  return {
    path: filePath,
    relative_file: normalizeRelative(filePath),
    size_bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

function tryResolve(baseDir, specifier) {
  const raw = path.resolve(baseDir, specifier);
  const candidates = [
    raw,
    `${raw}.mjs`,
    `${raw}.js`,
    `${raw}.json`,
    path.join(raw, "index.mjs"),
    path.join(raw, "index.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectImports(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const patterns = [
    /(?:import|export)\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const imports = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || !specifier.startsWith(".")) continue;
      const resolved = tryResolve(path.dirname(filePath), specifier);
      if (resolved && resolved.startsWith(process.cwd())) imports.add(resolved);
    }
  }
  return [...imports];
}

export function buildDependencySnapshot(filePath, maxDepth = 3) {
  if (!filePath || !fs.existsSync(filePath)) return { files: [] };
  const visited = new Set();
  const queue = [{ filePath, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current?.filePath || visited.has(current.filePath)) continue;
    visited.add(current.filePath);
    if (current.depth >= maxDepth) continue;
    for (const imported of collectImports(current.filePath)) {
      queue.push({ filePath: imported, depth: current.depth + 1 });
    }
  }
  return {
    max_depth: maxDepth,
    files: [...visited]
      .sort()
      .map((item) => {
        try {
          return fingerprintFile(item);
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  };
}

export function getWorkspaceState() {
  const tracked = safeExec("git diff --name-only HEAD --");
  const untracked = safeExec("git ls-files --others --exclude-standard");
  const changedFiles = [
    ...(tracked ? tracked.split("\n").filter(Boolean) : []),
    ...(untracked ? untracked.split("\n").filter(Boolean) : []),
  ].map((item) => item.replace(/\\/g, "/"));
  return {
    git_commit: safeExec("git rev-parse HEAD"),
    git_branch: safeExec("git branch --show-current"),
    changed_files: [...new Set(changedFiles)].sort(),
    dirty: changedFiles.length > 0,
  };
}

export function assessTestFreshness(test, workspaceState = getWorkspaceState()) {
  const snapshotFiles = test.dependency_snapshot?.files || [];
  if (snapshotFiles.length === 0) {
    return {
      status: "unknown",
      rerun_advice: workspaceState.dirty ? "rerun_recommended" : "rerun_not_needed",
      reason: "no dependency snapshot available",
      changed_relevant_files: [],
      dependency_changes: [],
    };
  }

  const changedSet = new Set(workspaceState.changed_files || []);
  const changedRelevant = snapshotFiles
    .map((file) => file.relative_file)
    .filter((relativeFile) => changedSet.has(relativeFile));

  const dependencyChanges = [];
  for (const dependency of snapshotFiles) {
    const absolutePath = dependency.path || path.join(process.cwd(), dependency.relative_file);
    try {
      const current = fingerprintFile(absolutePath);
      if (current.sha256 !== dependency.sha256) {
        dependencyChanges.push({
          file: dependency.relative_file,
          previous_sha256: dependency.sha256,
          current_sha256: current.sha256,
        });
      }
    } catch {
      dependencyChanges.push({
        file: dependency.relative_file,
        previous_sha256: dependency.sha256,
        current_sha256: null,
        missing: true,
      });
    }
  }

  if (changedRelevant.length || dependencyChanges.length) {
    return {
      status: "stale",
      rerun_advice: "rerun_required",
      reason: changedRelevant.length
        ? "tracked workspace changes intersect this test's dependency graph"
        : "dependency fingerprints changed since this test last ran",
      changed_relevant_files: changedRelevant,
      dependency_changes: dependencyChanges,
    };
  }

  if (!workspaceState.dirty) {
    return {
      status: "fresh",
      rerun_advice: "rerun_not_needed",
      reason: "workspace has no uncommitted changes",
      changed_relevant_files: [],
      dependency_changes: [],
    };
  }

  return {
    status: "fresh",
    rerun_advice: "rerun_not_needed",
    reason: "workspace changed, but not in this test's dependency graph",
    changed_relevant_files: [],
    dependency_changes: [],
  };
}

export function summarizeFreshness(tests, workspaceState = getWorkspaceState()) {
  const assessments = tests.map((test) => ({
    test,
    freshness: assessTestFreshness(test, workspaceState),
  }));
  return {
    workspace: workspaceState,
    stale: assessments.filter((item) => item.freshness.status === "stale").length,
    fresh: assessments.filter((item) => item.freshness.status === "fresh").length,
    unknown: assessments.filter((item) => item.freshness.status === "unknown").length,
    assessments,
  };
}
