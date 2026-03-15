#!/usr/bin/env node
/**
 * tts.mjs — Text-to-Speech integration for crewswarm
 * 
 * Supports:
 *   - ElevenLabs (premium, natural voices)
 *   - Google TTS (free, good quality)
 *   - Groq TTS (coming soon)
 * 
 * Used by Telegram, WhatsApp, and dashboard bridges
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const path = join(homedir(), ".crewswarm", "crewswarm.json");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const cfg = loadConfig();
const providers = cfg.providers || {};

// Provider API keys
const ELEVENLABS_KEY = providers.elevenlabs?.apiKey || "";
const GOOGLE_KEY = providers.google?.apiKey || "";

// Default voices
const ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVENLABS_MODEL = "eleven_monolingual_v1";

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

/**
 * Convert text to speech via ElevenLabs
 * @param {string} text - Text to speak (max 5000 chars)
 * @param {object} options - { voiceId, modelId }
 * @returns {Promise<Buffer>} - Audio buffer (MP3)
 */
export async function elevenLabsTTS(text, options = {}) {
  if (!ELEVENLABS_KEY) {
    throw new Error("ElevenLabs API key missing (providers.elevenlabs.apiKey)");
  }
  
  if (!text || text.length === 0) {
    throw new Error("Text is required for TTS");
  }
  
  if (text.length > 5000) {
    throw new Error("Text too long for ElevenLabs (max 5000 chars)");
  }
  
  const voiceId = options.voiceId || ELEVENLABS_VOICE_ID;
  const modelId = options.modelId || ELEVENLABS_MODEL;
  
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    }
  );
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`ElevenLabs TTS error: ${res.status} ${error}`);
  }
  
  return Buffer.from(await res.arrayBuffer());
}

// ── Google Cloud TTS ──────────────────────────────────────────────────────────

/**
 * Convert text to speech via Google Cloud TTS
 * @param {string} text - Text to speak
 * @param {object} options - { languageCode, voice, speakingRate }
 * @returns {Promise<Buffer>} - Audio buffer (MP3)
 */
export async function googleTTS(text, options = {}) {
  if (!GOOGLE_KEY) {
    throw new Error("Google API key missing (providers.google.apiKey)");
  }
  
  if (!text || text.length === 0) {
    throw new Error("Text is required for TTS");
  }
  
  const languageCode = options.languageCode || "en-US";
  const voiceName = options.voice || options.voiceId || "en-US-Neural2-C"; // Support both formats
  const speakingRate = options.speakingRate || 1.0;
  
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode,
          name: voiceName
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate
        }
      })
    }
  );
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Google TTS error: ${res.status} ${error}`);
  }
  
  const data = await res.json();
  if (!data.audioContent) {
    throw new Error("No audio content in Google TTS response");
  }
  
  // Google returns base64-encoded audio
  return Buffer.from(data.audioContent, "base64");
}

// ── Auto-Select Provider ──────────────────────────────────────────────────────

/**
 * Convert text to speech using best available provider
 * Priority: ElevenLabs (best quality) → Google (free) → fail
 * @param {string} text - Text to speak
 * @param {object} options - Provider-specific options + { provider: 'elevenlabs'|'google'|'auto' }
 * @returns {Promise<Buffer>} - Audio buffer (MP3)
 */
export async function textToSpeech(text, options = {}) {
  const provider = options.provider || "auto";
  
  // Auto-select: prefer ElevenLabs (best quality), fallback to Google
  if (provider === "auto") {
    if (ELEVENLABS_KEY) return elevenLabsTTS(text, options);
    if (GOOGLE_KEY) return googleTTS(text, options);
    throw new Error("No TTS provider configured (need ElevenLabs or Google API key)");
  }
  
  if (provider === "elevenlabs") return elevenLabsTTS(text, options);
  if (provider === "google") return googleTTS(text, options);
  throw new Error(`Unknown TTS provider: ${provider}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check if TTS is available
 */
export function hasTTSProvider() {
  return !!(ELEVENLABS_KEY || GOOGLE_KEY);
}

/**
 * Get active TTS providers
 */
export function getActiveTTSProviders() {
  const providers = [];
  if (ELEVENLABS_KEY) providers.push("elevenlabs");
  if (GOOGLE_KEY) providers.push("google");
  return providers;
}

/**
 * Get voice configuration for a specific agent
 * @param {string} agentId - Agent ID (e.g., "crew-coder", "crew-pm")
 * @param {object} voiceMap - Voice map from bridge config
 * @returns {object} - { provider, voiceId, voice, modelId }
 */
export function getVoiceForAgent(agentId, voiceMap = {}) {
  const latestCfg = loadConfig();
  const agentList = Array.isArray(latestCfg.agents)
    ? latestCfg.agents
    : Array.isArray(latestCfg.agents?.list)
      ? latestCfg.agents.list
      : [];
  const agentConfig = agentList.find((agent) => agent?.id === agentId);
  const configuredVoice =
    agentConfig?.voice ||
    latestCfg?.tts?.voiceMap?.[agentId] ||
    (voiceMap && voiceMap[agentId]);

  if (configuredVoice?.voiceId || configuredVoice?.voice) {
    return {
      provider: configuredVoice.provider || "auto",
      voiceId: configuredVoice.voiceId,
      voice: configuredVoice.voice, // Google TTS voice name
      modelId: configuredVoice.modelId
    };
  }
  
  // Default voice (fallback)
  return {
    provider: "auto",
    voiceId: ELEVENLABS_VOICE_ID,
    voice: "en-US-Neural2-C", // Google default
    modelId: ELEVENLABS_MODEL
  };
}

/**
 * Strip markdown formatting from text for TTS
 * Removes: **bold**, *italic*, `code`, [links](url), @@COMMANDS, etc.
 */
export function stripMarkdownForTTS(text) {
  return text
    // Remove code blocks (```...```)
    .replace(/```[\s\S]*?```/g, '[code block]')
    // Remove inline code (`...`)
    .replace(/`([^`]+)`/g, '$1')
    // Remove bold (**text** or __text__)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Remove italic (*text* or _text_)
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove links [text](url)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove @@COMMANDS
    .replace(/@@\w+(\s+[^\n]+)?/g, '')
    // Remove emojis at start of lines (🎯 text)
    .replace(/^[🎯🎨🎤🎭🔥⚡✅❌⚠️💡🚀📊🔴🟡🟢]\s+/gm, '')
    // Remove heading markers (## text)
    .replace(/^#+\s+/gm, '')
    // Remove list markers (- text, * text, 1. text)
    .replace(/^[\s]*[-*]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Clean up multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate text for TTS at sentence boundary
 * Keeps replies short and conversational for voice
 */
export function truncateForTTS(text, maxChars = 800) {
  const cleaned = stripMarkdownForTTS(text);
  
  if (cleaned.length <= maxChars) return cleaned;
  
  // Split into sentences
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  let result = "";
  
  for (const sentence of sentences) {
    if (result.length + sentence.length > maxChars) {
      break;
    }
    result += sentence;
  }
  
  // If we truncated, add ellipsis
  if (result.length < cleaned.length) {
    result = result.trim() + "...";
  }
  
  return result.trim() || cleaned.slice(0, maxChars) + "...";
}

/**
 * Chunk text into TTS-safe segments (under 5000 chars)
 * Splits on sentence boundaries when possible
 */
export function chunkTextForTTS(text, maxChars = 4500) {
  // Strip markdown and truncate for concise voice replies
  const cleaned = truncateForTTS(text, 800); // Max 800 chars for voice
  
  if (cleaned.length <= maxChars) return [cleaned];
  
  const chunks = [];
  let current = "";
  
  // Split on sentences (period, exclamation, question mark)
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  
  if (current) chunks.push(current.trim());
  return chunks;
}
