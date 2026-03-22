#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const adapterPath = path.join(root, "src", "tools", "gemini", "crew-adapter.ts");
const markerPath = path.join(root, "src", "tools", "sandbox-executor.ts");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function extractAdapterToolNames(src) {
  const matches = [...src.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  return uniq(matches).sort();
}

function extractMarkerTools(src) {
  const matches = [...src.matchAll(/@@([A-Z_]+)/g)].map((m) => `@@${m[1]}`);
  const skip = new Set(["@@END_FILE"]);
  return uniq(matches).filter((m) => !skip.has(m)).sort();
}

function main() {
  const adapterSrc = read(adapterPath);
  const markerSrc = read(markerPath);

  const adapterTools = extractAdapterToolNames(adapterSrc);
  const markerTools = extractMarkerTools(markerSrc);

  const report = {
    generatedAt: new Date().toISOString(),
    files: {
      adapter: adapterPath,
      marker: markerPath,
    },
    counts: {
      adapterDeclarations: adapterTools.length,
      markerCommands: markerTools.length,
    },
    adapterTools,
    markerTools,
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
