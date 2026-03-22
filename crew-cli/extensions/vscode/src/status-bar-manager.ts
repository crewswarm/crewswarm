import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private isConnected: boolean = false;
    private hasActiveChat: boolean = false;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.updateStatusBar();
    }

    setConnected(connected: boolean): void {
        this.isConnected = connected;
        this.updateStatusBar();
    }

    setActiveChat(active: boolean): void {
        this.hasActiveChat = active;
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        if (this.isConnected) {
            this.statusBarItem.text = `$(check) crewswarm`;
            this.statusBarItem.tooltip = 'crewswarm is connected';
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = `$(x) crewswarm`;
            this.statusBarItem.tooltip = 'crewswarm disconnected - Click to refresh';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }

        if (this.hasActiveChat) {
            this.statusBarItem.text += ' $(comment-discussion)';
        }

        this.statusBarItem.command = 'crewswarm.refreshConnection';
    }

    show(): void {
        this.statusBarItem.show();
    }

    hide(): void {
        this.statusBarItem.hide();
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}