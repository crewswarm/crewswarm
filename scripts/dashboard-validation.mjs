/**
 * Zod validation schemas for Dashboard API endpoints
 */
import { z } from 'zod';

// ── Common Schemas ────────────────────────────────────────────────────────
export const AgentIdSchema = z.string().min(1).max(50).regex(/^[a-z0-9-]+$/);
export const ProjectIdSchema = z.string().min(1).max(100);
export const ModelNameSchema = z.string().min(1).max(100);

// ── Agent Management ──────────────────────────────────────────────────────
export const SendMessageSchema = z.object({
  to: AgentIdSchema,
  message: z.string().min(1).max(10000),
});

export const UpdateAgentConfigSchema = z.object({
  agentId: AgentIdSchema,
  model: ModelNameSchema.optional(),
  fallbackModel: ModelNameSchema.optional(),
  systemPrompt: z.string().max(50000).optional(),
  name: z.string().max(100).optional(),
  emoji: z.string().max(10).optional(),
  theme: z.string().max(200).optional(),
  toolProfile: z.enum(['crewswarm', 'basic', 'custom']).optional(),
  alsoAllow: z.array(z.string()).optional(),
  useOpenCode: z.boolean().optional(),
  opencodeModel: z.string().optional(),
  opencodeFallbackModel: z.string().optional(),
  useCursorCli: z.boolean().optional(),
  cursorCliModel: z.string().optional(),
  useClaudeCode: z.boolean().optional(),
  claudeCodeModel: z.string().optional(),
  useCodex: z.boolean().optional(),
  useGeminiCli: z.boolean().optional(),
  geminiCliModel: z.string().optional(),
  role: z.string().optional(),
  opencodeLoop: z.boolean().optional(),
  opencodeLoopMaxRounds: z.number().int().min(1).max(100).optional(),
  workspace: z.string().optional(),
});

export const CreateAgentSchema = z.object({
  id: AgentIdSchema,
  model: ModelNameSchema,
  name: z.string().max(100).optional(),
  emoji: z.string().max(10).optional(),
  theme: z.string().max(200).optional(),
  systemPrompt: z.string().max(50000).optional(),
  alsoAllow: z.array(z.string()).optional(),
});

// ── Project Management ────────────────────────────────────────────────────
export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  outputDir: z.string().min(1).max(500).refine(
    (p) => {
      // Path sanitization: prevent traversal attacks
      const { resolve } = require('node:path');
      const { homedir } = require('node:os');
      const resolved = resolve(p);
      const cwd = resolve(process.cwd());
      const home = resolve(homedir());
      // Allow paths under workspace root OR user's home directory
      return resolved.startsWith(cwd) || resolved.startsWith(home);
    },
    { message: "outputDir must be under workspace root or home directory" }
  ),
  featuresDoc: z.string().max(500).optional(),
});

export const UpdateProjectSchema = z.object({
  projectId: ProjectIdSchema,
  autoAdvance: z.boolean().optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  outputDir: z.string().max(500).optional(),
});

export const DeleteProjectSchema = z.object({
  projectId: ProjectIdSchema,
});

// ── Build Operations ──────────────────────────────────────────────────────
export const StartBuildSchema = z.object({
  requirement: z.string().min(1).max(10000),
  projectId: ProjectIdSchema.optional(),
});

export const EnhancePromptSchema = z.object({
  text: z.string().min(1).max(10000),
  projectId: ProjectIdSchema.optional(),
  engine: z.enum(['claude', 'codex', 'cursor', 'gemini', 'gemini-cli', 'opencode', 'crew-cli']).optional(),
  model: z.string().max(200).optional(),
});

export const StopBuildSchema = z.object({
  projectId: ProjectIdSchema.optional(),
});

// ── PM Loop ───────────────────────────────────────────────────────────────
export const StartPMLoopSchema = z.object({
  dryRun: z.boolean().optional(),
  projectId: ProjectIdSchema.optional(),
  pmOptions: z.object({
    autoAdvance: z.boolean().optional(),
    maxIterations: z.number().int().min(1).max(1000).optional(),
    useSecurity: z.boolean().optional(),
    useQA: z.boolean().optional(),
  }).optional(),
});

export const StopPMLoopSchema = z.object({
  projectId: ProjectIdSchema.optional(),
});

// ── Skills ────────────────────────────────────────────────────────────────
export const CreateSkillSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  url: z.string().url().max(1000),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
  description: z.string().max(1000).optional(),
  auth: z.object({
    type: z.enum(['bearer', 'header', 'basic']).optional(),
    keyFrom: z.string().optional(),
    token: z.string().optional(),
    header: z.string().optional(),
  }).optional(),
  defaultParams: z.record(z.any()).optional(),
  requiresApproval: z.boolean().optional(),
});

export const DeleteSkillSchema = z.object({
  name: z.string().min(1).max(100),
});

export const RunSkillSchema = z.object({
  name: z.string().min(1).max(100),
  params: z.record(z.any()).optional(),
});

export const ImportSkillSchema = z.object({
  url: z.string().url().min(1).max(2000),
});

// ── Services ──────────────────────────────────────────────────────────────
export const ServiceActionSchema = z.object({
  id: z.enum([
    'rt-bus',
    'agents',
    'crew-lead',
    'telegram',
    'whatsapp',
    'opencode',
    'mcp',
    'openclaw-gateway',
    'dashboard',
  ]),
});

// ── Memory ────────────────────────────────────────────────────────────────
export const SearchMemorySchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(100).optional(),
});

// ── Benchmarks ────────────────────────────────────────────────────────────
export const RunBenchmarkSchema = z.object({
  benchmarkId: z.string().min(1).max(100),
  taskId: z.string().min(1).max(100),
  model: ModelNameSchema.optional(),
});

// ── DLQ ───────────────────────────────────────────────────────────────────
export const ReplayDLQSchema = z.object({
  key: z.string().min(1).max(200),
});

// ── Config ────────────────────────────────────────────────────────────────
export const UpdateConfigSchema = z.object({
  rtToken: z.string().optional(),
  telegramToken: z.string().optional(),
  telegramChatIds: z.array(z.string()).optional(),
  whatsappEnabled: z.boolean().optional(),
  bgConsciousnessModel: z.string().optional(),
  opencodeProject: z.string().optional(),
  opencodeFallbackModel: z.string().optional(),
  cursorCli: z.boolean().optional(),
  cursorCliModel: z.string().optional(),
  claudeCode: z.boolean().optional(),
  claudeCodeModel: z.string().optional(),
  geminiCli: z.boolean().optional(),
  geminiCliModel: z.string().optional(),
});

// ── Agent Config (create / delete / reset) ───────────────────────────────
export const AgentConfigCreateSchema = z.object({
  id: z.string().min(1).max(50),
  model: ModelNameSchema.optional(),
  name: z.string().max(100).optional(),
  emoji: z.string().max(10).optional(),
  theme: z.string().max(200).optional(),
  systemPrompt: z.string().max(50000).optional(),
  alsoAllow: z.array(z.string()).optional(),
});

export const AgentConfigDeleteSchema = z.object({
  agentId: z.string().min(1).max(50),
});

export const AgentResetSessionSchema = z.object({
  agentId: z.string().min(1).max(50),
});

// ── Providers ────────────────────────────────────────────────────────────
export const ProviderAddSchema = z.object({
  id: z.string().min(1).max(100),
  baseUrl: z.string().min(1).max(1000),
  apiKey: z.string().optional(),
  api: z.string().max(100).optional(),
});

export const ProviderSaveSchema = z.object({
  providerId: z.string().min(1).max(100),
  apiKey: z.string().min(1),
});

export const ProviderTestSchema = z.object({
  providerId: z.string().min(1).max(100),
});

export const ProviderBuiltinTestSchema = z.object({
  providerId: z.string().min(1).max(100),
});

// ── Continuous Build ─────────────────────────────────────────────────────
export const ContinuousBuildSchema = z.object({
  requirement: z.string().min(1).max(10000),
  projectId: ProjectIdSchema.optional(),
});

// ── Roadmap ──────────────────────────────────────────────────────────────
export const RoadmapWriteSchema = z.object({
  roadmapFile: z.string().min(1).max(500),
  content: z.string(),
});

export const RoadmapRetryFailedSchema = z.object({
  roadmapFile: z.string().min(1).max(500),
});

// ── Contacts ─────────────────────────────────────────────────────────────
export const ContactDeleteSchema = z.object({
  contactId: z.string().min(1).max(200),
});

export const ContactSendSchema = z.object({
  contactId: z.string().min(1).max(200),
  message: z.string().min(1).max(10000),
  platform: z.string().max(50).optional(),
});

// ── Validation Helper ─────────────────────────────────────────────────────
export function validate(schema, data) {
  try {
    return { ok: true, data: schema.parse(data) };
  } catch (err) {
    const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
    return { ok: false, error: msg };
  }
}
