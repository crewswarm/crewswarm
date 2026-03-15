import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  _parseTweetLinksForTest,
  enrichTwitterLinks,
} from "../../lib/integrations/twitter-links.mjs";

const envKeys = [
  "CREWSWARM_TWITTER_CLI_BIN",
  "CREWSWARM_TWITTER_CLI_ARGS",
];

test.afterEach(() => {
  for (const key of envKeys) delete process.env[key];
});

test("parseTweetLinks finds unique x.com status URLs", () => {
  const links = _parseTweetLinksForTest(
    [
      "check this https://x.com/jedisct1/status/2030962676382249415?s=42",
      "and this https://twitter.com/openai/status/1234567890123456789",
      "duplicate https://x.com/jedisct1/status/2030962676382249415?s=42",
    ].join("\n"),
  );

  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map((entry) => entry.tweetId),
    ["2030962676382249415", "1234567890123456789"],
  );
});

test("enrichTwitterLinks appends tweet context from twitter-cli JSON", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-twitter-test-"));
  const cliScript = path.join(tmpDir, "fake-twitter-cli.mjs");
  fs.writeFileSync(
    cliScript,
    `
const url = process.argv[3];
process.stdout.write(JSON.stringify({
  ok: true,
  schema_version: "1",
  data: [
    {
      id: "2030962676382249415",
      text: "A terminal-first CLI for Twitter/X. No API key needed.",
      author: { name: "Frank", screenName: "jedisct1" },
      metrics: { likes: 1113, retweets: 96, replies: 36, views: 93847 },
      createdAtLocal: "2026-03-09 07:03",
      urls: ["https://github.com/jackwener/twitter-cli/"]
    },
    {
      id: "2031011344296604015",
      text: "@jedisct1 is this safe or will its users get banned?",
      author: { screenName: "TomDavenport" },
      metrics: { likes: 17, replies: 4 }
    }
  ],
  requestedUrl: url
}));
    `,
    "utf8",
  );

  process.env.CREWSWARM_TWITTER_CLI_BIN = process.execPath;
  process.env.CREWSWARM_TWITTER_CLI_ARGS = cliScript;

  const result = await enrichTwitterLinks(
    "Summarize this thread https://x.com/jedisct1/status/2030962676382249415?s=42",
    { source: "test" },
  );

  assert.equal(result.appended, true);
  assert.match(result.text, /\[X link context\]/);
  assert.match(result.text, /Author: @jedisct1 \(Frank\)/);
  assert.match(result.text, /Tweet: A terminal-first CLI for Twitter\/X/);
  assert.match(result.text, /Replies:\n- @TomDavenport:/);
  assert.match(result.text, /Expanded URLs: https:\/\/github.com\/jackwener\/twitter-cli\//);
});

test("enrichTwitterLinks is a no-op when already expanded", async () => {
  const original = "Check this\n\n[X link context]\nfoo\n[/X link context]";
  const result = await enrichTwitterLinks(original, { source: "test" });
  assert.equal(result.text, original);
  assert.equal(result.appended, false);
});
