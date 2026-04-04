/**
 * Docker-based sandbox for safe command execution
 * Runs commands in isolated Docker containers with staged files
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface DockerSandboxOptions {
  workDir: string;
  image?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface DockerSandboxResult {
  success: boolean;
  output: string;
  exitCode: number;
  duration: number;
}

export class DockerSandbox {
  private readonly defaultImage = 'node:20-slim';
  private readonly defaultTimeout = 30000; // 30 seconds
  
  /**
   * Check if Docker is available and running
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      execSync('docker info', { 
        stdio: 'ignore',
        timeout: 5000 
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy staged files from sandbox to temp directory
   */
  private async prepareTempDir(sandbox: { getPendingPaths(): string[]; state?: { branches?: Record<string, Record<string, { modified?: string }>> }; getActiveBranch(): string }, tempDir: string): Promise<number> {
    const pendingPaths = sandbox.getPendingPaths();
    const branch = sandbox.state?.branches?.[sandbox.getActiveBranch()];
    
    if (!branch) return 0;

    let fileCount = 0;
    for (const filePath of pendingPaths) {
      const fileData = branch[filePath];
      if (!fileData?.modified) continue;

      const fullPath = path.join(tempDir, filePath);
      const dir = path.dirname(fullPath);
      
      // Create directory structure
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write staged content
      fs.writeFileSync(fullPath, fileData.modified, 'utf8');
      fileCount++;
    }

    return fileCount;
  }

  /**
   * Run command in Docker container with staged files
   */
  async runCommand(
    command: string,
    sandbox: { getPendingPaths(): string[]; state?: { branches?: Record<string, Record<string, { modified?: string }>> }; getActiveBranch(): string },
    options: Partial<DockerSandboxOptions> = {}
  ): Promise<DockerSandboxResult> {
    const startTime = Date.now();
    const tempDir = path.join('/tmp', `crew-sandbox-${randomUUID()}`);
    const image = options.image || this.defaultImage;
    const timeout = options.timeout || this.defaultTimeout;
    const workDir = options.workDir || process.cwd();

    try {
      // Create temp directory
      fs.mkdirSync(tempDir, { recursive: true });
      console.log(`[Docker] Created temp dir: ${tempDir}`);

      // Copy staged files to temp dir
      const fileCount = await this.prepareTempDir(sandbox, tempDir);
      console.log(`[Docker] Copied ${fileCount} staged file(s) to sandbox`);

      // Copy package.json if it exists (for npm commands)
      const pkgPath = path.join(workDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        fs.copyFileSync(pkgPath, path.join(tempDir, 'package.json'));
        console.log(`[Docker] Copied package.json`);
      }

      // Copy node_modules if npm/node command (for dependencies)
      const needsNodeModules = /\b(npm|node|npx)\b/.test(command);
      if (needsNodeModules) {
        const nodeModulesPath = path.join(workDir, 'node_modules');
        if (fs.existsSync(nodeModulesPath)) {
          console.log(`[Docker] Copying node_modules (this may take a few seconds)...`);
          execSync(`cp -r "${nodeModulesPath}" "${tempDir}/"`, {
            stdio: 'ignore',
            timeout: 10000
          });
        }
      }

      // Build environment variables
      const envFlags = options.env 
        ? Object.entries(options.env).map(([k, v]) => `-e ${k}="${v}"`).join(' ')
        : '';

      // Run command in Docker
      console.log(`[Docker] Running: ${command}`);
      const dockerCmd = `docker run --rm -v "${tempDir}":/work -w /work ${envFlags} ${image} sh -c "${command.replace(/"/g, '\\"')}"`;
      
      const output = execSync(dockerCmd, {
        encoding: 'utf8',
        timeout,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const duration = Date.now() - startTime;
      console.log(`[Docker] ✓ Command completed in ${duration}ms`);

      return {
        success: true,
        output,
        exitCode: 0,
        duration
      };

    } catch (err) {
      const duration = Date.now() - startTime;
      console.log(`[Docker] ✗ Command failed after ${duration}ms`);
      
      return {
        success: false,
        output: err.stdout || err.stderr || err.message,
        exitCode: err.status || 1,
        duration
      };

    } finally {
      // Cleanup temp directory
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
          console.log(`[Docker] Cleaned up temp dir`);
        }
      } catch (cleanupErr) {
        console.warn(`[Docker] Failed to cleanup ${tempDir}:`, cleanupErr);
      }
    }
  }

  /**
   * Pull Docker image if not present (with progress)
   */
  async ensureImage(image: string = this.defaultImage): Promise<boolean> {
    try {
      // Check if image exists
      execSync(`docker image inspect ${image}`, { 
        stdio: 'ignore',
        timeout: 5000 
      });
      return true; // Image already exists
    } catch {
      // Image doesn't exist, pull it
      console.log(`[Docker] Pulling image ${image}...`);
      try {
        execSync(`docker pull ${image}`, {
          stdio: 'inherit', // Show progress
          timeout: 120000 // 2 minutes for image pull
        });
        console.log(`[Docker] ✓ Image pulled successfully`);
        return true;
      } catch (pullErr) {
        console.error(`[Docker] Failed to pull image:`, pullErr);
        return false;
      }
    }
  }
}
