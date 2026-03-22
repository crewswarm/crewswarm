import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_PATH = pathToFileURL(
  path.resolve("lib/agents/permissions.mjs"),
).href;

test("writeAgentPrompt persists raw prompt text while runtime reads augmented text", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "crewswarm-prompts-"));
  const cfgDir = path.join(tmpHome, ".crewswarm");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, "agent-prompts.json"),
    JSON.stringify(
      {
        "crew-coder": "Base prompt line",
      },
      null,
      2,
    ),
  );

  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    const mod = await import(`${MODULE_PATH}?t=${Date.now()}`);
    const rawBefore = mod.getRawAgentPrompts()["crew-coder"];
    const augmentedBefore = mod.getAgentPrompts()["crew-coder"];
    assert.match(augmentedBefore, /Shared Chat \+ @Mention System/);

    mod.writeAgentPrompt("crew-coder", `${rawBefore}\nExtra rule`);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(cfgDir, "agent-prompts.json"), "utf8"),
    );
    assert.equal(
      persisted["crew-coder"],
      "Base prompt line\nExtra rule",
    );
    assert.doesNotMatch(
      persisted["crew-coder"],
      /Shared Chat \+ @Mention System/,
    );

    const augmentedAfter = mod.getAgentPrompts()["crew-coder"];
    assert.match(augmentedAfter, /Shared Chat \+ @Mention System/);
    assert.match(augmentedAfter, /Extra rule/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});
