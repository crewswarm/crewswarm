#!/usr/bin/env node
/**
 * migrate-chat-history.mjs — Fix chat history file locations
 * 
 * Due to a bug where loadHistory/appendHistory were called with swapped parameters,
 * chat history files ended up in the wrong directory structure.
 * 
 * This script:
 * 1. Moves root-level .jsonl files to default/ directory
 * 2. Moves misplaced user directories (e.g., owner/system.jsonl) to default/
 * 3. Merges files if both old and new locations exist
 * 
 * Usage: node scripts/migrate-chat-history.mjs [--dry-run]
 */

import fs from "fs";
import path from "path";
import os from "os";

const HISTORY_DIR = path.join(os.homedir(), ".crewswarm", "chat-history");
const DEFAULT_USER_DIR = path.join(HISTORY_DIR, "default");
const DRY_RUN = process.argv.includes("--dry-run");

function mergeJsonlFiles(oldPath, newPath) {
  // Read both files
  const oldLines = fs.readFileSync(oldPath, "utf8").split("\n").filter(line => line.trim());
  const newLines = fs.existsSync(newPath) 
    ? fs.readFileSync(newPath, "utf8").split("\n").filter(line => line.trim())
    : [];

  // Parse and merge by timestamp
  const messages = [];
  for (const line of [...oldLines, ...newLines]) {
    try {
      const msg = JSON.parse(line);
      messages.push(msg);
    } catch (e) {
      console.warn(`  ⚠ Skipping invalid JSON line: ${line.slice(0, 60)}`);
    }
  }

  // Sort by timestamp and deduplicate
  messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const uniqueMessages = [];
  const seen = new Set();
  for (const msg of messages) {
    const key = `${msg.role}:${msg.ts}:${msg.content?.slice(0, 50)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueMessages.push(msg);
    }
  }

  return uniqueMessages;
}

function main() {
  if (!fs.existsSync(HISTORY_DIR)) {
    console.log("No chat history directory found. Nothing to migrate.");
    return;
  }

  // Ensure default user directory exists
  fs.mkdirSync(DEFAULT_USER_DIR, { recursive: true });

  const entries = fs.readdirSync(HISTORY_DIR);
  let moved = 0;
  let merged = 0;
  let skipped = 0;

  console.log("=== Migrating chat history to default/ directory ===\n");

  // Pass 1: Move root-level .jsonl files to default/
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;

    const oldPath = path.join(HISTORY_DIR, entry);
    const newPath = path.join(DEFAULT_USER_DIR, entry);

    if (fs.existsSync(newPath)) {
      // Need to merge
      console.log(`⚠ Merging: ${entry} (found in both locations)`);
      if (!DRY_RUN) {
        try {
          const mergedMessages = mergeJsonlFiles(oldPath, newPath);
          const content = mergedMessages.map(m => JSON.stringify(m)).join("\n") + "\n";
          fs.writeFileSync(newPath, content, "utf8");
          fs.unlinkSync(oldPath);
          console.log(`  ✓ Merged ${mergedMessages.length} messages into default/${entry}`);
          merged++;
        } catch (e) {
          console.error(`  ✗ Merge failed: ${e.message}`);
          skipped++;
        }
      } else {
        console.log(`  → Would merge and write to default/${entry}`);
        merged++;
      }
    } else {
      // Simple move
      if (DRY_RUN) {
        console.log(`→ Would move: ${entry} → default/${entry}`);
      } else {
        fs.renameSync(oldPath, newPath);
        console.log(`✓ Moved: ${entry} → default/${entry}`);
      }
      moved++;
    }
  }

  // Pass 2: Move misplaced user directories (e.g., owner/ with files inside)
  for (const entry of entries) {
    const entryPath = path.join(HISTORY_DIR, entry);
    
    // Skip if not a directory, or if it's the correct "default" directory
    if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isDirectory() || entry === "default") {
      continue;
    }

    const sessionId = entry;
    const sessionFiles = fs.readdirSync(entryPath).filter(f => f.endsWith(".jsonl"));

    if (sessionFiles.length === 0) {
      console.log(`⊘ Empty directory: ${entry}/ (skipping)`);
      if (!DRY_RUN) {
        fs.rmdirSync(entryPath);
        console.log(`  Removed empty directory.`);
      }
      skipped++;
      continue;
    }

    for (const file of sessionFiles) {
      const oldPath = path.join(entryPath, file);
      const subSessionId = file.replace(".jsonl", "");
      
      // Determine final session name
      // If file is "default.jsonl", use the directory name as session
      // Otherwise, combine: owner/system.jsonl → owner-system.jsonl
      const finalSessionId = subSessionId === "default" ? sessionId : `${sessionId}-${subSessionId}`;
      const newPath = path.join(DEFAULT_USER_DIR, `${finalSessionId}.jsonl`);

      if (fs.existsSync(newPath)) {
        console.log(`⚠ Conflict: ${sessionId}/${file} vs default/${finalSessionId}.jsonl (already exists)`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`→ Would move: ${sessionId}/${file} → default/${finalSessionId}.jsonl`);
      } else {
        fs.renameSync(oldPath, newPath);
        console.log(`✓ Moved: ${sessionId}/${file} → default/${finalSessionId}.jsonl`);
      }
      moved++;
    }

    // Remove empty directory after migration
    if (!DRY_RUN) {
      try {
        if (fs.readdirSync(entryPath).length === 0) {
          fs.rmdirSync(entryPath);
          console.log(`  Removed empty directory: ${entry}/`);
        }
      } catch (e) {
        console.warn(`  Could not remove directory ${entry}/: ${e.message}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`${DRY_RUN ? "Would migrate" : "Migrated"} ${moved} file(s)`);
  console.log(`${DRY_RUN ? "Would merge" : "Merged"} ${merged} file(s)`);
  console.log(`Skipped ${skipped} file(s)`);
  
  if (DRY_RUN) {
    console.log("\nRun without --dry-run to perform the migration.");
  } else if (moved > 0 || merged > 0) {
    console.log("\n✓ Chat history migration complete!");
    console.log("\nYour old chats have been restored. Restart crew-lead to see them:");
    console.log("  cd /Users/jeffhobbs/Desktop/CrewSwarm");
    console.log("  pkill -f crew-lead.mjs && node crew-lead.mjs &");
    console.log("\nThen refresh the dashboard at http://127.0.0.1:4319");
  }
}

main();
