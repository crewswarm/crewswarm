import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolPathArgument } from "../../lib/crew-lead/tools.mjs";

describe("sanitizeToolPathArgument", () => {
  it("strips glued prose after .md", () => {
    assert.equal(
      sanitizeToolPathArgument(
        "/Users/jeffhobbs/Desktop/stinki-shrine/content-draft.md and then summarize",
      ),
      "/Users/jeffhobbs/Desktop/stinki-shrine/content-draft.md",
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
      sanitizeToolPathArgument("/Users/jeffhobbs/Desktop/stinki-shrine/content-draft.md"),
      "/Users/jeffhobbs/Desktop/stinki-shrine/content-draft.md",
    );
  });

  it("handles backtick-wrapped path", () => {
    assert.equal(
      sanitizeToolPathArgument("`/x/y.md` and more"),
      "/x/y.md",
    );
  });
});
