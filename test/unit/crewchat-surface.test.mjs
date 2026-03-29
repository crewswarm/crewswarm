import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SWIFT_PATH = path.join(ROOT, "apps", "crewchat", "CrewChat.swift");
const BUILD_PATH = path.join(ROOT, "apps", "crewchat", "build-crewchat.sh");

const swift = fs.readFileSync(SWIFT_PATH, "utf8");
const buildScript = fs.readFileSync(BUILD_PATH, "utf8");

describe("crewchat surface contract", () => {
  test("reads crewswarm config from ~/.crewswarm/crewswarm.json", () => {
    assert.match(swift, /\.crewswarm\/crewswarm\.json/);
    assert.match(swift, /loadCrewConfig\(\)/);
    assert.match(swift, /loadCrewSwarmJson\(\)/);
  });

  test("defaults dashboard API base to localhost dashboard port", () => {
    assert.match(swift, /let DASH_PORT\s+=\s+.*4319/);
    assert.match(swift, /let API_BASE\s+=\s+"http:\/\/127\.0\.0\.1:\\\(DASH_PORT\)"/);
  });

  test("supports crew-lead, direct CLI, and specialist agent modes", () => {
    assert.match(swift, /selectedMode: String = "crew-lead"/);
    assert.match(swift, /"cli:opencode"/);
    assert.match(swift, /"cli:cursor"/);
    assert.match(swift, /"agent:crew-coder"/);
    assert.match(swift, /switch between crew-lead, direct CLIs, and specialist agents/);
  });

  test("supports image upload and voice recording flows", () => {
    assert.match(swift, /pickImage/);
    assert.match(swift, /toggleVoiceRecording/);
    assert.match(swift, /apiPost\("\/api\/analyze-image"/);
    assert.match(swift, /apiPostMultipart\("\/api\/transcribe-audio"/);
  });

  test("loads project and per-agent chat history from crew-lead APIs", () => {
    assert.match(swift, /\/api\/crew-lead\/project-messages/);
    assert.match(swift, /\/api\/crew-lead\/history/);
    assert.match(swift, /\/api\/crew-lead\/clear/);
  });
});

describe("crewchat build script contract", () => {
  test("builds a macOS app bundle with crewchat identifiers", () => {
    assert.match(buildScript, /APP_NAME="crewchat"/);
    assert.match(buildScript, /CFBundleIdentifier/);
    assert.match(buildScript, /com\.crewswarm\.crewchat/);
    assert.match(buildScript, /CFBundleExecutable/);
  });

  test("declares microphone and photo usage descriptions", () => {
    assert.match(buildScript, /NSMicrophoneUsageDescription/);
    assert.match(buildScript, /record voice messages/);
    assert.match(buildScript, /NSPhotoLibraryUsageDescription/);
    assert.match(buildScript, /select images for analysis/);
  });

  test("documents the expected runtime features in build output", () => {
    assert.match(buildScript, /Mode picker for crew-lead, direct CLIs, and specialist agents/);
    assert.match(buildScript, /Per-agent \+ per-project chat history/);
    assert.match(buildScript, /Shows current engine per agent/);
  });
});
