/**
 * Unit tests for lib/integrations/multimodal.mjs
 *
 * The network-calling functions (analyzeImage, transcribeAudio, downloadToBuffer)
 * are skipped since they hit external APIs. We test the pure helper functions:
 * fileToBase64DataUri, hasVisionProvider, hasAudioProvider, getActiveProviders.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Dynamic import — the module runs loadSwarmConfig() at import time
let mod;

describe("multimodal module", () => {
  it("exports the expected functions", async () => {
    mod = await import("../../lib/integrations/multimodal.mjs");
    assert.equal(typeof mod.analyzeImage, "function");
    assert.equal(typeof mod.transcribeAudio, "function");
    assert.equal(typeof mod.downloadToBuffer, "function");
    assert.equal(typeof mod.fileToBase64DataUri, "function");
    assert.equal(typeof mod.hasVisionProvider, "function");
    assert.equal(typeof mod.hasAudioProvider, "function");
    assert.equal(typeof mod.getActiveProviders, "function");
  });
});

describe("fileToBase64DataUri", () => {
  const tmpDir = join(tmpdir(), `multimodal-test-${Date.now()}`);

  it("converts a file to base64 data URI", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "test.png");
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    writeFileSync(filePath, content);

    const uri = mod.fileToBase64DataUri(filePath, "image/png");
    assert.ok(uri.startsWith("data:image/png;base64,"));

    // Decode and verify round-trip
    const b64Part = uri.split(";base64,")[1];
    const decoded = Buffer.from(b64Part, "base64");
    assert.deepEqual(decoded, content);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses default mime type image/jpeg", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "test.jpg");
    writeFileSync(filePath, Buffer.from("fake-jpeg-data"));

    const uri = mod.fileToBase64DataUri(filePath);
    assert.ok(uri.startsWith("data:image/jpeg;base64,"));

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws for non-existent file", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    assert.throws(() => {
      mod.fileToBase64DataUri("/tmp/nonexistent-file-xyz-12345.png");
    });
  });
});

describe("hasVisionProvider", () => {
  it("returns a boolean", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    const result = mod.hasVisionProvider();
    assert.equal(typeof result, "boolean");
  });
});

describe("hasAudioProvider", () => {
  it("returns a boolean", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    const result = mod.hasAudioProvider();
    assert.equal(typeof result, "boolean");
  });
});

describe("getActiveProviders", () => {
  it("returns an array", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    const result = mod.getActiveProviders();
    assert.ok(Array.isArray(result));
  });

  it("only contains known provider names", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    const result = mod.getActiveProviders();
    const valid = new Set(["groq", "gemini"]);
    for (const p of result) {
      assert.ok(valid.has(p), `Unexpected provider: ${p}`);
    }
  });
});

describe("analyzeImage (provider selection)", () => {
  it("throws for unknown provider", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    await assert.rejects(
      () => mod.analyzeImage("http://example.com/img.png", "describe", { provider: "nonexistent" }),
      /Unknown vision provider/
    );
  });
});

describe("transcribeAudio (provider selection)", () => {
  it("throws for unknown provider", async () => {
    if (!mod) mod = await import("../../lib/integrations/multimodal.mjs");
    await assert.rejects(
      () => mod.transcribeAudio(Buffer.from("audio"), { provider: "nonexistent" }),
      /Unknown audio provider/
    );
  });
});
