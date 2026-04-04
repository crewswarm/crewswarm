import * as vscode from 'vscode';

export class TelemetryManager implements vscode.Disposable {
    private isEnabled: boolean;

    constructor() {
        this.isEnabled = vscode.workspace.getConfiguration('crewswarm').get('enableTelemetry', true);
    }

    track(event: string, properties?: Record<string, unknown>): void {
        if (!this.isEnabled) return;

        // Simple console-based telemetry for now
        // In production, this would integrate with VS Code's telemetry API
        const timestamp = new Date().toISOString();
        const sessionId = vscode.workspace.getConfiguration('crewswarm').get('sessionId', 'vscode-extension');
        
        const telemetryData = {
            event,
            timestamp,
            sessionId,
            properties: properties || {},
            version: '0.1.0'
        };

        console.log(`[crewswarm Telemetry] ${JSON.stringify(telemetryData)}`);
    }

    dispose(): void {
        // Cleanup if needed
    }
}