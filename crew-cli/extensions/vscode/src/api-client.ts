import * as vscode from 'vscode';

export interface ChatRequest {
  message: string;
  sessionId?: string;
  context?: string;
  mode?: 'connected' | 'standalone';
}

export interface ChatResponse {
  reply: string;
  traceId?: string;
  executionPath?: string[];
  pendingChanges?: number;
  patches?: Array<{
    path: string;
    unifiedDiff: string;
  }>;
  files?: Array<{
    path: string;
    contents: string;
  }>;
}

export class ApiClient {
  private baseUrl: string;
  private authToken: string;
  private timeout: number;

  constructor() {
    const config = vscode.workspace.getConfiguration('crewswarm');
    this.baseUrl = config.get('apiUrl', 'http://127.0.0.1:4319/v1');
    this.authToken = config.get('authToken', '');
    this.timeout = config.get('timeout', 30000);
  }

  async chat(message: string, context?: string): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      const requestBody: ChatRequest = {
        message,
        sessionId: vscode.workspace.getConfiguration('crewswarm').get('sessionId', 'vscode-extension'),
        context,
        mode: vscode.workspace.getConfiguration('crewswarm').get('mode', 'connected')
      };

      const response = await fetch(`${this.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken && { 'Authorization': `Bearer ${this.authToken}` })
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const payload = await response.json() as ChatResponse;
      return payload || { reply: '' };
    } catch (error: unknown) {
      clearTimeout(timeout);
      if ((error as Error).name === 'AbortError') {
        throw new Error(`API request timed out after ${this.timeout / 1000} seconds`);
      }
      throw new Error(`Failed to connect to crewswarm: ${(error as Error).message}`);
    }
  }

  async testConnection(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s for connection test

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: {
          ...(this.authToken && { 'Authorization': `Bearer ${this.authToken}` })
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }

      return true;
    } catch (error: unknown) {
      clearTimeout(timeout);
      throw new Error(`Connection test failed: ${(error as Error).message}`);
    }
  }

  async generateCode(prompt: string): Promise<string> {
    const response = await this.chat(prompt);
    return response.reply;
  }
}
