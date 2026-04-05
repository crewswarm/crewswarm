#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractToolActions, scoreTaskTrajectory } from '../../lib/autoharness/index.mjs';

function defaultRoot() {
  return path.join(os.homedir(), '.crewswarm', 'autoharness', 'traces');
}

function parseArgs(argv) {
  const args = {
    root: defaultRoot(),
    limit: 200,
    agent: '',
    project: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) args.root = argv[++i];
    else if (arg === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]) || args.limit;
    else if (arg === '--agent' && argv[i + 1]) args.agent = String(argv[++i]);
    else if (arg === '--project' && argv[i + 1]) args.project = String(argv[++i]);
  }

  return args;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function loadJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function round(value) {
  return Number((value || 0).toFixed(3));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function topCounts(items, limit = 5) {
  const counts = new Map();
  for (const item of items.filter(Boolean)) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function classifyPrompt(prompt = '') {
  const text = String(prompt).toLowerCase();
  if (/\b(test|failing test|unit test|make tests pass|regression)\b/.test(text)) return 'test_repair';
  if (/\b(fix|bug|broken|error|crash|issue|regression)\b/.test(text)) return 'bugfix';
  if (/\b(refactor|cleanup|rename|simplify|extract)\b/.test(text)) return 'refactor';
  if (/\b(add|implement|create|build|support|introduce)\b/.test(text)) return 'feature';
  return 'analysis';
}

function describeTask(task) {
  const metrics = task.metrics || scoreTaskTrajectory({
    success: Boolean(task.success),
    actions: Array.isArray(task.actions) && task.actions.length > 0
      ? task.actions
      : extractToolActions(task.reply || ''),
  });
  return {
    ts: task.ts,
    agentId: task.agentId,
    projectId: task.projectId,
    engineUsed: task.engineUsed || 'unknown',
    success: Boolean(task.success),
    mode: classifyPrompt(task.prompt || ''),
    trajectoryScore: Number(metrics.trajectoryScore || 0),
    verificationScore: Number(metrics.verificationScore || 0),
    readBeforeWriteRatio: Number(metrics.readBeforeWriteRatio || 0),
    repeatedCommandPrefixes: Number(metrics.repeatedCommandPrefixes || 0),
    repeatedTargets: Number(metrics.repeatedTargets || 0),
    actionCount: Number(metrics.actionCount || 0),
    uniqueToolCount: Number(metrics.uniqueToolCount || 0),
    errorClass: task.errorClass || '',
    prompt: String(task.prompt || '').slice(0, 120).replace(/\s+/g, ' '),
  };
}

function printSection(title, lines) {
  console.log(`\n${title}`);
  for (const line of lines) console.log(line);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.root)) {
    console.error(`Trace root not found: ${args.root}`);
    process.exit(1);
  }

  const files = walk(args.root).filter((file) => file.endsWith('.tasks.jsonl'));
  const rows = files.flatMap((file) => loadJsonl(file));
  const filtered = rows
    .filter((row) => !args.agent || row.agentId === args.agent)
    .filter((row) => !args.project || row.projectId === args.project)
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, args.limit);

  const tasks = filtered.map(describeTask);
  const successes = tasks.filter((task) => task.success);
  const failures = tasks.filter((task) => !task.success);

  console.log(`Trace root: ${args.root}`);
  console.log(`Tasks analyzed: ${tasks.length}`);
  console.log(`Success rate: ${tasks.length ? round(successes.length / tasks.length) : 0}`);
  console.log(`Avg trajectory: ${round(average(tasks.map((task) => task.trajectoryScore)))}`);
  console.log(`Avg verification: ${round(average(tasks.map((task) => task.verificationScore)))}`);
  console.log(`Avg read-before-write: ${round(average(tasks.map((task) => task.readBeforeWriteRatio)))}`);
  console.log(`Avg actions: ${round(average(tasks.map((task) => task.actionCount)))}`);

  printSection('By Mode', topCounts(tasks.map((task) => task.mode), 10).map(([mode, count]) => {
    const modeTasks = tasks.filter((task) => task.mode === mode);
    return `- ${mode}: ${count} tasks, avg trajectory ${round(average(modeTasks.map((task) => task.trajectoryScore)))}, avg verification ${round(average(modeTasks.map((task) => task.verificationScore)))}`;
  }));

  printSection('Top Engines', topCounts(tasks.map((task) => task.engineUsed), 10).map(([engine, count]) => {
    const engineTasks = tasks.filter((task) => task.engineUsed === engine);
    return `- ${engine}: ${count} tasks, success ${round(engineTasks.filter((task) => task.success).length / engineTasks.length)}`;
  }));

  printSection('Top Error Classes', topCounts(failures.map((task) => task.errorClass), 10).map(([errorClass, count]) => `- ${errorClass}: ${count}`));

  const lowTrajectory = [...tasks]
    .sort((a, b) => a.trajectoryScore - b.trajectoryScore)
    .slice(0, 5);
  printSection('Lowest Trajectory Tasks', lowTrajectory.map((task) =>
    `- ${task.ts} [${task.agentId}/${task.engineUsed}] score=${round(task.trajectoryScore)} verify=${round(task.verificationScore)} read=${round(task.readBeforeWriteRatio)} prompt="${task.prompt}"`
  ));

  const churny = [...tasks]
    .sort((a, b) => (b.repeatedCommandPrefixes + b.repeatedTargets) - (a.repeatedCommandPrefixes + a.repeatedTargets))
    .slice(0, 5);
  printSection('Highest Churn Tasks', churny.map((task) =>
    `- ${task.ts} [${task.agentId}/${task.engineUsed}] repeatedCommands=${task.repeatedCommandPrefixes} repeatedTargets=${task.repeatedTargets} prompt="${task.prompt}"`
  ));
}

main();
