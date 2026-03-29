import fs from 'fs';
import path from 'path';

const INDEX_PATH = '../website/index.html';
let html = fs.readFileSync(INDEX_PATH, 'utf8');

console.log('🚀 Updating crewswarm.ai marketing site...');

// 1. Tagline & Agent Count Consistency
// Ensuring all instances of 20 or 21 are updated to "21+" for future-proofing
html = html.replace('<h1>One idea.<br/>One build.<br/>', '<h1>One idea.<br/>One build.<br/>');
html = html.replace(/20 specialist agents/g, '21+ specialist agents');
html = html.replace(/21-agent specialist crew/g, '21+ specialist agent crew');

// 2. Add Vibe to Control Surfaces (replacing crewchat cs-item)
const crewChatCsItem = `<div class="cs-item cs-native">
                  <strong>crewchat</strong>
                  <span>Menu bar app — same conversation, one click away</span>
                </div>`;

const vibeCsItem = `<div class="cs-item cs-native">
                  <strong><a href="vibe.html" style="color:var(--accent);">crewswarm Vibe</a></strong>
                  <span>Browser-native IDE with Monaco — real-time file tree + agent chat.</span>
                </div>
                <div class="cs-item cs-native">
                  <strong>crewchat v2.0</strong>
                  <span>Quick & Advanced modes — multimodal image + voice support.</span>
                </div>`;

html = html.replace(crewChatCsItem, vibeCsItem);

// 3. Update Shared Memory (Replacing Tech Badge)
const sharedMemoryBadge = `<div class="tech-badge">
          <img src="https://cdn.simpleicons.org/markdown/94a3b8" alt="Markdown" width="28" height="28" loading="lazy">
          <div>
            <strong>Shared Memory</strong>
            <span>Markdown — current-state, decisions, handoff, roadmap</span>
          </div>
        </div>`;

const ragMemoryBadge = `<div class="tech-badge">
          <img src="https://cdn.simpleicons.org/markdown/94a3b8" alt="Markdown" width="28" height="28" loading="lazy">
          <div>
            <strong>Shared Memory RAG</strong>
            <span>Semantic search over history via local TF-IDF (no API calls).</span>
          </div>
        </div>
        <div class="tech-badge">
          <div style="font-size:24px;">🌊</div>
          <div>
            <strong>Wave Orchestration</strong>
            <span>Parallel task dispatch — 10x faster concurrent builds.</span>
          </div>
        </div>`;

html = html.replace(sharedMemoryBadge, ragMemoryBadge);

// 4. Update Execution Engines (Add Gemini CLI)
html = html.replace('Codex CLI', 'Codex CLI, and Gemini CLI');

// 5. Add Waves FAQ
const faqListStart = '<div class="faq-list" id="faqList">';
const waveFaq = `          <div class="faq-item">
            <button class="faq-question" aria-expanded="false">
              <span>What are "Waves" and parallel dispatch?</span>
              <span class="faq-icon">+</span>
            </button>
            <div class="faq-answer"><div class="faq-answer-inner"><p>Waves allow multiple specialists (like crew-coder and crew-qa) to work simultaneously on different parts of the same project. Tasks in Wave 1 must finish before Wave 2 starts, but everything inside a wave runs in parallel.</p></div></div>
          </div>`;

html = html.replace(faqListStart, faqListStart + '\n' + waveFaq);

fs.writeFileSync(INDEX_PATH, html);
console.log('✨ Website updated successfully!');
