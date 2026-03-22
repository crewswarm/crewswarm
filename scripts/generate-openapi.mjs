#!/usr/bin/env node
/**
 * Generate complete OpenAPI spec from actual endpoint implementations
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Read the old spec to preserve schemas
const oldSpecPath = path.join(rootDir, "crew-cli/docs/openapi.unified.v1.json");
const oldSpec = JSON.parse(fs.readFileSync(oldSpecPath, "utf8"));

const spec = {
  openapi: "3.1.0",
  info: {
    title: "crewswarm Complete API",
    version: "2.0.0",
    description: "Complete API specification for crewswarm Dashboard (port 4319) and crew-lead (port 5010). Includes all agent orchestration, messaging integrations, memory management, and system control endpoints."
  },
  servers: [
    {
      url: "http://127.0.0.1:4319",
      description: "Dashboard API (primary web interface)"
    },
    {
      url: "http://127.0.0.1:5010",
      description: "crew-lead API (orchestration and chat)"
    }
  ],
  tags: [
    { name: "Core", description: "Essential system endpoints" },
    { name: "Agents", description: "Agent management and configuration" },
    { name: "Chat", description: "Conversational interfaces" },
    { name: "Dispatch", description: "Task dispatch and orchestration" },
    { name: "Projects", description: "Project and roadmap management" },
    { name: "PM Loop", description: "Project manager autonomous loop" },
    { name: "Build", description: "Build orchestration" },
    { name: "Providers", description: "LLM provider configuration" },
    { name: "Skills", description: "Skill plugin management" },
    { name: "Memory", description: "Shared memory and brain" },
    { name: "Messaging", description: "Telegram and WhatsApp integrations" },
    { name: "Contacts", description: "Contact management" },
    { name: "Settings", description: "System configuration" },
    { name: "Services", description: "Service lifecycle management" },
    { name: "Engines", description: "Engine passthrough and configuration" },
    { name: "Multimodal", description: "Image and audio processing" },
    { name: "Telemetry", description: "Usage tracking and spending" }
  ],
  paths: {},
  components: oldSpec.components // Preserve existing schemas
};

// Dashboard endpoints with methods and tags
const dashboardEndpoints = {
  "/": { get: "Core" },
  "/health": { get: "Core" },
  "/api/health": { get: "Core" },
  "/api/agents": { get: "Agents" },
  "/api/agents-config": { get: "Agents" },
  "/api/agents-config/create": { post: "Agents" },
  "/api/agents-config/update": { post: "Agents" },
  "/api/agents-config/delete": { post: "Agents" },
  "/api/agents-config/reset-session": { post: "Agents" },
  "/api/agents/reset-session": { post: "Agents" },
  "/api/crew-lead/chat": { post: "Chat" },
  "/api/crew-lead/history": { get: "Chat" },
  "/api/crew-lead/clear": { post: "Chat" },
  "/api/crew-lead/status": { get: "Chat" },
  "/api/crew-lead/events": { get: "Chat" },
  "/api/crew-lead/confirm-project": { post: "Projects" },
  "/api/crew-lead/discard-project": { post: "Projects" },
  "/api/dispatch": { post: "Dispatch" },
  "/api/projects": { get: "Projects", post: "Projects" },
  "/api/projects/update": { post: "Projects" },
  "/api/projects/delete": { post: "Projects" },
  "/api/pm-loop/start": { post: "PM Loop" },
  "/api/pm-loop/stop": { post: "PM Loop" },
  "/api/pm-loop/status": { get: "PM Loop" },
  "/api/pm-loop/log": { get: "PM Loop" },
  "/api/pm-loop/roadmap": { get: "PM Loop" },
  "/api/roadmap/read": { post: "PM Loop" },
  "/api/roadmap/write": { post: "PM Loop" },
  "/api/roadmap/retry-failed": { post: "PM Loop" },
  "/api/build": { post: "Build" },
  "/api/build/stop": { post: "Build" },
  "/api/continuous-build": { post: "Build" },
  "/api/continuous-build/stop": { post: "Build" },
  "/api/continuous-build/log": { get: "Build" },
  "/api/phased-progress": { get: "Build" },
  "/api/providers": { get: "Providers" },
  "/api/providers/builtin": { get: "Providers" },
  "/api/providers/builtin/save": { post: "Providers" },
  "/api/providers/builtin/test": { post: "Providers" },
  "/api/providers/add": { post: "Providers" },
  "/api/providers/save": { post: "Providers" },
  "/api/providers/test": { post: "Providers" },
  "/api/providers/fetch-models": { post: "Providers" },
  "/api/skills/import": { post: "Skills" },
  "/api/memory/stats": { get: "Memory" },
  "/api/memory/search": { post: "Memory" },
  "/api/memory/migrate": { post: "Memory" },
  "/api/memory/compact": { post: "Memory" },
  "/api/telegram/config": { get: "Messaging", post: "Messaging" },
  "/api/telegram/start": { post: "Messaging" },
  "/api/telegram/stop": { post: "Messaging" },
  "/api/telegram/status": { get: "Messaging" },
  "/api/telegram/messages": { get: "Messaging" },
  "/api/telegram/discover-topics": { get: "Messaging" },
  "/api/telegram-sessions": { get: "Messaging" },
  "/api/whatsapp/config": { get: "Messaging", post: "Messaging" },
  "/api/whatsapp/start": { post: "Messaging" },
  "/api/whatsapp/stop": { post: "Messaging" },
  "/api/whatsapp/status": { get: "Messaging" },
  "/api/whatsapp/messages": { get: "Messaging" },
  "/api/contacts": { get: "Contacts" },
  "/api/contacts/update": { post: "Contacts" },
  "/api/contacts/delete": { post: "Contacts" },
  "/api/contacts/send": { post: "Contacts" },
  "/api/settings/rt-token": { get: "Settings", post: "Settings" },
  "/api/settings/opencode-project": { get: "Settings", post: "Settings" },
  "/api/settings/bg-consciousness": { get: "Settings", post: "Settings" },
  "/api/settings/cursor-waves": { get: "Settings", post: "Settings" },
  "/api/settings/claude-code": { get: "Settings", post: "Settings" },
  "/api/settings/codex": { get: "Settings", post: "Settings" },
  "/api/settings/gemini-cli": { get: "Settings", post: "Settings" },
  "/api/settings/crew-cli": { get: "Settings", post: "Settings" },
  "/api/settings/global-fallback": { get: "Settings", post: "Settings" },
  "/api/settings/global-oc-loop": { get: "Settings", post: "Settings" },
  "/api/settings/global-rules": { get: "Settings", post: "Settings" },
  "/api/settings/loop-brain": { get: "Settings", post: "Settings" },
  "/api/settings/openclaw-status": { get: "Settings" },
  "/api/settings/passthrough-notify": { get: "Settings", post: "Settings" },
  "/api/settings/role-defaults": { get: "Settings", post: "Settings" },
  "/api/settings/spending-caps": { get: "Settings", post: "Settings" },
  "/api/env": { get: "Settings" },
  "/api/env-advanced": { get: "Settings", post: "Settings" },
  "/api/services/status": { get: "Services" },
  "/api/services/restart": { post: "Services" },
  "/api/services/stop": { post: "Services" },
  "/api/crew/start": { post: "Services" },
  "/api/engines": { get: "Engines" },
  "/api/engines/import": { post: "Engines" },
  "/api/engine-passthrough": { post: "Engines" },
  "/api/opencode-models": { get: "Engines" },
  "/api/opencode-stats": { get: "Engines" },
  "/api/passthrough-sessions": { get: "Engines", delete: "Engines" },
  "/api/analyze-image": { post: "Multimodal" },
  "/api/transcribe-audio": { post: "Multimodal" },
  "/api/token-usage": { get: "Telemetry" },
  "/api/dlq": { get: "Core" },
  "/api/dlq/replay": { post: "Core" },
  "/api/waves/config": { get: "Core", post: "Core" },
  "/api/waves/config/reset": { post: "Core" },
  "/api/prompts": { get: "Core", post: "Core" },
  "/api/cmd-allowlist": { get: "Core", post: "Core", delete: "Core" },
  "/api/cmd-approve": { post: "Core" },
  "/api/cmd-reject": { post: "Core" },
  "/api/enhance-prompt": { post: "Core" },
  "/api/search-tools": { get: "Core" },
  "/api/search-tools/save": { post: "Core" },
  "/api/search-tools/test": { post: "Core" },
  "/api/benchmark-tasks": { get: "Core" },
  "/api/benchmark-run": { post: "Core" },
  "/api/files": { get: "Core" },
  "/api/file-content": { get: "Core" },
  "/api/pick-folder": { get: "Core" },
  "/api/sessions": { get: "Core" },
  "/api/messages": { get: "Core" },
  "/api/send": { post: "Core" },
  "/api/rt-messages": { get: "Core" }
};

// crew-lead endpoints
const crewLeadEndpoints = {
  "/health": { get: "Core" },
  "/status": { get: "Core" },
  "/chat": { post: "Chat" },
  "/history": { get: "Chat" },
  "/clear": { post: "Chat" },
  "/events": { get: "Chat" },
  "/confirm-project": { post: "Projects" },
  "/discard-project": { post: "Projects" },
  "/api/dispatch": { post: "Dispatch" },
  "/api/classify": { post: "Dispatch" },
  "/api/chat-agent": { post: "Dispatch" },
  "/api/agents": { get: "Agents" },
  "/api/agents/opencode": { get: "Agents" },
  "/api/skills": { get: "Skills", post: "Skills" },
  "/api/skills/approve": { post: "Skills" },
  "/api/skills/reject": { post: "Skills" },
  "/api/crew-lead/history": { get: "Chat" },
  "/api/engine-passthrough": { post: "Engines" },
  "/api/opencode-event": { post: "Engines" },
  "/api/opencode-sessions": { get: "Engines" },
  "/api/claude-sessions": { get: "Engines" },
  "/api/passthrough-sessions": { get: "Engines" },
  "/api/services/health": { get: "Services" },
  "/api/services/restart-opencode": { post: "Services" },
  "/api/settings/bg-consciousness": { get: "Settings", post: "Settings" },
  "/api/settings/claude-code": { get: "Settings", post: "Settings" },
  "/api/settings/cursor-waves": { get: "Settings", post: "Settings" },
  "/api/settings/global-fallback": { get: "Settings", post: "Settings" },
  "/api/settings/opencode-project": { get: "Settings", post: "Settings" },
  "/api/spending": { get: "Telemetry" },
  "/api/spending/reset": { post: "Telemetry" },
  "/api/telemetry": { get: "Telemetry" },
  "/api/agent-transcripts/recent": { get: "Telemetry" },
  "/api/background": { get: "Core" },
  "/api/health": { get: "Core" },
  "/allowlist-cmd": { get: "Core", post: "Core", delete: "Core" },
  "/approve-cmd": { post: "Core" },
  "/reject-cmd": { post: "Core" }
};

// Generate path objects
function createPathObject(path, methods, tag) {
  const pathObj = {};
  const methodList = typeof methods === "string" ? [methods] : methods;
  
  for (const method of methodList) {
    pathObj[method] = {
      tags: [tag],
      summary: `${method.toUpperCase()} ${path}`,
      responses: {
        "200": {
          description: "Success",
          content: {
            "application/json": {
              schema: { type: "object" }
            }
          }
        }
      }
    };
    
    // Add request body for POST/PUT/PATCH
    if (["post", "put", "patch"].includes(method)) {
      pathObj[method].requestBody = {
        content: {
          "application/json": {
            "schema": { type: "object" }
          }
        }
      };
    }
  }
  
  return pathObj;
}

// Merge dashboard endpoints
for (const [path, methodsOrObj] of Object.entries(dashboardEndpoints)) {
  if (typeof methodsOrObj === "object" && !Array.isArray(methodsOrObj)) {
    const methods = Object.keys(methodsOrObj);
    const tags = Object.values(methodsOrObj);
    spec.paths[path] = {};
    for (let i = 0; i < methods.length; i++) {
      spec.paths[path][methods[i]] = {
        tags: [tags[i]],
        summary: `${methods[i].toUpperCase()} ${path}`,
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: { type: "object" }
              }
            }
          }
        }
      };
      if (["post", "put", "patch"].includes(methods[i])) {
        spec.paths[path][methods[i]].requestBody = {
          content: {
            "application/json": {
              schema: { type: "object" }
            }
          }
        };
      }
    }
  }
}

// Merge crew-lead endpoints
for (const [path, methodsOrObj] of Object.entries(crewLeadEndpoints)) {
  if (!spec.paths[path]) {
    spec.paths[path] = {};
  }
  if (typeof methodsOrObj === "object" && !Array.isArray(methodsOrObj)) {
    const methods = Object.keys(methodsOrObj);
    const tags = Object.values(methodsOrObj);
    for (let i = 0; i < methods.length; i++) {
      if (!spec.paths[path][methods[i]]) {
        spec.paths[path][methods[i]] = {
          tags: [tags[i]],
          summary: `${methods[i].toUpperCase()} ${path}`,
          responses: {
            "200": {
              description: "Success",
              content: {
                "application/json": {
                  schema: { type: "object" }
                }
              }
            }
          }
        };
        if (["post", "put", "patch"].includes(methods[i])) {
          spec.paths[path][methods[i]].requestBody = {
            content: {
              "application/json": {
                schema: { type: "object" }
              }
            }
          };
        }
      }
    }
  }
}

// Write output
const outputPath = path.join(rootDir, "crew-cli/docs/openapi.complete.v2.json");
fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2), "utf8");

console.log(`✅ Generated complete OpenAPI spec:`);
console.log(`   ${outputPath}`);
console.log(`   ${Object.keys(spec.paths).length} endpoints documented`);
console.log(`   ${spec.tags.length} tag categories`);
