#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
const packagePath = path.join(repoRoot, 'package.json');
const args = new Set(process.argv.slice(2));
const releaseMode = args.has('--release');

const CATEGORY_MAP = new Map([
  ['feat', 'Added'],
  ['feature', 'Added'],
  ['fix', 'Fixed'],
  ['bugfix', 'Fixed'],
  ['perf', 'Changed'],
  ['refactor', 'Changed'],
  ['change', 'Changed'],
  ['chore', 'Changed'],
  ['docs', 'Documentation'],
  ['doc', 'Documentation'],
  ['test', 'Testing'],
  ['build', 'Infrastructure'],
  ['ci', 'Infrastructure'],
  ['infra', 'Infrastructure'],
  ['security', 'Security'],
  ['sec', 'Security'],
  ['deps', 'Changed']
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function git(argsList) {
  return execFileSync('git', argsList, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTrackedIssuesFromEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return new Map();
  }

  try {
    const payload = readJson(eventPath);
    const issues = new Map();
    const addIssue = (number, title) => {
      if (!number || !title) {
        return;
      }
      issues.set(String(number), title.trim());
    };

    addIssue(payload.pull_request?.number, payload.pull_request?.title);
    addIssue(payload.issue?.number, payload.issue?.title);

    for (const commit of payload.commits ?? []) {
      const matches = commit.message?.match(/#(\d+)/g) ?? [];
      for (const match of matches) {
        const issueNumber = match.slice(1);
        addIssue(issueNumber, commit.message.split('\n')[0]);
      }
    }

    return issues;
  } catch {
    return new Map();
  }
}

function getLatestVersionSection(changelog) {
  const matches = [...changelog.matchAll(/^## \[(?!Unreleased\])([^\]]+)\]/gm)];
  return matches[0]?.[1] ?? null;
}

function normalizeVersionTag(version) {
  if (!version) {
    return null;
  }
  return version.startsWith('v') ? version : `v${version}`;
}

function getCommitRange(baseTag) {
  if (!baseTag) {
    return 'HEAD';
  }

  try {
    git(['rev-parse', '--verify', baseTag]);
    return `${baseTag}..HEAD`;
  } catch {
    return 'HEAD';
  }
}

function parseCommit(raw, eventIssues) {
  const [hash, subject, date] = raw.split('\x1f');
  const conventional = subject.match(/^([A-Za-z]+)(?:\(([^)]+)\))?!?:\s+(.+)$/);
  const token = conventional?.[1]?.toLowerCase();
  const scope = conventional?.[2]?.trim();
  const summary = (conventional?.[3] ?? subject).trim();
  const category = CATEGORY_MAP.get(token) ?? 'Changed';
  const issueRefs = [...new Set((subject.match(/#(\d+)/g) ?? []).map((match) => match.slice(1)))];
  const issueNotes = issueRefs.map((issue) => `#${issue}${eventIssues.get(issue) ? ` ${eventIssues.get(issue)}` : ''}`);

  let line = `- ${summary}`;
  if (scope) {
    line += ` (${scope})`;
  }
  if (issueNotes.length > 0) {
    line += ` — ${issueNotes.join(', ')}`;
  }
  line += ` (${date})`;

  return { hash, category, line };
}

function buildSections(commits) {
  const buckets = new Map();

  for (const category of ['Added', 'Changed', 'Fixed', 'Security', 'Documentation', 'Testing', 'Infrastructure']) {
    buckets.set(category, []);
  }

  for (const commit of commits) {
    buckets.get(commit.category)?.push(commit.line);
  }

  return [...buckets.entries()].filter(([, entries]) => entries.length > 0);
}

function buildUnreleasedSection(commits, generatedOn) {
  const sections = buildSections(commits);
  const lines = [
    '## [Unreleased]',
    '',
    `> Auto-generated from git history${process.env.GITHUB_EVENT_NAME ? ' and GitHub event metadata' : ''}.`,
    `> Last generated: ${generatedOn}. Run \`npm run changelog:generate\` to refresh this section.`,
    ''
  ];

  if (sections.length === 0) {
    lines.push('No unreleased changes detected since the last tagged release.', '');
    return lines.join('\n');
  }

  for (const [category, entries] of sections) {
    lines.push(`### ${category}`, '');
    lines.push(...entries, '');
  }

  return lines.join('\n').trimEnd();
}

function replaceUnreleasedSection(changelog, newSection) {
  const unreleasedPattern = /^## \[Unreleased\][\s\S]*?(?=^## \[|\Z)/m;
  if (unreleasedPattern.test(changelog)) {
    return changelog.replace(unreleasedPattern, newSection + '\n\n');
  }

  return changelog.replace(
    /^(The format is based on .*?\.\n)/s,
    `$1\n${newSection}\n\n`
  );
}

function finalizeRelease(changelog, version, releaseDate) {
  const unreleasedPattern = /^## \[Unreleased\][\s\S]*?(?=^## \[|\Z)/m;
  const unreleasedMatch = changelog.match(unreleasedPattern);
  if (!unreleasedMatch) {
    return changelog;
  }

  const unreleasedBody = unreleasedMatch[0]
    .replace(/^## \[Unreleased\]\n*/m, '')
    .replace(/^> .*$/gm, '')
    .trim();

  const releaseHeading = `## [${version}] - ${releaseDate}`;
  const releaseBlock = unreleasedBody
    ? `${releaseHeading}\n\n${unreleasedBody}\n`
    : `${releaseHeading}\n\n- No categorized changes.\n`;

  return changelog.replace(
    unreleasedPattern,
    `## [Unreleased]\n\n> Auto-generated from git history and GitHub event metadata.\n> Last generated: ${releaseDate}. Run \`npm run changelog:generate\` to refresh this section.\n\n${releaseBlock}\n`
  );
}

const changelog = fs.readFileSync(changelogPath, 'utf8');
const pkg = readJson(packagePath);
const latestVersion = getLatestVersionSection(changelog);
const latestTag = normalizeVersionTag(latestVersion);
const commitRange = getCommitRange(latestTag);
const rawLog = git([
  'log',
  '--reverse',
  '--date=short',
  `--pretty=format:%H%x1f%s%x1f%ad`,
  commitRange
]);

const eventIssues = getTrackedIssuesFromEvent();
const commits = rawLog
  .split('\n')
  .filter(Boolean)
  .map((line) => parseCommit(line, eventIssues))
  .filter((entry) => entry.hash);

const generatedOn = new Date().toISOString().slice(0, 10);
let nextChangelog = replaceUnreleasedSection(changelog, buildUnreleasedSection(commits, generatedOn));

if (releaseMode) {
  nextChangelog = finalizeRelease(nextChangelog, pkg.version, generatedOn);
}

fs.writeFileSync(changelogPath, nextChangelog);
process.stdout.write(
  `Updated CHANGELOG.md using ${commits.length} commit${commits.length === 1 ? '' : 's'} from ${commitRange}.\n`
);
