/**
 * Shared Dependencies Pattern (Smol Developer)
 * 
 * Prevents cross-file hallucination by having LLM generate a shared
 * dependencies manifest FIRST, then injecting it into all file generations.
 * 
 * Example: Chrome extension
 *   Step 1: Generate shared-deps.md
 *     → "Extension ID: `my-extension-v1`"
 *     → "Background exports: `handleRequest()`"
 *   
 *   Step 2: Generate manifest.json WITH shared-deps
 *     → LLM sees: "Use Extension ID: `my-extension-v1`"
 *   
 *   Step 3: Generate background.js WITH shared-deps
 *     → LLM sees: "Use Extension ID: `my-extension-v1`"
 *   
 *   Result: ✅ CONSISTENT (no ID mismatch)
 */

import { LocalExecutor, type ExecutorResult } from './local.js';
import { Sandbox } from '../sandbox/index.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger();

export interface SharedDepsResult {
  sharedDeps: string;
  filePaths: string[];
  files: Map<string, string>;
}

const SHARED_DEPS_SYSTEM_PROMPT = `You are planning a coding project.

Your job is to analyze the user's task and generate a shared dependencies manifest.
This manifest will be injected into ALL file generations to ensure consistency.

Output format (markdown):

## Shared Dependencies

### Variables
- \`VARIABLE_NAME\`: type - description

### Functions
- \`functionName(params): ReturnType\` - description

### DOM Elements (if HTML/JS)
- \`#element-id\` - description

### API Routes (if backend)
- \`METHOD /path\` - description

### Data Schemas (if database)
\`\`\`typescript
interface Schema {
  field: type;
}
\`\`\`

### Component Names (if React/Vue)
- \`ComponentName\` - description

Be specific and exhaustive. List EVERY shared name that will be referenced across files.`;

const FILE_PATHS_SYSTEM_PROMPT = `You are a project planner.

Given a task and shared dependencies, list the files that need to be created.

Output ONLY a JSON array of file paths. No markdown, no explanations.

Example:
["src/index.ts", "src/api.ts", "README.md"]`;

const FILE_GENERATION_SYSTEM_PROMPT = `You are a skilled software engineer.

You are implementing a specific file as part of a larger project.

CRITICAL RULES:
1. Use the EXACT names from the Shared Dependencies section
2. Do NOT invent new variable/function names
3. Output ONLY the file contents (no markdown fences, no explanations)
4. Ensure all imports/exports match the shared dependencies`;

export class SharedDepsExecutor {
  private executor: LocalExecutor;

  constructor() {
    this.executor = new LocalExecutor();
  }

  /**
   * Execute task with shared dependencies pattern
   * 
   * @param task - User's task description
   * @param sandbox - Sandbox for staging files
   * @param options - Optional executor options
   */
  async execute(
    task: string,
    sandbox: Sandbox,
    options: { model?: string } = {}
  ): Promise<SharedDepsResult> {
    
    // Step 1: Generate shared dependencies
    logger.info('[SharedDeps] Step 1/3: Generating shared dependencies manifest...');
    const sharedDepsPrompt = `Task: ${task}

Generate a shared dependencies manifest for this project.
List ALL shared variables, functions, DOM elements, API routes, schemas, and component names.`;

    const sharedDepsResult = await this.executor.execute(sharedDepsPrompt, {
      ...options,
      systemPrompt: SHARED_DEPS_SYSTEM_PROMPT,
      maxTokens: 2000  // Limit shared deps to reasonable size
    });

    if (!sharedDepsResult.success) {
      throw new Error('Failed to generate shared dependencies');
    }

    const sharedDeps = sharedDepsResult.result;
    logger.info(`[SharedDeps] ✓ Generated shared dependencies (${sharedDeps.length} chars)`);
    
    // Save to sandbox for inspection
    await sandbox.addChange('shared-deps.md', sharedDeps);

    // Step 2: Generate file paths
    logger.info('[SharedDeps] Step 2/3: Determining file paths...');
    const filePathsPrompt = `Task: ${task}

Shared Dependencies:
${sharedDeps}

List the files to create for this project.
Output ONLY a JSON array of file paths.`;

    const filePathsResult = await this.executor.execute(filePathsPrompt, {
      ...options,
      systemPrompt: FILE_PATHS_SYSTEM_PROMPT,
      maxTokens: 500,
      jsonMode: true  // Enable JSON mode for guaranteed JSON output
    });

    if (!filePathsResult.success) {
      throw new Error('Failed to generate file paths');
    }

    // Parse file paths
    let filePaths: string[];
    try {
      // Strip markdown fences if present
      let jsonStr = filePathsResult.result.trim();
      
      // Remove markdown code fences
      jsonStr = jsonStr.replace(/```(?:json)?\n?/g, '').trim();
      
      // Remove any trailing/leading whitespace or newlines
      jsonStr = jsonStr.replace(/^\s+|\s+$/g, '');
      
      // If response contains explanatory text, try to extract just the JSON array
      const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        jsonStr = arrayMatch[0];
      }
      
      // Parse JSON
      filePaths = JSON.parse(jsonStr);
      
      if (!Array.isArray(filePaths)) {
        throw new Error('File paths must be an array');
      }
      
      // Filter out empty strings
      filePaths = filePaths.filter(p => p && typeof p === 'string');
      
      if (filePaths.length === 0) {
        throw new Error('No valid file paths found');
      }
      
    } catch (err) {
      logger.error(`Failed to parse file paths: ${(err as Error).message}`);
      logger.debug(`Raw response: ${filePathsResult.result}`);
      
      // Fallback: try to extract filenames from the text
      const lines = filePathsResult.result.split('\n');
      const possibleFiles = lines
        .map(l => l.trim())
        .filter(l => l.match(/\.(js|ts|json|html|css|md|txt)$/i));
      
      if (possibleFiles.length > 0) {
        logger.warn(`Using fallback extraction, found ${possibleFiles.length} files`);
        filePaths = possibleFiles;
      } else {
        throw new Error('Failed to parse file paths from LLM response');
      }
    }

    logger.info(`[SharedDeps] ✓ Identified ${filePaths.length} files: ${filePaths.join(', ')}`);

    // Step 3: Generate each file WITH shared_deps context
    logger.info('[SharedDeps] Step 3/3: Generating file contents...');
    const files = new Map<string, string>();

    for (const filePath of filePaths) {
      logger.info(`[SharedDeps]   Generating: ${filePath}...`);
      
      const filePrompt = `You are implementing: ${filePath}

Shared Dependencies (USE THESE EXACT NAMES):
${sharedDeps}

Task: ${task}

Generate the complete contents of ${filePath}.
Output ONLY the file contents (no markdown fences, no explanations).`;

      const fileResult = await this.executor.execute(filePrompt, {
        ...options,
        systemPrompt: FILE_GENERATION_SYSTEM_PROMPT,
        maxTokens: 4000
      });

      if (!fileResult.success) {
        logger.warn(`  ⚠️  Failed to generate ${filePath}, skipping`);
        continue;
      }

      // Strip markdown fences if present
      let content = fileResult.result.trim();
      if (content.startsWith('```')) {
        // Remove opening fence
        content = content.replace(/^```[\w]*\n/, '');
        // Remove closing fence
        content = content.replace(/\n```$/, '');
      }

      files.set(filePath, content);
      await sandbox.addChange(filePath, content);
      logger.info(`[SharedDeps]   ✓ Generated ${filePath} (${content.length} chars)`);
    }

    logger.info(`[SharedDeps] ✅ Complete: Generated ${files.size}/${filePaths.length} files`);

    return {
      sharedDeps,
      filePaths,
      files
    };
  }
}
