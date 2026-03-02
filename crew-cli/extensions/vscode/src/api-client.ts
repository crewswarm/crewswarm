import * as vscode from 'vscode';

export class ApiClient {
  private baseUrl = (vscode.workspace.getConfiguration('crewswarm')?.get('apiUrl') as string) || 'http://127.0.0.1:4319/api/crew-lead';

  async chat(message: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(`${this.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          sessionId: 'vscode-extension'
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      const payload: any = await response.json();
      return String(payload?.reply || payload?.response || '');
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new Error('API request timed out after 30 seconds');
      }
      throw new Error(`Failed to connect to CrewSwarm: ${error.message}`);
    }
  }

  async generateCode(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`${this.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: prompt,
          sessionId: 'vscode-extension'
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      const payload: any = await response.json();
      return String(payload?.reply || payload?.response || '');
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new Error('API request timed out after 30 seconds');
      }
      throw new Error(`Failed to connect to CrewSwarm: ${error.message}`);
    }
  }
}
