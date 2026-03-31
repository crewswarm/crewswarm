// @ts-nocheck
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AuthTokens {
  claude?: string;
  cursor?: string;
  gemini?: string;
  openai?: string;
}

export class TokenFinder {
  async findTokens(): Promise<AuthTokens> {
    const tokens: AuthTokens = {};

    // 1. Claude Code OAuth (macOS Keychain)
    const claudeToken = await this.findClaudeOauthToken();
    if (claudeToken) {
      tokens.claude = claudeToken;
    }

    // 2. OpenAI (~/.openai/config)
    const openaiPath = join(homedir(), '.openai', 'config');
    if (await this.exists(openaiPath)) {
      try {
        const data = await readFile(openaiPath, 'utf8');
        const match = data.match(/api_key[:=]\s*([a-zA-Z0-9\-]+)/);
        if (match) tokens.openai = match[1];
      } catch (e) {
        console.error(`Failed to parse OpenAI config: ${e.message}`);
      }
    }

    // 3. Gemini ADC (~/.config/gcloud/application_default_credentials.json)
    const geminiPath = join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    if (await this.exists(geminiPath)) {
      try {
        tokens.gemini = '(detected via ADC)';
      } catch (e) {
        console.error(`Failed to check Gemini ADC: ${e.message}`);
      }
    }

    // 4. Cursor auth from SQLite state DB
    const cursorDbPath = join(homedir(), '.cursor', 'User', 'globalStorage', 'state.vscdb');
    if (await this.exists(cursorDbPath)) {
      try {
        const { stdout } = await execFileAsync('sqlite3', [
          cursorDbPath,
          "SELECT value FROM ItemTable WHERE key LIKE '%token%' OR key LIKE '%auth%' LIMIT 20;"
        ]);
        const first = stdout
          .split('\n')
          .map(line => line.trim())
          .find(Boolean);
        if (first) {
          tokens.cursor = first.slice(0, 120);
        } else {
          tokens.cursor = '(cursor db detected; token key not found)';
        }
      } catch {
        tokens.cursor = '(cursor db detected; sqlite3 not available or parse failed)';
      }
    }

    return tokens;
  }

  private async findClaudeOauthToken(): Promise<string | undefined> {
    if (process.platform !== 'darwin') return undefined;

    const accounts = [userInfo().username, 'unknown'];
    for (const account of accounts) {
      try {
        const { stdout } = await execFileAsync('security', [
          'find-generic-password',
          '-a', account,
          '-s', 'Claude Code-credentials',
          '-w'
        ]);
        const raw = stdout.trim();
        if (!raw) continue;
        const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'hex').toString('utf8');
        const parsed = JSON.parse(jsonStr);
        const accessToken = parsed?.claudeAiOauth?.accessToken;
        if (accessToken) return accessToken;
      } catch {
        // Try the next account variant.
      }
    }

    return undefined;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
