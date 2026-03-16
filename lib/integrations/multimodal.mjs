#!/usr/bin/env node
/**
 * multimodal.mjs — Shared image/audio processing for crewswarm
 * 
 * Supports:
 *   - Image analysis via Groq Vision (Llama 4 Scout) or Gemini 2.0 Flash
 *   - Audio transcription via Groq Whisper or Gemini
 *   - Used by Telegram, WhatsApp, dashboard, and CrewChat
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSwarmConfig } from "../runtime/config.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

const cfg = loadSwarmConfig();
const providers = cfg.providers || {};

// Provider selection priority: Groq (fast/cheap) → Gemini → fail
const GROQ_KEY = providers.groq?.apiKey || "";
const GEMINI_KEY = providers.google?.apiKey || "";

const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"; // 216x realtime, $0.04/hr
const GEMINI_MODEL = "gemini-2.0-flash-exp";

// ── Image Analysis ────────────────────────────────────────────────────────────

/**
 * Analyze an image via URL or base64
 * @param {string} imageUrlOrBase64 - Public URL or base64 data URI
 * @param {string} prompt - Question/instruction for the model
 * @param {object} options - { provider: 'groq'|'gemini'|'auto' }
 * @returns {Promise<string>} - Model's response
 */
export async function analyzeImage(imageUrlOrBase64, prompt = "Describe this image in detail.", options = {}) {
  const provider = options.provider || "auto";
  
  // Auto-select: prefer Groq (cheaper), fallback to Gemini
  if (provider === "auto") {
    if (GROQ_KEY) return analyzeImageGroq(imageUrlOrBase64, prompt);
    if (GEMINI_KEY) return analyzeImageGemini(imageUrlOrBase64, prompt);
    throw new Error("No vision provider configured (need Groq or Gemini API key)");
  }
  
  if (provider === "groq") return analyzeImageGroq(imageUrlOrBase64, prompt);
  if (provider === "gemini") return analyzeImageGemini(imageUrlOrBase64, prompt);
  throw new Error(`Unknown vision provider: ${provider}`);
}

async function analyzeImageGroq(imageUrlOrBase64, prompt) {
  if (!GROQ_KEY) throw new Error("Groq API key missing (providers.groq.apiKey)");
  
  // Convert to message format Groq expects
  const isUrl = imageUrlOrBase64.startsWith("http://") || imageUrlOrBase64.startsWith("https://");
  const imageContent = isUrl 
    ? { type: "image_url", image_url: { url: imageUrlOrBase64 } }
    : { type: "image_url", image_url: { url: imageUrlOrBase64 } }; // base64 also uses image_url
  
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            imageContent
          ]
        }
      ],
      temperature: 0.7,
      max_tokens: 1024
    })
  });
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Groq vision API error: ${res.status} ${error}`);
  }
  
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "No response from vision model";
}

async function analyzeImageGemini(imageUrlOrBase64, prompt) {
  if (!GEMINI_KEY) throw new Error("Gemini API key missing (providers.google.apiKey)");
  
  // Gemini expects base64 inline parts
  let imagePart;
  if (imageUrlOrBase64.startsWith("data:image/")) {
    // Extract mime and base64 from data URI
    const [mime, base64] = imageUrlOrBase64.replace(/^data:/, "").split(";base64,");
    imagePart = {
      inline_data: {
        mime_type: mime,
        data: base64
      }
    };
  } else if (imageUrlOrBase64.startsWith("http")) {
    // Download and convert to base64
    const imgRes = await fetch(imageUrlOrBase64);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buffer.toString("base64");
    const mime = imgRes.headers.get("content-type") || "image/jpeg";
    imagePart = {
      inline_data: {
        mime_type: mime,
        data: base64
      }
    };
  } else {
    // Already base64
    imagePart = {
      inline_data: {
        mime_type: "image/jpeg",
        data: imageUrlOrBase64
      }
    };
  }
  
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              imagePart
            ]
          }
        ]
      })
    }
  );
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${error}`);
  }
  
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from Gemini";
}

// ── Audio Transcription ───────────────────────────────────────────────────────

/**
 * Transcribe audio file to text
 * @param {Buffer} audioBuffer - Raw audio file data
 * @param {object} options - { provider: 'groq'|'gemini'|'auto', language: 'en'|'auto' }
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeAudio(audioBuffer, options = {}) {
  const provider = options.provider || "auto";
  
  // Auto-select: prefer Groq (faster, cheaper)
  if (provider === "auto") {
    if (GROQ_KEY) return transcribeAudioGroq(audioBuffer, options);
    if (GEMINI_KEY) return transcribeAudioGemini(audioBuffer, options);
    throw new Error("No audio provider configured (need Groq or Gemini API key)");
  }
  
  if (provider === "groq") return transcribeAudioGroq(audioBuffer, options);
  if (provider === "gemini") return transcribeAudioGemini(audioBuffer, options);
  throw new Error(`Unknown audio provider: ${provider}`);
}

async function transcribeAudioGroq(audioBuffer, options) {
  if (!GROQ_KEY) throw new Error("Groq API key missing (providers.groq.apiKey)");
  
  // Groq uses multipart/form-data (OpenAI-compatible endpoint)
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer]), "audio.webm");
  formData.append("model", GROQ_WHISPER_MODEL);
  if (options.language && options.language !== "auto") {
    formData.append("language", options.language);
  }
  
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_KEY}`
    },
    body: formData
  });
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Groq Whisper API error: ${res.status} ${error}`);
  }
  
  const data = await res.json();
  return data.text || "";
}

async function transcribeAudioGemini(audioBuffer, options) {
  if (!GEMINI_KEY) throw new Error("Gemini API key missing (providers.google.apiKey)");
  
  const base64 = audioBuffer.toString("base64");
  
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Transcribe this audio to text. Only return the transcription, no other commentary." },
              {
                inline_data: {
                  mime_type: "audio/webm",
                  data: base64
                }
              }
            ]
          }
        ]
      })
    }
  );
  
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Gemini audio API error: ${res.status} ${error}`);
  }
  
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Download file from URL to Buffer
 */
export async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Convert file path to base64 data URI
 */
export function fileToBase64DataUri(filePath, mimeType = "image/jpeg") {
  const buffer = readFileSync(filePath);
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Check if provider is configured
 */
export function hasVisionProvider() {
  return !!(GROQ_KEY || GEMINI_KEY);
}

export function hasAudioProvider() {
  return !!(GROQ_KEY || GEMINI_KEY);
}

/**
 * Get active provider names
 */
export function getActiveProviders() {
  const providers = [];
  if (GROQ_KEY) providers.push("groq");
  if (GEMINI_KEY) providers.push("gemini");
  return providers;
}
