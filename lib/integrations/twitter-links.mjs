import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TWEET_URL_RE =
  /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[^\s]*)/gi;
const DEFAULT_TIMEOUT_MS = Number(
  process.env.CREWSWARM_TWITTER_FETCH_TIMEOUT_MS || 20_000,
);
const DEFAULT_MAX_LINKS = Number(
  process.env.CREWSWARM_TWITTER_FETCH_MAX_LINKS || 2,
);
const DEFAULT_CACHE_TTL_MS = Number(
  process.env.CREWSWARM_TWITTER_FETCH_CACHE_MS || 10 * 60 * 1000,
);

const tweetCache = new Map();

function splitArgs(raw = "") {
  return String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function resolveTwitterCommands() {
  const home = os.homedir();
  const configuredBin = process.env.CREWSWARM_TWITTER_CLI_BIN || "";
  const configuredArgs = splitArgs(process.env.CREWSWARM_TWITTER_CLI_ARGS || "");
  const candidates = [];

  if (configuredBin) {
    candidates.push({ bin: configuredBin, args: configuredArgs });
  }

  candidates.push(
    { bin: path.join(home, ".local", "bin", "twitter"), args: [] },
    { bin: "/usr/local/bin/twitter", args: [] },
    { bin: "/opt/homebrew/bin/twitter", args: [] },
    { bin: "twitter", args: [] },
  );

  return candidates.filter(Boolean);
}

function parseTweetLinks(text = "") {
  const found = new Map();
  let match;
  while ((match = TWEET_URL_RE.exec(String(text || "")))) {
    const [, authorHint, tweetId] = match;
    if (!found.has(tweetId)) {
      found.set(tweetId, {
        url: match[0],
        tweetId,
        authorHint,
      });
    }
  }
  return Array.from(found.values());
}

function hasExistingExpansion(text = "") {
  return String(text || "").includes("[X link context]");
}

function trimText(value = "", max = 280) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatMetric(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTweetContext(link, payload) {
  const tweets = Array.isArray(payload?.data) ? payload.data : [];
  if (!tweets.length) return "";

  const main = tweets[0];
  const replies = tweets.slice(1, 4);
  const metrics = main.metrics || {};
  const stats = [
    Number.isFinite(metrics.likes) ? `${formatMetric(metrics.likes)} likes` : null,
    Number.isFinite(metrics.retweets)
      ? `${formatMetric(metrics.retweets)} reposts`
      : null,
    Number.isFinite(metrics.replies)
      ? `${formatMetric(metrics.replies)} replies`
      : null,
    Number.isFinite(metrics.views) ? `${formatMetric(metrics.views)} views` : null,
  ].filter(Boolean);

  const lines = [
    `[X link context]`,
    `URL: ${link.url}`,
    `Author: @${main.author?.screenName || link.authorHint || "unknown"}${main.author?.name ? ` (${main.author.name})` : ""}`,
    main.createdAtLocal ? `Posted: ${main.createdAtLocal}` : null,
    `Tweet: ${trimText(main.text, 400)}`,
    stats.length ? `Stats: ${stats.join(" · ")}` : null,
    Array.isArray(main.urls) && main.urls.length
      ? `Expanded URLs: ${main.urls.join(", ")}`
      : null,
    replies.length
      ? `Replies:\n${replies
          .map(
            (reply) =>
              `- @${reply.author?.screenName || "unknown"}: ${trimText(reply.text, 220)}`,
          )
          .join("\n")}`
      : null,
    `[/X link context]`,
  ].filter(Boolean);

  return lines.join("\n");
}

function formatTweetFallback(link, errorMessage = "") {
  const lines = [
    `[X link context]`,
    `URL: ${link.url}`,
    `Author hint: @${link.authorHint || "unknown"}`,
    `Tweet ID: ${link.tweetId}`,
    `Status: Tweet link detected but automatic fetch failed.`,
    errorMessage ? `Fetch error: ${trimText(errorMessage, 220)}` : null,
    `Instruction: Treat this as a referenced X/Twitter post and tell the user fetch/auth is currently unavailable if exact tweet text is needed.`,
    `[/X link context]`,
  ].filter(Boolean);

  return lines.join("\n");
}

function fetchViaCommand(command, link, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command.bin,
      [...(command.args || []), "tweet", link.url, "--json"],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`twitter fetch timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            trimText(stderr || stdout || `twitter exited ${code}`, 500),
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(
          new Error(
            `invalid twitter-cli JSON output: ${trimText(err.message, 200)}`,
          ),
        );
      }
    });
  });
}

async function fetchTweetPayload(link, timeoutMs) {
  const now = Date.now();
  const cached = tweetCache.get(link.tweetId);
  if (cached && now - cached.ts < DEFAULT_CACHE_TTL_MS) {
    return cached.payload;
  }

  let lastError = null;
  for (const command of resolveTwitterCommands()) {
    try {
      if (
        command.bin.includes("/") &&
        command.bin !== "twitter" &&
        !fs.existsSync(command.bin)
      ) {
        continue;
      }
      const payload = await fetchViaCommand(command, link, timeoutMs);
      tweetCache.set(link.tweetId, { ts: now, payload });
      return payload;
    } catch (err) {
      lastError = err;
      if (err?.code === "ENOENT") continue;
      if (/ENOENT/.test(err?.message || "")) continue;
    }
  }

  if (lastError) throw lastError;
  throw new Error(
    "twitter CLI not found; set CREWSWARM_TWITTER_CLI_BIN or install twitter-cli",
  );
}

export async function enrichTwitterLinks(text, options = {}) {
  const source = options.source || "chat";
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxLinks = Number(options.maxLinks || DEFAULT_MAX_LINKS);
  const input = String(text || "");

  if (!input.trim() || hasExistingExpansion(input)) {
    return { text: input, appended: false, links: [], errors: [] };
  }

  const links = parseTweetLinks(input).slice(0, maxLinks);
  if (!links.length) {
    return { text: input, appended: false, links: [], errors: [] };
  }

  const blocks = [];
  const errors = [];
  for (const link of links) {
    try {
      const payload = await fetchTweetPayload(link, timeoutMs);
      const block = formatTweetContext(link, payload);
      if (block) blocks.push(block);
    } catch (err) {
      errors.push({
        tweetId: link.tweetId,
        url: link.url,
        error: err?.message || String(err),
      });
    }
  }

  if (!blocks.length) {
    const fallbackBlocks = errors.map((err) =>
      formatTweetFallback(
        links.find((link) => link.tweetId === err.tweetId) || {
          url: err.url,
          tweetId: err.tweetId,
          authorHint: "",
        },
        err.error,
      ),
    );
    if (!fallbackBlocks.length) {
      return { text: input, appended: false, links, errors, source };
    }
    return {
      text: `${input}\n\n${fallbackBlocks.join("\n\n")}`.trim(),
      appended: true,
      links,
      errors,
      source,
    };
  }

  return {
    text: `${input}\n\n${blocks.join("\n\n")}`.trim(),
    appended: true,
    links,
    errors,
    source,
  };
}

export function _parseTweetLinksForTest(text) {
  return parseTweetLinks(text);
}
