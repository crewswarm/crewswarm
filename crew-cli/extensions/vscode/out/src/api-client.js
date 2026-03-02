"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiClient = void 0;
const vscode = require("vscode");
class ApiClient {
    constructor() {
        this.baseUrl = vscode.workspace.getConfiguration('crewswarm')?.get('apiUrl') || 'http://127.0.0.1:5010/v1';
    }
    async chat(message) {
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
            const payload = await response.json();
            return String(payload?.reply || payload?.response || '');
        }
        catch (error) {
            clearTimeout(timeout);
            if (error.name === 'AbortError') {
                throw new Error('API request timed out after 30 seconds');
            }
            throw new Error(`Failed to connect to CrewSwarm: ${error.message}`);
        }
    }
    async generateCode(prompt) {
        const response = await fetch(`${this.baseUrl}/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: prompt,
                sessionId: 'vscode-extension'
            }),
        });
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        const payload = await response.json();
        return String(payload?.reply || payload?.response || '');
    }
}
exports.ApiClient = ApiClient;
//# sourceMappingURL=api-client.js.map