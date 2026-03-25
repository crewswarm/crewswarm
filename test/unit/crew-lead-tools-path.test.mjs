import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolPathArgument } from "../../lib/crew-lead/tools.mjs";

describe("sanitizeToolPathArgument", () => {
  it("strips glued prose after .md", () => {
    assert.equal(
      sanitizeToolPathArgument(
        "/home/user/stinki-shrine/content-draft.md and then summarize",
      ),
      "/home/user/stinki-shrine/content-draft.md",
    );
  });

  it("strips ' and ' without 'then'", () => {
    assert.equal(
      sanitizeToolPathArgument("/tmp/foo/seo-strategy.md and compare"),
      "/tmp/foo/seo-strategy.md",
    );
  });

  it("leaves clean paths unchanged", () => {
    assert.equal(
      sanitizeToolPathArgument("/home/user/stinki-shrine/content-draft.md"),
      "/home/user/stinki-shrine/content-draft.md",
    );
  });

  it("handles backtick-wrapped path", () => {
    assert.equal(
      sanitizeToolPathArgument("`/x/y.md` and more"),
      "/x/y.md",
    );
  });
});
