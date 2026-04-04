#!/usr/bin/env node
/**
 * Generate complete OpenAPI spec by dynamically scanning source files for routes.
 *
 * Scanning strategy (regex-based, no AST):
 *   - Pattern A: url.pathname === "/path" && req.method === "METHOD"
 *   - Pattern B: req.method === "METHOD" && url.pathname === "/path"
 *   - Pattern C: url.pathname === "/path"  (method inferred from context)
 *   - Pattern D: parsedUrl.pathname === "/path" && req.method === "METHOD"  (Vibe server)
 *   - Pattern E: req.method === 'METHOD' && path === '/path'  (crew-cli server.ts)
 *
 * Manual entries in dashboardEndpoints / crewLeadEndpoints act as overrides for
 * tag assignment. Scanned routes that match a manual entry use that tag; newly
 * discovered routes get auto-tagged from their path prefix.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Shared spec skeleton
// ---------------------------------------------------------------------------

const oldSpecPath = path.join(rootDir, "crew-cli/docs/openapi.unified.v1.json");
const oldSpec = JSON.parse(fs.readFileSync(oldSpecPath, "utf8"));

const spec = {
  openapi: "3.1.0",
  info: {
    title: "crewswarm Complete API",
    version: "2.0.0",
    description:
      "Complete API specification for crewswarm Dashboard (port 4319), crew-lead (port 5010), Vibe Studio (port 4320), and crew-cli (variable port). " +
      "Includes all agent orchestration, messaging integrations, memory management, and system control endpoints.",
  },
  servers: [
    { url: "http://127.0.0.1:4319", description: "Dashboard API (primary web interface)" },
    { url: "http://127.0.0.1:5010", description: "crew-lead API (orchestration and chat)" },
    { url: "http://127.0.0.1:4320", description: "Vibe Studio API (editor and sessions)" },
    { url: "http://127.0.0.1:4321", description: "crew-cli API (agent router and tasks)" },
  ],
  tags: [
    { name: "Core",       description: "Essential system endpoints" },
    { name: "Agents",     description: "Agent management and configuration" },
    { name: "Chat",       description: "Conversational interfaces" },
    { name: "Dispatch",   description: "Task dispatch and orchestration" },
    { name: "Projects",   description: "Project and roadmap management" },
    { name: "PM Loop",    description: "Project manager autonomous loop" },
    { name: "Build",      description: "Build orchestration" },
    { name: "Providers",  description: "LLM provider configuration" },
    { name: "Skills",     description: "Skill plugin management" },
    { name: "Memory",     description: "Shared memory and brain" },
    { name: "Messaging",  description: "Telegram and WhatsApp integrations" },
    { name: "Contacts",   description: "Contact management" },
    { name: "Settings",   description: "System configuration" },
    { name: "Services",   description: "Service lifecycle management" },
    { name: "Engines",    description: "Engine passthrough and configuration" },
    { name: "Multimodal", description: "Image and audio processing" },
    { name: "Telemetry",  description: "Usage tracking and spending" },
    { name: "OAuth",      description: "OAuth and subscription provider authentication" },
    { name: "Testing",    description: "Test suite execution and results" },
    { name: "Workflows",  description: "Scheduled pipeline workflow management" },
    { name: "Studio",     description: "Vibe Studio editor and session management" },
    { name: "RAG",        description: "Retrieval-augmented generation and indexing" },
    { name: "MCP",        description: "Model Context Protocol endpoints" },
    { name: "V1",         description: "crew-cli v1 API (tasks, sandbox, traces)" },
  ],
  paths: {},
  components: oldSpec.components,
};

// ---------------------------------------------------------------------------
// Manual override tables  (path → { method: tag, ... })
// These supply authoritative tags for known routes discovered by scanning.
// ---------------------------------------------------------------------------

const dashboardOverrides = {
  "/":                                   { get: "Core" },
  "/health":                             { get: "Core" },
  "/api/health":                         { get: "Core" },
  "/api/agents":                         { get: "Agents" },
  "/api/agents-config":                  { get: "Agents" },
  "/api/agents-config/create":           { post: "Agents" },
  "/api/agents-config/update":           { post: "Agents" },
  "/api/agents-config/delete":           { post: "Agents" },
  "/api/agents-config/reset-session":    { post: "Agents" },
  "/api/agents/reset-session":           { post: "Agents" },
  "/api/crew-lead/chat":                 { post: "Chat" },
  "/api/crew-lead/history":              { get: "Chat" },
  "/api/crew-lead/clear":                { post: "Chat" },
  "/api/crew-lead/status":               { get: "Chat" },
  "/api/crew-lead/events":               { get: "Chat" },
  "/api/crew-lead/confirm-project":      { post: "Projects" },
  "/api/crew-lead/discard-project":      { post: "Projects" },
  "/api/crew-lead/project-messages":     { get: "Projects" },
  "/api/dispatch":                       { post: "Dispatch" },
  "/api/projects":                       { get: "Projects", post: "Projects" },
  "/api/projects/update":                { post: "Projects" },
  "/api/projects/delete":                { post: "Projects" },
  "/api/pm-loop/start":                  { post: "PM Loop" },
  "/api/pm-loop/stop":                   { post: "PM Loop" },
  "/api/pm-loop/status":                 { get: "PM Loop" },
  "/api/pm-loop/log":                    { get: "PM Loop" },
  "/api/pm-loop/roadmap":                { get: "PM Loop" },
  "/api/roadmap/read":                   { post: "PM Loop" },
  "/api/roadmap/write":                  { post: "PM Loop" },
  "/api/roadmap/retry-failed":           { post: "PM Loop" },
  "/api/build":                          { post: "Build" },
  "/api/build/stop":                     { post: "Build" },
  "/api/continuous-build":               { post: "Build" },
  "/api/continuous-build/stop":          { post: "Build" },
  "/api/continuous-build/log":           { get: "Build" },
  "/api/phased-progress":                { get: "Build" },
  "/api/providers":                      { get: "Providers" },
  "/api/providers/builtin":              { get: "Providers" },
  "/api/providers/builtin/save":         { post: "Providers" },
  "/api/providers/builtin/test":         { post: "Providers" },
  "/api/providers/add":                  { post: "Providers" },
  "/api/providers/save":                 { post: "Providers" },
  "/api/providers/test":                 { post: "Providers" },
  "/api/providers/fetch-models":         { post: "Providers" },
  "/api/models":                         { get: "Providers" },
  "/api/skills/import":                  { post: "Skills" },
  "/api/memory/stats":                   { get: "Memory" },
  "/api/memory/search":                  { post: "Memory" },
  "/api/memory/migrate":                 { post: "Memory" },
  "/api/memory/compact":                 { post: "Memory" },
  "/api/telegram/config":                { get: "Messaging", post: "Messaging" },
  "/api/telegram/start":                 { post: "Messaging" },
  "/api/telegram/stop":                  { post: "Messaging" },
  "/api/telegram/status":                { get: "Messaging" },
  "/api/telegram/messages":              { get: "Messaging" },
  "/api/telegram/discover-topics":       { get: "Messaging" },
  "/api/telegram-sessions":              { get: "Messaging" },
  "/api/whatsapp/config":                { get: "Messaging", post: "Messaging" },
  "/api/whatsapp/start":                 { post: "Messaging" },
  "/api/whatsapp/stop":                  { post: "Messaging" },
  "/api/whatsapp/status":                { get: "Messaging" },
  "/api/whatsapp/messages":              { get: "Messaging" },
  "/api/contacts":                       { get: "Contacts" },
  "/api/contacts/update":                { post: "Contacts" },
  "/api/contacts/delete":                { post: "Contacts" },
  "/api/contacts/send":                  { post: "Contacts" },
  "/api/settings/rt-token":              { get: "Settings", post: "Settings" },
  "/api/settings/opencode-project":      { get: "Settings", post: "Settings" },
  "/api/settings/bg-consciousness":      { get: "Settings", post: "Settings" },
  "/api/settings/cursor-waves":          { get: "Settings", post: "Settings" },
  "/api/settings/claude-code":           { get: "Settings", post: "Settings" },
  "/api/settings/codex":                 { get: "Settings", post: "Settings" },
  "/api/settings/gemini-cli":            { get: "Settings", post: "Settings" },
  "/api/settings/crew-cli":              { get: "Settings", post: "Settings" },
  "/api/settings/global-fallback":       { get: "Settings", post: "Settings" },
  "/api/settings/global-oc-loop":        { get: "Settings", post: "Settings" },
  "/api/settings/global-rules":          { get: "Settings", post: "Settings" },
  "/api/settings/loop-brain":            { get: "Settings", post: "Settings" },
  "/api/settings/openclaw-status":       { get: "Settings" },
  "/api/settings/passthrough-notify":    { get: "Settings", post: "Settings" },
  "/api/settings/role-defaults":         { get: "Settings", post: "Settings" },
  "/api/settings/spending-caps":         { get: "Settings", post: "Settings" },
  "/api/settings/autonomous-mentions":   { get: "Settings", post: "Settings" },
  "/api/settings/cli-models":            { get: "Settings", post: "Settings" },
  "/api/settings/opencode":              { get: "Settings", post: "Settings" },
  "/api/settings/tmux-bridge":           { get: "Settings", post: "Settings" },
  "/api/env":                            { get: "Settings" },
  "/api/env-advanced":                   { get: "Settings", post: "Settings" },
  "/api/config/lock-status":             { get: "Settings" },
  "/api/config/lock":                    { post: "Settings" },
  "/api/config/unlock":                  { post: "Settings" },
  "/api/services/status":                { get: "Services" },
  "/api/services/restart":               { post: "Services" },
  "/api/services/stop":                  { post: "Services" },
  "/api/crew/start":                     { post: "Services" },
  "/api/engines":                        { get: "Engines" },
  "/api/engines/import":                 { post: "Engines" },
  "/api/engines/toggle":                 { post: "Engines" },
  "/api/engine-passthrough":             { post: "Engines" },
  "/api/opencode-models":                { get: "Engines" },
  "/api/opencode-stats":                 { get: "Engines" },
  "/api/passthrough-sessions":           { get: "Engines", delete: "Engines" },
  "/api/engine-runtimes":                { get: "Engines" },
  "/api/engine-sessions":                { get: "Engines" },
  "/api/codex-sessions":                 { get: "Engines" },
  "/api/gemini-sessions":                { get: "Engines" },
  "/api/crew-cli-sessions":              { get: "Engines" },
  "/api/first-run-engines":              { get: "Engines" },
  "/api/analyze-image":                  { post: "Multimodal" },
  "/api/transcribe-audio":               { post: "Multimodal" },
  "/api/token-usage":                    { get: "Telemetry" },
  "/api/oauth/status":                   { get: "OAuth" },
  "/api/oauth/test":                     { post: "OAuth" },
  "/api/oauth/models":                   { get: "OAuth" },
  "/api/oauth/model":                    { get: "OAuth", post: "OAuth" },
  "/api/tests/summary":                  { get: "Testing" },
  "/api/tests/history":                  { get: "Testing" },
  "/api/tests/run-detail":               { get: "Testing" },
  "/api/tests/run":                      { post: "Testing" },
  "/api/tests/progress":                 { get: "Testing" },
  "/api/workflows/list":                 { get: "Workflows" },
  "/api/workflows/item":                 { get: "Workflows" },
  "/api/workflows/save":                 { post: "Workflows" },
  "/api/workflows/delete":               { post: "Workflows" },
  "/api/workflows/run":                  { post: "Workflows" },
  "/api/workflows/log":                  { get: "Workflows" },
  "/api/workflows/status":               { get: "Workflows" },
  "/api/dlq":                            { get: "Core" },
  "/api/dlq/replay":                     { post: "Core" },
  "/api/waves/config":                   { get: "Core", post: "Core" },
  "/api/waves/config/reset":             { post: "Core" },
  "/api/prompts":                        { get: "Core", post: "Core" },
  "/api/cmd-allowlist":                  { get: "Core", post: "Core", delete: "Core" },
  "/api/cmd-approve":                    { post: "Core" },
  "/api/cmd-reject":                     { post: "Core" },
  "/api/enhance-prompt":                 { post: "Core" },
  "/api/search-tools":                   { get: "Core" },
  "/api/search-tools/save":              { post: "Core" },
  "/api/search-tools/test":              { post: "Core" },
  "/api/benchmark-tasks":                { get: "Core" },
  "/api/benchmark-run":                  { post: "Core" },
  "/api/files":                          { get: "Core" },
  "/api/file-content":                   { get: "Core" },
  "/api/pick-folder":                    { get: "Core" },
  "/api/sessions":                       { get: "Core" },
  "/api/messages":                       { get: "Core" },
  "/api/send":                           { post: "Core" },
  "/api/rt-messages":                    { get: "Core" },
  "/api/auth/token":                     { get: "Core" },
  "/api/signup":                         { post: "Core" },
  "/api/first-run-status":               { get: "Core" },
  "/api/cli-processes":                  { get: "Core" },
  "/api/ui/active-project":              { get: "Core", post: "Core" },
  "/api/agent-chat":                     { post: "Chat" },
  "/api/chat/unified":                   { post: "Chat" },
  "/api/cli/chat":                       { post: "Chat" },
  "/api/chat-participants":              { get: "Chat" },
  "/api/chat-agent":                     { post: "Chat" },
};

const crewLeadOverrides = {
  "/health":                             { get: "Core" },
  "/status":                             { get: "Core" },
  "/api/health":                         { get: "Core" },
  "/api/background":                     { get: "Core" },
  "/chat":                               { post: "Chat" },
  "/chat/stream":                        { post: "Chat" },
  "/history":                            { get: "Chat" },
  "/clear":                              { post: "Chat" },
  "/events":                             { get: "Chat" },
  "/confirm-project":                    { post: "Projects" },
  "/discard-project":                    { post: "Projects" },
  "/api/dispatch":                       { post: "Dispatch" },
  "/api/classify":                       { post: "Dispatch" },
  "/api/chat-agent":                     { post: "Dispatch" },
  "/api/pipeline":                       { post: "Dispatch" },
  "/api/agents":                         { get: "Agents" },
  "/api/agents/opencode":                { get: "Agents" },
  "/api/skills":                         { get: "Skills", post: "Skills" },
  "/api/skills/approve":                 { post: "Skills" },
  "/api/skills/reject":                  { post: "Skills" },
  "/api/crew-lead/history":              { get: "Chat" },
  "/api/crew-lead/project-messages":     { get: "Projects" },
  "/api/crew-lead/search-project-messages": { get: "Projects" },
  "/api/crew-lead/export-project-messages": { get: "Projects" },
  "/api/crew-lead/message-threads":      { get: "Projects" },
  "/api/crew-lead/search-messages-semantic": { get: "Projects" },
  "/api/crew-lead/index-project-messages": { post: "Projects" },
  "/api/crew-lead/message-index-stats":  { get: "Projects" },
  "/api/engine-passthrough":             { post: "Engines" },
  "/api/engine-passthrough/clear-session": { post: "Engines" },
  "/api/opencode-event":                 { post: "Engines" },
  "/api/opencode-sessions":              { get: "Engines" },
  "/api/claude-sessions":                { get: "Engines" },
  "/api/codex-sessions":                 { get: "Engines" },
  "/api/gemini-sessions":                { get: "Engines" },
  "/api/crew-cli-sessions":              { get: "Engines" },
  "/api/passthrough-sessions":           { get: "Engines", delete: "Engines" },
  "/api/services/health":                { get: "Services" },
  "/api/services/restart-opencode":      { post: "Services" },
  "/api/settings/bg-consciousness":      { get: "Settings", post: "Settings" },
  "/api/settings/claude-code":           { get: "Settings", post: "Settings" },
  "/api/settings/cursor-waves":          { get: "Settings", post: "Settings" },
  "/api/settings/global-fallback":       { get: "Settings", post: "Settings" },
  "/api/settings/opencode-project":      { get: "Settings", post: "Settings" },
  "/api/settings/autonomous-mentions":   { get: "Settings", post: "Settings" },
  "/api/settings/codex":                 { get: "Settings", post: "Settings" },
  "/api/settings/gemini-cli":            { get: "Settings", post: "Settings" },
  "/api/settings/crew-cli":              { get: "Settings", post: "Settings" },
  "/api/settings/opencode":              { get: "Settings", post: "Settings" },
  "/api/settings/global-oc-loop":        { get: "Settings", post: "Settings" },
  "/api/settings/passthrough-notify":    { get: "Settings", post: "Settings" },
  "/api/settings/loop-brain":            { get: "Settings", post: "Settings" },
  "/api/settings/openclaw-status":       { get: "Settings" },
  "/api/settings/rt-token":              { get: "Settings", post: "Settings" },
  "/api/settings/tmux-bridge":           { get: "Settings", post: "Settings" },
  "/api/config/lock-status":             { get: "Settings" },
  "/api/config/lock":                    { post: "Settings" },
  "/api/config/unlock":                  { post: "Settings" },
  "/api/spending":                       { get: "Telemetry" },
  "/api/spending/reset":                 { post: "Telemetry" },
  "/api/telemetry":                      { get: "Telemetry" },
  "/api/agent-transcripts/recent":       { get: "Telemetry" },
  "/allowlist-cmd":                      { get: "Core", post: "Core", delete: "Core" },
  "/approve-cmd":                        { post: "Core" },
  "/reject-cmd":                         { post: "Core" },
};

const vibeOverrides = {
  "/api/version":                        { get: "Core" },
  "/api/auth/token":                     { get: "Core" },
  "/api/agents":                         { get: "Agents" },
  "/api/chat/unified":                   { post: "Chat" },
  "/api/studio/sessions":                { get: "Studio", delete: "Studio" },
  "/api/studio/projects":                { get: "Studio", post: "Studio" },
  "/api/studio/active-project":          { get: "Studio", post: "Studio" },
  "/api/studio/files":                   { get: "Studio" },
  "/api/studio/file-content":            { get: "Studio", post: "Studio" },
  "/api/studio/project-messages":        { get: "Studio" },
  "/api/studio/engines":                 { get: "Studio" },
  "/api/studio/clear-cli-session":       { post: "Studio" },
  "/api/studio/git-diff":                { get: "Studio" },
  "/api/studio/chat/unified":            { post: "Studio" },
  "/api/studio/terminal/start":          { post: "Studio" },
  "/api/studio/terminal":                { delete: "Studio" },
};

const crewCliOverrides = {
  "/health":                             { get: "Core" },
  "/v1/chat":                            { post: "V1" },
  "/v1/chat/completions":                { post: "V1" },
  "/v1/models":                          { get: "V1" },
  "/v1/tasks":                           { post: "V1" },
  "/v1/agents":                          { get: "V1" },
  "/v1/status":                          { get: "V1" },
  "/v1/sandbox":                         { get: "V1" },
  "/v1/sandbox/apply":                   { post: "V1" },
  "/v1/sandbox/rollback":                { post: "V1" },
  "/v1/index/rebuild":                   { post: "V1" },
  "/v1/index/search":                    { get: "V1" },
  "/api/engine-passthrough":             { post: "Engines" },
  "/api/passthrough-sessions":           { get: "Engines", delete: "Engines" },
  "/api/tool-audit":                     { get: "Core" },
  "/api/tool-audit/replay":              { post: "Core" },
  "/api/rag/search":                     { get: "RAG" },
  "/api/rag/index":                      { post: "RAG" },
  "/api/rag/stats":                      { get: "RAG" },
  "/mcp":                                { post: "MCP" },
  "/mcp/health":                         { get: "MCP" },
};

// ---------------------------------------------------------------------------
// Auto-tag inference from path prefix
// ---------------------------------------------------------------------------

function inferTag(routePath) {
  if (routePath.startsWith("/api/oauth"))           return "OAuth";
  if (routePath.startsWith("/api/settings"))        return "Settings";
  if (routePath.startsWith("/api/config"))          return "Settings";
  if (routePath.startsWith("/api/telegram"))        return "Messaging";
  if (routePath.startsWith("/api/whatsapp"))        return "Messaging";
  if (routePath.startsWith("/api/contacts"))        return "Contacts";
  if (routePath.startsWith("/api/agents"))          return "Agents";
  if (routePath.startsWith("/api/skills"))          return "Skills";
  if (routePath.startsWith("/api/memory"))          return "Memory";
  if (routePath.startsWith("/api/pm-loop"))         return "PM Loop";
  if (routePath.startsWith("/api/roadmap"))         return "PM Loop";
  if (routePath.startsWith("/api/build"))           return "Build";
  if (routePath.startsWith("/api/continuous-build")) return "Build";
  if (routePath.startsWith("/api/phased"))          return "Build";
  if (routePath.startsWith("/api/providers"))       return "Providers";
  if (routePath.startsWith("/api/models"))          return "Providers";
  if (routePath.startsWith("/api/crew-lead"))       return "Chat";
  if (routePath.startsWith("/api/dispatch"))        return "Dispatch";
  if (routePath.startsWith("/api/classify"))        return "Dispatch";
  if (routePath.startsWith("/api/pipeline"))        return "Dispatch";
  if (routePath.startsWith("/api/projects"))        return "Projects";
  if (routePath.startsWith("/api/services"))        return "Services";
  if (routePath.startsWith("/api/engines"))         return "Engines";
  if (routePath.startsWith("/api/engine"))          return "Engines";
  if (routePath.startsWith("/api/opencode"))        return "Engines";
  if (routePath.startsWith("/api/passthrough"))     return "Engines";
  if (routePath.startsWith("/api/codex"))           return "Engines";
  if (routePath.startsWith("/api/gemini"))          return "Engines";
  if (routePath.startsWith("/api/crew-cli"))        return "Engines";
  if (routePath.startsWith("/api/analyze"))         return "Multimodal";
  if (routePath.startsWith("/api/transcribe"))      return "Multimodal";
  if (routePath.startsWith("/api/spending"))        return "Telemetry";
  if (routePath.startsWith("/api/telemetry"))       return "Telemetry";
  if (routePath.startsWith("/api/token-usage"))     return "Telemetry";
  if (routePath.startsWith("/api/agent-transcripts")) return "Telemetry";
  if (routePath.startsWith("/api/tests"))           return "Testing";
  if (routePath.startsWith("/api/workflows"))       return "Workflows";
  if (routePath.startsWith("/api/studio"))          return "Studio";
  if (routePath.startsWith("/api/rag"))             return "RAG";
  if (routePath.startsWith("/mcp"))                 return "MCP";
  if (routePath.startsWith("/v1"))                  return "V1";
  if (routePath.startsWith("/api/agent-chat"))      return "Chat";
  if (routePath.startsWith("/api/chat"))            return "Chat";
  if (routePath.startsWith("/api/cli/chat"))        return "Chat";
  if (routePath.startsWith("/chat"))                return "Chat";
  return "Core";
}

// ---------------------------------------------------------------------------
// Source scanner  —  extracts (path, method) pairs via regex
// ---------------------------------------------------------------------------

/**
 * Scan a source file and return Map<routePath, Set<method>>.
 *
 * Handles:
 *   A) url.pathname === "/path" && req.method === "METHOD"
 *   B) req.method === "METHOD" && url.pathname === "/path"
 *   C) parsedUrl.pathname === "/path" && req.method === "METHOD"  (Vibe)
 *   D) req.method === 'METHOD' && path === '/path'  (crew-cli TS)
 *   E) req.method === "METHOD" && path === "/path"  (crew-cli TS alternate)
 *   F) Standalone pathname match without explicit method (multi-method blocks)
 */
function scanSourceFile(filePath) {
  const routes = new Map();   // routePath → Set<method>
  const source = fs.readFileSync(filePath, "utf8");

  // Skip non-route pathnames (static files, globs, etc.)
  const SKIP_EXTENSIONS = /\.(html|ico|png|jpg|css|js|json|map|br|gz|txt|md)$/;
  const isRoutePath = (p) =>
    (p.startsWith("/api/") || p.startsWith("/v1/") || p.startsWith("/mcp") ||
     p === "/health" || p === "/status" || p === "/chat" || p === "/chat/stream" ||
     p === "/history" || p === "/clear" || p === "/events" ||
     p === "/confirm-project" || p === "/discard-project" ||
     p === "/approve-cmd" || p === "/reject-cmd" || p === "/allowlist-cmd" ||
     p === "/crew-chat.html" || p === "/signup" || p === "/signup.html") &&
    !SKIP_EXTENSIONS.test(p);

  function addRoute(rPath, method) {
    if (!isRoutePath(rPath)) return;
    if (!routes.has(rPath)) routes.set(rPath, new Set());
    if (method) routes.get(rPath).add(method.toLowerCase());
  }

  // Pattern A + C: pathname === "/path" && method === "METHOD"
  // Also handles: parsedUrl.pathname === "/path" && req.method === "METHOD"
  const patA = /(?:url|parsedUrl)\.pathname\s*===\s*["']([^"']+)["']\s*&&\s*req\.method\s*===\s*["'](GET|POST|DELETE|PUT|PATCH)["']/g;
  let m;
  while ((m = patA.exec(source)) !== null) addRoute(m[1], m[2]);

  // Pattern B: method === "METHOD" && pathname === "/path"
  const patB = /req\.method\s*===\s*["'](GET|POST|DELETE|PUT|PATCH)["']\s*&&\s*(?:url|parsedUrl)\.pathname\s*===\s*["']([^"']+)["']/g;
  while ((m = patB.exec(source)) !== null) addRoute(m[2], m[1]);

  // Pattern D/E: crew-cli style  req.method === 'METHOD' && path === '/path'
  const patD = /req\.method\s*===\s*['"]?(GET|POST|DELETE|PUT|PATCH)['"]?\s*&&\s*path\s*===\s*['"]([^'"]+)['"]/g;
  while ((m = patD.exec(source)) !== null) addRoute(m[2], m[1]);

  // Pattern E reverse: path === '/path' && req.method === 'METHOD'
  const patE = /path\s*===\s*['"]([^'"]+)['"]\s*&&\s*req\.method\s*===\s*['"]?(GET|POST|DELETE|PUT|PATCH)['"]?/g;
  while ((m = patE.exec(source)) !== null) addRoute(m[1], m[2]);

  // Pattern F: standalone pathname match (used for multi-method blocks like passthrough-sessions)
  // Only add path without method so we don't lose discovered paths.
  const patF = /(?:url|parsedUrl)\.pathname\s*===\s*["']([^"']+)["']/g;
  while ((m = patF.exec(source)) !== null) {
    if (isRoutePath(m[1]) && !routes.has(m[1])) {
      routes.set(m[1], new Set());
    }
  }

  // Pattern G: crew-cli — plain path === '/...' blocks (standalone, no method adjacent)
  const patG = /\bpath\s*===\s*['"]([^'"]+)['"]/g;
  while ((m = patG.exec(source)) !== null) {
    if (isRoutePath(m[1]) && !routes.has(m[1])) {
      routes.set(m[1], new Set());
    }
  }

  // Scan nearby lines to infer method for routes that had no explicit pairing
  // We do a second pass: for each known path, look within ±8 lines of each
  // occurrence for if (req.method === "X") blocks.
  const lines = source.split("\n");
  for (const [rPath, methods] of routes) {
    if (methods.size > 0) continue; // already has methods from pattern matching
    const escapedPath = rPath.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&");
    const lineRe = new RegExp(`["']${escapedPath}["']`);
    for (let i = 0; i < lines.length; i++) {
      if (!lineRe.test(lines[i])) continue;
      for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 12); j++) {
        const methodMatch = lines[j].match(/req\.method\s*===\s*["'](GET|POST|DELETE|PUT|PATCH)["']/);
        if (methodMatch) methods.add(methodMatch[1].toLowerCase());
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Scan validate() calls to associate Zod schemas with routes
// ---------------------------------------------------------------------------

function scanValidations(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  const result = {};  // routePath → schemaName

  for (let i = 0; i < lines.length; i++) {
    const pathMatch = lines[i].match(/(?:url|parsedUrl)\.pathname\s*===\s*["']([^"']+)["']/);
    if (!pathMatch) continue;
    const rPath = pathMatch[1];
    for (let j = i; j < Math.min(i + 15, lines.length); j++) {
      const valMatch = lines[j].match(/\bvalidate\((\w+Schema)\b/);
      if (valMatch) {
        result[rPath] = valMatch[1];
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build a per-server route table by merging scan output with manual overrides
// ---------------------------------------------------------------------------

/**
 * Merge scanned routes and manual overrides into a unified map:
 *   routePath → { method: tag, ... }
 *
 * Priority:
 *   1. Manual override provides the tag for a (path, method) pair.
 *   2. If path is in override table but scanned method is missing from override,
 *      keep the scanned method and infer the tag.
 *   3. Newly scanned paths not in override table get auto-generated tags.
 */
function mergeRoutes(scanned, overrides) {
  const merged = {};

  // Start from manual overrides (authoritative for their paths)
  for (const [rPath, methodTags] of Object.entries(overrides)) {
    merged[rPath] = { ...methodTags };
  }

  // Layer in scanned routes
  for (const [rPath, methods] of scanned) {
    if (!merged[rPath]) merged[rPath] = {};
    for (const method of methods) {
      if (!merged[rPath][method]) {
        // Auto-tag
        merged[rPath][method] = inferTag(rPath);
      }
      // If method already in override, keep the override tag (already there)
    }
    // If scanned path has no methods at all (only path known), and it's not in
    // overrides yet, we can't add it without a method — skip.
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Build OpenAPI path object
// ---------------------------------------------------------------------------

function buildPathEntry(routePath, methodTags, zodSchema, isAutoGenerated) {
  const pathObj = {};
  for (const [method, tag] of Object.entries(methodTags)) {
    const entry = {
      tags: [tag],
      summary: `${method.toUpperCase()} ${routePath}`,
      description: isAutoGenerated
        ? `Auto-discovered endpoint. Method: ${method.toUpperCase()}.`
        : undefined,
      responses: {
        "200": {
          description: "Success",
          content: { "application/json": { schema: { type: "object" } } },
        },
      },
    };
    if (zodSchema) {
      entry.description = (entry.description || "") +
        ` Validated with ${zodSchema}.`;
    }
    if (!entry.description) delete entry.description;
    if (["post", "put", "patch"].includes(method)) {
      entry.requestBody = {
        content: { "application/json": { schema: { type: "object" } } },
      };
    }
    pathObj[method] = entry;
  }
  return pathObj;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

const sources = [
  {
    label: "dashboard (scripts/dashboard.mjs)",
    file: path.join(rootDir, "scripts/dashboard.mjs"),
    overrides: dashboardOverrides,
  },
  {
    label: "crew-lead (lib/crew-lead/http-server.mjs)",
    file: path.join(rootDir, "lib/crew-lead/http-server.mjs"),
    overrides: crewLeadOverrides,
  },
  {
    label: "vibe (apps/vibe/server.mjs)",
    file: path.join(rootDir, "apps/vibe/server.mjs"),
    overrides: vibeOverrides,
  },
  {
    label: "crew-cli (crew-cli/src/interface/server.ts)",
    file: path.join(rootDir, "crew-cli/src/interface/server.ts"),
    overrides: crewCliOverrides,
  },
];

const summaryRows = [];
let totalManualCount = 0;
let totalAutoCount = 0;

for (const src of sources) {
  let scanned;
  try {
    scanned = scanSourceFile(src.file);
  } catch (err) {
    console.warn(`  [WARN] Could not read ${src.file}: ${err.message}`);
    scanned = new Map();
  }

  const validations = (() => {
    try { return scanValidations(src.file); } catch { return {}; }
  })();

  const merged = mergeRoutes(scanned, src.overrides);

  let fileManual = 0;
  let fileAuto = 0;

  for (const [rPath, methodTags] of Object.entries(merged)) {
    if (Object.keys(methodTags).length === 0) continue; // path-only scan, no method known

    const isManual = src.overrides[rPath] !== undefined;
    const zodSchema = validations[rPath];
    const isAutoGenerated = !isManual;

    if (isManual) fileManual++; else fileAuto++;

    const pathEntry = buildPathEntry(rPath, methodTags, zodSchema, isAutoGenerated);

    if (!spec.paths[rPath]) {
      spec.paths[rPath] = pathEntry;
    } else {
      // Merge methods — don't overwrite existing ones from higher-priority sources
      for (const [method, opObj] of Object.entries(pathEntry)) {
        if (!spec.paths[rPath][method]) {
          spec.paths[rPath][method] = opObj;
        }
      }
    }
  }

  totalManualCount += fileManual;
  totalAutoCount += fileAuto;
  summaryRows.push({
    source: src.label,
    scannedPaths: scanned.size,
    merged: Object.keys(merged).length,
    manual: fileManual,
    auto: fileAuto,
  });
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

const outputPath = path.join(rootDir, "crew-cli/docs/openapi.complete.v2.json");
fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2), "utf8");

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------

const totalPaths   = Object.keys(spec.paths).length;
// Count individual (path, method) pairs across all paths
const totalOps     = Object.values(spec.paths).reduce(
  (n, pathObj) => n + Object.keys(pathObj).length, 0
);

console.log("");
console.log("crewswarm OpenAPI generator — dynamic scan + manual override merge");
console.log("=".repeat(68));
console.log("");
console.log("Source files scanned:");
console.log("-".repeat(68));

const col = (s, w) => String(s).padEnd(w);
console.log(
  col("Source", 44) +
  col("Scanned", 9) +
  col("Manual", 8) +
  col("Auto", 6)
);
console.log("-".repeat(68));
for (const r of summaryRows) {
  console.log(
    col(r.source, 44) +
    col(r.scannedPaths, 9) +
    col(r.manual, 8) +
    col(r.auto, 6)
  );
}
console.log("-".repeat(68));
console.log(
  col("TOTAL", 44) +
  col("", 9) +
  col(totalManualCount, 8) +
  col(totalAutoCount, 6)
);
console.log("");
console.log(`Output: ${outputPath}`);
console.log(`  Unique paths  : ${totalPaths}`);
console.log(`  Operations    : ${totalOps}  (path × method pairs)`);
console.log(`  Tag categories: ${spec.tags.length}`);
console.log(`  Manual desc.  : ${totalManualCount} paths`);
console.log(`  Auto-generated: ${totalAutoCount} paths`);
console.log("");

if (totalOps < 182) {
  console.warn(`  [WARN] Expected >= 182 operations but only got ${totalOps}.`);
  process.exitCode = 1;
} else {
  console.log(`  [OK] >= 182 operations confirmed.`);
}
console.log("");
