#!/usr/bin/env node
/**
 * Ollama model speed test - measures tokens/sec for each local model.
 * Requires Ollama running and models loaded (first run per model may be slower).
 */
const MODELS = [
  "deepseek-coder:1.3b",
  "qwen2.5:1.5b",
  "qwen2.5-direct:latest",
  "qwen2.5:3b-instruct",
  "dolphin-phi:2.7b-v2.6-q4_0",
  "wizard-vicuna-uncensored:7b-q4_0",
];

const PROMPT = "Count from 1 to 20.";

async function testModel(model) {
  const start = Date.now();
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: PROMPT, stream: false }),
    });
    const data = await res.json();
    const elapsed = (Date.now() - start) / 1000;
    const tokens = data.eval_count ?? 0;
    const ns = data.eval_duration ?? 0;
    const tokensPerSec = ns > 0 ? (tokens / (ns / 1e9)).toFixed(1) : (tokens / elapsed).toFixed(1);
    return { model, tokens, elapsed: elapsed.toFixed(1) + "s", tokensPerSec, ok: true };
  } catch (e) {
    return { model, ok: false, error: e.message };
  }
}

async function main() {
  console.log("Ollama model speed test\nPrompt:", PROMPT);
  console.log("Machine: Intel i7, 16GB RAM, 4GB VRAM\n");

  const results = [];
  for (const model of MODELS) {
    process.stderr.write(`Testing ${model}... `);
    const r = await testModel(model);
    if (r.ok) {
      process.stderr.write(`${r.tokensPerSec} tok/s\n`);
      results.push(r);
    } else {
      process.stderr.write(`error: ${r.error}\n`);
    }
  }

  console.log("\n--- Results (sorted by speed) ---");
  results.sort((a, b) => parseFloat(b.tokensPerSec) - parseFloat(a.tokensPerSec));
  console.log("Model                              | Tokens | Time  | Tok/s");
  console.log("-".repeat(60));
  for (const r of results) {
    console.log(`${r.model.padEnd(33)} | ${String(r.tokens).padStart(6)} | ${r.elapsed.padStart(5)} | ${r.tokensPerSec}`);
  }
}

main().catch(console.error);
